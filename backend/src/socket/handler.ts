import { Server, Socket } from "socket.io";
import { verifyToken, TokenPayload } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  OnlinePlayer,
  addPlayer,
  removePlayer,
  movePlayerToZone,
  getPlayersInZone,
  getPlayer,
  getOnlineCount,
  getAllZones,
} from "./state.js";
import { GameEngine, computeStats, type GameEvent } from "../game/engine.js";

const TICK_RATE = 30;
const CULL_RADIUS = 2000;
const FIXED_DT = 1 / TICK_RATE;

export function setupSocket(io: Server) {
  const engine = new GameEngine();

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    try {
      const payload = verifyToken(token);
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket: Socket) => {
    const user: TokenPayload = (socket as any).user;
    console.log(`[IO] ${user.username} connected (player ${user.playerId})`);

    const [dbPlayer] = await db
      .select()
      .from(schema.players)
      .where(eq(schema.players.id, user.playerId))
      .limit(1);

    if (!dbPlayer) {
      socket.disconnect();
      return;
    }

    // Cache player data for stat computation
    const playerData = {
      shipClass: dbPlayer.shipClass,
      inventory: dbPlayer.inventory,
      equipped: dbPlayer.equipped,
      skills: dbPlayer.skills,
      drones: dbPlayer.drones,
      faction: dbPlayer.faction,
      level: dbPlayer.level,
    };
    engine.cachePlayerData(dbPlayer.id, playerData);
    const stats = computeStats(playerData);

    const online: OnlinePlayer = {
      socketId: socket.id,
      playerId: dbPlayer.id,
      name: dbPlayer.name,
      shipClass: dbPlayer.shipClass,
      level: dbPlayer.level,
      faction: dbPlayer.faction,
      clan: null,
      zone: dbPlayer.zone,
      posX: dbPlayer.posX,
      posY: dbPlayer.posY,
      velX: 0,
      velY: 0,
      angle: 0,
      hull: dbPlayer.hull > 0 ? dbPlayer.hull : stats.hullMax,
      hullMax: stats.hullMax,
      shield: dbPlayer.shield,
      shieldMax: stats.shieldMax,
      honor: dbPlayer.honor,
      targetX: null,
      targetY: null,
      speed: stats.speed,
      isLaserFiring: false,
      isRocketFiring: false,
      attackTargetId: null,
      laserAmmoType: "x1",
      rocketAmmoType: "cl1",
      laserFireCd: 0,
      rocketFireCd: 0,
      miningTargetId: null,
      lastHitTick: 0,
      shieldRegen: stats.shieldRegen,
      afterburnUntil: 0,
    };

    socket.join(`zone:${online.zone}`);
    addPlayer(online);

    socket.emit("welcome", {
      playerId: dbPlayer.id,
      tickRate: TICK_RATE,
      friction: 0.96,
      frictionRefFps: 60,
    });

    socket.to(`zone:${online.zone}`).emit("player:join", toClientPlayer(online));
    io.emit("online:count", getOnlineCount());

    // Send initial zone asteroids (static, not in per-tick state)
    socket.emit("zone:asteroids", engine.getZoneAsteroids(online.zone));

    // ── INPUT: MOVE (click target) ────────────────────────────────
    socket.on("input:move", (data: { x: number; y: number }) => {
      const p = getPlayer(user.playerId);
      if (!p) return;
      p.targetX = clamp(data.x, -8000, 8000);
      p.targetY = clamp(data.y, -8000, 8000);
    });

    // ── INPUT: ATTACK (start/stop firing) ─────────────────────────
    socket.on("input:attack", (data: { enemyId: string | null; laser: boolean; rocket: boolean; laserAmmo: string; rocketAmmo: string }) => {
      const p = getPlayer(user.playerId);
      if (!p) return;
      p.attackTargetId = data.enemyId;
      p.isLaserFiring = data.laser;
      p.isRocketFiring = data.rocket;
      if (data.laserAmmo) p.laserAmmoType = data.laserAmmo;
      if (data.rocketAmmo) p.rocketAmmoType = data.rocketAmmo;
    });

    // ── INPUT: MINE (start/stop mining) ───────────────────────────
    socket.on("input:mine", (data: { asteroidId: string | null }) => {
      const p = getPlayer(user.playerId);
      if (!p) return;
      p.miningTargetId = data.asteroidId;
    });

    // ── ZONE WARP ───────────────────────────────────────────────────
    socket.on("warp", (data: { toZone: string; x: number; y: number }) => {
      const p = getPlayer(user.playerId);
      if (!p) return;

      const oldZone = p.zone;
      socket.leave(`zone:${oldZone}`);
      socket.to(`zone:${oldZone}`).emit("player:leave", { playerId: p.playerId });

      movePlayerToZone(p.playerId, oldZone, data.toZone);
      p.posX = data.x;
      p.posY = data.y;
      p.velX = 0;
      p.velY = 0;
      p.targetX = null;
      p.targetY = null;
      p.attackTargetId = null;
      p.isLaserFiring = false;
      p.isRocketFiring = false;
      p.miningTargetId = null;

      socket.join(`zone:${data.toZone}`);
      socket.to(`zone:${data.toZone}`).emit("player:join", toClientPlayer(p));

      // Send asteroids for new zone
      socket.emit("zone:asteroids", engine.getZoneAsteroids(data.toZone));
    });

    // ── PVP COMBAT (visual broadcast for now) ───────────────────────
    socket.on("attack", (data: { targetPlayerId: number; damage: number; weaponKind: string }) => {
      const attacker = getPlayer(user.playerId);
      const target = getPlayer(data.targetPlayerId);
      if (!attacker || !target) return;
      if (attacker.zone !== target.zone) return;

      io.to(`zone:${attacker.zone}`).emit("combat:attack", {
        attackerId: attacker.playerId,
        targetId: target.playerId,
        weaponKind: data.weaponKind,
        damage: data.damage,
      });
    });

    // ── CHAT ────────────────────────────────────────────────────────
    socket.on("chat", async (data: { channel: string; text: string }) => {
      if (!data.text || data.text.length > 200) return;
      const p = getPlayer(user.playerId);
      if (!p) return;

      const msg = {
        from: p.name,
        text: data.text,
        channel: data.channel,
        time: Date.now(),
      };

      if (data.channel === "local") {
        io.to(`zone:${p.zone}`).emit("chat:message", msg);
      } else if (data.channel === "system") {
        io.emit("chat:message", msg);
      }

      await db.insert(schema.chatMessages).values({
        channel: data.channel,
        fromPlayerId: p.playerId,
        fromName: p.name,
        text: data.text,
        zone: p.zone,
      }).catch(() => { });
    });

    // ── STATS UPDATE (syncs player data for engine computation) ─────
    socket.on("stats:update", (data: {
      hull: number; shield: number; level: number;
      shipClass: string; honor: number;
      inventory?: any[]; equipped?: any; skills?: any;
      drones?: any[]; faction?: string;
    }) => {
      const p = getPlayer(user.playerId);
      if (!p) return;
      if (data.hull != null) p.hull = data.hull;
      if (data.shield != null) p.shield = data.shield;
      p.level = data.level;
      p.shipClass = data.shipClass;
      p.honor = data.honor;

      const cached = engine.playerDataCache.get(user.playerId);
      if (cached) {
        if (data.shipClass) cached.shipClass = data.shipClass;
        if (data.inventory) cached.inventory = data.inventory;
        if (data.equipped) cached.equipped = data.equipped;
        if (data.skills) cached.skills = data.skills;
        if (data.drones) cached.drones = data.drones;
        if (data.faction) cached.faction = data.faction;
        if (data.level) cached.level = data.level;
      }

      const newStats = engine.refreshPlayerStats(user.playerId) ?? computeStats(cached || data);
      p.speed = newStats.speed;
      p.hullMax = newStats.hullMax;
      p.shieldMax = newStats.shieldMax;
      p.shieldRegen = newStats.shieldRegen;
    });

    // ── DISCONNECT ──────────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log(`[IO] ${user.username} disconnected`);
      engine.removePlayerData(user.playerId);
      const zone = removePlayer(user.playerId);
      if (zone) {
        socket.to(`zone:${zone}`).emit("player:leave", { playerId: user.playerId });
      }
      io.emit("online:count", getOnlineCount());
    });
  });

  const TICK_MS = 1000 / TICK_RATE;
  const CULL_RADIUS_SQ = CULL_RADIUS * CULL_RADIUS;
  let nextTickAt = Date.now() + TICK_MS;
  let tickCounter = 0;

  const runTick = () => {
    try {
      const events = engine.tick(FIXED_DT, getPlayersInZone);
      broadcastEvents(io, events);
      tickCounter++;

      for (const [, playersMap] of getAllZones()) {
        if (playersMap.size === 0) continue;
        const playersArr = Array.from(playersMap.values());

        for (const p of playersArr) {
          const culled = engine.getCulledStateForPlayer(p);

          const nearbyPlayers: any[] = [];
          for (const other of playersArr) {
            if (other.playerId === p.playerId) continue;
            const dx = p.posX - other.posX;
            const dy = p.posY - other.posY;
            if (dx * dx + dy * dy < CULL_RADIUS_SQ) {
              nearbyPlayers.push({
                id: other.playerId,
                name: other.name,
                shipClass: other.shipClass,
                level: other.level,
                faction: other.faction,
                x: other.posX, y: other.posY,
                vx: other.velX, vy: other.velY,
                a: other.angle,
                hp: other.hull, sp: other.shield,
              });
            }
          }

          const sock = io.sockets.sockets.get(p.socketId);
          if (!sock) continue;

          sock.emit("state", {
            self: culled.self,
            players: nearbyPlayers,
            enemies: culled.enemies,
            npcs: culled.npcs,
          });

          const entities: any[] = [];
          for (const o of nearbyPlayers) {
            entities.push({
              id: `p-${o.id}`, entityType: "player",
              x: o.x, y: o.y, vx: o.vx, vy: o.vy, angle: o.a,
              hp: o.hp, shield: o.sp, version: tickCounter,
              name: o.name, shipClass: o.shipClass, level: o.level, faction: o.faction,
            });
          }
          for (const e of culled.enemies as any[]) {
            entities.push({
              id: e.id, entityType: "enemy",
              x: e.x, y: e.y, vx: e.vx, vy: e.vy, angle: e.a,
              hp: e.hp, hpMax: e.hpMax, version: tickCounter,
              type: e.type, behavior: e.behavior, name: e.name,
              damage: e.damage, speed: e.speed, color: e.color, size: e.size,
              isBoss: e.isBoss, bossPhase: e.bossPhase,
            });
          }
          for (const n of culled.npcs as any[]) {
            entities.push({
              id: n.id, entityType: "npc",
              x: n.x, y: n.y, vx: n.vx, vy: n.vy, angle: n.a,
              hp: n.hp, hpMax: n.hpMax, version: tickCounter,
              name: n.name, color: n.color, size: n.size, state: n.state,
            });
          }

          sock.emit("snapshot", {
            tick: tickCounter,
            self: {
              id: p.playerId,
              x: culled.self.x, y: culled.self.y,
              vx: culled.self.vx, vy: culled.self.vy,
              hp: culled.self.hp, hpMax: culled.self.hpMax,
              shield: culled.self.sp, shieldMax: culled.self.spMax,
              lastProcessedInput: 0,
            },
            entities,
          });
        }
      }
    } catch (err) {
      console.error("[tick] error:", err);
    }

    nextTickAt += TICK_MS;
    const now = Date.now();
    let delay = nextTickAt - now;
    if (delay < -TICK_MS * 5) {
      nextTickAt = now + TICK_MS;
      delay = TICK_MS;
    } else if (delay < 0) {
      delay = 0;
    }
    setTimeout(runTick, delay);
  };
  setTimeout(runTick, TICK_MS);
}

// ── EVENT BROADCASTING ─────────────────────────────────────────────────

function broadcastEvents(io: Server, events: GameEvent[]): void {
  for (const ev of events) {
    switch (ev.type) {
      case "enemy:die":
        io.to(`zone:${ev.zone}`).emit("enemy:die", {
          enemyId: ev.enemyId,
          killerId: ev.killerId,
          loot: ev.loot,
          pos: ev.pos,
        });
        break;
      case "enemy:hit":
        io.to(`zone:${ev.zone}`).emit("enemy:hit", {
          enemyId: ev.enemyId,
          damage: ev.damage,
          hp: ev.hp,
          hpMax: ev.hpMax,
          crit: ev.crit,
          attackerId: ev.attackerId,
        });
        break;
      case "player:hit": {
        const p = getPlayer(ev.playerId);
        if (p) {
          const sock = io.sockets.sockets.get(p.socketId);
          sock?.emit("player:hit", { damage: ev.damage, hp: p.hull, shield: p.shield });
        }
        break;
      }
      case "player:die": {
        io.to(`zone:${ev.zone}`).emit("player:die", { playerId: ev.playerId, pos: ev.pos });
        break;
      }
      case "asteroid:mine":
        io.to(`zone:${ev.zone}`).emit("asteroid:mine", {
          asteroidId: ev.asteroidId,
          hp: ev.hp,
          hpMax: ev.hpMax,
        });
        break;
      case "asteroid:destroy":
        io.to(`zone:${ev.zone}`).emit("asteroid:destroy", {
          asteroidId: ev.asteroidId,
          playerId: ev.playerId,
          ore: ev.ore,
        });
        break;
      case "boss:warn":
        io.to(`zone:${ev.zone}`).emit("boss:warn");
        break;
      case "enemy:spawn":
        io.to(`zone:${ev.zone}`).emit("enemy:spawn", ev.enemy);
        break;
      case "enemy:attack":
        io.to(`zone:${ev.zone}`).emit("enemy:attack", {
          enemyId: ev.enemyId,
          targetId: ev.targetId,
          damage: ev.damage,
          pos: ev.pos,
          targetPos: ev.targetPos,
        });
        break;
      case "asteroid:respawn":
        io.to(`zone:${ev.zone}`).emit("asteroid:respawn", ev.asteroid);
        break;
      case "npc:spawn":
        io.to(`zone:${ev.zone}`).emit("npc:spawn", ev.npc);
        break;
      case "npc:die":
        io.to(`zone:${ev.zone}`).emit("npc:die", { npcId: ev.npcId });
        break;
      case "projectile:spawn": {
        const source = getPlayer(ev.fromPlayerId);
        if (source) {
          const sock = io.sockets.sockets.get(source.socketId);
          if (sock) {
            sock.to(`zone:${ev.zone}`).emit("projectile:spawn", {
              x: ev.x, y: ev.y, vx: ev.vx, vy: ev.vy,
              damage: ev.damage, color: ev.color, size: ev.size,
              crit: ev.crit, weaponKind: ev.weaponKind, homing: ev.homing,
              fromPlayer: true,
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

function toClientPlayer(p: OnlinePlayer) {
  return {
    id: p.playerId,
    name: p.name,
    shipClass: p.shipClass,
    level: p.level,
    faction: p.faction,
    clan: p.clan,
    zone: p.zone,
    x: p.posX,
    y: p.posY,
    vx: p.velX,
    vy: p.velY,
    angle: p.angle,
    hull: p.hull,
    hullMax: p.hullMax,
    shield: p.shield,
    shieldMax: p.shieldMax,
    honor: p.honor,
  };
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
