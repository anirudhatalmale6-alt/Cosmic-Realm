import {
  bump, pushChat, pushNotification, pushHonor, save, addCargo, pushFloater,
  pushEvent, bumpMission, state, travelToZone, completeDungeon,
  tickHotbarCooldowns,
  ensureAmmoInitialized, getAmmoWeaponIds, rocketAmmoMax,
  getActiveAmmoType, getActiveRocketAmmoType, getRocketAmmoCount, rocketMissileMax, tryCollectNearbyBoxes,
} from "./store";
import {
  CargoBox, DRONE_DEFS, Drone, DUNGEONS, ENEMY_DEFS, ENEMY_NAMES, EXP_FOR_LEVEL,
  Enemy, EnemyType, FACTION_ENEMY_MODS, FACTIONS, MODULE_DEFS, ModuleStats,
  MAP_RADIUS, NpcShip, PORTALS, ROCKET_AMMO_TYPE_DEFS, ROCKET_MISSILE_TYPE_DEFS, WeaponKind,
  SHIP_CLASSES, STATIONS, ZONES, ZoneId,
  rankFor,
} from "./types";
import { sfx } from "./sound";
import { type ServerEnemy, type ServerAsteroid, type ServerNpc, type EnemyHitEvent, type EnemyDieEvent, type EnemyAttackEvent, type DeltaPayload, type SnapshotPayload, type WelcomePayload, type DeltaEntity, type LaserFireEvent, type RocketFireEvent, type ProjectileSpawnEvent } from "../net/socket";

// Returns the equipped weapon's color (used for laser projectiles)
function equippedWeaponColor(): string {
  const p = state.player;
  for (const id of p.equipped.weapon) {
    if (!id) continue;
    const item = p.inventory.find((m) => m.instanceId === id);
    if (item && MODULE_DEFS[item.defId]) return MODULE_DEFS[item.defId].color;
  }
  return "#4ee2ff";
}

function sumEquippedStats(): ModuleStats {
  const p = state.player;
  const acc: Required<ModuleStats> = {
    damage: 0, fireRate: 1, critChance: 0, shieldMax: 0, shieldRegen: 0,
    hullMax: 0, speed: 0, damageReduction: 0, shieldAbsorb: 0, cargoBonus: 0, lootBonus: 0, aoeRadius: 0,
    ammoCapacity: 0,
  };
  let weaponDmg = 0, weaponFireRate = 1, weaponCrit = 0, weaponAoe = 0, weaponCount = 0;
  for (const id of p.equipped.weapon) {
    if (!id) continue;
    const item = p.inventory.find((m) => m.instanceId === id);
    const def = item ? MODULE_DEFS[item.defId] : null;
    if (!def) continue;
    weaponCount++;
    weaponDmg += def.stats.damage ?? 0;
    weaponFireRate *= def.stats.fireRate ?? 1;
    weaponCrit += def.stats.critChance ?? 0;
    weaponAoe = Math.max(weaponAoe, def.stats.aoeRadius ?? 0);
  }
  // Weapons stack damage; fire rate averaged so dual-equip doesn't 2× the rate
  acc.damage += weaponDmg;
  acc.fireRate = weaponCount > 0 ? Math.pow(weaponFireRate, 1 / weaponCount) : 1;
  acc.critChance += weaponCrit;
  acc.aoeRadius = Math.max(acc.aoeRadius, weaponAoe);

  for (const id of [...p.equipped.generator, ...p.equipped.module]) {
    if (!id) continue;
    const item = p.inventory.find((m) => m.instanceId === id);
    const def = item ? MODULE_DEFS[item.defId] : null;
    if (!def) continue;
    const s = def.stats;
    acc.damage          += s.damage ?? 0;
    if (s.fireRate)     acc.fireRate *= s.fireRate;
    acc.critChance      += s.critChance ?? 0;
    acc.shieldMax       += s.shieldMax ?? 0;
    acc.shieldRegen     += s.shieldRegen ?? 0;
    acc.hullMax         += s.hullMax ?? 0;
    acc.speed           += s.speed ?? 0;
    acc.damageReduction += s.damageReduction ?? 0;
    acc.shieldAbsorb    += s.shieldAbsorb ?? 0;
    acc.cargoBonus      += s.cargoBonus ?? 0;
    acc.lootBonus       += s.lootBonus ?? 0;
    acc.aoeRadius       = Math.max(acc.aoeRadius, s.aoeRadius ?? 0);
  }
  return acc;
}

let last = performance.now();
let raf = 0;
let enemySpawnTimer = 0;
let npcSpawnTimer = 0;
let saveTimer = 0;
let chatTimer = 6;
let aiUpdateTimer = 0;
let trailTimer = 0;
let bossActive = false;
let queuedAttackTargetId: string | null = null;

const CHAT_LINES = [
  "anyone selling void crystals?",
  "wtb plasma cells, 35cr each",
  "raider stronghold spotted near veiled outpost",
  "lfg crimson dread x2",
  "nebula portal is HOT, watch yourselves",
  "just hit lvl 10 lets gooo",
  "this thruster mk3 hits different",
  "iron belt prices are steal rn",
  "anyone in my clan online?",
  "scout swarm @ alpha sector",
  "anyone got spare scrap plating",
  "azure port buying quantum chips premium",
  "boss event spawned, headed there now",
  "syndicate just took echo anchorage lol",
];

// ── NPC SHIPS ─────────────────────────────────────────────────────────────
const NPC_NAMES = [
  "Trader Vex", "Patrol Hawk", "Cargo Runner", "Scout Nova", "Enforcer",
  "Merchant Iris", "Hauler Kain", "Sentinel Ray", "Courier Ash", "Marshal",
  "Freighter Bo", "Ranger Kel", "Supply Runner", "Warden Pax", "Navigator",
];
const NPC_COLORS = ["#4ee2ff", "#5cff8a", "#ffd24a", "#ff8a4e", "#c8a0ff", "#7ad8ff"];

function spawnNpcShip(): void {
  const zone = state.player.zone;
  const zoneStations = STATIONS.filter((s) => s.zone === zone);
  if (zoneStations.length === 0) return;
  if (state.npcShips.filter((n) => n.zone === zone).length >= 5) return;
  const start = zoneStations[Math.floor(Math.random() * zoneStations.length)];
  const dest = zoneStations.length > 1
    ? zoneStations.filter((s) => s.id !== start.id)[Math.floor(Math.random() * (zoneStations.length - 1))]
    : start;
  const name = NPC_NAMES[Math.floor(Math.random() * NPC_NAMES.length)];
  const color = NPC_COLORS[Math.floor(Math.random() * NPC_COLORS.length)];
  state.npcShips.push({
    id: `npc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name, color, size: 12,
    pos: { x: start.pos.x + (Math.random() - 0.5) * 60, y: start.pos.y + (Math.random() - 0.5) * 60 },
    vel: { x: 0, y: 0 }, angle: 0,
    hull: 200, hullMax: 200, speed: 80 + Math.random() * 40,
    damage: 8 + Math.random() * 6, fireCd: 0,
    targetPos: { x: dest.pos.x, y: dest.pos.y },
    state: "patrol", targetEnemyId: null, zone,
  });
}

function updateNpcShips(dt: number): void {
  for (let i = state.npcShips.length - 1; i >= 0; i--) {
    const npc = state.npcShips[i];
    if (npc.zone !== state.player.zone) { state.npcShips.splice(i, 1); continue; }
    npc.fireCd = Math.max(0, npc.fireCd - dt);

    // Check for nearby enemies to fight
    let nearestEnemy: Enemy | null = null;
    let nearestDist = 350;
    for (const e of state.enemies) {
      const d = Math.hypot(e.pos.x - npc.pos.x, e.pos.y - npc.pos.y);
      if (d < nearestDist) { nearestEnemy = e; nearestDist = d; }
    }

    if (nearestEnemy) {
      npc.state = "fight";
      npc.targetEnemyId = nearestEnemy.id;
      const dx = nearestEnemy.pos.x - npc.pos.x;
      const dy = nearestEnemy.pos.y - npc.pos.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      npc.angle = Math.atan2(dy, dx);
      if (dist > 120) {
        npc.vel.x = (dx / dist) * npc.speed;
        npc.vel.y = (dy / dist) * npc.speed;
      } else {
        npc.vel.x *= 0.9;
        npc.vel.y *= 0.9;
      }
      if (npc.fireCd <= 0 && dist < 300) {
        fireProjectile("player", npc.pos.x, npc.pos.y, npc.angle + (Math.random() - 0.5) * 0.1, npc.damage, npc.color, 2);
        npc.fireCd = 0.8 + Math.random() * 0.4;
      }
    } else {
      npc.state = "patrol";
      npc.targetEnemyId = null;
      const dx = npc.targetPos.x - npc.pos.x;
      const dy = npc.targetPos.y - npc.pos.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      npc.angle = Math.atan2(dy, dx);
      if (dist < 50) {
        const zoneStations = STATIONS.filter((s) => s.zone === npc.zone);
        const next = zoneStations[Math.floor(Math.random() * zoneStations.length)];
        npc.targetPos = { x: next.pos.x + (Math.random() - 0.5) * 80, y: next.pos.y + (Math.random() - 0.5) * 80 };
      }
      npc.vel.x = (dx / dist) * npc.speed * 0.6;
      npc.vel.y = (dy / dist) * npc.speed * 0.6;
    }

    npc.pos.x += npc.vel.x * dt;
    npc.pos.y += npc.vel.y * dt;

    if (npc.hull <= 0) {
      emitDeath(npc.pos.x, npc.pos.y, npc.color, false);
      state.npcShips.splice(i, 1);
    }
  }
}

// ── PLAYER STATS (with drone bonuses + skills + faction) ─────────────────
export function effectiveStats(): {
  damage: number; speed: number; hullMax: number; shieldMax: number;
  fireRate: number; critChance: number; aoeRadius: number; damageReduction: number; shieldAbsorb: number; shieldRegen: number; lootBonus: number;
} {
  const p = state.player;
  const cls = SHIP_CLASSES[p.shipClass];

  const skOffPower  = p.skills["off-power"]  ?? 0;
  const skOffRapid  = p.skills["off-rapid"]  ?? 0;
  const skOffCrit   = p.skills["off-crit"]   ?? 0;
  const skOffPierce = p.skills["off-pierce"] ?? 0;
  const skDefShield = p.skills["def-shield"] ?? 0;
  const skDefRegen  = p.skills["def-regen"]  ?? 0;
  const skDefArmor  = p.skills["def-armor"]  ?? 0;
  const skDefBulw   = p.skills["def-bulwark"] ?? 0;
  const skUtThrust  = p.skills["ut-thrust"]  ?? 0;

  const mod = sumEquippedStats() as Required<ModuleStats>;
  let damage = (cls.baseDamage + mod.damage) * (1 + skOffPower * 0.03);
  let hullMax = (cls.hullMax + (mod.hullMax ?? 0)) * (1 + skDefArmor * 0.05);
  let shieldMax = (cls.shieldMax + (mod.shieldMax ?? 0)) * (1 + skDefShield * 0.05);
  let speed = (cls.baseSpeed + (mod.speed ?? 0)) * (1 + skUtThrust * 0.03);
  let shieldRegen = 5 + (mod.shieldRegen ?? 0);
  let damageReduction = (skDefBulw * 0.03) + (mod.damageReduction ?? 0);
  let shieldAbsorb = Math.min(0.5, mod.shieldAbsorb ?? 0);
  let aoeRadius = (skOffPierce * 3) + (mod.aoeRadius ?? 0);
  let critChance = 0.03 + skOffCrit * 0.02 + (mod.critChance ?? 0);
  let fireRate = (1 + skOffRapid * 0.03) * (mod.fireRate ?? 1);
  let lootBonus = mod.lootBonus ?? 0;

  for (const d of p.drones) {
    const def = DRONE_DEFS[d.kind];
    damage += def.damageBonus;
    hullMax += def.hullBonus;
    shieldMax += def.shieldBonus;
  }

  // Faction bonuses disabled
  shieldRegen *= (1 + skDefRegen * 0.15);

  return { damage, speed, hullMax, shieldMax, fireRate, critChance, aoeRadius, damageReduction, shieldAbsorb, shieldRegen, lootBonus };
}

export function queueAttackTarget(enemyId: string): void {
  // Gate: only accept when weapon is off cooldown.
  // Prevents double-clicks, keyboard repeat, or any other repeated triggers
  // from causing more than one shot per cooldown window.
  if (playerFireCd.value > 0 && rocketFireCd.value > 0) return;
  queuedAttackTargetId = enemyId;
}

// ── SPAWN ──────────────────────────────────────────────────────────────────
function spawnEnemy(): void {
  const z = ZONES[state.player.zone];
  if (state.enemies.filter((e) => !e.isBoss).length >= 18 + z.enemyTier * 4) return;
  const type: EnemyType = z.enemyTypes[Math.floor(Math.random() * z.enemyTypes.length)];
  const def = ENEMY_DEFS[type];
  const angle = Math.random() * Math.PI * 2;
  // Spawn across the whole map, not just near player
  const nearPlayer = Math.random() < 0.4;
  let px: number, py: number;
  if (nearPlayer) {
    const dist = 500 + Math.random() * 500;
    px = state.player.pos.x + Math.cos(angle) * dist;
    py = state.player.pos.y + Math.sin(angle) * dist;
  } else {
    const mapR = MAP_RADIUS * 0.85;
    px = (Math.random() - 0.5) * 2 * mapR;
    py = (Math.random() - 0.5) * 2 * mapR;
  }
  const tierMult = 1 + (z.enemyTier - 1) * 0.5;
  const namePool = ENEMY_NAMES[type];
  const eName = namePool[Math.floor(Math.random() * namePool.length)];
  // Apply faction-specific stat/color overrides
  const fMod = FACTION_ENEMY_MODS[z.faction]?.[type];
  const hullFac  = fMod?.hullMul  ?? 1;
  const dmgFac   = fMod?.damageMul ?? 1;
  const spdFac   = fMod?.speedMul  ?? 1;
  const color    = fMod?.color     ?? def.color;
  state.enemies.push({
    id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    name: eName,
    behavior: def.behavior,
    pos: { x: px, y: py },
    vel: { x: 0, y: 0 },
    angle: 0,
    hull: def.hullMax * tierMult * hullFac,
    hullMax: def.hullMax * tierMult * hullFac,
    damage: def.damage * tierMult * dmgFac,
    speed: def.speed * spdFac,
    fireCd: Math.random() * 2,
    exp: Math.round(def.exp * tierMult),
    credits: Math.round(def.credits * tierMult),
    honor: Math.round(def.honor * tierMult),
    color,
    size: def.size,
    loot: def.loot,
    burstCd: 0,
    burstShots: 0,
    spawnPos: { x: px, y: py },
    aggro: false,
  });
}

// ── DUNGEON ───────────────────────────────────────────────────────────────
let dungeonSpawnCd = 0;

function spawnDungeonEnemy(type: EnemyType, hpMul: number, dmgMul: number): void {
  const def = ENEMY_DEFS[type];
  const angle = Math.random() * Math.PI * 2;
  const dist = 480 + Math.random() * 220;
  const px = state.player.pos.x + Math.cos(angle) * dist;
  const py = state.player.pos.y + Math.sin(angle) * dist;
  const hullMax = def.hullMax * hpMul;
  state.enemies.push({
    id: `dg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type, behavior: def.behavior,
    pos: { x: px, y: py }, vel: { x: 0, y: 0 }, angle: 0,
    name: ENEMY_NAMES[type]?.[Math.floor(Math.random() * (ENEMY_NAMES[type]?.length ?? 1))],
    hull: hullMax, hullMax,
    damage: def.damage * dmgMul,
    speed: def.speed,
    fireCd: Math.random() * 1.5,
    exp: Math.round(def.exp * 1.4),
    credits: Math.round(def.credits * 1.4),
    honor: Math.round(def.honor * 1.4),
    color: def.color, size: def.size,
    loot: def.loot, burstCd: 0, burstShots: 0,
    spawnPos: { x: px, y: py },
    aggro: true,
  });
}

function updateDungeon(dt: number): void {
  const run = state.dungeon;
  if (!run) return;
  const def = DUNGEONS[run.id];
  const aliveCount = state.enemies.length;
  // Spawn the wave's enemies (staggered)
  if (!run.spawnedThisWave) {
    dungeonSpawnCd -= dt;
    if (dungeonSpawnCd <= 0) {
      const spawned = aliveCount;
      const target = def.enemiesPerWave;
      if (spawned < target) {
        const t: EnemyType = def.enemyTypes[Math.floor(Math.random() * def.enemyTypes.length)];
        spawnDungeonEnemy(t, def.enemyHpMul, def.enemyDmgMul);
        dungeonSpawnCd = 0.45;
      } else {
        run.spawnedThisWave = true;
      }
    }
  } else if (aliveCount === 0) {
    // Wave clear
    if (run.wave >= run.totalWaves) {
      pushEvent({ title: "✦ ALL WAVES CLEAR", body: `${def.name} subdued.`, ttl: 4, kind: "global", color: def.color });
      completeDungeon();
      return;
    }
    run.wave++;
    run.spawnedThisWave = false;
    run.enemiesLeft = def.enemiesPerWave;
    dungeonSpawnCd = 1.2;
    pushEvent({ title: `▼ WAVE ${run.wave} / ${run.totalWaves}`, body: `Hostiles re-engaging.`, ttl: 3.5, kind: "info", color: def.color });
    sfx.bossWarn();
  }
}

function spawnBoss(): void {
  const z = ZONES[state.player.zone];
  const tierMult = 1 + (z.enemyTier - 1) * 0.5;
  const angle = Math.random() * Math.PI * 2;
  const dist = 600;
  const px = state.player.pos.x + Math.cos(angle) * dist;
  const py = state.player.pos.y + Math.sin(angle) * dist;
  const def = ENEMY_DEFS.dread;
  const hullMax = def.hullMax * 4 * tierMult;
  state.enemies.push({
    id: `boss-${Date.now()}`,
    type: "dread",
    behavior: "tank",
    pos: { x: px, y: py },
    vel: { x: 0, y: 0 },
    angle: 0,
    hull: hullMax,
    hullMax,
    damage: def.damage * 1.5 * tierMult,
    speed: 38,
    fireCd: 1,
    exp: Math.round(def.exp * 5 * tierMult),
    credits: Math.round(def.credits * 5 * tierMult),
    honor: Math.round(def.honor * 4 * tierMult),
    color: "#ff8a4e",
    size: def.size * 1.6,
    loot: { resourceId: "dread", qty: 4 },
    isBoss: true,
    bossPhase: 0,
    burstCd: 0,
    burstShots: 0,
    spawnPos: { x: px, y: py },
    aggro: true,
  });
  bossActive = true;
  pushEvent({
    title: "BOSS WARSHIP ARRIVES",
    body: `A heavy dreadnought has materialized in ${z.name}. Engage with caution.`,
    ttl: 10, kind: "boss", zone: state.player.zone, color: "#ff8a4e",
  });
  pushChat("system", "SYSTEM", `A boss dreadnought has spawned in ${z.name}.`);
  pushNotification("BOSS SPAWNED — Engage!", "bad");
  sfx.bossWarn();
  state.cameraShake = Math.max(state.cameraShake, 0.6);
}

// ── PARTICLES & FX ────────────────────────────────────────────────────────
function emitSpark(x: number, y: number, color: string, count = 6, speed = 90, size = 2): void {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = (0.4 + Math.random() * 0.6) * speed;
    state.particles.push({
      id: `p-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x, y },
      vel: { x: Math.cos(a) * s, y: Math.sin(a) * s },
      ttl: 0.3 + Math.random() * 0.4,
      maxTtl: 0.6,
      color, size, kind: "spark",
    });
  }
}

function emitRing(x: number, y: number, color: string, radius = 20): void {
  state.particles.push({
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x, y }, vel: { x: 0, y: 0 },
    ttl: 0.45, maxTtl: 0.45,
    color, size: radius, kind: "ring",
  });
}

function emitTrail(x: number, y: number, color: string): void {
  state.particles.push({
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x, y }, vel: { x: 0, y: 0 },
    ttl: 2.0, maxTtl: 2.0,
    color, size: 5, kind: "trail",
  });
}

function emitDeath(x: number, y: number, color: string, big = false): void {
  const B = big;

  // Central white flash bloom — massive
  state.particles.push({
    id: `fl-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x, y }, vel: { x: 0, y: 0 },
    ttl: B ? 0.6 : 0.4, maxTtl: B ? 0.6 : 0.4,
    color: "#ffffff",
    size: B ? 300 : 180, kind: "flash",
  });
  state.particles.push({
    id: `fl2-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x, y }, vel: { x: 0, y: 0 },
    ttl: B ? 0.5 : 0.32, maxTtl: B ? 0.5 : 0.32,
    color, size: B ? 220 : 130, kind: "flash",
  });
  state.particles.push({
    id: `fl3-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x, y }, vel: { x: 0, y: 0 },
    ttl: B ? 0.35 : 0.24, maxTtl: B ? 0.35 : 0.24,
    color: "#ffd24a", size: B ? 180 : 100, kind: "flash",
  });
  // Delayed secondary flash
  setTimeout(() => {
    state.particles.push({
      id: `fl4-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x, y }, vel: { x: 0, y: 0 },
      ttl: 0.2, maxTtl: 0.2,
      color: "#ff8c00", size: B ? 150 : 80, kind: "flash",
    });
  }, 120);

  // Expanding shockwave rings — huge and staggered
  const ringR = B ? 220 : 130;
  for (let i = 0; i < (B ? 6 : 4); i++) {
    const ringColor = i === 0 ? "#ffffff" : i === 1 ? color : i === 2 ? "#ffd24a" : "#ff8c00";
    const rSize = ringR * (1 - i * 0.12);
    setTimeout(() => emitRing(x, y, ringColor, rSize), i * 70);
  }

  // Fireballs — large fire blobs that fly outward
  const fbColors = ["#ff8c00", "#ff4500", "#ffd700", "#ff6600", "#ff2244", "#ff0066", "#ffaa00", "#ff7700"];
  const fbCount = B ? 28 : 16;
  for (let i = 0; i < fbCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = (0.3 + Math.random() * 0.7) * (B ? 160 : 110);
    state.particles.push({
      id: `fb-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 20 },
      vel: { x: Math.cos(a) * spd, y: Math.sin(a) * spd },
      ttl: 0.7 + Math.random() * 0.6, maxTtl: 1.3,
      color: fbColors[Math.floor(Math.random() * fbColors.length)],
      size: B ? (100 + Math.random() * 80) : (55 + Math.random() * 40),
      kind: "fireball",
    });
  }

  // Smoke puffs — dark billowing clouds
  const smokeCount = B ? 20 : 10;
  for (let i = 0; i < smokeCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = (0.1 + Math.random() * 0.4) * (B ? 60 : 40);
    state.particles.push({
      id: `sm-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x: x + (Math.random() - 0.5) * 14, y: y + (Math.random() - 0.5) * 14 },
      vel: { x: Math.cos(a) * spd, y: Math.sin(a) * spd },
      ttl: 0.9 + Math.random() * 0.7, maxTtl: 1.6,
      color: i % 3 === 0 ? "#111" : i % 3 === 1 ? "#333" : "#555",
      size: B ? (50 + Math.random() * 45) : (28 + Math.random() * 22),
      kind: "smoke",
    });
  }

  // Large burning hull fragments — big chunks flying far in all directions
  const debrisCount = B ? 24 : 14;
  const debrisColors = [color, "#ff8a4e", "#ffd24a", "#ffccaa", "#cccccc", "#ff5c6c"];
  for (let i = 0; i < debrisCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = (0.4 + Math.random() * 0.6) * (B ? 300 : 200);
    state.particles.push({
      id: `db-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10 },
      vel: { x: Math.cos(a) * spd, y: Math.sin(a) * spd },
      ttl: 1.0 + Math.random() * 1.0, maxTtl: 2.0,
      color: debrisColors[Math.floor(Math.random() * debrisColors.length)],
      size: B ? (12 + Math.random() * 18) : (8 + Math.random() * 12),
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 18,
      kind: "debris",
    });
  }

  // Sparks — five tiers, fast and bright, flying far from explosion
  emitSpark(x, y, "#ffffff", B ? 60 : 30, B ? 500 : 380, B ? 5 : 3);
  emitSpark(x, y, color, B ? 80 : 40, B ? 360 : 280, B ? 5 : 4);
  emitSpark(x, y, "#ffd24a", B ? 60 : 24, B ? 280 : 200, B ? 4 : 3);
  emitSpark(x, y, "#ff8c00", B ? 40 : 18, B ? 320 : 220, B ? 4 : 3);
  emitSpark(x, y, "#ff5cf0", B ? 24 : 10, B ? 240 : 160, B ? 3 : 2);

  // Burning embers — big glowing fire chunks flying far in all directions
  const emberCount = B ? 40 : 22;
  const emberColors = ["#ff8c00", "#ff4500", "#ffd700", "#ffaa00", "#ff6600", "#ff2244", color];
  for (let i = 0; i < emberCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = (180 + Math.random() * 350) * (B ? 1.5 : 1);
    state.particles.push({
      id: `em-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x: x + (Math.random() - 0.5) * 14, y: y + (Math.random() - 0.5) * 14 },
      vel: { x: Math.cos(a) * spd, y: Math.sin(a) * spd },
      ttl: 0.8 + Math.random() * 1.0, maxTtl: 1.8,
      color: emberColors[Math.floor(Math.random() * emberColors.length)],
      size: B ? (5 + Math.random() * 8) : (4 + Math.random() * 5), kind: "ember",
    });
  }
}

// ── PROJECTILES ───────────────────────────────────────────────────────────
function fireProjectile(
  from: "player" | "enemy" | "drone",
  x: number, y: number, angle: number, damage: number, color: string, size = 3,
  opts?: { crit?: boolean; aoeRadius?: number; speedMul?: number; homing?: boolean; empStun?: number; armorPiercing?: boolean; weaponKind?: WeaponKind; renderOnly?: boolean },
): void {
  const speedBase = from === "player" ? 280 : from === "drone" ? 260 : 220;
  const speed = speedBase * (opts?.speedMul ?? 1);
  state.projectiles.push({
    id: `pr-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x, y },
    vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    damage,
    ttl: opts?.homing ? 4.0 : 1.6,
    fromPlayer: from !== "enemy",
    color,
    size: opts?.crit ? size + 2 : size,
    crit: opts?.crit,
    aoeRadius: opts?.aoeRadius,
    homing: opts?.homing,
    empStun: opts?.empStun,
    armorPiercing: opts?.armorPiercing,
    weaponKind: opts?.weaponKind,
    renderOnly: opts?.renderOnly,
  });
}

function hasRocketWeapon(): boolean {
  const p = state.player;
  for (const id of p.equipped.weapon) {
    if (!id) continue;
    const item = p.inventory.find((m) => m.instanceId === id);
    if (item && MODULE_DEFS[item.defId]?.weaponKind === "rocket") return true;
  }
  return false;
}

// ── XP / LEVEL ────────────────────────────────────────────────────────────
function tryLevelUp(): void {
  const p = state.player;
  while (p.exp >= EXP_FOR_LEVEL(p.level)) {
    p.exp -= EXP_FOR_LEVEL(p.level);
    p.level++;
    p.skillPoints += 1;
    pushNotification(`LEVEL UP! Now level ${p.level} (+1 skill pt)`, "good");
    pushChat("system", "SYSTEM", `You reached level ${p.level}.`);
    bumpMission("level-up", 1);
    const stats = effectiveStats();
    p.hull = stats.hullMax;
    p.shield = stats.shieldMax;
    state.levelUpFlash = 1.6;
    state.cameraShake = Math.max(state.cameraShake, 0.5);
    sfx.levelUp();
    // burst ring at player
    for (let i = 0; i < 3; i++) {
      setTimeout(() => emitRing(p.pos.x, p.pos.y, "#ffd24a"), i * 100);
    }
  }
}

const MILESTONE_KEYS = ["totalKills", "totalMined", "totalCreditsEarned", "totalWarps", "bossKills"] as const;
const MILESTONE_TIER_THRESHOLDS: Record<typeof MILESTONE_KEYS[number], number[]> = {
  totalKills: [10, 50, 200, 1000, 5000],
  totalMined: [10, 100, 500, 2500, 10000],
  totalCreditsEarned: [1000, 10000, 100000, 1000000, 10000000],
  totalWarps: [5, 25, 100, 500, 2000],
  bossKills: [1, 5, 20, 50, 200],
};
const MILESTONE_REWARDS: Record<typeof MILESTONE_KEYS[number], number> = {
  totalKills: 500, totalMined: 400, totalCreditsEarned: 600, totalWarps: 300, bossKills: 1500,
};

function checkMilestoneTier(kind: typeof MILESTONE_KEYS[number], previous: number, current: number): void {
  const tiers = MILESTONE_TIER_THRESHOLDS[kind];
  for (const t of tiers) {
    if (previous < t && current >= t) {
      const reward = MILESTONE_REWARDS[kind] * (tiers.indexOf(t) + 1);
      state.player.credits += reward;
      state.player.skillPoints += 1;
      pushNotification(`MILESTONE: ${kind} ${t.toLocaleString()} (+${reward}cr +1pt)`, "good");
      pushChat("system", "SYSTEM", `Milestone reached: ${kind} ${t.toLocaleString()}.`);
    }
  }
}

function applyKill(e: Enemy, killerCrit: boolean): void {
  const stats = effectiveStats();
  emitDeath(e.pos.x, e.pos.y, e.color, !!e.isBoss);
  if (e.isBoss) {
    sfx.bossKill();
    // Boss always shakes hard (~0.6 s at decay 1.6/s), regardless of distance
    state.cameraShake = Math.max(state.cameraShake, 1);
  } else {
    sfx.explosion(e.size > 16);
    const dist = Math.hypot(e.pos.x - state.player.pos.x, e.pos.y - state.player.pos.y);
    const proximity = Math.max(0, 1 - dist / 800);
    const baseShake = e.size > 16 ? 0.75 : 0.5;
    state.cameraShake = Math.max(state.cameraShake, baseShake * proximity);
  }

  const expGain = e.exp;
  const credGain = e.credits + (state.player.skills["ut-salvage"] ?? 0) * Math.max(1, Math.floor(e.honor));
  const honorGain = e.honor;

  // Grant exp, credits, honor directly on kill
  const p2 = state.player;
  p2.exp += expGain;
  p2.credits += credGain;
  p2.honor += honorGain;
  while (p2.exp >= EXP_FOR_LEVEL(p2.level)) {
    p2.exp -= EXP_FOR_LEVEL(p2.level);
    p2.level++;
    state.levelUpFlash = 1.6;
  }
  pushFloater({ text: `+${expGain} XP`, color: "#ff5cf0", x: e.pos.x, y: e.pos.y - 20, scale: 0.9, bold: false });
  pushFloater({ text: `+${credGain} CR`, color: "#ffd24a", x: e.pos.x + 20, y: e.pos.y - 8, scale: 0.9, bold: false });
  if (honorGain > 0) pushFloater({ text: `+${honorGain} ✪`, color: "#c8a0ff", x: e.pos.x - 20, y: e.pos.y - 8, scale: 0.8, bold: false });

  // Loot box only contains resources (no exp/credits/honor)
  const hasSalvage = state.player.drones.some((d) => d.kind === "salvage");
  const lootQty = e.loot ? e.loot.qty + (hasSalvage ? 1 : 0) + stats.lootBonus : 0;

  if (lootQty > 0) {
    const box: CargoBox = {
      id: `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      pos: { x: e.pos.x + (Math.random() - 0.5) * 30, y: e.pos.y + (Math.random() - 0.5) * 30 },
      resourceId: e.loot?.resourceId ?? "scrap",
      qty: lootQty,
      credits: 0,
      exp: 0,
      honor: 0,
      ttl: 30,
      color: e.isBoss ? "#ffd24a" : "#5cff8a",
    };
    state.cargoBoxes.push(box);
    pushFloater({ text: "LOOT ▼", color: box.color, x: e.pos.x, y: e.pos.y - 12, scale: 1, bold: true });
  }

  // Ammo drop (x1 basic ammo)
  const ammoDrop = 1 + Math.floor(Math.random() * 3);
  p2.ammo.x1 = (p2.ammo.x1 ?? 0) + ammoDrop;
  pushFloater({ text: `+${ammoDrop} x1 ammo`, color: "#aabbcc", x: e.pos.x + 30, y: e.pos.y - 20, scale: 0.7, bold: false });

  // Quest progress
  for (const q of state.player.activeQuests) {
    if (!q.completed && q.killType === e.type && q.zone === state.player.zone) {
      q.progress++;
      if (q.progress >= q.killCount) {
        q.completed = true;
        pushNotification(`Quest complete: ${q.title}`, "good");
        pushChat("system", "SYSTEM", `Quest "${q.title}" ready to turn in.`);
      }
    }
  }

  // Milestones
  const m = state.player.milestones;
  const prevKills = m.totalKills;
  m.totalKills++;
  checkMilestoneTier("totalKills", prevKills, m.totalKills);
  if (e.isBoss) {
    const prevBoss = m.bossKills;
    m.bossKills++;
    checkMilestoneTier("bossKills", prevBoss, m.bossKills);
    bossActive = false;
    pushEvent({
      title: "BOSS DEFEATED",
      body: `Excellent shooting, Captain. Premium loot dropped.`,
      ttl: 6, kind: "boss", color: "#5cff8a",
    });
  }

  // Mission progress
  bumpMission("kill-any", 1);
  bumpMission("kill-zone", 1, state.player.zone);
  bumpMission("earn-credits", credGain);

  if (killerCrit) {
    pushFloater({ text: "CRIT!", color: "#ffee00", x: e.pos.x, y: e.pos.y - 28, scale: 1.6, bold: true, ttl: 1.0 });
    emitSpark(e.pos.x, e.pos.y, "#ffee00", 8, 140, 3);
    emitSpark(e.pos.x, e.pos.y, "#ffffff", 4, 100, 2);
  }

  tryLevelUp();
}

function damagePlayer(amount: number): void {
  const p = state.player;
  const stats = effectiveStats();
  state.lastHitTick = state.tick;
  amount *= Math.max(0.2, 1 - stats.damageReduction);

  // Shield absorbs a percentage of damage (base 50%, generators increase up to 80%)
  const absorbPct = Math.min(0.95, 0.5 + stats.shieldAbsorb);
  if (p.shield > 0) {
    const shieldDmg = Math.min(p.shield, amount * absorbPct);
    p.shield -= shieldDmg;
    const hullBleed = amount - shieldDmg;
    amount = hullBleed;
    emitRing(p.pos.x, p.pos.y, "#4ee2ff");
    sfx.shieldHit();
  }
  if (amount > 0) {
    p.hull -= amount;
    emitSpark(p.pos.x, p.pos.y, "#ff5c6c", 6, 70, 2);
    sfx.hit();
    state.cameraShake = Math.max(state.cameraShake, 0.15);
    if (p.hull <= 0 && state.playerRespawnTimer <= 0) {
      const deathX = p.pos.x;
      const deathY = p.pos.y;
      const shipColor = SHIP_CLASSES[p.shipClass].color;
      emitDeath(deathX, deathY, shipColor, true);
      state.playerDeathFlash = 0.6;
      state.playerRespawnTimer = 0.5;
      p.hull = 1;
      p.vel = { x: 0, y: 0 };
      state.player.milestones.totalDeaths++;
      sfx.thrusterStop();
      sfx.explosion(true);
      state.cameraShake = 1;
    }
  }
}

function damageDrone(d: { id: string; hp: number; hpMax: number }, amount: number): boolean {
  d.hp -= amount;
  if (d.hp <= 0) return true;
  return false;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────
export function startLoop(): void {
  if (raf) return;
  ensureAmmoInitialized();
  last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!state.paused && !state.dockedAt) tickWorld(dt);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

export function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

const playerFireCd = { value: 0 };
const rocketFireCd = { value: 0 };

function tickWorld(dt: number): void {
  state.tick += dt;
  if (state.levelUpFlash > 0) state.levelUpFlash = Math.max(0, state.levelUpFlash - dt);
  if (state.playerDeathFlash > 0) state.playerDeathFlash = Math.max(0, state.playerDeathFlash - dt);
  if (state.cameraShake > 0) state.cameraShake = Math.max(0, state.cameraShake - dt * 1.6);
  if (state.combatLaserFlash) {
    state.combatLaserFlash.ttl -= dt;
    if (state.combatLaserFlash.ttl <= 0) state.combatLaserFlash = null;
  }

  if (serverAuthoritative) applyServerSmoothing(dt);

  // ── Respawn timer: fire actual respawn logic after explosion delay ────
  if (state.playerRespawnTimer > 0) {
    state.playerRespawnTimer -= dt;
    if (state.playerRespawnTimer <= 0) {
      state.playerRespawnTimer = 0;
      const p2 = state.player;
      const stats2 = effectiveStats();
      p2.hull = stats2.hullMax;
      p2.shield = stats2.shieldMax;
      const lostCr = Math.floor(p2.credits * 0.1);
      p2.credits = Math.max(0, p2.credits - lostCr);
      // Respawn at main station in current zone
      const homeStation = STATIONS.find((st) => st.zone === p2.zone && st.kind === "hub")
        || STATIONS.find((st) => st.zone === p2.zone)
        || STATIONS[0];
      p2.pos = { x: homeStation.pos.x, y: homeStation.pos.y + 80 };
      p2.vel = { x: 0, y: 0 };
      state.cameraTarget = { ...p2.pos };
      state.enemies = [];
      state.isAttacking = false;
      state.isLaserFiring = false;
      state.isRocketFiring = false;
      state.attackTargetId = null;
      state.selectedWorldTarget = null;
      bossActive = false;
      pushNotification(`Ship destroyed. -${lostCr}cr. Respawned at ${homeStation.name}.`, "bad");
      pushChat("system", "SYSTEM", `Your ship was destroyed. -${lostCr} credits. Respawned at ${homeStation.name}.`);
    }
    // Keep VFX alive during the death window so explosion particles animate
    for (const pa of state.particles) {
      pa.pos.x += pa.vel.x * dt; pa.pos.y += pa.vel.y * dt;
      pa.vel.x *= 0.95; pa.vel.y *= 0.95;
      if (pa.rotVel !== undefined && pa.rot !== undefined) pa.rot += pa.rotVel * dt;
      pa.ttl -= dt;
    }
    state.particles = state.particles.filter((pa) => pa.ttl > 0);
    for (const f of state.floaters) { f.pos.y += f.vy * dt; f.vy *= 0.96; f.ttl -= dt; }
    state.floaters = state.floaters.filter((f) => f.ttl > 0);
    for (const ev of state.events) ev.ttl -= dt;
    state.events = state.events.filter((ev) => ev.ttl > 0);
    return; // skip combat/movement/AI while awaiting respawn
  }
  tickHotbarCooldowns(dt);
  const p = state.player;
  const stats = effectiveStats();
  const outOfCombatFor = state.tick - state.lastHitTick;

  // ── Consumable: Repair Bot HoT (paused while in combat)
  if (state.repairBotUntil > 0 && state.tick < state.repairBotUntil && outOfCombatFor >= 5) {
    p.hull = Math.min(p.hull + (40 / 8) * dt, stats.hullMax);
  }

  // ── Consumable: Pending Rocket Salvo
  if (state.pendingRocketSalvo > 0) {
    const nearest = state.enemies.reduce<{ dist: number; e: Enemy | null }>(
      (acc, e) => { const dx = e.pos.x - p.pos.x, dy = e.pos.y - p.pos.y; const d = Math.sqrt(dx*dx+dy*dy); return d < acc.dist ? { dist: d, e } : acc; },
      { dist: 2000, e: null }
    );
    const targetAng = nearest.e ? Math.atan2(nearest.e.pos.y - p.pos.y, nearest.e.pos.x - p.pos.x) : p.angle;
    const spread = (state.pendingRocketSalvo - 1) * 0.22;
    const startAng = targetAng - spread;
    fireProjectile("player", p.pos.x, p.pos.y, startAng + (3 - state.pendingRocketSalvo) * 0.22, 35, "#ff8a4e", 4, { homing: true, speedMul: 0.35 });
    state.pendingRocketSalvo--;
  }

  // ── Consumable: Drone Pod — spawn temp drone
  if (state.pendingDronePod) {
    state.pendingDronePod = false;
    const tempDrone: import("./types").Drone = {
      id: `temp-drone-${Date.now()}`,
      kind: "combat-i",
      mode: "forward",
      hp: 200, hpMax: 200,
      orbitPhase: Math.random() * Math.PI * 2,
      fireCd: 0,
    };
    p.drones.push(tempDrone);
    // Mark for removal after 30s using a simple check via TTL on id
    setTimeout(() => {
      const idx = p.drones.findIndex(d => d.id === tempDrone.id);
      if (idx !== -1) { p.drones.splice(idx, 1); bump(); }
    }, 30000);
  }

  // ── Player movement
  if (!serverAuthoritative) {
    const dx = state.cameraTarget.x - p.pos.x;
    const dy = state.cameraTarget.y - p.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 6) {
      p.angle = Math.atan2(dy, dx);
      const accel = stats.speed * 4;
      p.vel.x += Math.cos(p.angle) * accel * dt;
      p.vel.y += Math.sin(p.angle) * accel * dt;
    }
    const v = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y);
    const speedCap = state.afterburnUntil > state.tick ? stats.speed * 3 : stats.speed;
    if (v > speedCap) {
      p.vel.x = (p.vel.x / v) * speedCap;
      p.vel.y = (p.vel.y / v) * speedCap;
    }
    p.vel.x *= 0.96;
    p.vel.y *= 0.96;
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
  } else {
    // Server owns position; extrapolate linearly with server velocity between delta snaps
    // No friction here - server velocity is post-friction and represents the right speed
    // Applying friction client-side causes undershoot then snap-forward on each delta
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    if (Math.abs(p.vel.x) > 1 || Math.abs(p.vel.y) > 1) {
      p.angle = Math.atan2(p.vel.y, p.vel.x);
    }
  }
  // Face attack target when fighting (DarkOrbit style)
  if ((state.isLaserFiring || state.isRocketFiring) && state.attackTargetId) {
    const atk = state.enemies.find(e => e.id === state.attackTargetId);
    if (atk) {
      p.angle = Math.atan2(atk.pos.y - p.pos.y, atk.pos.x - p.pos.x);
    }
  }

  // ── Engine particles + 16-bit trail + thruster sound
  const cls = SHIP_CLASSES[p.shipClass];
  const shipSpeed = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y);
  if (shipSpeed > 30) {
    sfx.thrusterStart();
    sfx.thrusterUpdate(Math.min(1, shipSpeed / stats.speed));
    trailTimer -= dt;
    if (trailTimer <= 0) {
      const back = p.angle + Math.PI;
      emitTrail(p.pos.x + Math.cos(back) * 8, p.pos.y + Math.sin(back) * 8, "#4ee2ff");
      trailTimer = 0.08;
    }
  } else {
    sfx.thrusterUpdate(0);
  }

  // ── Shield regen (only after 5s out of combat)
  if (!serverAuthoritative && outOfCombatFor >= 5 && p.shield < stats.shieldMax) {
    p.shield = Math.min(stats.shieldMax, p.shield + stats.shieldRegen * dt);
  }

  // ── Enemies spawn (server handles spawning when connected, local fallback otherwise)
  if (state.dungeon) {
    updateDungeon(dt);
  } else if (!serverEnemiesReceived) {
    enemySpawnTimer -= dt;
    if (enemySpawnTimer <= 0) {
      spawnEnemy();
      enemySpawnTimer = 0.8 + Math.random() * 1.0;
    }
  }

  // ── Boss event timer (only when no boss currently active and not in dungeon, local fallback)
  if (!serverEnemiesReceived && !bossActive && !state.dungeon) {
    state.bossSpawnTimer -= dt;
    if (state.bossSpawnTimer < 30 && state.bossSpawnTimer > 28) {
      const z = ZONES[state.player.zone];
      pushEvent({
        title: "INCOMING DREAD",
        body: `Sensors detect a heavy warship inbound to ${z.name} in 30s.`,
        ttl: 6, kind: "global", color: "#ff8a4e",
      });
    }
    if (state.bossSpawnTimer <= 0) {
      spawnBoss();
      state.bossSpawnTimer = 300 + Math.random() * 120;
    }
  }

  // ── NPC ships spawn and update (server handles spawning when connected)
  if (!state.dungeon) {
    if (!serverEnemiesReceived) {
      npcSpawnTimer -= dt;
      if (npcSpawnTimer <= 0) {
        spawnNpcShip();
        npcSpawnTimer = 8 + Math.random() * 12;
      }
    }
    if (!serverAuthoritative) {
      updateNpcShips(dt);
    }
  }

  // ── Update enemies (patrol near spawn, aggro when attacked or NPC nearby)
  const LEASH_RANGE = 800;
  const MIN_DIST = 60;
  for (const e of state.enemies) {
    if (e.hitFlash !== undefined && e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    if (e.combo) {
      e.combo.ttl -= dt;
      if (e.combo.ttl <= 0) e.combo = undefined;
    }
    if (serverAuthoritative) {
      // Server owns enemy positions; just interpolate with velocity
      e.pos.x += e.vel.x * dt;
      e.pos.y += e.vel.y * dt;
      if (Math.abs(e.vel.x) > 1 || Math.abs(e.vel.y) > 1) {
        e.angle = Math.atan2(e.vel.y, e.vel.x);
      }
      continue;
    }
    const exd = p.pos.x - e.pos.x;
    const eyd = p.pos.y - e.pos.y;
    let ed = Math.sqrt(exd * exd + eyd * eyd);
    e.angle = Math.atan2(eyd, exd);
    // EMP stun: skip AI while stunned
    if (e.stunUntil !== undefined && e.stunUntil > state.tick) {
      e.vel.x *= 0.85; e.vel.y *= 0.85;
      e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt;
      continue;
    }

    // Check for nearby NPC ships — enemies aggro and target them
    let npcTarget: NpcShip | null = null;
    let npcDist = 400;
    for (const npc of state.npcShips) {
      const nd = Math.hypot(npc.pos.x - e.pos.x, npc.pos.y - e.pos.y);
      if (nd < npcDist) { npcTarget = npc; npcDist = nd; }
    }
    if (npcTarget && npcDist < ed) {
      e.aggro = true;
      e.angle = Math.atan2(npcTarget.pos.y - e.pos.y, npcTarget.pos.x - e.pos.x);
      ed = npcDist;
    }

    // Aggro: enters aggro when hit or NPC nearby, drops aggro when too far from spawn
    const distFromSpawn = Math.sqrt(
      (e.pos.x - e.spawnPos.x) ** 2 + (e.pos.y - e.spawnPos.y) ** 2
    );
    if (e.aggro && distFromSpawn > LEASH_RANGE && !npcTarget) e.aggro = false;
    if (e.isBoss) e.aggro = ed < 800;

    if (!e.aggro) {
      // PATROL: drift slowly near spawn position
      const toSpawnX = e.spawnPos.x - e.pos.x;
      const toSpawnY = e.spawnPos.y - e.pos.y;
      const toSpawnD = Math.sqrt(toSpawnX * toSpawnX + toSpawnY * toSpawnY);
      const patrolSpeed = e.speed * 0.25;
      if (toSpawnD > 120) {
        const ang = Math.atan2(toSpawnY, toSpawnX);
        e.vel.x = Math.cos(ang) * patrolSpeed;
        e.vel.y = Math.sin(ang) * patrolSpeed;
        e.angle = ang;
      } else {
        const wobble = Math.sin(state.tick * 0.8 + e.pos.x * 0.01) * Math.PI;
        e.vel.x = Math.cos(wobble) * patrolSpeed * 0.5;
        e.vel.y = Math.sin(wobble) * patrolSpeed * 0.5;
        e.angle = wobble;
      }
    } else if (ed < MIN_DIST) {
      // Too close to player — stop and hold position
      e.vel.x *= 0.8;
      e.vel.y *= 0.8;
    } else if (e.behavior === "fast") {
      const wobble = Math.sin(state.tick * 5 + (e.pos.x + e.pos.y)) * 0.6;
      const ang = e.angle + wobble;
      e.vel.x = Math.cos(ang) * e.speed;
      e.vel.y = Math.sin(ang) * e.speed;
    } else if (e.behavior === "ranged") {
      const ideal = 340;
      const speed = e.speed * (ed < ideal - 40 ? -1 : ed > ideal + 40 ? 1 : 0.2);
      e.vel.x = Math.cos(e.angle) * speed;
      e.vel.y = Math.sin(e.angle) * speed;
    } else if (e.behavior === "tank") {
      if (ed > 160) {
        e.vel.x = Math.cos(e.angle) * e.speed;
        e.vel.y = Math.sin(e.angle) * e.speed;
      } else {
        e.vel.x *= 0.85;
        e.vel.y *= 0.85;
      }
    } else {
      if (ed > 120) {
        e.vel.x = Math.cos(e.angle) * e.speed;
        e.vel.y = Math.sin(e.angle) * e.speed;
      } else {
        e.vel.x *= 0.9;
        e.vel.y *= 0.9;
      }
    }
    e.pos.x += e.vel.x * dt;
    e.pos.y += e.vel.y * dt;

    // Firing: only when aggroed
    e.fireCd -= dt;
    if (!e.aggro) continue;
    if (e.isBoss) {
      const hpPct = e.hull / e.hullMax;
      const newPhase = hpPct > 0.66 ? 0 : hpPct > 0.33 ? 1 : 2;
      if (newPhase > (e.bossPhase ?? 0)) {
        e.bossPhase = newPhase;
        state.cameraShake = Math.max(state.cameraShake, 0.5);
        emitRing(e.pos.x, e.pos.y, "#ff3b4d", 80);
        emitRing(e.pos.x, e.pos.y, "#ff8a4e", 60);
        emitSpark(e.pos.x, e.pos.y, "#ff8a4e", 20, 200, 3);
        pushNotification(newPhase === 1 ? "BOSS ENRAGED — Phase 2!" : "BOSS BERSERK — Phase 3!", "bad");
        pushChat("system", "SYSTEM", newPhase === 1 ? "The dreadnought powers up its secondary weapons!" : "The dreadnought enters berserk mode!");
        sfx.bossWarn();
      }
      const phase = e.bossPhase ?? 0;
      if (e.fireCd <= 0 && ed < 600) {
        if (phase === 0) {
          for (let i = -2; i <= 2; i++) {
            fireProjectile("enemy", e.pos.x, e.pos.y, e.angle + i * 0.1, e.damage, e.color, 4, { speedMul: 0.95 });
          }
          e.fireCd = 1.4;
        } else if (phase === 1) {
          for (let i = -3; i <= 3; i++) {
            fireProjectile("enemy", e.pos.x, e.pos.y, e.angle + i * 0.12, e.damage * 1.2, "#ff5c6c", 4, { speedMul: 1.05 });
          }
          e.fireCd = 1.0;
        } else {
          for (let i = 0; i < 12; i++) {
            const ra = (Math.PI * 2 / 12) * i + state.tick * 0.5;
            fireProjectile("enemy", e.pos.x, e.pos.y, ra, e.damage * 0.8, "#ff3b4d", 3, { speedMul: 0.7 });
          }
          for (let i = -2; i <= 2; i++) {
            fireProjectile("enemy", e.pos.x, e.pos.y, e.angle + i * 0.08, e.damage * 1.5, "#ffffff", 5, { speedMul: 1.1 });
          }
          e.fireCd = 1.2;
        }
        e.burstShots = phase >= 1 ? 5 : 3;
        e.burstCd = 0.12;
      }
      if ((e.burstShots ?? 0) > 0) {
        e.burstCd = (e.burstCd ?? 0) - dt;
        if ((e.burstCd ?? 0) <= 0) {
          fireProjectile("enemy", e.pos.x, e.pos.y, e.angle, e.damage * 0.7, e.color, 3);
          e.burstShots = (e.burstShots ?? 0) - 1;
          e.burstCd = 0.12;
        }
      }
      if (phase >= 2) { e.speed = 55; }
    } else if (e.behavior === "ranged") {
      if (e.fireCd <= 0 && ed < 480) {
        fireProjectile("enemy", e.pos.x, e.pos.y, e.angle, e.damage, e.color);
        e.fireCd = 0.6 + Math.random() * 0.4;
      }
    } else if (e.behavior === "tank") {
      if (e.fireCd <= 0 && ed < 440) {
        fireProjectile("enemy", e.pos.x, e.pos.y, e.angle - 0.04, e.damage * 0.9, e.color);
        fireProjectile("enemy", e.pos.x, e.pos.y, e.angle + 0.04, e.damage * 0.9, e.color);
        e.fireCd = 1.4 + Math.random() * 0.6;
      }
    } else if (e.behavior === "fast") {
      if (e.fireCd <= 0 && ed < 280) {
        fireProjectile("enemy", e.pos.x, e.pos.y, e.angle, e.damage, e.color, 2);
        e.fireCd = 0.5 + Math.random() * 0.4;
      }
    } else {
      if (e.fireCd <= 0 && ed < 500) {
        fireProjectile("enemy", e.pos.x, e.pos.y, e.angle, e.damage, e.color);
        e.fireCd = 1.0 + Math.random() * 0.8;
      }
    }
  }

  // ── Attack: only fire when player chooses to attack (isAttacking)
  playerFireCd.value -= dt;
  rocketFireCd.value -= dt;
  const atkTarget = state.attackTargetId
    ? state.enemies.find((e) => e.id === state.attackTargetId)
    : null;
  const FIRE_RANGE = 400;
  if ((state.isLaserFiring || state.isRocketFiring) && atkTarget) {
    const ang = Math.atan2(atkTarget.pos.y - p.pos.y, atkTarget.pos.x - p.pos.x);
    const atkDist = Math.sqrt((atkTarget.pos.x - p.pos.x) ** 2 + (atkTarget.pos.y - p.pos.y) ** 2);
    if (atkDist < FIRE_RANGE) {
      const weaponIds = p.equipped.weapon.filter(Boolean) as string[];
      const laserAmmoType = getActiveAmmoType();
      const laserTypeDef = ROCKET_AMMO_TYPE_DEFS[laserAmmoType];
      const laserDmgMul = (laserTypeDef?.damageMul ?? 1.0) * 0.4;
      const laserColor = laserTypeDef?.color ?? "#4ee2ff";
      const rocketAmmoType = getActiveRocketAmmoType();
      const rocketTypeDef = ROCKET_MISSILE_TYPE_DEFS[rocketAmmoType];
      const rocketDmgMul = (rocketTypeDef?.damageMul ?? 1.0) * 0.4;
      const rocketColor = rocketTypeDef?.color ?? "#ff8a4e";
      const laserIds: string[] = [];
      const rocketIds: string[] = [];
      for (const wid of weaponIds) {
        const wi = p.inventory.find((m) => m.instanceId === wid);
        const wd = wi ? MODULE_DEFS[wi.defId] : null;
        if (wd?.weaponKind === "rocket") rocketIds.push(wid);
        else laserIds.push(wid);
      }
      const perpAng = ang + Math.PI / 2;

      // Fire lasers on laser cooldown (uses laser ammo) - only when laser firing is active
      const laserAmmo = p.ammo[laserAmmoType] ?? 0;
      if (state.isLaserFiring && playerFireCd.value <= 0 && laserIds.length > 0 && laserAmmo >= 1) {
        p.ammo[laserAmmoType] = laserAmmo - 1;
        const laserDmg = stats.damage * laserDmgMul;
        const perShot = Math.round(laserDmg / 2);
        for (let si = 0; si < 2; si++) {
          const side = si === 0 ? -1 : 1;
          const ox = p.pos.x + Math.cos(perpAng) * 14 * side;
          const oy = p.pos.y + Math.sin(perpAng) * 14 * side;
          fireProjectile("player", ox, oy, ang - side * 0.03, perShot, laserColor, 4, {
            weaponKind: "laser",
          });
          // Muzzle flash at gun port — large and visible when zoomed out
          state.particles.push({
            id: `mf-${Math.random().toString(36).slice(2, 8)}`,
            pos: { x: ox, y: oy }, vel: { x: 0, y: 0 },
            ttl: 0.18, maxTtl: 0.18,
            color: laserColor, size: 70, kind: "flash",
          });
          state.particles.push({
            id: `mf2-${Math.random().toString(36).slice(2, 8)}`,
            pos: { x: ox, y: oy }, vel: { x: 0, y: 0 },
            ttl: 0.1, maxTtl: 0.1,
            color: "#ffffff", size: 45, kind: "flash",
          });
          emitSpark(ox, oy, laserColor, 6, 120, 3);
          emitSpark(ox, oy, "#ffffff", 3, 70, 2);
        }
        sfx.laserShoot();
        atkTarget.aggro = true;
        const cd = Math.max(0.2, 0.85 / stats.fireRate);
        playerFireCd.value = cd;
        state.attackCooldownUntil = state.tick + cd;
        state.attackCooldownDuration = cd;
        // Server handles damage via input state (isLaserFiring + attackTargetId)
      }

      // Fire rockets on separate slower cooldown (uses rocket ammo, higher damage) - only when rocket firing is active
      const rocketAmmo = p.rocketAmmo[rocketAmmoType] ?? 0;
      if (state.isRocketFiring && rocketFireCd.value <= 0 && rocketIds.length > 0 && rocketAmmo >= 1) {
        p.rocketAmmo[rocketAmmoType] = rocketAmmo - 1;
        for (const rId of rocketIds) {
          const ri = p.inventory.find((m) => m.instanceId === rId);
          const rd = ri ? MODULE_DEFS[ri.defId] : null;
          const rocketBaseDmg = stats.damage * rocketDmgMul * 2.5;
          const rDmg = Math.round(rocketBaseDmg);
          fireProjectile("player", p.pos.x, p.pos.y, ang, rDmg, rocketColor, 5, {
            weaponKind: "rocket",
            homing: true,
            speedMul: 0.55,
          });
        }
        // Muzzle flash + smoke burst at ship (radial, not directional)
        state.particles.push({
          id: `rl-${Math.random().toString(36).slice(2, 8)}`,
          pos: { x: p.pos.x, y: p.pos.y }, vel: { x: 0, y: 0 },
          ttl: 0.2, maxTtl: 0.2,
          color: "#ff8a4e", size: 65, kind: "flash",
        });
        state.particles.push({
          id: `rl2-${Math.random().toString(36).slice(2, 8)}`,
          pos: { x: p.pos.x, y: p.pos.y }, vel: { x: 0, y: 0 },
          ttl: 0.1, maxTtl: 0.1,
          color: "#ffffff", size: 35, kind: "flash",
        });
        // Radial smoke puffs around ship
        for (let si = 0; si < 6; si++) {
          const sa = Math.random() * Math.PI * 2;
          const ss = 25 + Math.random() * 40;
          state.particles.push({
            id: `rls-${Math.random().toString(36).slice(2, 8)}`,
            pos: { x: p.pos.x, y: p.pos.y },
            vel: { x: Math.cos(sa) * ss, y: Math.sin(sa) * ss },
            ttl: 0.5 + Math.random() * 0.3, maxTtl: 0.8,
            color: "#888888", size: 4 + Math.random() * 3, kind: "smoke",
          });
        }
        emitSpark(p.pos.x, p.pos.y, "#ffd24a", 4, 80, 2);
        sfx.rocketShoot();
        atkTarget.aggro = true;
        // Server handles damage via input state (isRocketFiring + attackTargetId)
        const avgRocketRate = rocketIds.reduce((sum, rid) => {
          const ri = p.inventory.find((m) => m.instanceId === rid);
          const rd = ri ? MODULE_DEFS[ri.defId] : null;
          return sum + (rd?.stats.fireRate ?? 0.5);
        }, 0) / rocketIds.length;
        const rCd = 1.5 / avgRocketRate;
        rocketFireCd.value = rCd;
      }
    }
  }
  // Clear target lock only when enemy dies
  if (state.attackTargetId && !atkTarget) {
    state.attackTargetId = null;
    state.selectedWorldTarget = null;
    state.isAttacking = false;
    state.isLaserFiring = false;
    state.isRocketFiring = false;
    bump();
  }

  // ── Mining: beam damages asteroid continuously (no projectiles)
  if (!state.miningTargetId || state.attackTargetId) sfx.miningLaserStop();
  if (state.miningTargetId && !state.attackTargetId) {
    const mAst = state.asteroids.find((a) => a.id === state.miningTargetId && a.zone === p.zone);
    if (mAst) {
      const mDist = distance(p.pos.x, p.pos.y, mAst.pos.x, mAst.pos.y);
      if (mDist < 450) {
        const miningDps = stats.damage * 0.25;
        // Server handles mining via input state (miningTargetId)
        if (!serverEnemiesReceived) {
          mAst.hp -= miningDps * dt;
        }
        sfx.miningLaserStart();
        if (Math.random() < dt * 4) {
          const rx = mAst.pos.x + (Math.random() - 0.5) * mAst.size;
          const ry = mAst.pos.y + (Math.random() - 0.5) * mAst.size;
          emitSpark(rx, ry, "#c69060", 2, 40, 1);
          const da = Math.random() * Math.PI * 2;
          const dspd = 30 + Math.random() * 60;
          state.particles.push({
            id: `rd-${Math.random().toString(36).slice(2, 8)}`,
            pos: { x: rx, y: ry },
            vel: { x: Math.cos(da) * dspd, y: Math.sin(da) * dspd },
            ttl: 0.5 + Math.random() * 0.6, maxTtl: 1.1,
            color: Math.random() > 0.5 ? "#c0a070" : "#8a7050",
            size: 2 + Math.random() * 3,
            rot: Math.random() * Math.PI * 2,
            rotVel: (Math.random() - 0.5) * 12,
            kind: "debris",
          });
        }
        if (!serverEnemiesReceived && mAst.hp <= 0) { state.miningTargetId = null; sfx.miningLaserStop(); destroyAsteroid(mAst.id); }
      } else {
        state.miningTargetId = null;
        sfx.miningLaserStop();
      }
    } else {
      state.miningTargetId = null;
      sfx.miningLaserStop();
    }
  }

  // ── Update drones (formation behind player)
  const droneCount = p.drones.length;
  let nearest: Enemy | null = null;
  let nearestD = 400;
  for (const e of state.enemies) {
    const d = distance(p.pos.x, p.pos.y, e.pos.x, e.pos.y);
    const adj = d * (e.isBoss ? 0.6 : 1);
    if (adj < nearestD) { nearest = e; nearestD = adj; }
  }
  for (let i = 0; i < droneCount; i++) {
    const d = p.drones[i];
    const def = DRONE_DEFS[d.kind];
    d.orbitPhase += dt * 1.5;

    // Formation: line up behind the player ship
    const behindAngle = p.angle + Math.PI;
    const cols = Math.min(4, droneCount);
    const row = Math.floor(i / cols);
    const col = i % cols;
    const spacing = 38;
    const rowOffset = (row + 1) * spacing;
    const colOffset = (col - (Math.min(cols, droneCount - row * cols) - 1) / 2) * spacing;
    const perpAngle = behindAngle + Math.PI / 2;
    const anchorX = p.pos.x + Math.cos(behindAngle) * rowOffset + Math.cos(perpAngle) * colOffset;
    const anchorY = p.pos.y + Math.sin(behindAngle) * rowOffset + Math.sin(perpAngle) * colOffset;
    (d as Drone & { anchor?: { x: number; y: number } }).anchor = {
      x: anchorX,
      y: anchorY,
    };
    if (def.fireRate > 0) {
      d.fireCd -= dt;
      if (d.fireCd <= 0 && nearest && (state.isLaserFiring || state.isRocketFiring)) {
        const dpos = (d as Drone & { anchor: { x: number; y: number } }).anchor;
        const fireRange = d.mode === "defensive" ? 200 : 380;
        if (distance(dpos.x, dpos.y, nearest.pos.x, nearest.pos.y) < fireRange) {
          const dang = Math.atan2(nearest.pos.y - dpos.y, nearest.pos.x - dpos.x);
          fireProjectile("drone", dpos.x, dpos.y, dang, def.damageBonus, def.color, 2);
          d.fireCd = 1 / def.fireRate;
        }
      }
    }
  }

  // ── Projectiles update + collisions
  state.projectiles = state.projectiles.filter((pr) => {
    // Homing steering (rockets)
    if (pr.homing && pr.fromPlayer && state.enemies.length > 0) {
      let target: Enemy | null = null;
      let bestD = 9999;
      for (const e of state.enemies) {
        const d = distance(pr.pos.x, pr.pos.y, e.pos.x, e.pos.y);
        if (d < bestD) { bestD = d; target = e; }
      }
      if (target) {
        const desiredAng = Math.atan2(target.pos.y - pr.pos.y, target.pos.x - pr.pos.x);
        const curAng = Math.atan2(pr.vel.y, pr.vel.x);
        let diff = desiredAng - curAng;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turnRate = 3.5 * dt;
        const newAng = curAng + Math.sign(diff) * Math.min(Math.abs(diff), turnRate);
        const spd = Math.sqrt(pr.vel.x * pr.vel.x + pr.vel.y * pr.vel.y);
        pr.vel.x = Math.cos(newAng) * spd;
        pr.vel.y = Math.sin(newAng) * spd;
      }
    }
    pr.pos.x += pr.vel.x * dt;
    pr.pos.y += pr.vel.y * dt;
    pr.ttl -= dt;
    if (pr.ttl <= 0) return false;
    // ── Rocket trail: long fiery trail + bright smoke ──
    if (pr.weaponKind === "rocket" && pr.fromPlayer) {
      const isEmp = !!(pr.empStun && pr.empStun > 0);
      const velAng = Math.atan2(pr.vel.y, pr.vel.x);
      const backX = -Math.cos(velAng);
      const backY = -Math.sin(velAng);
      // Fiery core trail
      if (Math.random() < 0.9) {
        const spread = (Math.random() - 0.5) * 4;
        state.particles.push({
          id: `rt-${Math.random().toString(36).slice(2, 8)}`,
          pos: { x: pr.pos.x + backX * 6 + spread * backY, y: pr.pos.y + backY * 6 - spread * backX },
          vel: { x: backX * (20 + Math.random() * 40) + (Math.random() - 0.5) * 10, y: backY * (20 + Math.random() * 40) + (Math.random() - 0.5) * 10 },
          ttl: 0.35 + Math.random() * 0.25, maxTtl: 0.6,
          color: Math.random() > 0.5 ? "#ff8a4e" : "#ffd24a", size: 2.5 + Math.random() * 2, kind: "ember",
        });
      }
      // Smoke wisps behind rocket
      if (Math.random() < 0.6) {
        const spread = (Math.random() - 0.5) * 4;
        state.particles.push({
          id: `rs-${Math.random().toString(36).slice(2, 8)}`,
          pos: { x: pr.pos.x + backX * 10 + spread * backY, y: pr.pos.y + backY * 10 - spread * backX },
          vel: { x: backX * (8 + Math.random() * 15) + (Math.random() - 0.5) * 8, y: backY * (8 + Math.random() * 15) + (Math.random() - 0.5) * 8 },
          ttl: 0.5 + Math.random() * 0.3, maxTtl: 0.8,
          color: "#999999", size: 2.5 + Math.random() * 2.5, kind: "smoke",
        });
      }
      // EMP rockets also emit occasional electric ring pulse while in flight
      if (isEmp && Math.random() < 0.08) {
        emitRing(pr.pos.x, pr.pos.y, pr.color);
      }
    }
    if (pr.renderOnly) {
      return true;
    }
    if (pr.fromPlayer) {
      // hit enemies
      for (const e of state.enemies) {
        if (distance(pr.pos.x, pr.pos.y, e.pos.x, e.pos.y) < e.size + 4) {
          const stacks = e.combo ? Math.min(5, e.combo.stacks + 1) : 1;
          e.combo = { stacks, ttl: 3 };
          const comboMul = 1 + (stacks - 1) * 0.10;
          const dmg = pr.damage * comboMul;
          if (!serverEnemiesReceived) {
            e.hull -= dmg;
          }
          e.hitFlash = 1;
          e.aggro = true;
          sfx.enemyHit();
          emitSpark(pr.pos.x, pr.pos.y, e.color, pr.crit ? 8 : 4, pr.crit ? 180 : 120, pr.crit ? 4 : 3);
          emitSpark(pr.pos.x, pr.pos.y, "#ffffff", pr.crit ? 4 : 2, pr.crit ? 140 : 90, 2);
          emitRing(pr.pos.x, pr.pos.y, pr.color, pr.crit ? 35 : 22);
          // Hit flash
          state.particles.push({
            id: `hf-${Math.random().toString(36).slice(2, 8)}`,
            pos: { x: pr.pos.x, y: pr.pos.y }, vel: { x: 0, y: 0 },
            ttl: 0.14, maxTtl: 0.14,
            color: pr.crit ? "#ffd24a" : "#ffffff",
            size: pr.crit ? 40 : 25, kind: "flash",
          });
          // A few embers flying outward from hit point
          const emberCount = pr.crit ? 4 : 2;
          for (let ei = 0; ei < emberCount; ei++) {
            const ea = Math.random() * Math.PI * 2;
            const es = 80 + Math.random() * 120;
            const eColors = ["#ff8c00", "#ff4500", "#ffd700", e.color];
            state.particles.push({
              id: `em-${Math.random().toString(36).slice(2, 8)}`,
              pos: { x: pr.pos.x, y: pr.pos.y },
              vel: { x: Math.cos(ea) * es, y: Math.sin(ea) * es },
              ttl: 0.3 + Math.random() * 0.25, maxTtl: 0.55,
              color: eColors[Math.floor(Math.random() * eColors.length)],
              size: 2 + Math.random() * 2, kind: "ember",
            });
          }
          // Rocket explosion on impact
          if (pr.weaponKind === "rocket") {
            state.particles.push({
              id: `rf-${Math.random().toString(36).slice(2, 8)}`,
              pos: { x: pr.pos.x, y: pr.pos.y }, vel: { x: 0, y: 0 },
              ttl: 0.28, maxTtl: 0.28,
              color: "#ff8a4e", size: 80, kind: "flash",
            });
            emitRing(pr.pos.x, pr.pos.y, "#ff8a4e", 60);
            emitRing(pr.pos.x, pr.pos.y, "#ffd24a", 45);
            emitRing(pr.pos.x, pr.pos.y, "#ff5c6c", 35);
            for (let fi = 0; fi < 10; fi++) {
              const fa = Math.random() * Math.PI * 2;
              const fs = 50 + Math.random() * 120;
              state.particles.push({
                id: `rfb-${Math.random().toString(36).slice(2, 8)}`,
                pos: { x: pr.pos.x, y: pr.pos.y },
                vel: { x: Math.cos(fa) * fs, y: Math.sin(fa) * fs },
                ttl: 0.25 + Math.random() * 0.25, maxTtl: 0.5,
                color: Math.random() > 0.5 ? "#ff8a4e" : "#ffd24a", size: 5 + Math.random() * 6, kind: "fireball",
              });
            }
            for (let ei = 0; ei < 6; ei++) {
              const ea = Math.random() * Math.PI * 2;
              const es = 80 + Math.random() * 160;
              state.particles.push({
                id: `rfe-${Math.random().toString(36).slice(2, 8)}`,
                pos: { x: pr.pos.x, y: pr.pos.y },
                vel: { x: Math.cos(ea) * es, y: Math.sin(ea) * es },
                ttl: 0.4 + Math.random() * 0.3, maxTtl: 0.7,
                color: ["#ff8c00", "#ff4500", "#ffd700"][Math.floor(Math.random() * 3)],
                size: 2 + Math.random() * 3, kind: "ember",
              });
            }
            for (let si = 0; si < 6; si++) {
              const sa = Math.random() * Math.PI * 2;
              const ss = 25 + Math.random() * 50;
              state.particles.push({
                id: `rfs-${Math.random().toString(36).slice(2, 8)}`,
                pos: { x: pr.pos.x, y: pr.pos.y },
                vel: { x: Math.cos(sa) * ss, y: Math.sin(sa) * ss },
                ttl: 0.5 + Math.random() * 0.4, maxTtl: 0.9,
                color: "#999999", size: 6 + Math.random() * 6, kind: "smoke",
              });
            }
            sfx.explosion();
          }
          // Camera shake on hit
          const hitDist = Math.hypot(pr.pos.x - state.player.pos.x, pr.pos.y - state.player.pos.y);
          const hitShake = pr.weaponKind === "rocket" ? 0.25 : (pr.crit ? 0.15 : 0.08);
          state.cameraShake = Math.max(state.cameraShake, hitShake * Math.max(0, 1 - hitDist / 500));
          // damage floater
          pushFloater({
            text: pr.crit ? `${Math.round(dmg)}!` : `${Math.round(dmg)}`,
            color: pr.crit ? "#ffee00" : "#e8f0ff",
            x: e.pos.x + (Math.random() - 0.5) * 18,
            y: e.pos.y - e.size - 8,
            scale: pr.crit ? 1.5 : 0.95, ttl: pr.crit ? 1.0 : 0.7, bold: pr.crit,
          });
          if (pr.crit) {
            emitSpark(e.pos.x, e.pos.y, "#ffee00", 6, 100, 2);
          }
          if (stacks >= 3) {
            pushFloater({ text: `x${stacks}`, color: "#ff5cf0", x: e.pos.x, y: e.pos.y + e.size + 8, scale: 0.9, ttl: 0.5 });
          }
          // EMP stun: disable enemy fire/movement briefly
          if (pr.empStun && pr.empStun > 0) {
            e.stunUntil = state.tick + pr.empStun;
            pushFloater({ text: "EMP!", color: "#ffd24a", x: e.pos.x, y: e.pos.y - e.size - 14, scale: 1.1, ttl: 0.9, bold: true });
            emitRing(pr.pos.x, pr.pos.y, pr.color);
            emitRing(pr.pos.x, pr.pos.y, "#ffffff");
            setTimeout(() => emitRing(pr.pos.x, pr.pos.y, pr.color), 100);
            setTimeout(() => emitRing(pr.pos.x, pr.pos.y, pr.color), 220);
          }
          // AP floater
          if (pr.armorPiercing) {
            pushFloater({ text: "AP", color: "#ff5c6c", x: e.pos.x + 10, y: e.pos.y - e.size - 8, scale: 0.85, ttl: 0.5 });
          }
          // splash
          if (pr.aoeRadius && pr.aoeRadius > 0) {
            for (const e2 of state.enemies) {
              if (e2.id === e.id) continue;
              if (distance(e.pos.x, e.pos.y, e2.pos.x, e2.pos.y) < pr.aoeRadius * 8) {
                if (!serverEnemiesReceived) e2.hull -= dmg * 0.4;
                e2.hitFlash = 1;
              }
            }
            emitRing(pr.pos.x, pr.pos.y, "#ffaa44");
          }
          if (!serverEnemiesReceived && e.hull <= 0) applyKill(e, !!pr.crit);
          return false;
        }
      }
      // Projectiles pass through asteroids (mining is beam-only now)
    } else {
      // enemy projectile -> hit NPC ships, drones, then player
      for (const npc of state.npcShips) {
        if (distance(pr.pos.x, pr.pos.y, npc.pos.x, npc.pos.y) < npc.size + 4) {
          npc.hull -= pr.damage;
          emitSpark(pr.pos.x, pr.pos.y, npc.color, 6, 100, 2);
          emitRing(pr.pos.x, pr.pos.y, pr.color, 20);
          state.particles.push({
            id: `nhf-${Math.random().toString(36).slice(2, 8)}`,
            pos: { x: pr.pos.x, y: pr.pos.y }, vel: { x: 0, y: 0 },
            ttl: 0.12, maxTtl: 0.12,
            color: "#ffffff", size: 20, kind: "flash",
          });
          return false;
        }
      }
      for (const dr of p.drones) {
        const anchor = (dr as Drone & { anchor?: { x: number; y: number } }).anchor;
        if (!anchor) continue;
        if (distance(pr.pos.x, pr.pos.y, anchor.x, anchor.y) < 10) {
          const dead = damageDrone(dr, pr.damage);
          emitSpark(pr.pos.x, pr.pos.y, DRONE_DEFS[dr.kind].color, 5, 80, 2);
          if (dead) {
            p.drones = p.drones.filter((x) => x.id !== dr.id);
            pushNotification(`Drone destroyed: ${DRONE_DEFS[dr.kind].name}`, "bad");
            emitDeath(anchor.x, anchor.y, DRONE_DEFS[dr.kind].color);
            sfx.explosion();
          }
          return false;
        }
      }
      if (distance(pr.pos.x, pr.pos.y, p.pos.x, p.pos.y) < 12) {
        if (!serverAuthoritative) damagePlayer(pr.damage);
        return false;
      }
    }
    return true;
  });

  if (!serverEnemiesReceived) {
    state.enemies = state.enemies.filter((e) => e.hull > 0);
  }

  // ── Particles update
  for (const pa of state.particles) {
    pa.pos.x += pa.vel.x * dt;
    pa.pos.y += pa.vel.y * dt;
    const drag = (pa.kind === "ember" || pa.kind === "debris") ? 0.985 : 0.95;
    pa.vel.x *= drag;
    pa.vel.y *= drag;
    if (pa.rotVel !== undefined && pa.rot !== undefined) {
      pa.rot += pa.rotVel * dt;
    }
    pa.ttl -= dt;
  }
  state.particles = state.particles.filter((pa) => pa.ttl > 0);
  if (state.particles.length > 600) {
    state.particles.splice(0, state.particles.length - 600);
  }

  // ── Cargo box TTL + proximity pickup
  for (const cb of state.cargoBoxes) cb.ttl -= dt;
  state.cargoBoxes = state.cargoBoxes.filter((cb) => cb.ttl > 0);
  tryCollectNearbyBoxes();

  // ── Floaters update
  for (const f of state.floaters) {
    f.pos.y += f.vy * dt;
    f.vy *= 0.96;
    f.ttl -= dt;
  }
  state.floaters = state.floaters.filter((f) => f.ttl > 0);

  // ── Events ttl
  for (const ev of state.events) ev.ttl -= dt;
  state.events = state.events.filter((ev) => ev.ttl > 0);

  // ── Other players movement
  if (serverAuthoritative) {
    // Server sends positions via delta/snapshot; interpolate with velocity
    for (const o of state.others) {
      o.pos.x += o.vel.x * dt;
      o.pos.y += o.vel.y * dt;
      if (Math.abs(o.vel.x) > 1 || Math.abs(o.vel.y) > 1) {
        o.angle = Math.atan2(o.vel.y, o.vel.x);
      }
    }
  } else {
    // AI drift (singleplayer fallback)
    aiUpdateTimer -= dt;
    if (aiUpdateTimer <= 0) {
      for (const o of state.others) {
        if (Math.random() < 0.3) {
          o.vel.x = (Math.random() - 0.5) * 100;
          o.vel.y = (Math.random() - 0.5) * 100;
          o.angle = Math.atan2(o.vel.y, o.vel.x);
        }
      }
      aiUpdateTimer = 2;
    }
    for (const o of state.others) {
      o.pos.x += o.vel.x * dt;
      o.pos.y += o.vel.y * dt;
    }
  }

  // ── Auto chat chatter (singleplayer fallback only)
  if (!serverAuthoritative) {
    chatTimer -= dt;
    if (chatTimer <= 0) {
      const o = state.others[Math.floor(Math.random() * state.others.length)];
      if (o) pushChat("local", o.name, CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)]);
      chatTimer = 8 + Math.random() * 10;
    }
  }

  // ── Notification ttl
  for (const n of state.notifications) n.ttl -= dt;
  state.notifications = state.notifications.filter((n) => n.ttl > 0);
  if (state.notifications.length > 5) {
    state.notifications.splice(0, state.notifications.length - 5);
  }
  for (const h of state.recentHonor) h.ttl -= dt;
  state.recentHonor = state.recentHonor.filter((h) => h.ttl > 0);

  // ── Asteroid rotation + player collision
  for (const a of state.asteroids) {
    a.rotation += a.rotSpeed * dt;
    if (serverAuthoritative) continue;
    if (a.zone !== state.player.zone) continue;
    const adist = distance(p.pos.x, p.pos.y, a.pos.x, a.pos.y);
    if (adist < a.size + 10) {
      const pushAng = Math.atan2(p.pos.y - a.pos.y, p.pos.x - a.pos.x);
      p.pos.x = a.pos.x + Math.cos(pushAng) * (a.size + 12);
      p.pos.y = a.pos.y + Math.sin(pushAng) * (a.size + 12);
      damagePlayer(Math.round(a.size * 0.3));
      emitSpark(p.pos.x, p.pos.y, "#c69060", 3, 50, 2);
    }
  }

  // ── Save periodically
  saveTimer -= dt;
  if (saveTimer <= 0) {
    save();
    saveTimer = 6;
  }

  bump();
}

function destroyAsteroid(id: string): void {
  const a = state.asteroids.find((x) => x.id === id);
  if (!a) return;
  emitSpark(a.pos.x, a.pos.y, "#c69060", 16, 120, 3);
  emitSpark(a.pos.x, a.pos.y, "#7a5028", 8, 80, 2);
  // Smoke-only explosion (no fire) + rock debris
  state.particles.push({
    id: `af-${Math.random().toString(36).slice(2, 8)}`,
    pos: { x: a.pos.x, y: a.pos.y }, vel: { x: 0, y: 0 },
    ttl: 0.3, maxTtl: 0.3,
    color: "#ffffff", size: 80, kind: "flash",
  });
  for (let i = 0; i < 14; i++) {
    const sa = Math.random() * Math.PI * 2;
    const ss = 20 + Math.random() * 50;
    state.particles.push({
      id: `as-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x: a.pos.x + (Math.random() - 0.5) * 10, y: a.pos.y + (Math.random() - 0.5) * 10 },
      vel: { x: Math.cos(sa) * ss, y: Math.sin(sa) * ss },
      ttl: 0.8 + Math.random() * 0.8, maxTtl: 1.6,
      color: i % 3 === 0 ? "#555" : i % 3 === 1 ? "#888" : "#aaa",
      size: 8 + Math.random() * 12, kind: "smoke",
    });
  }
  for (let i = 0; i < 10; i++) {
    const da = Math.random() * Math.PI * 2;
    const ds = 60 + Math.random() * 140;
    state.particles.push({
      id: `ad-${Math.random().toString(36).slice(2, 8)}`,
      pos: { x: a.pos.x, y: a.pos.y },
      vel: { x: Math.cos(da) * ds, y: Math.sin(da) * ds },
      ttl: 0.6 + Math.random() * 0.8, maxTtl: 1.4,
      color: Math.random() > 0.4 ? "#c0a070" : "#7a5028",
      size: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 16,
      kind: "debris",
    });
  }
  emitRing(a.pos.x, a.pos.y, "#c0a070", 30);
  sfx.explosion();
  const qty = 2 + Math.floor(Math.random() * 3);
  const got = addCargo(a.yields, qty);
  if (got > 0) {
    pushFloater({ text: `+${got} ${a.yields === "iron" ? "Iron" : "Lumenite"}`, color: "#5cff8a", x: a.pos.x, y: a.pos.y - 12, scale: 1, ttl: 0.9 });
    sfx.pickup();
    state.player.milestones.totalMined += got;
    bumpMission("mine", got);
    const prev = state.player.milestones.totalMined - got;
    checkMilestoneTier("totalMined", prev, state.player.milestones.totalMined);
  } else {
    pushNotification("Cargo full — ore lost", "bad");
  }
  state.asteroids = state.asteroids.filter((x) => x.id !== id);
  setTimeout(() => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 1200 + Math.random() * 1200;
    const yieldsLumenite = Math.random() < 0.18;
    state.asteroids.push({
      id: `ast-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      pos: { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist },
      hp: 80, hpMax: 80, size: 16 + Math.random() * 14,
      rotation: 0, rotSpeed: (Math.random() - 0.5) * 0.4,
      zone: state.player.zone,
      yields: yieldsLumenite ? "lumenite" : "iron",
    });
  }, 6000);
}

export function checkPortal(): void {
  const p = state.player;
  const portal = PORTALS.find(
    (po) => po.fromZone === p.zone && distance(p.pos.x, p.pos.y, po.pos.x, po.pos.y) < 70
  );
  if (portal) {
    const z = ZONES[portal.toZone];
    if (state.player.level < z.unlockLevel) {
      pushNotification(`Need level ${z.unlockLevel} to enter ${z.name}`, "bad");
      const ang = Math.atan2(p.pos.y - portal.pos.y, p.pos.x - portal.pos.x);
      p.pos.x += Math.cos(ang) * 80;
      p.pos.y += Math.sin(ang) * 80;
      return;
    }
    travelToZone(portal.toZone);
  }
}

export function checkStationDock(): string | null {
  const p = state.player;
  const station = STATIONS.find(
    (s) => s.zone === p.zone && distance(p.pos.x, p.pos.y, s.pos.x, s.pos.y) < 90
  );
  return station ? station.id : null;
}

// silence unused export warning for ZoneId import
export type _ZoneId = ZoneId;

// ── SERVER EVENT HANDLERS (called from App.tsx socket listeners) ─────────

let serverEnemiesReceived = false;

export function onServerZoneEnemies(enemies: ServerEnemy[]): void {
  serverEnemiesReceived = true;
  state.enemies = enemies.map(serverEnemyToLocal);
  bump();
}

export function onServerZoneAsteroids(asteroids: ServerAsteroid[]): void {
  state.asteroids = asteroids.map((a) => ({
    id: a.id,
    pos: { x: a.x, y: a.y },
    hp: a.hp, hpMax: a.hpMax, size: a.size,
    rotation: 0, rotSpeed: (Math.random() - 0.5) * 0.4,
    zone: state.player.zone,
    yields: a.yields as any,
  }));
  bump();
}

export function onServerZoneNpcs(npcs: ServerNpc[]): void {
  state.npcShips = npcs.map((n) => ({
    id: n.id, name: n.name,
    pos: { x: n.x, y: n.y }, vel: { x: n.vx, y: n.vy },
    angle: n.angle, color: n.color, size: n.size,
    hull: n.hull, hullMax: n.hullMax, speed: n.speed,
    damage: 0, fireCd: 2,
    targetPos: { x: n.x, y: n.y },
    state: n.state as any,
    targetEnemyId: null,
    zone: state.player.zone,
  }));
  bump();
}

export function onEnemySpawn(data: ServerEnemy): void {
  if (state.enemies.find((e) => e.id === data.id)) return;
  state.enemies.push(serverEnemyToLocal(data));
}

export function onEnemyHit(data: EnemyHitEvent): void {
  const e = state.enemies.find((en) => en.id === data.enemyId);
  if (!e) return;
  e.hull = data.hp;
  e.hullMax = data.hpMax;
  e.hitFlash = 1;
  e.aggro = true;
  if (data.crit) {
    emitSpark(e.pos.x, e.pos.y, "#ffee00", 8, 140, 3);
    emitSpark(e.pos.x, e.pos.y, "#ffffff", 4, 100, 2);
    pushFloater({ text: `${Math.round(data.damage)}!`, color: "#ffee00", x: e.pos.x + (Math.random() - 0.5) * 18, y: e.pos.y - e.size - 8, scale: 1.5, ttl: 1.0, bold: true });
  } else {
    pushFloater({ text: `${Math.round(data.damage)}`, color: "#e8f0ff", x: e.pos.x + (Math.random() - 0.5) * 18, y: e.pos.y - e.size - 8, scale: 0.95, ttl: 0.7 });
  }
  emitSpark(e.pos.x, e.pos.y, e.color, data.crit ? 8 : 4, data.crit ? 180 : 120, data.crit ? 4 : 3);
}

export function onEnemyDie(data: EnemyDieEvent): void {
  const e = state.enemies.find((en) => en.id === data.enemyId);
  const pos = e ? { x: e.pos.x, y: e.pos.y } : data.pos;
  const wasBoss = e?.isBoss;
  const color = e?.color ?? "#ff5c6c";
  const size = e?.size ?? 12;

  emitDeath(pos.x, pos.y, color, !!wasBoss);
  if (wasBoss) {
    sfx.bossKill();
    state.cameraShake = Math.max(state.cameraShake, 1);
    bossActive = false;
    pushEvent({
      title: "BOSS DEFEATED",
      body: "Excellent shooting, Captain. Premium loot dropped.",
      ttl: 6, kind: "boss", color: "#5cff8a",
    });
  } else {
    sfx.explosion(size > 16);
    const dist = Math.hypot(pos.x - state.player.pos.x, pos.y - state.player.pos.y);
    state.cameraShake = Math.max(state.cameraShake, (size > 16 ? 0.75 : 0.5) * Math.max(0, 1 - dist / 800));
  }

  // Grant loot from server
  const loot = data.loot;
  const p = state.player;
  p.exp += loot.exp;
  p.credits += loot.credits;
  p.honor += loot.honor;
  while (p.exp >= EXP_FOR_LEVEL(p.level)) {
    p.exp -= EXP_FOR_LEVEL(p.level);
    p.level++;
    state.levelUpFlash = 1.6;
  }
  pushFloater({ text: `+${loot.exp} XP`, color: "#ff5cf0", x: pos.x, y: pos.y - 20, scale: 0.9 });
  pushFloater({ text: `+${loot.credits} CR`, color: "#ffd24a", x: pos.x + 20, y: pos.y - 8, scale: 0.9 });
  if (loot.honor > 0) pushFloater({ text: `+${loot.honor} H`, color: "#c8a0ff", x: pos.x - 20, y: pos.y - 8, scale: 0.8 });
  if (loot.resource) {
    const got = addCargo(loot.resource.resourceId as any, loot.resource.qty);
    if (got > 0) {
      pushFloater({ text: `+${got} ${loot.resource.resourceId}`, color: "#5cff8a", x: pos.x, y: pos.y + 12, scale: 0.9 });
      sfx.pickup();
    }
  }

  // Ammo drop
  const ammoDrop = 1 + Math.floor(Math.random() * 3);
  p.ammo.x1 = (p.ammo.x1 ?? 0) + ammoDrop;

  // Quest + mission progress
  if (e) {
    for (const q of p.activeQuests) {
      if (!q.completed && q.killType === e.type && q.zone === p.zone) {
        q.progress++;
        if (q.progress >= q.killCount) {
          q.completed = true;
          pushNotification(`Quest complete: ${q.title}`, "good");
        }
      }
    }
  }
  p.milestones.totalKills++;
  if (wasBoss) p.milestones.bossKills++;
  bumpMission("kill-any", 1);
  bumpMission("kill-zone", 1, p.zone);
  bumpMission("earn-credits", loot.credits);
  tryLevelUp();

  state.enemies = state.enemies.filter((en) => en.id !== data.enemyId);
  bump();
}

export function onEnemyAttack(data: EnemyAttackEvent): void {
  fireProjectile("enemy", data.pos.x, data.pos.y,
    Math.atan2(data.targetPos.y - data.pos.y, data.targetPos.x - data.pos.x),
    data.damage, "#ff5c6c", 3);
  if (!serverAuthoritative) {
    damagePlayer(data.damage);
  }
}

export function onAsteroidMine(data: { asteroidId: string; hp: number; hpMax: number }): void {
  const a = state.asteroids.find((ast) => ast.id === data.asteroidId);
  if (a) {
    a.hp = data.hp;
    a.hpMax = data.hpMax;
  }
}

export function onAsteroidDestroy(data: { asteroidId: string; playerId: number; ore: { resourceId: string; qty: number } }): void {
  const a = state.asteroids.find((ast) => ast.id === data.asteroidId);
  if (a) {
    emitSpark(a.pos.x, a.pos.y, "#c69060", 16, 120, 3);
    emitRing(a.pos.x, a.pos.y, "#c0a070", 30);
    sfx.explosion();
    const got = addCargo(data.ore.resourceId as any, data.ore.qty);
    if (got > 0) {
      pushFloater({ text: `+${got} ${data.ore.resourceId}`, color: "#5cff8a", x: a.pos.x, y: a.pos.y - 12, scale: 1, ttl: 0.9 });
      sfx.pickup();
      state.player.milestones.totalMined += got;
      bumpMission("mine", got);
    }
  }
  state.asteroids = state.asteroids.filter((ast) => ast.id !== data.asteroidId);
  state.miningTargetId = null;
  sfx.miningLaserStop();
}

export function onAsteroidRespawn(data: ServerAsteroid): void {
  state.asteroids.push({
    id: data.id,
    pos: { x: data.x, y: data.y },
    hp: data.hp, hpMax: data.hpMax, size: data.size,
    rotation: 0, rotSpeed: (Math.random() - 0.5) * 0.4,
    zone: state.player.zone,
    yields: data.yields as any,
  });
}

export function onBossWarn(): void {
  const z = ZONES[state.player.zone];
  pushEvent({
    title: "INCOMING DREAD",
    body: `Sensors detect a heavy warship inbound to ${z.name} in 30s.`,
    ttl: 6, kind: "global", color: "#ff8a4e",
  });
  sfx.bossWarn();
}

export function onNpcSpawn(data: ServerNpc): void {
  if (state.npcShips.find((n) => n.id === data.id)) return;
  state.npcShips.push({
    id: data.id, name: data.name,
    pos: { x: data.x, y: data.y }, vel: { x: data.vx, y: data.vy },
    angle: data.angle, color: data.color, size: data.size,
    hull: data.hull, hullMax: data.hullMax, speed: data.speed,
    damage: 0, fireCd: 2,
    targetPos: { x: data.x, y: data.y },
    state: data.state as any,
    targetEnemyId: null,
    zone: state.player.zone,
  });
}

export function onNpcDie(data: { npcId: string }): void {
  const n = state.npcShips.find((ns) => ns.id === data.npcId);
  if (n) {
    emitDeath(n.pos.x, n.pos.y, n.color);
    sfx.explosion();
  }
  state.npcShips = state.npcShips.filter((ns) => ns.id !== data.npcId);
}

export function onLaserFireFromServer(data: LaserFireEvent): void {
  if (data.attackerId === serverPlayerId) return;
  const attacker = state.others.find(o => o.id === String(data.attackerId));
  const target = state.enemies.find(e => e.id === data.targetId);
  if (!attacker || !target) return;
  const angle = Math.atan2(target.pos.y - attacker.pos.y, target.pos.x - attacker.pos.x);
  fireProjectile("player", attacker.pos.x, attacker.pos.y, angle, data.damage, "#4ee2ff", 3);
  if (data.crit) {
    emitSpark(target.pos.x, target.pos.y, "#ffee00", 6, 120, 3);
  }
}

export function onRocketFireFromServer(data: RocketFireEvent): void {
  if (data.attackerId === serverPlayerId) return;
  const angle = Math.atan2(data.targetPos.y - data.pos.y, data.targetPos.x - data.pos.x);
  fireProjectile("player", data.pos.x, data.pos.y, angle, data.damage, "#ff8844", 4, { speedMul: 0.7 });
  if (data.crit) {
    emitSpark(data.targetPos.x, data.targetPos.y, "#ffee00", 6, 120, 3);
  }
}

export function onProjectileSpawnFromServer(data: ProjectileSpawnEvent): void {
  const angle = Math.atan2(data.vy, data.vx);
  const speed = Math.sqrt(data.vx * data.vx + data.vy * data.vy);
  const baseSpeed = data.fromPlayer ? 280 : 220;
  const speedMul = baseSpeed > 0 ? speed / baseSpeed : 1;

  fireProjectile(data.fromPlayer ? "player" : "enemy", data.x, data.y, angle, data.damage, data.color, data.size, {
    crit: data.crit,
    homing: data.homing,
    speedMul,
    weaponKind: data.weaponKind,
    renderOnly: true,
  });
}

function serverEnemyToLocal(se: ServerEnemy): Enemy {
  return {
    id: se.id,
    type: se.type as EnemyType,
    name: se.name,
    behavior: se.behavior as any,
    pos: { x: se.x, y: se.y },
    vel: { x: se.vx, y: se.vy },
    angle: se.angle,
    hull: se.hull, hullMax: se.hullMax,
    damage: se.damage, speed: se.speed,
    fireCd: Math.random() * 2,
    exp: 0, credits: 0, honor: 0,
    color: se.color, size: se.size,
    isBoss: se.isBoss, bossPhase: se.bossPhase,
    burstCd: 0, burstShots: 0,
    spawnPos: { x: se.x, y: se.y },
    aggro: false,
  };
}

// ── DELTA / SNAPSHOT HANDLERS (server-authoritative netcode) ──────────────

let serverConfig = { tickRate: 25, friction: 0.96, frictionRefFps: 60 };
export let serverAuthoritative = false;
let serverPlayerId = 0;
let _deltaCount = 0;

const SELF_LERP_RATE = 18;
const ENTITY_LERP_RATE = 14;
const SELF_SNAP_DIST_SQ = 250 * 250;

type RenderTarget = { x: number; y: number; vx: number; vy: number };
const _selfTarget: RenderTarget & { set: boolean } = { x: 0, y: 0, vx: 0, vy: 0, set: false };
const _entityTargets = new Map<string, RenderTarget>();

function setSelfTarget(x: number, y: number, vx: number, vy: number): void {
  if (!_selfTarget.set) {
    state.player.pos.x = x;
    state.player.pos.y = y;
    _selfTarget.set = true;
  }
  _selfTarget.x = x;
  _selfTarget.y = y;
  _selfTarget.vx = vx;
  _selfTarget.vy = vy;
}

function setEntityTarget(id: string, x: number, y: number, vx: number, vy: number): void {
  const cur = _entityTargets.get(id);
  if (cur) { cur.x = x; cur.y = y; cur.vx = vx; cur.vy = vy; }
  else _entityTargets.set(id, { x, y, vx, vy });
}

function applyServerSmoothing(dt: number): void {
  if (_selfTarget.set) {
    const p = state.player;
    const dx = _selfTarget.x - p.pos.x;
    const dy = _selfTarget.y - p.pos.y;
    if (dx * dx + dy * dy > SELF_SNAP_DIST_SQ) {
      p.pos.x = _selfTarget.x;
      p.pos.y = _selfTarget.y;
    } else {
      const t = Math.min(1, SELF_LERP_RATE * dt);
      p.pos.x += dx * t;
      p.pos.y += dy * t;
    }
    p.vel.x = _selfTarget.vx;
    p.vel.y = _selfTarget.vy;
  }
  const t = Math.min(1, ENTITY_LERP_RATE * dt);
  for (const o of state.others) {
    const tgt = _entityTargets.get(`p-${o.id}`);
    if (!tgt) continue;
    o.pos.x += (tgt.x - o.pos.x) * t;
    o.pos.y += (tgt.y - o.pos.y) * t;
    o.vel.x = tgt.vx;
    o.vel.y = tgt.vy;
  }
  for (const e of state.enemies) {
    const tgt = _entityTargets.get(e.id);
    if (!tgt) continue;
    e.pos.x += (tgt.x - e.pos.x) * t;
    e.pos.y += (tgt.y - e.pos.y) * t;
    e.vel.x = tgt.vx;
    e.vel.y = tgt.vy;
  }
  for (const n of state.npcShips) {
    const tgt = _entityTargets.get(n.id);
    if (!tgt) continue;
    n.pos.x += (tgt.x - n.pos.x) * t;
    n.pos.y += (tgt.y - n.pos.y) * t;
    n.vel.x = tgt.vx;
    n.vel.y = tgt.vy;
  }
}

export function onWelcome(data: WelcomePayload): void {
  serverConfig = {
    tickRate: data.tickRate,
    friction: data.friction,
    frictionRefFps: data.frictionRefFps,
  };
  serverPlayerId = data.playerId;
  serverAuthoritative = true;
}

export function onDelta(data: DeltaPayload): void {
  serverAuthoritative = true;
  _deltaCount++;
  if (_deltaCount % 20 === 0) {
    document.title = `CR [S:${data.tick} d:${_deltaCount} e:${data.addOrUpdate.length}]`;
  }
  const p = state.player;
  const self = data.self;

  setSelfTarget(self.x, self.y, self.vx, self.vy);

  if (state.playerRespawnTimer <= 0) {
    p.hull = self.hp;
    p.shield = self.shield;
  }

  for (const entity of data.addOrUpdate) {
    applyEntityUpdate(entity);
  }

  for (const id of data.removals) {
    removeEntityById(id);
    _entityTargets.delete(id);
  }
}

export function onSnapshot(data: SnapshotPayload): void {
  serverAuthoritative = true;
  const p = state.player;
  const self = data.self;

  setSelfTarget(self.x, self.y, self.vx, self.vy);
  if (state.playerRespawnTimer <= 0) {
    p.hull = self.hp;
    p.shield = self.shield;
  }

  const entityIds = new Set<string>();
  for (const entity of data.entities) {
    entityIds.add(entity.id);
    applyEntityUpdate(entity);
  }

  state.enemies = state.enemies.filter(e => entityIds.has(e.id));
  state.npcShips = state.npcShips.filter(n => entityIds.has(n.id));
  state.others = state.others.filter(o => entityIds.has(`p-${o.id}`));

  for (const id of Array.from(_entityTargets.keys())) {
    if (!entityIds.has(id)) _entityTargets.delete(id);
  }

  bump();
}

export function onPlayerHitFromServer(data: { damage: number; hp: number; shield: number }): void {
  const p = state.player;
  if (state.playerRespawnTimer > 0) return;
  p.hull = data.hp;
  p.shield = data.shield;
  emitSpark(p.pos.x, p.pos.y, "#ff5c6c", 6, 70, 2);
  sfx.hit();
  state.cameraShake = Math.max(state.cameraShake, 0.15);
  state.lastHitTick = state.tick;
}

export function onPlayerDieFromServer(data: { playerId: number; pos: { x: number; y: number } }): void {
  const p = state.player;
  if (data.playerId !== serverPlayerId) return;
  const shipColor = SHIP_CLASSES[p.shipClass].color;
  emitDeath(data.pos.x, data.pos.y, shipColor, true);
  state.playerDeathFlash = 0.6;
  state.player.milestones.totalDeaths++;
  state.isAttacking = false;
  state.isLaserFiring = false;
  state.isRocketFiring = false;
  state.attackTargetId = null;
  state.selectedWorldTarget = null;
  sfx.thrusterStop();
  sfx.explosion(true);
  state.cameraShake = 1;
  pushNotification("Ship destroyed. Respawning...", "bad");
}

function applyEntityUpdate(entity: DeltaEntity): void {
  switch (entity.entityType) {
    case "enemy": {
      const e = state.enemies.find(en => en.id === entity.id);
      if (e) {
        setEntityTarget(entity.id, entity.x, entity.y, entity.vx ?? 0, entity.vy ?? 0);
        if (entity.angle != null) e.angle = entity.angle;
        if (entity.hp != null) e.hull = entity.hp;
        if (entity.hpMax != null) e.hullMax = entity.hpMax;
        if (entity.isBoss != null) e.isBoss = entity.isBoss;
        if (entity.bossPhase != null) e.bossPhase = entity.bossPhase;
      } else {
        setEntityTarget(entity.id, entity.x, entity.y, entity.vx ?? 0, entity.vy ?? 0);
        state.enemies.push({
          id: entity.id,
          type: (entity.type || "scout") as EnemyType,
          name: entity.name || "Unknown",
          behavior: (entity.behavior || "chaser") as any,
          pos: { x: entity.x, y: entity.y },
          vel: { x: entity.vx || 0, y: entity.vy || 0 },
          angle: entity.angle || 0,
          hull: entity.hp || 100, hullMax: entity.hpMax || 100,
          damage: entity.damage || 10, speed: entity.speed || 80,
          fireCd: Math.random() * 2, exp: 0, credits: 0, honor: 0,
          color: entity.color || "#ff5c6c", size: entity.size || 12,
          isBoss: entity.isBoss || false, bossPhase: entity.bossPhase || 0,
          burstCd: 0, burstShots: 0,
          spawnPos: { x: entity.x, y: entity.y },
          aggro: false,
        });
      }
      break;
    }
    case "player": {
      const numId = entity.id.replace("p-", "");
      const o = state.others.find(op => op.id === numId);
      if (o) {
        setEntityTarget(entity.id, entity.x, entity.y, entity.vx ?? 0, entity.vy ?? 0);
        if (entity.angle != null) o.angle = entity.angle;
      } else {
        setEntityTarget(entity.id, entity.x, entity.y, entity.vx ?? 0, entity.vy ?? 0);
        state.others.push({
          id: numId,
          name: entity.name || "Pilot",
          shipClass: (entity.shipClass || "skimmer") as any,
          level: entity.level || 1,
          clan: null,
          zone: state.player.zone as any,
          pos: { x: entity.x, y: entity.y },
          vel: { x: entity.vx || 0, y: entity.vy || 0 },
          angle: entity.angle || 0,
          inParty: false,
        });
      }
      break;
    }
    case "npc": {
      const n = state.npcShips.find(ns => ns.id === entity.id);
      if (n) {
        setEntityTarget(entity.id, entity.x, entity.y, entity.vx ?? 0, entity.vy ?? 0);
        if (entity.angle != null) n.angle = entity.angle;
        if (entity.hp != null) n.hull = entity.hp;
        if (entity.hpMax != null) n.hullMax = entity.hpMax;
        if (entity.state != null) n.state = entity.state as any;
      } else {
        setEntityTarget(entity.id, entity.x, entity.y, entity.vx ?? 0, entity.vy ?? 0);
        state.npcShips.push({
          id: entity.id,
          name: entity.name || "NPC",
          pos: { x: entity.x, y: entity.y },
          vel: { x: entity.vx || 0, y: entity.vy || 0 },
          angle: entity.angle || 0,
          color: entity.color || "#4ee2ff",
          size: entity.size || 12,
          hull: entity.hp || 200, hullMax: entity.hpMax || 200,
          speed: entity.speed || 100, damage: 0, fireCd: 2,
          targetPos: { x: entity.x, y: entity.y },
          state: (entity.state || "patrol") as any,
          targetEnemyId: null,
          zone: state.player.zone,
        });
      }
      break;
    }
    case "asteroid": {
      const a = state.asteroids.find(ast => ast.id === entity.id);
      if (a) {
        if (entity.hp != null) a.hp = entity.hp;
        if (entity.hpMax != null) a.hpMax = entity.hpMax;
      } else {
        state.asteroids.push({
          id: entity.id,
          pos: { x: entity.x, y: entity.y },
          hp: entity.hp || 100, hpMax: entity.hpMax || 100,
          size: entity.size || 20,
          rotation: 0, rotSpeed: (Math.random() - 0.5) * 0.4,
          zone: state.player.zone,
          yields: (entity.yields || "iron") as any,
        });
      }
      break;
    }
  }
}

function removeEntityById(id: string): void {
  if (id.startsWith("p-")) {
    const numId = id.replace("p-", "");
    state.others = state.others.filter(o => o.id !== numId);
  } else if (id.startsWith("e-") || id.startsWith("boss-")) {
    state.enemies = state.enemies.filter(e => e.id !== id);
  } else if (id.startsWith("npc-")) {
    state.npcShips = state.npcShips.filter(n => n.id !== id);
  } else if (id.startsWith("ast-")) {
    state.asteroids = state.asteroids.filter(a => a.id !== id);
  }
}
