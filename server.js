const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`APEX BATTLEGROUNDS server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const WORLD_W = 3000, WORLD_H = 3000, ARENA_MARGIN = 60;
const TICK_RATE = 50; // ms between state broadcasts (20/sec)
const GAME_DURATION = 5 * 60 * 1000; // 5 minutes in ms
const MAX_PLAYERS = 4;
const PLAYER_COLORS = ['#4488ff', '#44ff88', '#ff8844', '#ff44cc'];
const PLAYER_GLOW   = ['#2255cc', '#22cc55', '#cc5522', '#cc2288'];

// ─── ROOM STORE ───────────────────────────────────────────────────────────────
const rooms = new Map(); // code → room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

// ─── OBSTACLE GENERATION (must match client) ──────────────────────────────────
function genObstacles(seed) {
  const rng = mulberry32(seed);
  const obs = [];
  for (let i = 0; i < 13; i++) {
    for (let a = 0; a < 80; a++) {
      const x = ARENA_MARGIN + rng() * (WORLD_W - ARENA_MARGIN * 2);
      const y = ARENA_MARGIN + rng() * (WORLD_H - ARENA_MARGIN * 2);
      const r = 30 + rng() * 40;
      if (Math.hypot(x - WORLD_W/2, y - WORLD_H/2) < 200) continue;
      if (!obs.some(o => Math.hypot(x - o.x, y - o.y) < r + o.r + 30)) { obs.push({x, y, r}); break; }
    }
  }
  return obs;
}

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function circleVsObs(x, y, r, obstacles) {
  for (const o of obstacles) {
    const d = Math.hypot(x - o.x, y - o.y);
    if (d < r + o.r) {
      const a = Math.atan2(y - o.y, x - o.x);
      return { nx: Math.cos(a), ny: Math.sin(a), push: r + o.r - d };
    }
  }
  return null;
}

// ─── ENEMY AI (server-authoritative) ─────────────────────────────────────────
function createEnemy(tier, x, y) {
  const S = [
    {hp:80,  spd:1.5, r:16, atk:12},
    {hp:150, spd:2.2, r:17, atk:20},
    {hp:250, spd:2.8, r:18, atk:30},
    {hp:600, spd:2.0, r:24, atk:45}
  ][tier];
  return {
    id: uuidv4(),
    x, y, tier,
    radius: S.r, hp: S.hp, maxHp: S.hp, spd: S.spd, atk: S.atk,
    color: ['#ffffff','#ffdd22','#ff8822','#ff1111'][tier],
    vx: 0, vy: 0, state: 'IDLE',
    staggerTimer: 0, attackCooldown: 0, dashCooldown: 0,
    hitFlash: 0, dead: false, deathTimer: 0,
    idleDir: Math.random() * Math.PI * 2,
    idleTimer: 60 + Math.random() * 60,
    glowPhase: Math.random() * Math.PI * 2,
    slowed: false, slowTimer: 0
  };
}

// ─── ROOM ─────────────────────────────────────────────────────────────────────
function createRoom(code) {
  const seed = Math.floor(Math.random() * 0xFFFFFFFF);
  const obstacles = genObstacles(seed);
  return {
    code,
    hostId: null,
    players: new Map(),   // playerId → playerState
    clients: new Map(),   // playerId → ws
    phase: 'lobby',       // lobby | playing | gameover
    enemies: [],
    spawnTimer: 0,
    spawnInterval: 900,
    elapsed: 0,           // ticks
    seed,
    obstacles,
    tickInterval: null,
    startTime: null,
    chatLog: []
  };
}

function getSpawnPos(room) {
  const alivePlayers = [...room.players.values()].filter(p => !p.dead);
  for (let t = 0; t < 50; t++) {
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    if (edge === 0) { x = ARENA_MARGIN + Math.random()*(WORLD_W - ARENA_MARGIN*2); y = ARENA_MARGIN + 20; }
    else if (edge === 1) { x = WORLD_W - ARENA_MARGIN - 20; y = ARENA_MARGIN + Math.random()*(WORLD_H - ARENA_MARGIN*2); }
    else if (edge === 2) { x = ARENA_MARGIN + Math.random()*(WORLD_W - ARENA_MARGIN*2); y = WORLD_H - ARENA_MARGIN - 20; }
    else { x = ARENA_MARGIN + 20; y = ARENA_MARGIN + Math.random()*(WORLD_H - ARENA_MARGIN*2); }
    const tooClose = alivePlayers.some(p => Math.hypot(x - p.x, y - p.y) < 350);
    if (!tooClose) return { x, y };
  }
  return { x: ARENA_MARGIN + 50, y: ARENA_MARGIN + 50 };
}

function spawnEnemy(room, forceTier) {
  const alive = room.enemies.filter(e => !e.dead).length;
  if (alive >= 12) return;
  const { x, y } = getSpawnPos(room);
  let tier = forceTier;
  if (tier === undefined) {
    const r = Math.random(), el = room.elapsed / 60;
    if (el < 30) tier = r < 0.7 ? 0 : 1;
    else if (el < 90) tier = r < 0.4 ? 0 : r < 0.75 ? 1 : r < 0.95 ? 2 : 3;
    else tier = r < 0.2 ? 0 : r < 0.5 ? 1 : r < 0.75 ? 2 : 3;
  }
  room.enemies.push(createEnemy(tier, x, y));
}

function updateEnemyAI(e, room) {
  e.hitFlash = Math.max(0, e.hitFlash - 1);
  if (e.attackCooldown > 0) e.attackCooldown--;
  if (e.dashCooldown > 0) e.dashCooldown--;
  e.glowPhase += 0.05;
  if (e.slowed && --e.slowTimer <= 0) e.slowed = false;

  // Find nearest alive player
  const alivePlayers = [...room.players.values()].filter(p => !p.dead);
  if (alivePlayers.length === 0) return;
  let target = null, minDist = Infinity;
  for (const p of alivePlayers) {
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d < minDist) { minDist = d; target = p; }
  }
  if (!target) return;

  const dp = minDist;
  const ap = Math.atan2(target.y - e.y, target.x - e.x);
  const sm = e.slowed ? 0.35 : 1;

  if (e.staggerTimer > 0) { e.staggerTimer--; e.state = 'STAGGER'; }
  else if (e.state === 'STAGGER') e.state = 'CHASE';

  if (e.state !== 'STAGGER') {
    if (dp > 300) e.state = 'IDLE';
    else if (dp > (e.tier === 3 ? 100 : 60)) e.state = 'CHASE';
    else e.state = 'ATTACK';
  }

  if (e.state === 'IDLE') {
    if (--e.idleTimer <= 0) { e.idleDir = Math.random() * Math.PI * 2; e.idleTimer = 60 + Math.random() * 60; }
    e.vx += Math.cos(e.idleDir) * 0.15;
    e.vy += Math.sin(e.idleDir) * 0.15;
  } else if (e.state === 'CHASE') {
    if (e.tier >= 2 && e.dashCooldown === 0 && Math.random() < 0.005) {
      e.dashCooldown = 120;
      const sa = ap + (Math.random() < 0.5 ? Math.PI/2 : -Math.PI/2);
      e.vx += Math.cos(sa) * 10; e.vy += Math.sin(sa) * 10;
    }
    e.vx += Math.cos(ap) * 0.4 * sm;
    e.vy += Math.sin(ap) * 0.4 * sm;
    const sp2 = Math.hypot(e.vx, e.vy);
    if (sp2 > e.spd * sm) { e.vx = e.vx/sp2 * e.spd * sm; e.vy = e.vy/sp2 * e.spd * sm; }
  } else if (e.state === 'ATTACK' && e.attackCooldown === 0) {
    if (e.tier >= 1 && e.dashCooldown === 0 && dp > 40 && Math.random() < 0.3) {
      e.dashCooldown = 150;
      e.vx += Math.cos(ap) * 14 * sm; e.vy += Math.sin(ap) * 14 * sm;
      if (dp < 100) damagePlayer(room, target, e.atk * 0.8);
    } else {
      e.attackCooldown = e.tier === 3 ? 60 : 90;
      if (dp < 65 + e.radius) damagePlayer(room, target, e.atk);
    }
  }

  e.vx *= 0.82; e.vy *= 0.82;
  e.x += e.vx; e.y += e.vy;
  e.x = Math.max(ARENA_MARGIN + e.radius, Math.min(WORLD_W - ARENA_MARGIN - e.radius, e.x));
  e.y = Math.max(ARENA_MARGIN + e.radius, Math.min(WORLD_H - ARENA_MARGIN - e.radius, e.y));

  const obs = circleVsObs(e.x, e.y, e.radius, room.obstacles);
  if (obs) { e.x += obs.nx * obs.push; e.y += obs.ny * obs.push; }

  for (const o of room.enemies) {
    if (o === e || o.dead) continue;
    const d = Math.hypot(e.x - o.x, e.y - o.y), md = e.radius + o.radius + 2;
    if (d < md && d > 0) {
      const nx = (e.x - o.x)/d, ny = (e.y - o.y)/d, push = (md-d)*0.3;
      e.x += nx*push; e.y += ny*push; o.x -= nx*push; o.y -= ny*push;
    }
  }
}

function damagePlayer(room, playerState, amount) {
  if (playerState.invincible > 0 || playerState.smokeMode || playerState.ironFort || playerState.dead) return;
  let dmg = amount * (playerState.defense || 0.8);
  if (playerState.blocking) dmg *= 0.4;
  playerState.hp = Math.max(0, playerState.hp - dmg);

  broadcast(room, {
    type: 'player_hit',
    playerId: playerState.id,
    newHp: playerState.hp,
    amount: Math.round(dmg)
  });

  if (playerState.hp <= 0 && !playerState.dead) {
    playerState.dead = true;
    playerState.deathTime = room.elapsed;
    broadcast(room, { type: 'player_died', playerId: playerState.id });
    checkGameOver(room);
  }
}

function processHit(room, attackerId, enemyId, dmgAmount) {
  const enemy = room.enemies.find(e => e.id === enemyId);
  if (!enemy || enemy.dead) return;

  const attacker = room.players.get(attackerId);
  const dmgMult = attacker ? (attacker.dmgMult || 1.0) : 1.0;
  const critChance = attacker ? (attacker.critChance || 0.1) : 0.1;
  const crit = Math.random() < critChance;
  let dmg = Math.min(dmgAmount * dmgMult, enemy.maxHp); // cap to prevent cheating
  if (crit) dmg *= 1.5;

  enemy.hp -= dmg;
  enemy.hitFlash = 10;
  enemy.staggerTimer = enemy.tier === 3 ? 10 : 20;
  enemy.state = 'STAGGER';

  if (enemy.hp <= 0 && !enemy.dead) {
    enemy.dead = true;
    enemy.deathTimer = 30;
    if (attacker) {
      attacker.kills = (attacker.kills || 0) + 1;
      const xpGain = [15, 30, 60, 150][enemy.tier];
      attacker.xp = (attacker.xp || 0) + xpGain;
      // Level up logic
      while (attacker.xp >= attacker.xpToNext) {
        attacker.xp -= attacker.xpToNext;
        attacker.level = (attacker.level || 1) + 1;
        attacker.xpToNext = Math.floor(attacker.xpToNext * 1.4);
        attacker.maxHp += 25;
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + 25);
        attacker.dmgMult += 0.1;
        attacker.speed += 0.05;
      }
    }
    broadcast(room, {
      type: 'enemy_killed',
      enemyId: enemy.id,
      killerId: attackerId,
      killerKills: attacker ? attacker.kills : 0
    });
  } else {
    broadcast(room, {
      type: 'enemy_hit',
      enemyId: enemy.id,
      newHp: enemy.hp,
      dmg: Math.round(dmg),
      crit
    });
  }
}

function checkGameOver(room) {
  const alive = [...room.players.values()].filter(p => !p.dead);
  if (alive.length > 0) return;
  endGame(room);
}

function endGame(room) {
  room.phase = 'gameover';
  clearInterval(room.tickInterval);
  const scores = [...room.players.values()].map(p => ({
    id: p.id,
    slot: p.slot,
    kills: p.kills || 0,
    damageTaken: p.damageTaken || 0,
    timeSurvived: p.deathTime || room.elapsed,
    classId: p.classId
  })).sort((a, b) => b.kills - a.kills);
  broadcast(room, { type: 'game_over', scores });
}

function gameTick(room) {
  if (room.phase !== 'playing') return;
  room.elapsed++;

  // Spawn enemies
  if (++room.spawnTimer >= room.spawnInterval) {
    room.spawnTimer = 0;
    const count = 1 + Math.floor(room.elapsed / 3600);
    for (let i = 0; i < Math.min(count, 3); i++) spawnEnemy(room);
    room.spawnInterval = Math.max(400, room.spawnInterval - 30);
  }

  // Update enemy AI
  for (let i = room.enemies.length - 1; i >= 0; i--) {
    const e = room.enemies[i];
    if (e.dead) {
      if (--e.deathTimer <= 0) { room.enemies.splice(i, 1); }
      continue;
    }
    updateEnemyAI(e, room);
  }

  // Decay invincibility / smoke / ironfort timers on server player states
  for (const p of room.players.values()) {
    if (p.invincible > 0) p.invincible--;
    if (p.smokeMode && --p.smokeTimer <= 0) p.smokeMode = false;
    if (p.ironFort && --p.ironTimer <= 0) p.ironFort = false;
    if (p.rageMode && --p.rageTimer <= 0) { p.rageMode = false; p.dmgMult /= 2; }
    if (p.blocking !== undefined && p.invincible > 0) {} // handled by client
  }

  // Check time limit
  if (room.elapsed >= GAME_DURATION / (TICK_RATE / 60)) {
    endGame(room);
    return;
  }

  // Broadcast state every tick
  const state = {
    type: 'game_state',
    elapsed: room.elapsed,
    players: Object.fromEntries(
      [...room.players.entries()].map(([id, p]) => [id, {
        x: p.x, y: p.y, angle: p.angle, state: p.animState,
        hp: p.hp, maxHp: p.maxHp, dead: p.dead,
        kills: p.kills, level: p.level, xp: p.xp, xpToNext: p.xpToNext,
        blocking: p.blocking, smokeMode: p.smokeMode, rageMode: p.rageMode,
        ironFort: p.ironFort, invincible: p.invincible,
        classId: p.classId, slot: p.slot,
        dmgMult: p.dmgMult, speed: p.speed
      }])
    ),
    enemies: room.enemies.filter(e => !e.dead || e.deathTimer > 0).map(e => ({
      id: e.id, x: e.x, y: e.y, tier: e.tier, hp: e.hp, maxHp: e.maxHp,
      dead: e.dead, deathTimer: e.deathTimer, hitFlash: e.hitFlash,
      state: e.state, slowed: e.slowed, glowPhase: e.glowPhase,
      radius: e.radius, color: e.color
    }))
  };
  broadcast(room, state);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  for (const ws of room.clients.values()) {
    if (ws.readyState === 1) ws.send(str);
  }
}

function broadcastExcept(room, exceptId, msg) {
  const str = JSON.stringify(msg);
  for (const [pid, ws] of room.clients.entries()) {
    if (pid !== exceptId && ws.readyState === 1) ws.send(str);
  }
}

function startGame(room) {
  room.phase = 'playing';
  room.elapsed = 0;
  room.enemies = [];
  room.spawnTimer = 0;
  room.spawnInterval = 900;
  room.startTime = Date.now();

  // Spawn initial enemies
  for (let i = 0; i < 3; i++) spawnEnemy(room, 0);

  // Position players at spread spawn points
  const spawns = [
    { x: WORLD_W/2 - 80, y: WORLD_H/2 - 80 },
    { x: WORLD_W/2 + 80, y: WORLD_H/2 - 80 },
    { x: WORLD_W/2 - 80, y: WORLD_H/2 + 80 },
    { x: WORLD_W/2 + 80, y: WORLD_H/2 + 80 }
  ];

  let i = 0;
  for (const p of room.players.values()) {
    const sp = spawns[i++ % 4];
    p.x = sp.x; p.y = sp.y;
    p.dead = false;
    p.hp = p.maxHp;
    p.kills = 0;
    p.xp = 0;
    p.xpToNext = 100;
    p.level = 1;
    p.dmgMult = p._baseDmgMult || 1.0;
    p.speed = p._baseSpeed || 3.5;
    p.invincible = 0;
    p.smokeMode = false;
    p.ironFort = false;
    p.rageMode = false;
  }

  broadcast(room, {
    type: 'game_started',
    seed: room.seed,
    players: Object.fromEntries(
      [...room.players.entries()].map(([id, p]) => [id, {
        x: p.x, y: p.y, slot: p.slot, classId: p.classId,
        hp: p.hp, maxHp: p.maxHp, kills: 0, level: 1
      }])
    )
  });

  room.tickInterval = setInterval(() => gameTick(room), TICK_RATE / 60);
}

// ─── WEBSOCKET HANDLER ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      playerId = uuidv4();
      roomCode = genCode();
      const room = createRoom(roomCode);
      room.hostId = playerId;
      rooms.set(roomCode, room);

      const slot = 0;
      room.players.set(playerId, {
        id: playerId, slot,
        name: msg.name || `P${slot+1}`,
        classId: 'brawler',
        x: WORLD_W/2, y: WORLD_H/2,
        angle: 0, animState: 'idle',
        hp: 400, maxHp: 400,
        speed: 3.5, dmgMult: 1.0, defense: 0.8, critChance: 0.1,
        _baseDmgMult: 1.0, _baseSpeed: 3.5,
        xp: 0, xpToNext: 100, level: 1,
        kills: 0, damageTaken: 0, dead: false,
        blocking: false, smokeMode: false, rageMode: false, ironFort: false,
        invincible: 0, smokeTimer: 0, rageTimer: 0, ironTimer: 0
      });
      room.clients.set(playerId, ws);

      send(ws, { type: 'room_created', code: roomCode, playerId, slot, seed: room.seed });

    } else if (msg.type === 'join_room') {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'Game already in progress' });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Room is full' });

      playerId = uuidv4();
      roomCode = msg.code.toUpperCase();

      // Find next available slot
      const usedSlots = new Set([...room.players.values()].map(p => p.slot));
      let slot = 0;
      while (usedSlots.has(slot)) slot++;

      const classDefs = {
        brawler:  { hp:400, spd:2.8, dmg:1.5, def:0.7, crit:0.08 },
        assassin: { hp:180, spd:5.2, dmg:1.1, def:1.0, crit:0.35 },
        mage:     { hp:250, spd:3.2, dmg:1.3, def:0.9, crit:0.12 },
        tank:     { hp:550, spd:2.3, dmg:0.9, def:0.5, crit:0.05 }
      };
      const cd = classDefs.brawler;

      room.players.set(playerId, {
        id: playerId, slot,
        name: msg.name || `P${slot+1}`,
        classId: 'brawler',
        x: WORLD_W/2, y: WORLD_H/2,
        angle: 0, animState: 'idle',
        hp: cd.hp, maxHp: cd.hp,
        speed: cd.spd, dmgMult: cd.dmg, defense: cd.def, critChance: cd.crit,
        _baseDmgMult: cd.dmg, _baseSpeed: cd.spd,
        xp: 0, xpToNext: 100, level: 1,
        kills: 0, damageTaken: 0, dead: false,
        blocking: false, smokeMode: false, rageMode: false, ironFort: false,
        invincible: 0, smokeTimer: 0, rageTimer: 0, ironTimer: 0
      });
      room.clients.set(playerId, ws);

      const existingPlayers = [...room.players.entries()]
        .filter(([id]) => id !== playerId)
        .map(([, p]) => ({ id: p.id, slot: p.slot, name: p.name, classId: p.classId, hp: p.hp, maxHp: p.maxHp }));

      send(ws, { type: 'room_joined', code: roomCode, playerId, slot, existingPlayers, seed: room.seed, hostId: room.hostId });
      broadcastExcept(room, playerId, { type: 'player_joined', player: { id: playerId, slot, name: room.players.get(playerId).name, classId: 'brawler' } });

    } else if (msg.type === 'set_class') {
      const room = rooms.get(roomCode);
      if (!room) return;
      const p = room.players.get(playerId);
      if (!p || room.phase !== 'lobby') return;

      const classDefs = {
        brawler:  { hp:400, spd:2.8, dmg:1.5, def:0.7, crit:0.08 },
        assassin: { hp:180, spd:5.2, dmg:1.1, def:1.0, crit:0.35 },
        mage:     { hp:250, spd:3.2, dmg:1.3, def:0.9, crit:0.12 },
        tank:     { hp:550, spd:2.3, dmg:0.9, def:0.5, crit:0.05 }
      };
      const cd = classDefs[msg.classId] || classDefs.brawler;
      p.classId = msg.classId;
      p.hp = cd.hp; p.maxHp = cd.hp;
      p.speed = cd.spd; p.dmgMult = cd.dmg;
      p._baseDmgMult = cd.dmg; p._baseSpeed = cd.spd;
      p.defense = cd.def; p.critChance = cd.crit;

      broadcast(room, { type: 'player_class_changed', playerId, classId: msg.classId });

    } else if (msg.type === 'start_game') {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId || room.phase !== 'lobby') return;
      if (room.players.size < 1) return;
      startGame(room);

    } else if (msg.type === 'player_update') {
      const room = rooms.get(roomCode);
      if (!room || room.phase !== 'playing') return;
      const p = room.players.get(playerId);
      if (!p || p.dead) return;

      // Update position (trust client for movement, server will reconcile via state)
      p.x = Math.max(ARENA_MARGIN + 18, Math.min(WORLD_W - ARENA_MARGIN - 18, msg.x || p.x));
      p.y = Math.max(ARENA_MARGIN + 18, Math.min(WORLD_H - ARENA_MARGIN - 18, msg.y || p.y));
      p.angle = msg.angle || 0;
      p.animState = msg.state || 'idle';
      p.blocking = !!msg.blocking;
      p.smokeMode = !!msg.smokeMode;
      p.rageMode = !!msg.rageMode;
      p.ironFort = !!msg.ironFort;
      p.invincible = Math.max(0, msg.invincible || 0);

    } else if (msg.type === 'player_attack') {
      const room = rooms.get(roomCode);
      if (!room || room.phase !== 'playing') return;
      const p = room.players.get(playerId);
      if (!p || p.dead) return;

      // Validate and process hits
      const hitIds = Array.isArray(msg.hitEnemyIds) ? msg.hitEnemyIds.slice(0, 10) : [];
      const baseDmg = Math.min(Math.abs(msg.dmg || 15), 200); // cap damage
      for (const eid of hitIds) {
        processHit(room, playerId, eid, baseDmg);
      }
      // Echo attack to other players for visual effects
      broadcastExcept(room, playerId, {
        type: 'player_attacked',
        playerId, skillId: msg.skillId,
        x: p.x, y: p.y, angle: p.angle
      });

    } else if (msg.type === 'apply_skill_effect') {
      // Skill state changes (rage, smoke, ironfort) reported by client
      const room = rooms.get(roomCode);
      if (!room || room.phase !== 'playing') return;
      const p = room.players.get(playerId);
      if (!p || p.dead) return;

      if (msg.effect === 'rage') { p.rageMode = true; p.rageTimer = 300; p.dmgMult *= 2; }
      else if (msg.effect === 'smoke') { p.smokeMode = true; p.smokeTimer = 120; p.invincible = 120; }
      else if (msg.effect === 'ironfort') { p.ironFort = true; p.ironTimer = 120; p.invincible = 120; }
      else if (msg.effect === 'slow_all') {
        for (const e of room.enemies) { if (!e.dead) { e.slowed = true; e.slowTimer = 180; } }
      } else if (msg.effect === 'freeze_near') {
        for (const e of room.enemies) {
          if (!e.dead && Math.hypot(e.x - p.x, e.y - p.y) < 210 + e.radius) {
            e.staggerTimer = 120; e.state = 'STAGGER'; e.vx = 0; e.vy = 0;
          }
        }
      }

    } else if (msg.type === 'play_again') {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId || room.phase !== 'gameover') return;
      // Reset to lobby for class selection
      clearInterval(room.tickInterval);
      room.phase = 'lobby';
      room.enemies = [];
      room.elapsed = 0;
      for (const p of room.players.values()) {
        p.dead = false; p.kills = 0; p.xp = 0; p.xpToNext = 100; p.level = 1;
      }
      broadcast(room, { type: 'back_to_lobby' });

    } else if (msg.type === 'chat') {
      const room = rooms.get(roomCode);
      if (!room) return;
      const p = room.players.get(playerId);
      const text = String(msg.text || '').slice(0, 100);
      broadcast(room, { type: 'chat', playerId, slot: p?.slot ?? 0, text });
    }
  });

  ws.on('close', () => {
    if (!roomCode || !playerId) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.delete(playerId);
    room.clients.delete(playerId);

    if (room.players.size === 0) {
      clearInterval(room.tickInterval);
      rooms.delete(roomCode);
      return;
    }

    // Migrate host if needed
    if (room.hostId === playerId) {
      room.hostId = room.players.keys().next().value;
      broadcast(room, { type: 'host_changed', newHostId: room.hostId });
    }

    broadcast(room, { type: 'player_left', playerId });

    // If game is running and all remaining players are dead, end game
    if (room.phase === 'playing') {
      checkGameOver(room);
    }
  });

  ws.on('error', () => {});
});
