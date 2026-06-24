import { useEffect, useRef, useState } from "react";
import { state, bump, useGame, save, pushNotification, pushChat, abandonDungeon, useConsumable, runDockingServices, loadServerPlayer, collectCargoBox, enterDungeon } from "./game/store";
import { startLoop, stopLoop, checkPortal, checkStationDock, effectiveStats } from "./game/loop";
import { render } from "./game/render";
import { TopBar, WorldTargetHud } from "./components/TopBar";
import { MiniMap } from "./components/MiniMap";
import { Hangar } from "./components/Hangar";
import { SocialPanel, ClanPanel, GalaxyMap, BattleLog } from "./components/SocialPanel";
import { FactionPicker } from "./components/FactionPicker";
import { IdleRewardModal } from "./components/IdleRewardModal";
import { EventBanners } from "./components/EventBanners";
import { Hotbar } from "./components/Hotbar";
import { QuestTracker } from "./components/QuestTracker";
import { DUNGEONS, STATIONS, PORTALS, ZONES, MODULE_DEFS } from "./game/types";
import { travelToZone, state as gameState } from "./game/store";
import AuthScreen from "./components/AuthScreen";
import { hasToken, getPlayer, clearToken } from "./net/api";
import {
  connectSocket, disconnectSocket, setSocketListeners, sendInput,
  type ServerEnemy, type ServerAsteroid, type ServerNpc, type ProjectileSpawnEvent,
  type EnemyHitEvent, type EnemyDieEvent, type EnemyAttackEvent,
} from "./net/socket";
import {
  onEnemyHit, onEnemyDie, onEnemyAttack, onEnemySpawn, onBossWarn,
  onAsteroidMine, onAsteroidDestroy, onAsteroidRespawn,
  onServerZoneEnemies, onServerZoneAsteroids, onServerZoneNpcs,
  onNpcSpawn, onNpcDie,
  onWelcome, onDelta, onSnapshot, onPlayerHitFromServer, onPlayerDieFromServer,
  onLaserFireFromServer, onRocketFireFromServer, onProjectileSpawnFromServer,
} from "./game/loop";

function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    startLoop();
    return () => stopLoop();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      render(ctx, w, h);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const screenToWorld = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const zoom = state.cameraZoom;
    return {
      x: state.player.pos.x + (cx - rect.width / 2) / zoom,
      y: state.player.pos.y + (cy - rect.height / 2) / zoom,
    };
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (state.dockedAt) return;
    const { x: wx, y: wy } = screenToWorld(e);

    // Check if clicking on enemy — lock target (stays locked), do NOT auto-attack
    const enemy = state.enemies.find((en) => Math.hypot(en.pos.x - wx, en.pos.y - wy) < Math.max(24, en.size + 14));
    if (enemy) {
      state.selectedWorldTarget = {
        kind: "enemy",
        id: enemy.id,
        name: enemy.name ?? enemy.type.toUpperCase(),
        detail: `${enemy.type.toUpperCase()} · ${Math.max(0, Math.round(enemy.hull))}/${Math.round(enemy.hullMax)} HP`,
      };
      state.attackTargetId = enemy.id;
      state.miningTargetId = null;
      bump();
      return;
    }

    // Check if clicking on asteroid — select but do NOT move ship
    const asteroid = state.asteroids.find((a) => a.zone === state.player.zone && Math.hypot(a.pos.x - wx, a.pos.y - wy) < a.size + 10);
    if (asteroid) {
      state.selectedWorldTarget = {
        kind: "asteroid",
        id: asteroid.id,
        name: asteroid.yields === "lumenite" ? "LUMENITE ROCK" : "ORE ROCK",
        detail: `${asteroid.yields.toUpperCase()} · ${Math.round(asteroid.hp)}/${Math.round(asteroid.hpMax)} HP`,
      };
      state.miningTargetId = asteroid.id;
      bump();
      return;
    }

    // Check if clicking on cargo box — fly to it to collect
    const cargoBox = state.cargoBoxes.find((cb) => Math.hypot(cb.pos.x - wx, cb.pos.y - wy) < 24);
    if (cargoBox) {
      state.cameraTarget = { x: cargoBox.pos.x, y: cargoBox.pos.y };
      bump();
      return;
    }

    // Check if clicking on dungeon rift — enter if close enough, otherwise fly to it
    for (const d of Object.values(DUNGEONS)) {
      if (d.zone !== state.player.zone) continue;
      if (Math.hypot(d.pos.x - wx, d.pos.y - wy) < 50) {
        const playerDist = Math.hypot(d.pos.x - state.player.pos.x, d.pos.y - state.player.pos.y);
        if (playerDist < 120) {
          enterDungeon(d.id);
        } else {
          state.cameraTarget = { x: d.pos.x, y: d.pos.y };
          pushNotification(`Fly closer to enter ${d.name}`, "info");
        }
        bump();
        return;
      }
    }

    // Clicked on free space — move ship there, keep target lock
    state.cameraTarget = { x: wx, y: wy };
    state.miningTargetId = null;

    // Snap to station if clicked nearby
    for (const s of STATIONS) {
      if (s.zone !== state.player.zone) continue;
      if (Math.hypot(s.pos.x - wx, s.pos.y - wy) < 60) {
        state.cameraTarget = { x: s.pos.x, y: s.pos.y };
        break;
      }
    }
    bump();
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (state.dockedAt) return;
    const { x: wx, y: wy } = screenToWorld(e);
    const enemy = state.enemies.find((en) => Math.hypot(en.pos.x - wx, en.pos.y - wy) < Math.max(24, en.size + 14));
    if (enemy) {
      state.selectedWorldTarget = {
        kind: "enemy",
        id: enemy.id,
        name: enemy.name ?? enemy.type.toUpperCase(),
        detail: `${enemy.type.toUpperCase()} · ${Math.max(0, Math.round(enemy.hull))}/${Math.round(enemy.hullMax)} HP`,
      };
      state.attackTargetId = enemy.id;
      state.miningTargetId = null;
      // Double-click starts both lasers and rockets
      state.isLaserFiring = true;
      state.isRocketFiring = true;
      state.isAttacking = true;
      bump();
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1 || state.dockedAt) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    state.cameraTarget = {
      x: state.player.pos.x + (cx - rect.width / 2) / state.cameraZoom,
      y: state.player.pos.y + (cy - rect.height / 2) / state.cameraZoom,
    };
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    state.cameraZoom = Math.max(1.0, Math.min(2.5, state.cameraZoom + delta));
    bump();
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      className="absolute inset-0 w-full h-full"
      style={{ cursor: "crosshair", display: "block" }}
    />
  );
}

function Notifications() {
  const items = useGame((s) => s.notifications);
  return (
    <div className="absolute flex flex-col items-start gap-1 pointer-events-none z-40" style={{ bottom: 80, left: 12 }}>
      {items.slice(-4).map((n) => (
        <div
          key={n.id}
          className="panel px-3 py-1.5 text-[14px] font-bold tracking-widest"
          style={{
            opacity: Math.min(1, n.ttl),
            color: n.kind === "good" ? "#5cff8a" : n.kind === "bad" ? "#ff5c6c" : "#4ee2ff",
            borderColor: n.kind === "good" ? "#5cff8a" : n.kind === "bad" ? "#ff5c6c" : "#4ee2ff",
          }}
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}

function DungeonHud() {
  const dungeon = useGame((s) => s.dungeon);
  if (!dungeon) return null;
  const def = DUNGEONS[dungeon.id];
  return (
    <>
      {/* corner tint to signal instance mode */}
      <div className="absolute inset-0 pointer-events-none z-[5]" style={{
        boxShadow: `inset 0 0 220px ${def.color}33`,
      }} />
      <div className="absolute z-30 pointer-events-auto" style={{ top: 64, left: "50%", transform: "translateX(-50%)" }}>
        <div className="panel px-3 py-1.5 flex items-center gap-3" style={{ borderColor: def.color, boxShadow: `0 0 14px ${def.color}55` }}>
          <div className="text-[10px] tracking-[0.25em] font-bold" style={{ color: def.color }}>▼ {def.name.toUpperCase()}</div>
          <div className="text-[10px] text-mute tabular-nums">WAVE {dungeon.wave}/{dungeon.totalWaves}</div>
          <div className="text-[10px] text-amber tabular-nums">ENEMIES: {state.enemies.length}</div>
          <button className="btn btn-danger" style={{ padding: "1px 6px", fontSize: 9 }} onClick={abandonDungeon}>
            Abandon
          </button>
        </div>
      </div>
    </>
  );
}

function DockPrompt() {
  const player = useGame((s) => s.player);
  useGame((s) => s.tick);

  const station = STATIONS.find(
    (s) => s.zone === player.zone && Math.hypot(s.pos.x - player.pos.x, s.pos.y - player.pos.y) < 90
  );
  const portal = PORTALS.find(
    (po) => po.fromZone === player.zone && Math.hypot(po.pos.x - player.pos.x, po.pos.y - player.pos.y) < 70
  );

  if (!station && !portal) return null;

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40">
      {station && !state.dockedAt && (
        <button
          className="btn btn-primary text-base px-8 py-3"
          style={{ animation: "pulse-glow 2s ease-in-out infinite", whiteSpace: "nowrap", minWidth: "fit-content" }}
          onClick={() => {
            state.dockedAt = station.id;
            state.player.vel = { x: 0, y: 0 };
            pushNotification(`Docking with ${station.name}`, "good");
            save(); bump();
            const stats = effectiveStats();
            runDockingServices(stats.hullMax, stats.shieldMax);
          }}
        >
          [SPACE] DOCK AT {station.name.toUpperCase()}
        </button>
      )}
      {portal && (
        <button
          className="btn px-6 py-3"
          style={{ borderColor: "#ff5cf0", color: "#ff5cf0", animation: "pulse-glow 2s ease-in-out infinite" }}
          onClick={() => {
            const z = ZONES[portal.toZone];
            if (player.level < z.unlockLevel) {
              pushNotification(`Need level ${z.unlockLevel} to enter ${z.name}`, "bad");
              return;
            }
            travelToZone(portal.toZone);
          }}
        >
          ▶ WARP TO {ZONES[portal.toZone].name.toUpperCase()}
        </button>
      )}
    </div>
  );
}


function Title() {
  return (
    <div className="absolute bottom-3 left-3 z-30 pointer-events-none">
      <div className="text-cyan glow-cyan text-[10px] tracking-[0.3em]">COSMIC REALM</div>
      <div className="text-mute text-[9px] tracking-widest">
        v 2.0 · CLICK to move · MINIMAP click warps · SPACE docks · SHOOT asteroids to mine
      </div>
    </div>
  );
}

function DockingSummary() {
  const summary = useGame((s) => s.dockingSummary);

  useEffect(() => {
    if (!summary) return;
    const dismiss = () => { state.dockingSummary = null; bump(); };
    const timer = setTimeout(dismiss, 6000);
    document.addEventListener("click", dismiss, { once: true });
    return () => { clearTimeout(timer); document.removeEventListener("click", dismiss); };
  }, [summary]);

  if (!summary) return null;

  const totalCost = summary.reduce((acc, e) => acc + e.cost, 0);
  const iconFor = (kind: string) => {
    if (kind === "repair") return "⬡";
    if (kind === "shield") return "◈";
    if (kind === "ammo") return "▸";
    return "✕";
  };
  const colorFor = (kind: string) => {
    if (kind === "repair") return "#4ade80";
    if (kind === "shield") return "#60a5fa";
    if (kind === "ammo") return "#facc15";
    return "#f87171";
  };

  return (
    <div
      className="absolute top-16 left-1/2 -translate-x-1/2 z-50"
      style={{ animation: "fadeInDown 0.3s ease" }}
    >
      <div
        className="rounded border px-5 py-4 cursor-pointer select-none"
        style={{
          background: "rgba(2,6,20,0.92)",
          borderColor: "#1e3a5f",
          boxShadow: "0 0 24px rgba(0,180,255,0.15)",
          minWidth: 260,
        }}
      >
        <div className="text-cyan text-[11px] tracking-[0.25em] font-bold mb-3">◉ DOCKING REPORT</div>
        <div className="flex flex-col gap-2">
          {summary.map((entry, i) => (
            <div key={i} className="flex items-center justify-between gap-4 text-[12px]">
              <div className="flex items-center gap-2">
                <span style={{ color: colorFor(entry.kind) }}>{iconFor(entry.kind)}</span>
                <span style={{ color: entry.kind === "failed" ? "#f87171" : "#c8d8f0" }}>{entry.label}</span>
              </div>
              {entry.cost > 0 && (
                <span style={{ color: "#facc15" }} className="shrink-0">-{entry.cost}cr</span>
              )}
            </div>
          ))}
        </div>
        {totalCost > 0 && (
          <>
            <div className="border-t mt-3 mb-2" style={{ borderColor: "#1e3a5f" }} />
            <div className="flex justify-between text-[12px]">
              <span style={{ color: "#7a9cbf" }}>Total spent</span>
              <span style={{ color: "#facc15" }}>-{totalCost}cr</span>
            </div>
          </>
        )}
        <div className="text-[9px] tracking-widest mt-3" style={{ color: "#3a5a7a" }}>CLICK TO DISMISS</div>
      </div>
    </div>
  );
}

function GameApp() {
  // Wire socket listeners to game state
  useEffect(() => {
    setSocketListeners({
      onWelcome: (payload) => onWelcome(payload),
      onDelta: (payload) => onDelta(payload),
      onSnapshot: (payload) => onSnapshot(payload),
      onPlayerJoin: (p) => {
        const sid = String(p.id);
        if (state.others.find((o) => o.id === sid)) return;
        state.others.push({
          id: sid, name: p.name, shipClass: p.shipClass as any,
          level: p.level, clan: null, zone: p.zone as any,
          pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, angle: 0,
          inParty: false,
        });
        bump();
      },
      onPlayerLeave: (data) => {
        const sid = String(data.playerId);
        state.others = state.others.filter((o) => o.id !== sid);
        bump();
      },
      onChatMessage: (msg) => {
        pushChat(msg.channel as any, msg.from, msg.text);
      },
      onOnlineCount: (_count) => {},
      onZoneEnemies: (enemies: ServerEnemy[]) => onServerZoneEnemies(enemies),
      onZoneAsteroids: (asteroids: ServerAsteroid[]) => onServerZoneAsteroids(asteroids),
      onZoneNpcs: (npcs: ServerNpc[]) => onServerZoneNpcs(npcs),
      onEnemySpawn: (enemy: ServerEnemy) => onEnemySpawn(enemy),
      onEnemyDie: (event: EnemyDieEvent) => onEnemyDie(event),
      onEnemyHit: (event: EnemyHitEvent) => onEnemyHit(event),
      onEnemyAttack: (event: EnemyAttackEvent) => onEnemyAttack(event),
      onPlayerHit: (data) => onPlayerHitFromServer(data),
      onPlayerDie: (data) => onPlayerDieFromServer(data),
      onAsteroidMine: (data) => onAsteroidMine(data),
      onAsteroidDestroy: (data) => onAsteroidDestroy(data),
      onAsteroidRespawn: (asteroid: ServerAsteroid) => onAsteroidRespawn(asteroid),
      onBossWarn: () => onBossWarn(),
      onNpcSpawn: (npc: ServerNpc) => onNpcSpawn(npc),
      onNpcDie: (data) => onNpcDie(data),
      onProjectileSpawn: (event: ProjectileSpawnEvent) => onProjectileSpawnFromServer(event),
      onLaserFire: (event) => onLaserFireFromServer(event),
      onRocketFire: (event) => onRocketFireFromServer(event),
    });
    return () => setSocketListeners({});
  }, []);

  useEffect(() => {
    const last = {
      targetX: Number.NaN,
      targetY: Number.NaN,
      firing: false,
      rocketFiring: false,
      attackTargetId: null as string | null,
      miningTargetId: null as string | null,
      laserAmmo: "",
      rocketAmmo: "",
      sentAt: 0,
    };
    const HEARTBEAT_MS = 1000;
    const MOVE_EPSILON = 1.5;

    const id = setInterval(() => {
      const cur = {
        targetX: state.cameraTarget.x,
        targetY: state.cameraTarget.y,
        firing: state.isLaserFiring,
        rocketFiring: state.isRocketFiring,
        attackTargetId: state.attackTargetId,
        miningTargetId: state.miningTargetId,
        laserAmmo: state.player.activeAmmoType ?? "x1",
        rocketAmmo: state.player.activeRocketAmmoType ?? "cl1",
      };
      const now = performance.now();
      const moved =
        Math.abs(cur.targetX - last.targetX) > MOVE_EPSILON ||
        Math.abs(cur.targetY - last.targetY) > MOVE_EPSILON;
      const combatChanged =
        cur.firing !== last.firing ||
        cur.rocketFiring !== last.rocketFiring ||
        cur.attackTargetId !== last.attackTargetId ||
        cur.laserAmmo !== last.laserAmmo ||
        cur.rocketAmmo !== last.rocketAmmo;
      const miningChanged = cur.miningTargetId !== last.miningTargetId;
      const heartbeat = now - last.sentAt > HEARTBEAT_MS;

      if (!moved && !combatChanged && !miningChanged && !heartbeat) return;

      sendInput(cur);
      Object.assign(last, cur, { sentAt: now });
    }, 50);
    return () => clearInterval(id);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (state.dockedAt) return;
        const sid = checkStationDock();
        if (sid) {
          state.dockedAt = sid;
          state.player.vel = { x: 0, y: 0 };
          pushNotification("Docking...", "good");
          save(); bump();
          const stats = effectiveStats();
          runDockingServices(stats.hullMax, stats.shieldMax);
        }
      } else if (e.key === "m" || e.key === "M") {
        state.showFullZoneMap = !state.showFullZoneMap; bump();
      } else if (e.key === "+" || e.key === "=") {
        state.minimapScale = Math.min(3, state.minimapScale + 0.25); bump();
      } else if (e.key === "-" || e.key === "_") {
        state.minimapScale = Math.max(0.5, state.minimapScale - 0.25); bump();
      } else if (e.key === "c" || e.key === "C") {
        state.showClan = !state.showClan; bump();
      } else if (e.key === "h" || e.key === "H") {
        state.showSocial = !state.showSocial; bump();
      } else if (e.key === "Escape") {
        state.showMap = false;
        state.showClan = false;
        state.showAmmoSelector = false;
        state.showRocketAmmoSelector = false;
        state.showFullZoneMap = false;
        bump();
      } else if (e.key === "1") {
        if (!state.dockedAt) {
          if (state.selectedWorldTarget?.kind === "enemy") {
            state.isLaserFiring = !state.isLaserFiring;
            state.isAttacking = state.isLaserFiring || state.isRocketFiring;
            bump();
          }
        }
      } else if (e.key === "2") {
        if (!state.dockedAt) {
          if (state.selectedWorldTarget?.kind === "enemy") {
            state.isRocketFiring = !state.isRocketFiring;
            state.isAttacking = state.isLaserFiring || state.isRocketFiring;
            bump();
          }
        }
      } else if (e.key >= "3" && e.key <= "9") {
        if (!state.dockedAt) {
          useConsumable(parseInt(e.key) - 3);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Auto-check portal collision
  useEffect(() => {
    const id = setInterval(() => {
      if (state.dockedAt) return;
      checkPortal();
    }, 200);
    return () => clearInterval(id);
  }, []);

  const docked = useGame((s) => s.dockedAt);
  const showSocial = useGame((s) => s.showSocial);

  return (
    <div className="relative w-full h-full overflow-hidden" style={{ background: "#02040c" }}>
      <GameCanvas />
      <TopBar />
      <WorldTargetHud />
      <MiniMap />
      <Notifications />
      <DungeonHud />
      <QuestTracker />
      <BattleLog />
      {showSocial && <SocialPanel />}
      <ClanPanel />
      <GalaxyMap />
      <EventBanners />
      <Title />
      {docked && <Hangar stationId={docked} />}
      <DockingSummary />
      <div
        style={{
          position: "fixed",
          left: "50%",
          bottom: 74,
          transform: "translateX(-50%)",
          zIndex: 51,
          pointerEvents: "auto",
        }}
      >
        <DockPrompt />
      </div>
      <Hotbar />
      <IdleRewardModal />
      <FactionPicker />
      <button
        onClick={() => { clearToken(); disconnectSocket(); window.location.reload(); }}
        style={{
          position: "fixed", top: 8, right: 8, zIndex: 60,
          background: "rgba(255,60,80,0.12)", border: "1px solid #ff3b4d55",
          color: "#ff8a9a", fontSize: 10, letterSpacing: "0.12em",
          padding: "3px 10px", borderRadius: 4, cursor: "pointer",
          fontFamily: "'Courier New', monospace",
        }}
      >
        LOGOUT
      </button>
      <div className="crt-overlay" />
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    getPlayer()
      .then((data) => {
        loadServerPlayer(data.player);
        connectSocket(localStorage.getItem("cosmic-token")!);
        setAuthed(true);
      })
      .catch(() => {
        clearToken();
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{
        position: "fixed", inset: 0, display: "flex", alignItems: "center",
        justifyContent: "center", background: "#020408", color: "#4ee2ff",
        fontSize: 14, letterSpacing: 4,
      }}>
        CONNECTING...
      </div>
    );
  }

  if (!authed) {
    return (
      <AuthScreen
        onAuth={(playerData) => {
          loadServerPlayer(playerData);
          connectSocket(localStorage.getItem("cosmic-token")!);
          setAuthed(true);
        }}
      />
    );
  }

  return <GameApp />;
}
