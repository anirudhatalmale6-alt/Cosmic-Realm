import {
  type Vec2, type ZoneId, type EnemyType, type EnemyBehavior, type FactionId,
  type ShipClassId, type RocketAmmoType, type RocketMissileType, type ResourceId,
  type SkillId, type DroneKind,
  ZONES, ENEMY_DEFS, FACTION_ENEMY_MODS, SHIP_CLASSES, MODULE_DEFS,
  FACTIONS, DRONE_DEFS, SKILL_NODES,  ENEMY_NAMES,
  ROCKET_AMMO_TYPE_DEFS, ROCKET_MISSILE_TYPE_DEFS,
  MAP_RADIUS, EXP_FOR_LEVEL, MINING_DPS_FACTOR, MINING_RANGE,
} from "./data.js";
import type { OnlinePlayer } from "../socket/state.js";
import { SpatialHashGrid } from "../core/SpatialHashGrid.js";

// ── CONFIGURATION ───────────────────────────────────────────────────────────

export const TICK_RATE = 25;
export const DELTA_RATE = 20;
export const SNAPSHOT_RATE = 1;
export const VIEW_RADIUS = 1500;
const GRID_CELL = 512;
const ATTACK_RANGE = 800;
const FRICTION = 0.96;
const FRICTION_REF_FPS = 60;
const POS_VERSION_EPSILON = 0.05;

// ── SERVER ENTITY TYPES ─────────────────────────────────────────────────────

export type ServerEnemy = {
  id: string;
  type: EnemyType;
  behavior: EnemyBehavior;
  name: string;
  pos: Vec2;
  vel: Vec2;
  angle: number;
  hull: number;
  hullMax: number;
  damage: number;
  speed: number;
  exp: number;
  credits: number;
  honor: number;
  loot?: { resourceId: ResourceId; qty: number };
  color: string;
  size: number;
  isBoss: boolean;
  bossPhase: number;
  phaseTimer: number;
  fireTimer: number;
  burstCd: number;
  burstShots: number;
  aggroTarget: number | null;
  aggroRange: number;
  spawnPos: Vec2;
  stunUntil: number;
  combo: Map<number, { stacks: number; ttl: number }>;
  version: number;
};

export type ServerAsteroid = {
  id: string;
  pos: Vec2;
  hp: number;
  hpMax: number;
  size: number;
  yields: ResourceId;
  respawnAt: number;
  version: number;
};

export type ServerNpc = {
  id: string;
  name: string;
  pos: Vec2;
  vel: Vec2;
  angle: number;
  hull: number;
  hullMax: number;
  speed: number;
  damage: number;
  fireTimer: number;
  targetPos: Vec2;
  state: "patrol" | "fight";
  targetEnemyId: string | null;
  color: string;
  size: number;
  version: number;
};

export type LootDrop = {
  credits: number;
  exp: number;
  honor: number;
  resource?: { resourceId: ResourceId; qty: number };
};

export type GameEvent =
  | { type: "enemy:spawn"; zone: string; enemy: any }
  | { type: "enemy:die"; zone: string; enemyId: string; killerId: number; loot: LootDrop; pos: Vec2 }
  | { type: "enemy:hit"; zone: string; enemyId: string; damage: number; hp: number; hpMax: number; crit: boolean; attackerId: number }
  | { type: "enemy:attack"; zone: string; enemyId: string; targetId: number; damage: number; pos: Vec2; targetPos: Vec2 }
  | { type: "player:damage"; playerId: number; damage: number; shieldDmg: number; hullDmg: number }
  | { type: "asteroid:mine"; zone: string; asteroidId: string; hp: number; hpMax: number }
  | { type: "asteroid:destroy"; zone: string; asteroidId: string; playerId: number; ore: { resourceId: ResourceId; qty: number } }
  | { type: "asteroid:respawn"; zone: string; asteroid: any }
  | { type: "boss:warn"; zone: string }
  | { type: "npc:spawn"; zone: string; npc: any }
  | { type: "npc:die"; zone: string; npcId: string }
  | { type: "laser:fire"; zone: string; attackerId: number; targetId: string; damage: number; crit: boolean }
  | { type: "rocket:fire"; zone: string; attackerId: number; targetId: string; damage: number; crit: boolean; pos: Vec2; targetPos: Vec2 };

export type DeltaPayload = {
  tick: number;
  self: {
    id: number;
    x: number; y: number;
    vx: number; vy: number;
    hp: number; hpMax: number;
    shield: number; shieldMax: number;
    lastProcessedInput: number;
  };
  addOrUpdate: any[];
  removals: string[];
};

export type SnapshotPayload = {
  tick: number;
  self: {
    id: number;
    x: number; y: number;
    vx: number; vy: number;
    hp: number; hpMax: number;
    shield: number; shieldMax: number;
    lastProcessedInput: number;
  };
  entities: any[];
};

export type TickResult = {
  events: GameEvent[];
  deltas: Map<number, DeltaPayload>;
  snapshots: Map<number, SnapshotPayload>;
};

// ── PLAYER STATS COMPUTATION ────────────────────────────────────────────────

export type EffectiveStats = {
  damage: number;
  speed: number;
  hullMax: number;
  shieldMax: number;
  shieldRegen: number;
  fireRate: number;
  critChance: number;
  damageReduction: number;
  shieldAbsorb: number;
  aoeRadius: number;
  lootBonus: number;
  cargoMax: number;
};

export function computeStats(playerData: any): EffectiveStats {
  const cls = SHIP_CLASSES[playerData.shipClass as ShipClassId];
  if (!cls) {
    return {
      damage: 8, speed: 180, hullMax: 100, shieldMax: 50,
      shieldRegen: 5, fireRate: 1, critChance: 0.03,
      damageReduction: 0, shieldAbsorb: 0.5, aoeRadius: 0,
      lootBonus: 0, cargoMax: 20,
    };
  }

  const mod = sumEquippedStats(playerData.inventory, playerData.equipped);
  const sk = (id: SkillId) => (playerData.skills?.[id] ?? 0) as number;

  let damage = (cls.baseDamage + (mod.damage ?? 0)) * (1 + sk("off-power") * 0.05);
  let hullMax = (cls.hullMax + (mod.hullMax ?? 0)) * (1 + sk("def-armor") * 0.08);
  let shieldMax = (cls.shieldMax + (mod.shieldMax ?? 0)) * (1 + sk("def-shield") * 0.08 + sk("def-barrier") * 0.12);
  let speed = (cls.baseSpeed + (mod.speed ?? 0)) * (1 + sk("ut-thrust") * 0.05);
  let shieldRegen = 5 + (mod.shieldRegen ?? 0);
  let damageReduction = (sk("def-bulwark") * 0.04) + (mod.damageReduction ?? 0);
  let shieldAbsorb = Math.min(0.5, mod.shieldAbsorb ?? 0);
  let aoeRadius = (sk("off-pierce") * 4) + (mod.aoeRadius ?? 0);
  let critChance = 0.03 + sk("off-crit") * 0.03 + (mod.critChance ?? 0);
  let fireRate = (1 + sk("off-rapid") * 0.08) * (mod.fireRate ?? 1);
  let lootBonus = (mod.lootBonus ?? 0);
  let cargoMax = cls.cargoMax;

  damage *= (1 + sk("off-snipe") * 0.04);
  critChance += sk("off-snipe") * 0.02;

  fireRate *= (1 + sk("eng-coolant") * 0.10);
  damage *= (1 + sk("eng-capacitor") * 0.06);
  shieldRegen *= (1 + sk("eng-capacitor") * 0.05);
  critChance += sk("eng-targeting") * 0.05;
  speed *= (1 + sk("eng-warp-core") * 0.08);

  const od = sk("eng-overdrive");
  if (od > 0) {
    damage *= (1 + od * 0.12);
    shieldMax *= (1 + od * 0.12);
    speed *= (1 + od * 0.12);
  }
  if (sk("eng-singularity") > 0) {
    damage *= 1.20;
    fireRate *= 1.15;
    speed *= 1.10;
  }

  shieldRegen *= (1 + sk("def-nano") * 0.10);
  hullMax *= (1 + sk("def-nano") * 0.05);
  fireRate *= (1 + sk("off-volley") * 0.15);
  shieldRegen *= (1 + sk("def-regen") * 0.15);

  const drones = playerData.drones ?? [];
  for (const drone of drones) {
    const def = DRONE_DEFS[drone.kind as DroneKind];
    if (!def) continue;
    damage += def.damageBonus;
    hullMax += def.hullBonus;
    shieldMax += def.shieldBonus;
  }

  const faction = FACTIONS[playerData.faction as FactionId];
  if (faction) {
    if (faction.bonus.damage) damage *= (1 + faction.bonus.damage);
    if (faction.bonus.speed) speed *= (1 + faction.bonus.speed);
    if (faction.bonus.shieldRegen) shieldRegen *= faction.bonus.shieldRegen;
    if (faction.bonus.lootBonus) lootBonus += faction.bonus.lootBonus;
  }

  cargoMax = Math.floor(cargoMax * (1 + sk("ut-cargo") * 0.15) * (1 + (mod.cargoBonus ?? 0)));

  return {
    damage, speed, hullMax, shieldMax, shieldRegen,
    fireRate, critChance, damageReduction: Math.min(0.8, damageReduction),
    shieldAbsorb: 0.5 + shieldAbsorb,
    aoeRadius, lootBonus, cargoMax,
  };
}

function sumEquippedStats(inventory: any[], equipped: any): Record<string, number> {
  const result: Record<string, number> = {};
  if (!inventory || !equipped) return result;

  const allSlotIds: string[] = [
    ...(equipped.weapon ?? []),
    ...(equipped.generator ?? []),
    ...(equipped.module ?? []),
  ].filter(Boolean);

  for (const instanceId of allSlotIds) {
    const item = inventory.find((i: any) => i.instanceId === instanceId);
    if (!item) continue;
    const def = MODULE_DEFS[item.defId];
    if (!def) continue;
    for (const [key, val] of Object.entries(def.stats)) {
      if (typeof val !== "number") continue;
      if (key === "fireRate") {
        result.fireRate = (result.fireRate ?? 1) * val;
      } else {
        result[key] = (result[key] ?? 0) + val;
      }
    }
  }
  return result;
}

// ── ZONE STATE ──────────────────────────────────────────────────────────────

type ZoneState = {
  enemies: Map<string, ServerEnemy>;
  asteroids: Map<string, ServerAsteroid>;
  npcShips: Map<string, ServerNpc>;
  grid: SpatialHashGrid;
  spawnTimer: number;
  bossTimer: number;
  bossActive: boolean;
  npcSpawnTimer: number;
};

// ── GAME ENGINE ─────────────────────────────────────────────────────────────

let _eidSeq = 0;
function eid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++_eidSeq).toString(36)}`;
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(randRange(min, max + 1));
}

function angleFromTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export class GameEngine {
  zones = new Map<string, ZoneState>();
  playerDataCache = new Map<number, any>();
  private tickCount = 0;
  private lastDeltaAt = 0;
  private lastSnapshotAt = 0;

  constructor() {
    for (const zone of Object.values(ZONES)) {
      const zs: ZoneState = {
        enemies: new Map(),
        asteroids: new Map(),
        npcShips: new Map(),
        grid: new SpatialHashGrid(GRID_CELL),
        spawnTimer: randRange(2, 5),
        bossTimer: randRange(120, 300),
        bossActive: false,
        npcSpawnTimer: randRange(5, 15),
      };
      this.zones.set(zone.id, zs);
      this.spawnInitialAsteroids(zone.id, zs);
    }
  }

  cachePlayerData(playerId: number, data: any): void {
    this.playerDataCache.set(playerId, data);
  }

  removePlayerData(playerId: number): void {
    this.playerDataCache.delete(playerId);
  }

  // ── MAIN TICK ───────────────────────────────────────────────────────────

  tick(dt: number, getPlayersInZone: (zone: string) => OnlinePlayer[]): TickResult {
    this.tickCount++;
    const now = Date.now();
    const events: GameEvent[] = [];
    const deltas = new Map<number, DeltaPayload>();
    const snapshots = new Map<number, SnapshotPayload>();

    const shouldDelta = now - this.lastDeltaAt >= 1000 / DELTA_RATE;
    const shouldSnapshot = now - this.lastSnapshotAt >= 1000 / SNAPSHOT_RATE;
    if (shouldDelta) this.lastDeltaAt = now;
    if (shouldSnapshot) this.lastSnapshotAt = now;

    for (const [zoneId, zs] of this.zones) {
      const players = getPlayersInZone(zoneId);

      if (players.length === 0) {
        if (zs.bossActive) {
          for (const [id, e] of zs.enemies) if (e.isBoss) zs.enemies.delete(id);
          zs.bossActive = false;
          zs.bossTimer = randRange(180, 420);
        }
        continue;
      }

      this.tickPlayerInputs(players);
      this.tickPlayerMovement(players, dt);
      this.rebuildGrid(zs, players);
      this.tickPlayerCombat(zoneId, zs, players, dt, events);
      this.tickPlayerMining(zoneId, zs, players, dt, events);
      this.tickShieldRegen(players, dt);
      this.tickEnemySpawns(zoneId, zs, players, dt, events);
      this.tickBossSpawn(zoneId, zs, players, dt, events);
      this.tickNpcSpawns(zoneId, zs, dt, events);
      this.tickEnemyAI(zoneId, zs, players, dt, events);
      this.tickNpcAI(zoneId, zs, dt, events);
      this.tickAsteroidRespawn(zoneId, zs, dt, events);

      for (const e of zs.enemies.values()) {
        for (const [pid, combo] of e.combo) {
          combo.ttl -= dt;
          if (combo.ttl <= 0) e.combo.delete(pid);
        }
      }

      if (shouldSnapshot) {
        for (const p of players) {
          snapshots.set(p.playerId, this.buildSnapshot(p, zoneId, zs, players));
        }
      } else if (shouldDelta) {
        for (const p of players) {
          deltas.set(p.playerId, this.buildDelta(p, zoneId, zs, players));
        }
      }
    }

    return { events, deltas, snapshots };
  }

  // ── PLAYER INPUT PROCESSING ───────────────────────────────────────────

  private tickPlayerInputs(players: OnlinePlayer[]): void {
    for (const p of players) {
      while (p.inputQueue.length > 0) {
        const input = p.inputQueue.shift()!;
        p.lastProcessedInput = input.seq;
        p.targetX = input.targetX;
        p.targetY = input.targetY;
        p.isLaserFiring = input.firing;
        p.isRocketFiring = input.rocketFiring;
        p.attackTargetId = input.attackTargetId;
        p.miningTargetId = input.miningTargetId;
        if (input.laserAmmo) p.laserAmmoType = input.laserAmmo;
        if (input.rocketAmmo) p.rocketAmmoType = input.rocketAmmo;
      }
    }
  }

  // ── PLAYER MOVEMENT ───────────────────────────────────────────────────

  private tickPlayerMovement(players: OnlinePlayer[], dt: number): void {
    for (const p of players) {
      const oldX = p.posX;
      const oldY = p.posY;

      if (p.targetX !== null && p.targetY !== null) {
        const dx = p.targetX - p.posX;
        const dy = p.targetY - p.posY;
        const d = Math.sqrt(dx * dx + dy * dy);

        if (d > 6) {
          p.angle = Math.atan2(dy, dx);
          const maxSpd = (Date.now() < p.afterburnUntil) ? p.speed * 3 : p.speed;
          const accel = p.speed * 4;
          p.velX += Math.cos(p.angle) * accel * dt;
          p.velY += Math.sin(p.angle) * accel * dt;

          // Speed cap
          const spd = Math.sqrt(p.velX * p.velX + p.velY * p.velY);
          if (spd > maxSpd) {
            const scale = maxSpd / spd;
            p.velX *= scale;
            p.velY *= scale;
          }
        } else {
          p.targetX = null;
          p.targetY = null;
        }
      }

      // Frame-rate independent friction: matches client 0.96 per frame at 60fps
      const frictionFactor = Math.pow(FRICTION, dt * FRICTION_REF_FPS);
      p.velX *= frictionFactor;
      p.velY *= frictionFactor;

      // Position update
      p.posX += p.velX * dt;
      p.posY += p.velY * dt;

      // Map boundary clamp
      p.posX = clamp(p.posX, -MAP_RADIUS, MAP_RADIUS);
      p.posY = clamp(p.posY, -MAP_RADIUS, MAP_RADIUS);

      if (Math.abs(p.posX - oldX) > POS_VERSION_EPSILON || Math.abs(p.posY - oldY) > POS_VERSION_EPSILON) p.version++;
    }
  }

  // ── SHIELD REGEN ──────────────────────────────────────────────────────

  private tickShieldRegen(players: OnlinePlayer[], dt: number): void {
    for (const p of players) {
      if (p.shield < p.shieldMax && p.hull > 0) {
        const regenDelay = this.tickCount - p.lastHitTick > TICK_RATE * 3;
        if (regenDelay) {
          p.shield = Math.min(p.shieldMax, p.shield + p.shieldRegen * dt);
        }
      }
    }
  }

  // ── PLAYER COMBAT ─────────────────────────────────────────────────────

  private tickPlayerCombat(zoneId: string, zs: ZoneState, players: OnlinePlayer[], dt: number, events: GameEvent[]): void {
    for (const p of players) {
      if (!p.attackTargetId || p.hull <= 0) continue;
      const enemy = zs.enemies.get(p.attackTargetId);
      if (!enemy) { p.attackTargetId = null; continue; }

      const pPos: Vec2 = { x: p.posX, y: p.posY };
      const d = dist(pPos, enemy.pos);
      if (d > ATTACK_RANGE) continue;

      const pData = this.playerDataCache.get(p.playerId);
      if (!pData) continue;

      // Laser fire
      if (p.isLaserFiring) {
        p.laserFireCd -= dt;
        if (p.laserFireCd <= 0) {
          p.laserFireCd = 1 / p.fireRate;
          const result = this.computeDamage(p, pData, enemy, zoneId, "laser");
          this.applyEnemyDamage(zoneId, zs, enemy, result.dmg, result.crit, p.playerId, events);
          events.push({
            type: "laser:fire", zone: zoneId,
            attackerId: p.playerId, targetId: enemy.id,
            damage: result.dmg, crit: result.crit,
          });
        }
      }

      // Rocket fire
      if (p.isRocketFiring) {
        p.rocketFireCd -= dt;
        if (p.rocketFireCd <= 0) {
          p.rocketFireCd = 1.2;
          const result = this.computeDamage(p, pData, enemy, zoneId, "rocket");
          events.push({
            type: "rocket:fire", zone: zoneId,
            attackerId: p.playerId, targetId: enemy.id,
            damage: result.dmg, crit: result.crit,
            pos: { ...pPos }, targetPos: { ...enemy.pos },
          });
          // Rocket damage applied after short travel delay (0.5s) — for now, apply instantly
          this.applyEnemyDamage(zoneId, zs, enemy, result.dmg, result.crit, p.playerId, events);
        }
      }
    }
  }

  private computeDamage(
    p: OnlinePlayer, pData: any, enemy: ServerEnemy,
    zone: string, weaponKind: "laser" | "rocket",
  ): { dmg: number; crit: boolean } {
    let baseDmg: number;
    if (weaponKind === "laser") {
      const ammoDef = ROCKET_AMMO_TYPE_DEFS[p.laserAmmoType as RocketAmmoType];
      const mul = ammoDef ? ammoDef.damageMul : 1;
      baseDmg = p.damage * mul * 0.4;
    } else {
      const missileDef = ROCKET_MISSILE_TYPE_DEFS[p.rocketAmmoType as RocketMissileType];
      const mul = missileDef ? missileDef.damageMul : 1;
      baseDmg = p.damage * mul * 0.4 * 2.5;
    }

    // Combo
    let combo = enemy.combo.get(p.playerId);
    const stacks = combo ? Math.min(5, combo.stacks + 1) : 1;
    enemy.combo.set(p.playerId, { stacks, ttl: 3 });
    const comboMul = 1 + (stacks - 1) * 0.10;

    // Crit
    const crit = Math.random() < p.critChance;
    const critMul = crit ? 1.5 : 1;

    // Execute bonus
    const sk = (id: SkillId) => (pData.skills?.[id] ?? 0) as number;
    const execMul = (enemy.hull / enemy.hullMax < 0.25 && sk("off-execute") > 0) ? (1 + sk("off-execute") * 0.20) : 1;

    // Void rounds
    const voidMul = ((enemy.type === "dread" || enemy.type === "voidling") && sk("off-void") > 0) ? (1 + sk("off-void") * 0.08) : 1;

    let dmg = Math.round(baseDmg * comboMul * critMul * execMul * voidMul);
    if (dmg < 1) dmg = 1;

    return { dmg, crit };
  }

  private applyEnemyDamage(zoneId: string, zs: ZoneState, enemy: ServerEnemy, dmg: number, crit: boolean, attackerId: number, events: GameEvent[]): void {
    enemy.hull -= dmg;
    enemy.aggroTarget = attackerId;
    enemy.version++;

    if (enemy.hull <= 0) {
      const tierMult = this.getZoneTierMult(zoneId);
      const pData = this.playerDataCache.get(attackerId);
      const stats = pData ? computeStats(pData) : null;
      const lootBon = stats?.lootBonus ?? 0;
      const loot: LootDrop = {
        credits: Math.round(enemy.credits * tierMult) + Math.round(lootBon * 2),
        exp: Math.round(enemy.exp * tierMult * (enemy.isBoss ? 2 : 1)),
        honor: enemy.honor,
        resource: enemy.loot ? { ...enemy.loot } : undefined,
      };
      events.push({ type: "enemy:die", zone: zoneId, enemyId: enemy.id, killerId: attackerId, loot, pos: { ...enemy.pos } });
      zs.enemies.delete(enemy.id);
      if (enemy.isBoss) {
        zs.bossActive = false;
        zs.bossTimer = randRange(180, 420);
      }

      // AOE splash
      if (stats) {
        if (stats.aoeRadius > 0) {
          const splashRange = stats.aoeRadius * 8;
          const splashDmg = Math.round(dmg * 0.4);
          for (const e2 of zs.enemies.values()) {
            if (e2.id === enemy.id) continue;
            if (dist(enemy.pos, e2.pos) < splashRange) {
              e2.hull -= splashDmg;
              e2.version++;
              if (e2.hull <= 0) {
                const loot2: LootDrop = {
                  credits: Math.round(e2.credits * tierMult),
                  exp: Math.round(e2.exp * tierMult),
                  honor: e2.honor,
                  resource: e2.loot ? { ...e2.loot } : undefined,
                };
                events.push({ type: "enemy:die", zone: zoneId, enemyId: e2.id, killerId: attackerId, loot: loot2, pos: { ...e2.pos } });
                zs.enemies.delete(e2.id);
              } else {
                events.push({ type: "enemy:hit", zone: zoneId, enemyId: e2.id, damage: splashDmg, hp: e2.hull, hpMax: e2.hullMax, crit: false, attackerId });
              }
            }
          }
        }
      }
    } else {
      events.push({ type: "enemy:hit", zone: zoneId, enemyId: enemy.id, damage: dmg, hp: enemy.hull, hpMax: enemy.hullMax, crit, attackerId });
    }
  }

  // ── PLAYER MINING ─────────────────────────────────────────────────────

  private tickPlayerMining(zoneId: string, zs: ZoneState, players: OnlinePlayer[], dt: number, events: GameEvent[]): void {
    for (const p of players) {
      if (!p.miningTargetId || p.hull <= 0) continue;
      const ast = zs.asteroids.get(p.miningTargetId);
      if (!ast || ast.respawnAt > 0) { p.miningTargetId = null; continue; }

      const pPos: Vec2 = { x: p.posX, y: p.posY };
      if (dist(pPos, ast.pos) > MINING_RANGE) continue;

      const miningDps = p.damage * MINING_DPS_FACTOR;
      ast.hp -= miningDps * dt;
      ast.version++;

      if (ast.hp <= 0) {
        const qty = 2 + Math.floor(Math.random() * 3);
        events.push({
          type: "asteroid:destroy", zone: zoneId, asteroidId: ast.id,
          playerId: p.playerId,
          ore: { resourceId: ast.yields, qty },
        });
        ast.hp = 0;
        ast.respawnAt = Date.now() + 6000;
      } else {
        events.push({ type: "asteroid:mine", zone: zoneId, asteroidId: ast.id, hp: ast.hp, hpMax: ast.hpMax });
      }
    }
  }

  // ── SPATIAL GRID ──────────────────────────────────────────────────────

  private rebuildGrid(zs: ZoneState, players: OnlinePlayer[]): void {
    zs.grid.clear();
    for (const p of players) zs.grid.insert(p, p.posX, p.posY);
    for (const e of zs.enemies.values()) zs.grid.insert(e, e.pos.x, e.pos.y);
    for (const a of zs.asteroids.values()) {
      if (a.respawnAt === 0) zs.grid.insert(a, a.pos.x, a.pos.y);
    }
    for (const n of zs.npcShips.values()) zs.grid.insert(n, n.pos.x, n.pos.y);
  }

  // ── DELTA / SNAPSHOT GENERATION ───────────────────────────────────────

  private selfState(p: OnlinePlayer) {
    return {
      id: p.playerId,
      x: round2(p.posX), y: round2(p.posY),
      vx: round2(p.velX), vy: round2(p.velY),
      hp: round2(p.hull), hpMax: round2(p.hullMax),
      shield: round2(p.shield), shieldMax: round2(p.shieldMax),
      lastProcessedInput: p.lastProcessedInput,
    };
  }

  private getVisibleEntities(p: OnlinePlayer, zs: ZoneState, players: OnlinePlayer[]): any[] {
    const nearby = zs.grid.queryCircle(p.posX, p.posY, VIEW_RADIUS);
    const result: any[] = [];

    for (const entity of nearby) {
      if (entity === p) continue;

      // Check if it's a player (has playerId)
      if ('playerId' in entity && 'socketId' in entity) {
        result.push(this.serializePlayer(entity as OnlinePlayer));
      } else if ('behavior' in entity && 'hullMax' in entity) {
        result.push(this.serializeEnemy(entity as ServerEnemy));
      } else if ('yields' in entity) {
        result.push(this.serializeAsteroid(entity as ServerAsteroid));
      } else if ('targetPos' in entity && 'state' in entity) {
        result.push(this.serializeNpc(entity as ServerNpc));
      }
    }

    return result;
  }

  private buildDelta(p: OnlinePlayer, zoneId: string, zs: ZoneState, players: OnlinePlayer[]): DeltaPayload {
    const visible = this.getVisibleEntities(p, zs, players);
    const addOrUpdate: any[] = [];
    const currentVisibleIds = new Set<string>();

    for (const entity of visible) {
      currentVisibleIds.add(entity.id);
      const version = entity.version || 1;
      const prevVersion = p.visibleEntityVersions.get(entity.id);
      if (prevVersion !== version) {
        addOrUpdate.push(entity);
        p.visibleEntityVersions.set(entity.id, version);
      }
    }

    const removals: string[] = [];
    for (const knownId of p.visibleEntityVersions.keys()) {
      if (!currentVisibleIds.has(knownId)) {
        removals.push(knownId);
        p.visibleEntityVersions.delete(knownId);
      }
    }

    return {
      tick: this.tickCount,
      self: this.selfState(p),
      addOrUpdate,
      removals,
    };
  }

  private buildSnapshot(p: OnlinePlayer, zoneId: string, zs: ZoneState, players: OnlinePlayer[]): SnapshotPayload {
    const entities = this.getVisibleEntities(p, zs, players);

    // Reset visible entity tracking (snapshot is a full resync)
    p.visibleEntityVersions.clear();
    for (const entity of entities) {
      p.visibleEntityVersions.set(entity.id, entity.version || 1);
    }

    return {
      tick: this.tickCount,
      self: this.selfState(p),
      entities,
    };
  }

  // ── ENTITY SERIALIZATION ──────────────────────────────────────────────

  private serializePlayer(p: OnlinePlayer): any {
    return {
      id: `p-${p.playerId}`,
      entityType: "player",
      name: p.name,
      shipClass: p.shipClass,
      level: p.level,
      faction: p.faction,
      x: round2(p.posX), y: round2(p.posY),
      vx: round2(p.velX), vy: round2(p.velY),
      angle: round2(p.angle),
      hp: round2(p.hull), hpMax: round2(p.hullMax),
      shield: round2(p.shield), shieldMax: round2(p.shieldMax),
      honor: p.honor,
      version: p.version,
    };
  }

  private serializeEnemy(e: ServerEnemy): any {
    return {
      id: e.id,
      entityType: "enemy",
      type: e.type, behavior: e.behavior, name: e.name,
      x: round2(e.pos.x), y: round2(e.pos.y),
      vx: round2(e.vel.x), vy: round2(e.vel.y),
      angle: round2(e.angle),
      hp: e.hull, hpMax: e.hullMax,
      damage: e.damage, speed: e.speed,
      color: e.color, size: e.size,
      isBoss: e.isBoss, bossPhase: e.bossPhase,
      version: e.version,
    };
  }

  private serializeAsteroid(a: ServerAsteroid): any {
    return {
      id: a.id,
      entityType: "asteroid",
      x: round2(a.pos.x), y: round2(a.pos.y),
      hp: round2(a.hp), hpMax: a.hpMax,
      size: a.size, yields: a.yields,
      version: a.version,
    };
  }

  private serializeNpc(n: ServerNpc): any {
    return {
      id: n.id,
      entityType: "npc",
      name: n.name,
      x: round2(n.pos.x), y: round2(n.pos.y),
      vx: round2(n.vel.x), vy: round2(n.vel.y),
      angle: round2(n.angle),
      hp: n.hull, hpMax: n.hullMax,
      speed: n.speed, color: n.color, size: n.size,
      state: n.state,
      version: n.version,
    };
  }

  // ── ZONE STATE QUERIES (for initial load) ─────────────────────────────

  getZoneEnemies(zone: string): any[] {
    const zs = this.zones.get(zone);
    if (!zs) return [];
    return Array.from(zs.enemies.values()).map(e => this.serializeEnemy(e));
  }

  getZoneAsteroids(zone: string): any[] {
    const zs = this.zones.get(zone);
    if (!zs) return [];
    return Array.from(zs.asteroids.values())
      .filter(a => a.respawnAt === 0)
      .map(a => this.serializeAsteroid(a));
  }

  getZoneNpcs(zone: string): any[] {
    const zs = this.zones.get(zone);
    if (!zs) return [];
    return Array.from(zs.npcShips.values()).map(n => this.serializeNpc(n));
  }

  // ── ENEMY SPAWNING ────────────────────────────────────────────────────

  private tickEnemySpawns(zoneId: string, zs: ZoneState, players: OnlinePlayer[], dt: number, events: GameEvent[]): void {
    zs.spawnTimer -= dt;
    if (zs.spawnTimer > 0) return;
    zs.spawnTimer = randRange(1.5, 4);

    const zoneDef = ZONES[zoneId as ZoneId];
    if (!zoneDef) return;

    const maxEnemies = 18 + zoneDef.enemyTier * 4;
    const nonBossCount = Array.from(zs.enemies.values()).filter(e => !e.isBoss).length;
    if (nonBossCount >= maxEnemies) return;

    const tierMult = 1 + (zoneDef.enemyTier - 1) * 0.5;
    const typePool = zoneDef.enemyTypes;
    const enemyType = typePool[Math.floor(Math.random() * typePool.length)];
    const baseDef = ENEMY_DEFS[enemyType];
    if (!baseDef) return;

    const fMods = FACTION_ENEMY_MODS[zoneDef.faction]?.[enemyType];
    const hullMul = (fMods?.hullMul ?? 1) * tierMult;
    const dmgMul = (fMods?.damageMul ?? 1) * tierMult;
    const spdMul = fMods?.speedMul ?? 1;
    const color = fMods?.color ?? baseDef.color;

    let spawnPos: Vec2;
    if (players.length > 0 && Math.random() < 0.4) {
      const rp = players[Math.floor(Math.random() * players.length)];
      const ang = Math.random() * Math.PI * 2;
      const d = 500 + Math.random() * 500;
      spawnPos = {
        x: clamp(rp.posX + Math.cos(ang) * d, -MAP_RADIUS, MAP_RADIUS),
        y: clamp(rp.posY + Math.sin(ang) * d, -MAP_RADIUS, MAP_RADIUS),
      };
    } else {
      spawnPos = {
        x: randRange(-MAP_RADIUS * 0.9, MAP_RADIUS * 0.9),
        y: randRange(-MAP_RADIUS * 0.9, MAP_RADIUS * 0.9),
      };
    }

    const names = ENEMY_NAMES[enemyType];
    const name = names[Math.floor(Math.random() * names.length)];

    const enemy: ServerEnemy = {
      id: eid("e"),
      type: enemyType, behavior: baseDef.behavior, name,
      pos: { ...spawnPos }, vel: { x: 0, y: 0 },
      angle: Math.random() * Math.PI * 2,
      hull: Math.round(baseDef.hullMax * hullMul),
      hullMax: Math.round(baseDef.hullMax * hullMul),
      damage: Math.round(baseDef.damage * dmgMul),
      speed: Math.round(baseDef.speed * spdMul),
      exp: baseDef.exp, credits: baseDef.credits, honor: baseDef.honor,
      loot: baseDef.loot ? { ...baseDef.loot } : undefined,
      color, size: baseDef.size,
      isBoss: false, bossPhase: 0, phaseTimer: 0,
      fireTimer: randRange(1, 3), burstCd: 0, burstShots: 0,
      aggroTarget: null, aggroRange: 400,
      spawnPos: { ...spawnPos }, stunUntil: 0,
      combo: new Map(),
      version: 1,
    };

    zs.enemies.set(enemy.id, enemy);
    events.push({ type: "enemy:spawn", zone: zoneId, enemy: this.serializeEnemy(enemy) });
  }

  // ── BOSS SPAWNING ─────────────────────────────────────────────────────

  private tickBossSpawn(zoneId: string, zs: ZoneState, players: OnlinePlayer[], dt: number, events: GameEvent[]): void {
    if (zs.bossActive) return;
    zs.bossTimer -= dt;
    if (zs.bossTimer > 0) return;

    const zoneDef = ZONES[zoneId as ZoneId];
    if (!zoneDef) return;
    const tierMult = 1 + (zoneDef.enemyTier - 1) * 0.5;

    const bossType = zoneDef.enemyTypes[zoneDef.enemyTypes.length - 1];
    const baseDef = ENEMY_DEFS[bossType];
    if (!baseDef) return;

    const hpMul = randRange(4.5, 6.0) * tierMult;
    const dmgMul = randRange(3.0, 4.0) * tierMult;
    const fMods = FACTION_ENEMY_MODS[zoneDef.faction]?.[bossType];
    const color = fMods?.color ?? baseDef.color;

    const rp = players[Math.floor(Math.random() * players.length)];
    const spawnPos: Vec2 = rp
      ? { x: clamp(rp.posX + randRange(-600, 600), -MAP_RADIUS * 0.8, MAP_RADIUS * 0.8),
          y: clamp(rp.posY + randRange(-600, 600), -MAP_RADIUS * 0.8, MAP_RADIUS * 0.8) }
      : { x: 0, y: 0 };

    const boss: ServerEnemy = {
      id: eid("boss"),
      type: bossType, behavior: "tank",
      name: `BOSS ${ENEMY_NAMES[bossType][0]}`,
      pos: { ...spawnPos }, vel: { x: 0, y: 0 },
      angle: Math.random() * Math.PI * 2,
      hull: Math.round(baseDef.hullMax * hpMul),
      hullMax: Math.round(baseDef.hullMax * hpMul),
      damage: Math.round(baseDef.damage * dmgMul),
      speed: Math.round(baseDef.speed * 0.6),
      exp: Math.round(baseDef.exp * hpMul),
      credits: Math.round(baseDef.credits * hpMul * 2),
      honor: Math.round(baseDef.honor * hpMul),
      loot: { resourceId: "dread" as ResourceId, qty: Math.ceil(tierMult * 2) },
      color, size: Math.round(baseDef.size * 2.5),
      isBoss: true, bossPhase: 0,
      phaseTimer: randRange(10, 15),
      fireTimer: 1.4, burstCd: 0, burstShots: 3,
      aggroTarget: null, aggroRange: 800,
      spawnPos: { ...spawnPos }, stunUntil: 0,
      combo: new Map(),
      version: 1,
    };

    zs.enemies.set(boss.id, boss);
    zs.bossActive = true;
    events.push({ type: "boss:warn", zone: zoneId });
    events.push({ type: "enemy:spawn", zone: zoneId, enemy: this.serializeEnemy(boss) });
  }

  // ── ENEMY AI ──────────────────────────────────────────────────────────

  private tickEnemyAI(zoneId: string, zs: ZoneState, players: OnlinePlayer[], dt: number, events: GameEvent[]): void {
    for (const e of zs.enemies.values()) {
      if (Date.now() < e.stunUntil) continue;

      let target: OnlinePlayer | null = null;
      if (e.aggroTarget !== null) {
        target = players.find(p => p.playerId === e.aggroTarget) ?? null;
        if (!target || dist(e.pos, { x: target.posX, y: target.posY }) > e.aggroRange * 3) {
          e.aggroTarget = null;
          target = null;
        }
      }
      if (!target) {
        let closestDist = e.aggroRange;
        for (const p of players) {
          const d = dist(e.pos, { x: p.posX, y: p.posY });
          if (d < closestDist) {
            closestDist = d;
            target = p;
          }
        }
        if (target) e.aggroTarget = target.playerId;
      }

      const oldX = e.pos.x;
      const oldY = e.pos.y;

      if (target) {
        const tPos = { x: target.posX, y: target.posY };
        const d = dist(e.pos, tPos);
        const fireRange = e.isBoss ? 500 : (e.behavior === "ranged" ? 350 : 250);

        if (d > fireRange * 0.8) {
          const ang = angleFromTo(e.pos, tPos);
          e.angle = ang;
          e.vel.x = Math.cos(ang) * e.speed;
          e.vel.y = Math.sin(ang) * e.speed;
          e.pos.x += Math.cos(ang) * e.speed * dt;
          e.pos.y += Math.sin(ang) * e.speed * dt;
        } else {
          e.vel.x *= 0.9;
          e.vel.y *= 0.9;
          e.angle = angleFromTo(e.pos, tPos);
        }

        e.fireTimer -= dt;
        if (e.fireTimer <= 0 && d < fireRange) {
          e.fireTimer = e.isBoss ? this.bossFireCd(e) : (e.behavior === "fast" ? randRange(0.6, 1.0) : randRange(0.8, 1.5));
          const dmg = this.calcEnemyDamage(e);

          // Apply damage to player (shield absorbs first)
          const shieldDmg = Math.min(target.shield, dmg * target.shieldAbsorb);
          const hullDmg = dmg - shieldDmg;
          target.shield = Math.max(0, target.shield - shieldDmg);
          target.hull = Math.max(0, target.hull - hullDmg);
          target.lastHitTick = this.tickCount;
          target.version++;

          events.push({
            type: "enemy:attack", zone: zoneId,
            enemyId: e.id, targetId: target.playerId,
            damage: dmg, pos: { ...e.pos },
            targetPos: { x: target.posX, y: target.posY },
          });

          if (target.hull <= 0) {
            events.push({
              type: "player:damage", playerId: target.playerId,
              damage: dmg, shieldDmg, hullDmg,
            });
          }
        }

        if (e.isBoss) {
          e.phaseTimer -= dt;
          if (e.phaseTimer <= 0) {
            e.bossPhase = (e.bossPhase + 1) % 3;
            e.phaseTimer = randRange(10, 15);
          }
        }
      } else {
        const dFromSpawn = dist(e.pos, e.spawnPos);
        if (dFromSpawn > 300) {
          const ang = angleFromTo(e.pos, e.spawnPos);
          e.pos.x += Math.cos(ang) * e.speed * 0.3 * dt;
          e.pos.y += Math.sin(ang) * e.speed * 0.3 * dt;
          e.angle = ang;
        } else {
          e.pos.x += e.vel.x * dt;
          e.pos.y += e.vel.y * dt;
          e.vel.x *= 0.95;
          e.vel.y *= 0.95;
          if (Math.random() < 0.02) {
            const ang = Math.random() * Math.PI * 2;
            e.vel.x = Math.cos(ang) * e.speed * 0.2;
            e.vel.y = Math.sin(ang) * e.speed * 0.2;
            e.angle = ang;
          }
        }
      }

      e.pos.x = clamp(e.pos.x, -MAP_RADIUS, MAP_RADIUS);
      e.pos.y = clamp(e.pos.y, -MAP_RADIUS, MAP_RADIUS);

      if (e.pos.x !== oldX || e.pos.y !== oldY) e.version++;
    }
  }

  private bossFireCd(e: ServerEnemy): number {
    if (e.bossPhase === 0) return 1.4;
    if (e.bossPhase === 1) return 1.0;
    return 1.2;
  }

  private calcEnemyDamage(e: ServerEnemy): number {
    let dmg = e.damage;
    if (e.isBoss) dmg *= (e.bossPhase === 2 ? 1.5 : 1.0);
    return Math.round(dmg);
  }

  // ── NPC SHIPS ─────────────────────────────────────────────────────────

  private tickNpcSpawns(zoneId: string, zs: ZoneState, dt: number, events: GameEvent[]): void {
    zs.npcSpawnTimer -= dt;
    if (zs.npcSpawnTimer > 0) return;
    zs.npcSpawnTimer = randRange(8, 20);

    if (zs.npcShips.size >= 5) return;

    const spawnPos: Vec2 = {
      x: randRange(-MAP_RADIUS * 0.7, MAP_RADIUS * 0.7),
      y: randRange(-MAP_RADIUS * 0.7, MAP_RADIUS * 0.7),
    };
    const targetPos: Vec2 = {
      x: randRange(-MAP_RADIUS * 0.7, MAP_RADIUS * 0.7),
      y: randRange(-MAP_RADIUS * 0.7, MAP_RADIUS * 0.7),
    };

    const npc: ServerNpc = {
      id: eid("npc"),
      name: `NPC-${randInt(100, 999)}`,
      pos: { ...spawnPos }, vel: { x: 0, y: 0 },
      angle: angleFromTo(spawnPos, targetPos),
      hull: 200, hullMax: 200,
      speed: randRange(80, 120),
      damage: randRange(8, 14),
      fireTimer: randRange(0.8, 1.2),
      targetPos: { ...targetPos },
      state: "patrol", targetEnemyId: null,
      color: "#4ee2ff", size: 12,
      version: 1,
    };

    zs.npcShips.set(npc.id, npc);
    events.push({ type: "npc:spawn", zone: zoneId, npc: this.serializeNpc(npc) });
  }

  private tickNpcAI(zoneId: string, zs: ZoneState, dt: number, events: GameEvent[]): void {
    for (const npc of zs.npcShips.values()) {
      const oldX = npc.pos.x;
      const oldY = npc.pos.y;

      if (npc.state === "patrol") {
        const d = dist(npc.pos, npc.targetPos);
        if (d < 50) {
          npc.targetPos = {
            x: randRange(-MAP_RADIUS * 0.7, MAP_RADIUS * 0.7),
            y: randRange(-MAP_RADIUS * 0.7, MAP_RADIUS * 0.7),
          };
        }
        const ang = angleFromTo(npc.pos, npc.targetPos);
        npc.angle = ang;
        npc.vel.x = Math.cos(ang) * npc.speed;
        npc.vel.y = Math.sin(ang) * npc.speed;
        npc.pos.x += npc.vel.x * dt;
        npc.pos.y += npc.vel.y * dt;

        let closestEnemy: ServerEnemy | null = null;
        let closestDist = 350;
        for (const e of zs.enemies.values()) {
          const ed = dist(npc.pos, e.pos);
          if (ed < closestDist) {
            closestDist = ed;
            closestEnemy = e;
          }
        }
        if (closestEnemy) {
          npc.state = "fight";
          npc.targetEnemyId = closestEnemy.id;
        }
      } else {
        const target = npc.targetEnemyId ? zs.enemies.get(npc.targetEnemyId) : null;
        if (!target) {
          npc.state = "patrol";
          npc.targetEnemyId = null;
          continue;
        }

        const d = dist(npc.pos, target.pos);
        if (d > 300) {
          const ang = angleFromTo(npc.pos, target.pos);
          npc.angle = ang;
          npc.pos.x += Math.cos(ang) * npc.speed * dt;
          npc.pos.y += Math.sin(ang) * npc.speed * dt;
          npc.vel.x = Math.cos(ang) * npc.speed;
          npc.vel.y = Math.sin(ang) * npc.speed;
        } else {
          npc.angle = angleFromTo(npc.pos, target.pos);
          npc.vel.x *= 0.9;
          npc.vel.y *= 0.9;
        }

        npc.fireTimer -= dt;
        if (npc.fireTimer <= 0 && d < 300) {
          npc.fireTimer = randRange(0.8, 1.2);
          target.hull -= npc.damage;
          target.version++;
          if (target.hull <= 0) {
            zs.enemies.delete(target.id);
            npc.state = "patrol";
            npc.targetEnemyId = null;
          }
        }

        if (d > 600) {
          npc.state = "patrol";
          npc.targetEnemyId = null;
        }
      }

      npc.pos.x = clamp(npc.pos.x, -MAP_RADIUS, MAP_RADIUS);
      npc.pos.y = clamp(npc.pos.y, -MAP_RADIUS, MAP_RADIUS);

      if (npc.pos.x !== oldX || npc.pos.y !== oldY) npc.version++;
    }
  }

  // ── ASTEROIDS ─────────────────────────────────────────────────────────

  private spawnInitialAsteroids(zoneId: string, zs: ZoneState): void {
    const zoneDef = ZONES[zoneId as ZoneId];
    if (!zoneDef) return;

    const counts: Record<number, number> = { 1: 80, 2: 70, 3: 60, 4: 50, 5: 40, 6: 30, 7: 20 };
    const count = counts[zoneDef.enemyTier] ?? 50;

    for (let i = 0; i < count; i++) {
      const size = randRange(14, 36);
      const isLumenite = Math.random() < 0.18;
      const ast: ServerAsteroid = {
        id: eid("ast"),
        pos: {
          x: randRange(-MAP_RADIUS * 0.85, MAP_RADIUS * 0.85),
          y: randRange(-MAP_RADIUS * 0.85, MAP_RADIUS * 0.85),
        },
        hp: size * 4, hpMax: size * 4, size,
        yields: isLumenite ? "lumenite" as ResourceId : "iron" as ResourceId,
        respawnAt: 0,
        version: 1,
      };
      zs.asteroids.set(ast.id, ast);
    }
  }

  private tickAsteroidRespawn(zoneId: string, zs: ZoneState, dt: number, events: GameEvent[]): void {
    const now = Date.now();
    for (const ast of zs.asteroids.values()) {
      if (ast.respawnAt > 0 && now >= ast.respawnAt) {
        ast.respawnAt = 0;
        const size = randRange(14, 36);
        ast.size = size;
        ast.hp = size * 4;
        ast.hpMax = size * 4;
        ast.pos = {
          x: randRange(-MAP_RADIUS * 0.85, MAP_RADIUS * 0.85),
          y: randRange(-MAP_RADIUS * 0.85, MAP_RADIUS * 0.85),
        };
        ast.yields = (Math.random() < 0.18 ? "lumenite" : "iron") as ResourceId;
        ast.version++;
        events.push({ type: "asteroid:respawn", zone: zoneId, asteroid: this.serializeAsteroid(ast) });
      }
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────────────

  private getZoneTierMult(zone: string): number {
    const z = ZONES[zone as ZoneId];
    if (!z) return 1;
    return 1 + (z.enemyTier - 1) * 0.5;
  }
}
