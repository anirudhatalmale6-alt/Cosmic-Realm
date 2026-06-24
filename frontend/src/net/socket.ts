import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

// ── TYPES ────────────────────────────────────────────────────────────────

export type RemotePlayer = {
  id: number;
  name: string;
  shipClass: string;
  level: number;
  faction: string | null;
  clan: string | null;
  zone: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hull: number;
  hullMax: number;
  shield: number;
  shieldMax: number;
  honor: number;
};

export type WelcomePayload = {
  playerId: number;
  tickRate: number;
  friction: number;
  frictionRefFps: number;
};

export type DeltaEntity = {
  id: string;
  entityType: "player" | "enemy" | "npc" | "asteroid";
  x: number; y: number;
  vx?: number; vy?: number;
  angle?: number;
  hp?: number; hpMax?: number;
  shield?: number; shieldMax?: number;
  version: number;
  // Player-specific
  name?: string;
  shipClass?: string;
  level?: number;
  faction?: string | null;
  honor?: number;
  // Enemy-specific
  type?: string;
  behavior?: string;
  damage?: number;
  speed?: number;
  color?: string;
  size?: number;
  isBoss?: boolean;
  bossPhase?: number;
  // NPC-specific
  state?: string;
  // Asteroid-specific
  yields?: string;
};

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
  addOrUpdate: DeltaEntity[];
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
  entities: DeltaEntity[];
};

export type ServerEnemy = {
  id: string; type: string; behavior: string; name: string;
  x: number; y: number; vx: number; vy: number; angle: number;
  hull: number; hullMax: number; damage: number; speed: number;
  color: string; size: number; isBoss: boolean; bossPhase: number;
};

export type ServerAsteroid = {
  id: string; x: number; y: number;
  hp: number; hpMax: number; size: number; yields: string;
};

export type ServerNpc = {
  id: string; name: string;
  x: number; y: number; vx: number; vy: number; angle: number;
  hull: number; hullMax: number; speed: number;
  color: string; size: number; state: string;
};

export type CombatEvent = {
  attackerId: number;
  targetId: number;
  weaponKind: string;
  damage: number;
};

export type EnemyHitEvent = {
  enemyId: string;
  damage: number;
  hp: number;
  hpMax: number;
  crit: boolean;
  attackerId: number;
};

export type EnemyDieEvent = {
  enemyId: string;
  killerId: number;
  loot: { credits: number; exp: number; honor: number; resource?: { resourceId: string; qty: number } };
  pos: { x: number; y: number };
};

export type EnemyAttackEvent = {
  enemyId: string;
  targetId: number;
  damage: number;
  pos: { x: number; y: number };
  targetPos: { x: number; y: number };
};

export type LaserFireEvent = {
  attackerId: number;
  targetId: string;
  damage: number;
  crit: boolean;
};

export type RocketFireEvent = {
  attackerId: number;
  targetId: string;
  damage: number;
  crit: boolean;
  pos: { x: number; y: number };
  targetPos: { x: number; y: number };
};

export type ProjectileSpawnEvent = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  color: string;
  size: number;
  crit: boolean;
  weaponKind: "laser" | "rocket";
  homing: boolean;
  fromPlayer: boolean;
};

type SocketEvents = {
  onWelcome: (payload: WelcomePayload) => void;
  onDelta: (payload: DeltaPayload) => void;
  onSnapshot: (payload: SnapshotPayload) => void;
  onPlayerJoin: (player: { id: number; name: string; shipClass: string; level: number; faction: string | null; zone: string }) => void;
  onPlayerLeave: (data: { playerId: number }) => void;
  onCombatAttack: (event: CombatEvent) => void;
  onChatMessage: (msg: { from: string; text: string; channel: string; time: number }) => void;
  onOnlineCount: (count: number) => void;
  onZoneEnemies: (enemies: ServerEnemy[]) => void;
  onZoneAsteroids: (asteroids: ServerAsteroid[]) => void;
  onZoneNpcs: (npcs: ServerNpc[]) => void;
  onEnemySpawn: (enemy: ServerEnemy) => void;
  onEnemyDie: (event: EnemyDieEvent) => void;
  onEnemyHit: (event: EnemyHitEvent) => void;
  onEnemyAttack: (event: EnemyAttackEvent) => void;
  onPlayerHit: (data: { damage: number; hp: number; shield: number }) => void;
  onPlayerDie: (data: { playerId: number; pos: { x: number; y: number } }) => void;
  onAsteroidMine: (data: { asteroidId: string; hp: number; hpMax: number }) => void;
  onAsteroidDestroy: (data: { asteroidId: string; playerId: number; ore: { resourceId: string; qty: number } }) => void;
  onAsteroidRespawn: (asteroid: ServerAsteroid) => void;
  onBossWarn: () => void;
  onNpcSpawn: (npc: ServerNpc) => void;
  onNpcDie: (data: { npcId: string }) => void;
  onProjectileSpawn: (event: ProjectileSpawnEvent) => void;
  onLaserFire: (event: LaserFireEvent) => void;
  onRocketFire: (event: RocketFireEvent) => void;
};

let listeners: Partial<SocketEvents> = {};

export function connectSocket(token: string) {
  if (socket?.connected) return;

  socket = io(window.location.origin, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  socket.on("connect", () => {
    console.log("[Socket] Connected:", socket!.id);
  });

  socket.on("disconnect", (reason) => {
    console.log("[Socket] Disconnected:", reason);
  });

  // Server authority events
  socket.on("welcome", (payload: WelcomePayload) => {
    listeners.onWelcome?.(payload);
  });

  socket.on("delta", (payload: DeltaPayload) => {
    listeners.onDelta?.(payload);
  });

  socket.on("snapshot", (payload: SnapshotPayload) => {
    listeners.onSnapshot?.(payload);
  });

  // Player events
  socket.on("player:join", (player) => {
    listeners.onPlayerJoin?.(player);
  });

  socket.on("player:leave", (data: { playerId: number }) => {
    listeners.onPlayerLeave?.(data);
  });

  socket.on("combat:attack", (event: CombatEvent) => {
    listeners.onCombatAttack?.(event);
  });

  socket.on("chat:message", (msg) => {
    listeners.onChatMessage?.(msg);
  });

  socket.on("online:count", (count: number) => {
    listeners.onOnlineCount?.(count);
  });

  // Zone state (initial load + warp)
  socket.on("zone:enemies", (enemies: ServerEnemy[]) => {
    listeners.onZoneEnemies?.(enemies);
  });

  socket.on("zone:asteroids", (asteroids: ServerAsteroid[]) => {
    listeners.onZoneAsteroids?.(asteroids);
  });

  socket.on("zone:npcs", (npcs: ServerNpc[]) => {
    listeners.onZoneNpcs?.(npcs);
  });

  // Game events
  socket.on("enemy:spawn", (enemy: ServerEnemy) => {
    listeners.onEnemySpawn?.(enemy);
  });

  socket.on("enemy:die", (event: EnemyDieEvent) => {
    listeners.onEnemyDie?.(event);
  });

  socket.on("enemy:hit", (event: EnemyHitEvent) => {
    listeners.onEnemyHit?.(event);
  });

  socket.on("enemy:attack", (event: EnemyAttackEvent) => {
    listeners.onEnemyAttack?.(event);
  });

  socket.on("player:hit", (data: { damage: number; hp: number; shield: number }) => {
    listeners.onPlayerHit?.(data);
  });

  socket.on("player:die", (data: { playerId: number; pos: { x: number; y: number } }) => {
    listeners.onPlayerDie?.(data);
  });

  socket.on("asteroid:mine", (data: { asteroidId: string; hp: number; hpMax: number }) => {
    listeners.onAsteroidMine?.(data);
  });

  socket.on("asteroid:destroy", (data: { asteroidId: string; playerId: number; ore: { resourceId: string; qty: number } }) => {
    listeners.onAsteroidDestroy?.(data);
  });

  socket.on("asteroid:respawn", (asteroid: ServerAsteroid) => {
    listeners.onAsteroidRespawn?.(asteroid);
  });

  socket.on("boss:warn", () => {
    listeners.onBossWarn?.();
  });

  socket.on("npc:spawn", (npc: ServerNpc) => {
    listeners.onNpcSpawn?.(npc);
  });

  socket.on("npc:die", (data: { npcId: string }) => {
    listeners.onNpcDie?.(data);
  });

  socket.on("projectile:spawn", (event: ProjectileSpawnEvent) => {
    listeners.onProjectileSpawn?.(event);
  });

  socket.on("laser:fire", (event: LaserFireEvent) => {
    listeners.onLaserFire?.(event);
  });

  socket.on("rocket:fire", (event: RocketFireEvent) => {
    listeners.onRocketFire?.(event);
  });
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function setSocketListeners(l: Partial<SocketEvents>) {
  listeners = l;
}

// ── Outgoing events ──────────────────────────────────────────────────────

let _inputSeq = 0;

export function sendInput(data: {
  targetX: number | null;
  targetY: number | null;
  firing: boolean;
  rocketFiring: boolean;
  attackTargetId: string | null;
  miningTargetId: string | null;
  laserAmmo: string;
  rocketAmmo: string;
}): number {
  const seq = ++_inputSeq;
  if (typeof data.targetX === "number" && Number.isFinite(data.targetX) && typeof data.targetY === "number" && Number.isFinite(data.targetY)) {
    socket?.emit("input:move", {
      x: data.targetX,
      y: data.targetY,
    });
  }
  socket?.emit("input:attack", {
    enemyId: data.attackTargetId,
    laser: data.firing,
    rocket: data.rocketFiring,
    laserAmmo: data.laserAmmo,
    rocketAmmo: data.rocketAmmo,
  });
  socket?.emit("input:mine", {
    asteroidId: data.miningTargetId,
  });
  return seq;
}

export function sendWarp(toZone: string, x: number, y: number) {
  socket?.emit("warp", { toZone, x, y });
}

export function sendAttack(targetPlayerId: number, damage: number, weaponKind: string) {
  socket?.emit("attack", { targetPlayerId, damage, weaponKind });
}

export function sendChat(channel: string, text: string) {
  socket?.emit("chat", { channel, text });
}

export function sendStatsUpdate(data: {
  hull?: number; shield?: number; level?: number; shipClass?: string; honor?: number;
  inventory?: any[]; equipped?: any; skills?: any; drones?: any[]; faction?: string;
}) {
  socket?.emit("stats:update", data);
}

export function isConnected(): boolean {
  return socket?.connected ?? false;
}

export function getInputSeq(): number {
  return _inputSeq;
}
