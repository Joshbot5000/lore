// Everything that moves besides the player: traffic, civilians, the Syndicate, police cars,
// officers, the police helicopter, and the wanted system that ties them together.
import * as THREE from 'three';
import { G, clamp, lerp, damp, angDiff, TAU } from './util.js';
import { Geo, BLOCK } from './geo.js';
import { makeRig, animateRig, tintRig, makeCar, makeHeli } from './rig.js';

const V = () => new THREE.Vector3(), _a = V(), _b = V(), _c = V(), out = {};
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]], LANE = 3.4, GRAV = 26;
const CAR_COLORS = [0xb8bcc2, 0x15171a, 0xf1f1ee, 0x8a1b1b, 0x1d3a6b, 0x39424a, 0x6d6f73, 0x1f5a45, 0xc9a227, 0x7a4b2a];
const roadLine = v => Math.round(v / BLOCK) * BLOCK;

// ================= cars =================
export class Car {
  constructor(type, color, police) {
    this.m = makeCar(type, color, police); this.type = type; this.police = police; this.spec = this.m.spec;
    this.pos = V(); this.vel = V(); this.yaw = 0; this.vf = 0; this.vy = 0; this.hp = 100; this.ai = 'traffic';
    this.dir = 0; this.plan = null; this.sinceTurn = 99; this.cruise = 9 + Math.random() * 5; this.frozen = 0; this.emp = 0; this.infected = 0; this.gen = 0;
    this.dead = false; this.deadT = 0; this.stuck = 0; this.rev = 0; this.grounded = true; this.occupied = true; this.launch = 0;
    this.m.root.rotation.order = 'YXZ'; G.scene.add(this.m.root);
  }
  get fwd() { return _a.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  place(x, z, dir) { this.pos.set(x, Geo.height(x, z), z); this.dir = dir; this.yaw = Math.atan2(DIRS[dir][0], DIRS[dir][1]); this.sync(0); }
  // arcade driving model shared by the player and police AI
  drive(dt, throttle, steer, handbrake) {
    const s = this.spec; if (this.frozen > 0 || this.emp > 0 || this.dead) { throttle = 0; steer = 0; if (this.frozen > 0) this.vel.multiplyScalar(Math.exp(-6 * dt)); }
    let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), vf = this.vel.x * fx + this.vel.z * fz, vs = this.vel.x * -fz + this.vel.z * fx;
    if (this.grounded) {
      if (throttle * vf < -0.5) vf += throttle * 30 * dt; else vf += throttle * (throttle > 0 ? s.acc * (1 - clamp(vf / s.max, 0, 1) * 0.7) : 9) * dt;
      vf -= vf * 0.12 * dt + Math.sign(vf) * Math.min(Math.abs(vf), (throttle ? 0.3 : 2.2) * dt);
      if (handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 16 * dt);
      vf = clamp(vf, -13, s.max * (this.boost || 1));
      vs *= Math.exp(-(handbrake ? 1.4 : 6.5 - Math.min(3.5, Math.abs(vf) * 0.06)) * dt);
      this.yaw -= steer * (2.4 / (1 + Math.abs(vf) / 24)) * clamp(vf / 5, -1, 1) * dt * (handbrake ? 1.5 : 1);
      fx = Math.sin(this.yaw); fz = Math.cos(this.yaw); this.vel.x = fx * vf - fz * vs; this.vel.z = fz * vf + fx * vs;
    }
    this.vf = vf; this.steer = steer; this.physics(dt);
  }
  physics(dt) {
    const p = this.pos; this.vy -= GRAV * dt; p.x += this.vel.x * dt; p.z += this.vel.z * dt; p.y += this.vy * dt;
    _b.set(this.vel.x, this.vy, this.vel.z); const before = Math.hypot(this.vel.x, this.vel.z);
    G.world.collide(p, 1.5, 1.4, _b, out);
    if (out.wall) { const loss = before - Math.hypot(_b.x, _b.z); if (loss > 5) { this.damage(loss * 1.6); G.audio.crash(p, loss); if (this === G.player.car) G.shake = Math.min(1, loss / 20); } }
    this.vel.x = _b.x; this.vel.z = _b.z; const g = out.ground;
    if (out.grounded) { this.vy = 0; this.grounded = true; } else if (this.grounded && p.y - g < 0.5 && this.vy <= 0) { p.y = g; this.vy = 0; } else this.grounded = false;
    if (g < -1.2 && p.y < -0.6) { this.vel.multiplyScalar(Math.exp(-3 * dt)); p.y = Math.max(p.y, -1.2); this.vy = Math.max(this.vy, 0); this.grounded = true; if (this.frozenWater) p.y = 0; }
    this.sync(dt);
  }
  sync(dt) {
    const r = this.m.root, p = this.pos, fx = Math.sin(this.yaw), fz = Math.cos(this.yaw); r.position.copy(p); r.rotation.y = this.yaw;
    if (this.grounded && dt) {
      const hf = Geo.height(p.x + fx * 1.6, p.z + fz * 1.6), hb = Geo.height(p.x - fx * 1.6, p.z - fz * 1.6), hl = Geo.height(p.x - fz * 0.9, p.z + fx * 0.9), hr = Geo.height(p.x + fz * 0.9, p.z - fx * 0.9);
      if (!out.box) { r.rotation.x = damp(r.rotation.x, -Math.atan2(hf - hb, 3.2), 10, dt); r.rotation.z = damp(r.rotation.z, Math.atan2(hr - hl, 1.8) * -1, 10, dt); }
    } else if (dt) { r.rotation.x += this.launch * dt; }
    this.m.tilt.rotation.z = damp(this.m.tilt.rotation.z, (this.steer || 0) * this.vf * 0.0035, 6, dt || 0.016);
    for (const w of this.m.wheels) w.rotation.x += this.vf * (dt || 0) / this.spec.wheel;
    if (this.m.bar) { const on = this.ai === 'cop' && !this.dead && this.emp <= 0, f = Math.floor(G.time * 6) % 2; this.m.bar[0].visible = on && !f; this.m.bar[1].visible = on && !!f; }
  }
  damage(d) {
    if (this.dead) return; this.hp -= d;
    if (this.hp <= 0) this.explode();
  }
  explode() {
    if (this.dead) return; this.dead = true; this.hp = 0; this.ai = 'none'; this.deadT = 0; this.m.paint.color.set(0x111111); this.m.paint.clearcoat = 0; this.m.paint.roughness = 1;
    G.fx.explosion(_c.copy(this.pos).setY(this.pos.y + 1), 1.2); this.vy = 9; this.grounded = false; this.launch = (Math.random() - 0.5) * 6;
    G.ents.blast(this.pos, 9, 70, 12, this); if (G.player.car === this) { G.player.exitCar(true); G.player.damage(45, this.pos); }
  }
  // lane-following traffic
  traffic(dt) {
    const d = DIRS[this.dir], p = this.pos, axisX = d[0] !== 0, a = axisX ? p.x : p.z, sgn = axisX ? d[0] : d[1];
    this.sinceTurn += this.vf * dt;
    if (!this.plan && this.sinceTurn > 30) {
      const I = sgn > 0 ? Math.ceil((a + 0.01) / BLOCK) * BLOCK : Math.floor((a - 0.01) / BLOCK) * BLOCK;
      if (Math.abs(I - a) < 16) {
        const r = Math.random(), order = r < 0.55 ? [0, 1, 3] : r < 0.78 ? [1, 0, 3] : [3, 0, 1]; let nd = (this.dir + 2) % 4;
        const cross = roadLine(axisX ? p.z : p.x), ix = axisX ? I : cross, iz = axisX ? cross : I;
        for (const o of order) { const c = (this.dir + o) % 4, q = DIRS[c]; if (G.world.isRoadChunk(ix + q[0] * 70, iz + q[1] * 70)) { nd = c; break; } }
        const n = DIRS[nd]; this.plan = { nd, at: nd === this.dir ? null : I + (axisX ? -n[1] : n[0]) * LANE, uturn: nd === (this.dir + 2) % 4, cross };
      }
    }
    if (this.plan && this.plan.at !== null && (a - this.plan.at) * sgn >= 0) {
      const pl = this.plan, n = DIRS[pl.nd];
      if (pl.uturn) { if (axisX) p.z = pl.cross + n[0] * LANE; else p.x = pl.cross - n[1] * LANE; } else if (axisX) p.x = pl.at; else p.z = pl.at;
      this.dir = pl.nd; this.plan = null; this.sinceTurn = 0;
    } else if (this.plan && this.plan.at === null && (a - roadLine(a)) * sgn > 8) { this.plan = null; this.sinceTurn = 0; }
    // brake for anything in the lane ahead
    let target = this.plan && this.plan.at !== null ? 5 : this.cruise; const dd = DIRS[this.dir];
    const block = (q, rad) => { const rx = q.x - p.x, rz = q.z - p.z, f = rx * dd[0] + rz * dd[1], l = Math.abs(-rx * dd[1] + rz * dd[0]); if (f > 1 && f < 7 + this.vf * 0.9 && l < rad && Math.abs(q.y - p.y) < 3) target = 0; };
    for (const c of G.ents.cars) if (c !== this) block(c.pos, 2.2);
    if (G.player.mode === 'foot') block(G.player.pos, 1.6);
    for (const n of G.ents.npcs) if (!n.dead) block(n.pos, 1.3);
    if (this.frozen > 0 || this.emp > 0) target = 0;
    this.vf = damp(this.vf, target, target < this.vf ? 4 : 1.2, dt); if (this.frozen > 0) this.vf = 0;
    const e = DIRS[this.dir]; p.x += e[0] * this.vf * dt; p.z += e[1] * this.vf * dt; p.y = Geo.height(p.x, p.z); this.grounded = true;
    this.vel.set(e[0] * this.vf, 0, e[1] * this.vf);
    this.yaw += angDiff(this.yaw, Math.atan2(e[0], e[1])) * Math.min(1, 5 * dt); this.steer = 0; out.box = null; this.sync(dt);
  }
  // police pursuit: steer at the target, feel for walls, back out when stuck
  pursue(dt, tgt, speedCap) {
    const p = this.pos, dx = tgt.x - p.x, dz = tgt.z - p.z, dist = Math.hypot(dx, dz);
    let want = Math.atan2(dx, dz), steer = 0, thr = 1;
    for (const s of [-1, 1]) { const a = this.yaw + s * 0.45, L = 9 + this.vf * 0.6; let hit = false; G.world.forBoxes(p.x + Math.sin(a) * L - 0.5, p.z + Math.cos(a) * L - 0.5, p.x + Math.sin(a) * L + 0.5, p.z + Math.cos(a) * L + 0.5, b => { if (b.maxy > p.y + 0.5) hit = true; }); if (hit) want += s * -0.9; }
    const diff = angDiff(this.yaw, want); steer = clamp(-diff * 2, -1, 1);
    if (Math.abs(diff) > 1.2 && this.vf > 12) thr = -0.4;
    if (this.vf > speedCap) thr = 0;
    if (dist < 14 && this.vf > 8) thr = -1;
    if (Math.abs(this.vf) < 1.2) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 1.4) { this.rev = 1.3; this.stuck = 0; }
    if (this.rev > 0) { this.rev -= dt; thr = -1; steer = -steer; }
    this.drive(dt, thr, steer, false);
  }
  update(dt) {
    if (this.frozen > 0) { this.frozen -= dt; if (this.frozen <= 0) this.m.paint.emissive.set(0); }
    if (this.emp > 0) this.emp -= dt;
    if (this.infected > 0 && !this.dead) {
      this.infected -= dt; if (Math.random() < dt * 12) G.fx.burst(_c.copy(this.pos).setY(this.pos.y + 1.2), 0x66ff44, 1, 2, 0.8, 1.2, -2, 2);
      if (this.infected <= 0) this.explode();
    }
    if (this.dead) { this.deadT += dt; if (Math.random() < dt * 14 && this.deadT < 14) G.fx.burst(_c.copy(this.pos).setY(this.pos.y + 1), this.deadT < 6 ? 0xff7020 : 0x333333, 1, 1.5, 1.6, 2.5, -4, 1.4); }
    if (this === G.player.car) return;
    if (this.infected > 0 && this.ai !== 'none') {            // hijacked by the virus: drives itself, badly
      this.boost = 1.2; this.drive(dt, 1, Math.sin(G.time * 1.7 + this.gen * 3 + this.pos.x) * 0.8, false);
    } else if (this.ai === 'traffic') this.traffic(dt);
    else if (this.ai === 'cop') G.wanted.driveCop(this, dt);
    else if (this.ai === 'leave') { this.ai = 'traffic'; this.dir = Math.round(((Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)) / (Math.PI / 2)) % 4 + 4)) % 4; this.dir = [1, 0, 3, 2][this.dir]; this.snapToLane(); }
    else this.drive(dt, 0, 0, this.grounded && !this.occupied && Math.abs(this.vf) < 3);
  }
  snapToLane() { const d = DIRS[this.dir]; if (d[0]) this.pos.z = roadLine(this.pos.z) + d[0] * LANE; else this.pos.x = roadLine(this.pos.x) - d[1] * LANE; this.plan = null; this.sinceTurn = 99; }
  remove() { G.scene.remove(this.m.root); }
}

// ================= people =================
const LOOK = {
  ped: () => ({ suit: new THREE.Color().setHSL(Math.random(), 0.35, 0.3 + Math.random() * 0.35), second: new THREE.Color().setHSL(0.6, 0.2, 0.15 + Math.random() * 0.25), head: [0xe8b98f, 0xc68e62, 0x8d5a3a, 0xf1cfae][Math.random() * 4 | 0], accent: 0x22252a, scale: 0.92 + Math.random() * 0.14 }),
  thug: () => ({ suit: 0x23242a, second: 0x3a1418, head: 0xc9a07a, accent: 0xff2a3a, accentGlow: 1.6, visor: true, scale: 1.02 }),
  heavy: () => ({ suit: 0x3a1418, second: 0x16171b, head: 0x2a2a2e, accent: 0xff2a3a, accentGlow: 2, visor: true, scale: 1.28 }),
  cop: () => ({ suit: 0x18284a, second: 0x0e1626, head: 0xd9ac84, accent: 0xd8c060, hat: true, scale: 1 }),
};
export class NPC {
  constructor(kind, x, z, heavy) {
    this.kind = kind; this.heavy = heavy; this.rig = makeRig(LOOK[heavy ? 'heavy' : kind]()); G.scene.add(this.rig.root);
    this.pos = V().set(x, Geo.height(x, z), z); this.vel = V(); this.yaw = Math.random() * TAU; this.hp = this.maxHp = heavy ? 220 : kind === 'ped' ? 40 : kind === 'thug' ? 90 : 80;
    this.state = 'walk'; this.t = 0; this.cool = 1 + Math.random(); this.gun = kind === 'cop' || (kind === 'thug' && !heavy && Math.random() < 0.35);
    this.frozen = 0; this.webbed = 0; this.infected = 0; this.gen = 0; this.burning = 0; this.dead = false; this.deadT = 0; this.punch = 0; this.side = 1; this.grounded = true;
    this.axis = Math.random() < 0.5 ? 0 : 1; this.sgn = Math.random() < 0.5 ? 1 : -1; this.hostile = kind === 'thug'; this.gang = null; this.fx = x; this.fz = z + 1; this.shell = null; this.anim = {};
  }
  setShell(color, opacity) {
    if (!color) { if (this.shell) { this.rig.root.remove(this.shell); this.shell.material.dispose(); this.shell = null; } return; }
    if (this.shell) return;
    this.shell = new THREE.Mesh(SHELL, new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: 0.15, metalness: 0.1 })); this.shell.position.y = 0.95; this.rig.root.add(this.shell);
  }
  hit(dmg, dir, knock, src) {
    if (this.dead) return;
    if (this.frozen > 0) { dmg *= 2.2; this.frozen = 0; this.setShell(null); G.fx.burst(_c.copy(this.pos).setY(this.pos.y + 1), 0xbfeaff, 30, 9, 0.7, 1.4, 14, 0.8); G.audio.shatter(this.pos); knock = Math.max(knock, 7); }
    this.hp -= dmg; G.fx.burst(_c.copy(this.pos).setY(this.pos.y + 1.2), 0xffe0a0, 6, 5, 0.25, 1.1);
    if (src === 'player') { this.fx = G.player.pos.x; this.fz = G.player.pos.z; if (this.kind === 'ped') G.wanted.crime(1.3); else if (this.kind === 'cop') G.wanted.crime(2.2); else this.alert = true; G.ents.panic(this.pos, 22); }
    if (this.hp <= 0) { this.dead = true; this.deadT = 0; knock = Math.max(knock, 5); if (src === 'player' || src === 'virus') G.onDefeat(this); }
    if (knock > 0 || this.dead) { this.state = 'down'; this.t = this.dead ? 99 : 1.6 + Math.random(); this.vel.set((dir ? dir.x : 0) * knock, knock * 0.55 + 2, (dir ? dir.z : 0) * knock); this.grounded = false; this.webbed = Math.min(this.webbed, 0.01); }
    else if (this.state !== 'down') { this.state = 'stagger'; this.t = 0.35; }
  }
  freeze(t) { if (this.dead) return; this.frozen = t; this.setShell(0xa8e4ff, 0.55); this.vel.set(0, this.vel.y, 0); }
  web(t) { if (this.dead) return; this.webbed = t; this.setShell(0xf2f2f2, 0.8); }
  infect(gen) { if (this.dead || this.infected > 0 || gen > 5) return false; this.infected = 14; this.gen = gen; tintRig(this.rig, 0x55ff33, 1.6); G.stats.infected++; return true; }
  moveTo(tx, tz, speed, dt) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z, d = Math.hypot(dx, dz) || 1;
    this.vel.x = damp(this.vel.x, dx / d * speed, 8, dt); this.vel.z = damp(this.vel.z, dz / d * speed, 8, dt);
    if (speed > 0.2) this.yaw += angDiff(this.yaw, Math.atan2(dx, dz)) * Math.min(1, 10 * dt); return d;
  }
  shoot(target, dmg) {
    const from = _a.copy(this.pos).setY(this.pos.y + 1.4), to = _b.copy(target.pos).setY(target.pos.y + 1.1);
    const sp = target.vel ? target.vel.length() : 0, hitc = clamp(0.8 - sp * 0.028, 0.08, 0.8);
    const ok = Math.random() < hitc; if (!ok) to.add(_c.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(4));
    G.fx.line(from.clone(), to.clone(), 0xffe9a0, 0.03, 0.09); G.fx.burst(from, 0xffd070, 3, 2, 0.08, 1.4); G.audio.shot(this.pos);
    if (ok) { if (target === G.player) G.player.damage(dmg, this.pos); else target.hit(dmg, null, 0, 'npc'); }
    this.aimT = 0.4;
  }
  fight(target, dt, visible) {              // shared by thugs, police and the infected
    const tp = target.pos, d = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z), dy = tp.y - this.pos.y;
    this.cool -= dt;
    if (this.gun && visible) {
      const keep = d > 22 ? 6 : d < 9 ? -3.5 : 0; this.moveTo(tp.x, tp.z, Math.abs(keep), dt); if (keep < 0) { this.vel.x *= -1; this.vel.z *= -1; }
      this.yaw += angDiff(this.yaw, Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z)) * Math.min(1, 10 * dt);
      if (this.cool <= 0 && d < 70) { this.cool = 0.9 + Math.random() * 1.3; this.shoot(target, this.kind === 'cop' ? 5 + G.wanted.level : 6); }
    } else if (d > 1.7 || Math.abs(dy) > 2.5) this.moveTo(tp.x, tp.z, this.heavy ? 4.6 : 6.2, dt);
    else {
      this.moveTo(tp.x, tp.z, 0, dt); this.yaw = Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z);
      if (this.cool <= 0) { this.cool = this.heavy ? 1.5 : 1 + Math.random() * 0.6; this.punch = 0.001; this.side = -this.side; this.pending = { target, t: 0.22, dmg: this.heavy ? 22 : this.infected > 0 ? 18 : 9 }; }
    }
  }
  update(dt) {
    const p = this.pos, pl = G.player, A = this.anim; A.down = A.flail = A.aim = false; A.punch = 0;
    if (this.punch > 0) { this.punch += dt * 3.2; if (this.punch >= 1) this.punch = 0; A.punch = this.punch; A.punchSide = this.side; }
    if (this.pending) { this.pending.t -= dt; if (this.pending.t <= 0) { const q = this.pending, tg = q.target; this.pending = null; if (!this.dead && this.state !== 'down' && tg.pos.distanceTo(p) < 2.4) { if (tg === pl) pl.damage(q.dmg, p); else { tg.hit(q.dmg, _a.subVectors(tg.pos, p).normalize(), this.heavy ? 6 : 0, this.infected > 0 ? 'virus' : 'npc'); if (this.infected > 0) tg.infect(this.gen + 1); } G.audio.hit(p); } } }
    if (this.aimT > 0) { this.aimT -= dt; A.aim = true; }
    if (this.dead) this.deadT += dt;
    let active = !this.dead && this.state !== 'down';
    if (this.frozen > 0) { this.frozen -= dt; if (this.frozen <= 0) this.setShell(null); active = false; this.vel.x = this.vel.z = 0; }
    else if (this.webbed > 0) { this.webbed -= dt; if (this.webbed <= 0) this.setShell(null); if (!this.dead && this.state !== 'down') { active = false; this.vel.x *= 0.8; this.vel.z *= 0.8; } }
    if (this.burning > 0 && !this.dead) { this.burning -= dt; this.hp -= 11 * dt; A.flail = true; if (Math.random() < dt * 20) G.fx.burst(_c.copy(p).setY(p.y + 1 + Math.random()), 0xff7a1a, 1, 1.5, 0.6, 1.6, -5, 0.5); if (this.hp <= 0) this.hit(1, null, 2, 'player'); }
    if (this.infected > 0 && !this.dead) {
      this.infected -= dt; this.hp -= 4 * dt; if (Math.random() < dt * 8) G.fx.burst(_c.copy(p).setY(p.y + 1.3), 0x66ff44, 1, 1, 0.9, 1, -1.5, 0.6);
      if (this.infected <= 0) tintRig(this.rig, 0, 0); if (this.hp <= 0) this.hit(1, null, 0, 'virus');
    }
    if (this.state === 'down') {
      A.down = this.grounded; A.flail = !this.grounded; this.t -= dt;
      if (this.grounded) { this.vel.x *= Math.exp(-5 * dt); this.vel.z *= Math.exp(-5 * dt); }
      if (this.t <= 0 && !this.dead && this.grounded) { this.state = this.kind === 'ped' ? 'flee' : 'walk'; this.t = 6; }
    } else if (this.state === 'stagger') { this.t -= dt; this.vel.x *= 0.85; this.vel.z *= 0.85; if (this.t <= 0) this.state = this.kind === 'ped' ? 'flee' : 'walk'; this.t = this.t <= 0 ? 6 : this.t; }
    else if (active) {
      const dp = Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z), sees = !pl.invisible && dp < 60 && Math.abs(pl.pos.y - p.y) < 45;
      if (this.infected > 0) {                                    // berserk: attack whoever is closest
        const o = G.ents.nearest(p, 30, n => n !== this && n.infected <= 0); if (o) this.fight(o, dt, true); else this.wander(dt, 2);
        const s = G.ents.nearest(p, 3.2, n => n !== this && n.infected <= 0); if (s && Math.random() < dt * 1.5) s.infect(this.gen + 1);
      } else if (this.burning > 0) { this.wander(dt, 6.5); if (Math.random() < dt * 2) this.sgn = -this.sgn; }
      else if (this.kind === 'thug') {
        if (!this.alert && sees && dp < 26) { this.alert = true; if (this.gang) for (const m of this.gang.members) m.alert = true; }
        if (this.alert && (sees || dp < 8)) this.fight(pl, dt, sees && G.world.los(_a.copy(p).setY(p.y + 1.5), _b.copy(pl.pos).setY(pl.pos.y + 1))); else { this.vel.x *= 0.9; this.vel.z *= 0.9; if (this.alert && !sees) this.wander(dt, 2); }
      } else if (this.kind === 'cop') {
        if (G.wanted.level > 0) { const tgt = G.wanted.seen ? pl.pos : G.wanted.last; if (G.wanted.seen) this.fight(pl, dt, this.canSee); else if (this.moveTo(tgt.x, tgt.z, 5.5, dt) < 6) this.wander(dt, 2.5); }
        else this.wander(dt, 1.6);
      } else if (this.state === 'flee') { this.t -= dt; const ax = p.x - this.fx, az = p.z - this.fz, l = Math.hypot(ax, az) || 1; this.moveTo(p.x + ax / l * 10, p.z + az / l * 10, 6.8, dt); A.flail = true; if (this.t <= 0) this.state = 'walk'; }
      else this.wander(dt, 1.5);
    }
    // integrate
    this.vel.y -= GRAV * dt; p.addScaledVector(this.vel, dt); G.world.collide(p, 0.35, 1.8, this.vel, out); this.grounded = out.grounded;
    if (out.wall && this.kind === 'ped' && this.state === 'walk') this.sgn = -this.sgn;
    if (out.ground < -0.8 && p.y < -0.8) { p.y = -0.8; this.vel.y = 0; this.grounded = true; }
    const r = this.rig; r.root.position.copy(p); r.root.rotation.y = this.yaw;
    A.speed = this.frozen > 0 ? 0 : Math.hypot(this.vel.x, this.vel.z); A.air = !this.grounded && this.state !== 'down'; A.vy = this.vel.y;
    if (this.frozen <= 0) animateRig(r, A, dt);
    if (this.dead && this.deadT > 7) r.root.position.y -= (this.deadT - 7) * 0.4;
  }
  // stroll along pavements, turning at corners
  wander(dt, speed) {
    const p = this.pos, ch = G.world.chunkAt(p.x, p.z);
    if (!ch || !ch.urban) { this.moveTo(p.x + Math.sin(this.yaw) * 5, p.z + Math.cos(this.yaw) * 5, speed, dt); if (Math.random() < dt * 0.3) this.yaw += (Math.random() - 0.5) * 2; return; }
    const ax = this.axis, a = ax ? p.z : p.x, c = ax ? p.x : p.z, line = roadLine(c), side = c >= line ? 1 : -1, want = line + side * 9;
    const tx = ax ? want : a + this.sgn * 6, tz = ax ? a + this.sgn * 6 : want; this.moveTo(tx, tz, speed, dt);
    const m = ((a % BLOCK) + BLOCK) % BLOCK; if ((Math.abs(m - 9) < 0.6 || Math.abs(m - 87) < 0.6) && Math.random() < dt * 3) { if (Math.random() < 0.5) { this.axis = 1 - ax; this.sgn = Math.random() < 0.5 ? 1 : -1; } }
  }
  remove() { G.scene.remove(this.rig.root); for (const m of this.rig.mats) m.dispose(); }
}
const SHELL = new THREE.CapsuleGeometry(0.5, 1.1, 3, 8);

// ================= manager =================
export class Ents {
  constructor(q) { this.q = q; this.npcs = []; this.cars = []; this.gangs = []; this.spawnT = 0; this.gangT = 12; }
  nearest(p, r, filter) { let best = null, bd = r * r; for (const n of this.npcs) { if (n.dead || (filter && !filter(n))) continue; const d = n.pos.distanceToSquared(p); if (d < bd) { bd = d; best = n; } } return best; }
  inRange(p, r, cb) { const r2 = r * r; for (const n of this.npcs) if (!n.dead && n.pos.distanceToSquared(p) < r2) cb(n); }
  carsIn(p, r, cb) { const r2 = r * r; for (const c of this.cars) if (c.pos.distanceToSquared(p) < r2) cb(c); }
  panic(p, r) { this.inRange(p, r, n => { if (n.kind === 'ped' && n.state === 'walk' && n.infected <= 0) { n.state = 'flee'; n.t = 5 + Math.random() * 4; n.fx = p.x; n.fz = p.z; } }); }
  // radial damage and knockback
  blast(p, r, dmg, knock, skipCar, status) {
    this.inRange(p, r, n => { const d = _a.subVectors(n.pos, p); d.y = 0; const l = d.length() || 1; d.multiplyScalar(1 / l); n.hit(dmg * (1 - l / r * 0.6), d, knock, 'player'); if (status === 'burn') n.burning = 5; });
    this.carsIn(p, r, c => { if (c === skipCar || c === G.player.car) return; const d = _a.subVectors(c.pos, p); d.y = 0; d.normalize(); c.vel.addScaledVector(d, knock * 0.9); c.vy = knock * 0.6; c.grounded = false; c.launch = (Math.random() - 0.5) * 5; if (c.ai === 'traffic') c.ai = 'none'; c.damage(dmg * 0.9); });
    this.panic(p, r * 3);
  }
  roadSpot(minR, maxR) {
    const pl = G.player.pos;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * TAU, r = minR + Math.random() * (maxR - minR), x = pl.x + Math.sin(a) * r, z = pl.z + Math.cos(a) * r;
      if (!G.world.isRoadChunk(x, z)) continue;
      const dir = Math.random() * 4 | 0, d = DIRS[dir], pos = d[0] ? { x, z: roadLine(z) + d[0] * LANE } : { x: roadLine(x) - d[1] * LANE, z };
      const m = (((d[0] ? pos.x : pos.z) % BLOCK) + BLOCK) % BLOCK; if (m < 14 || m > BLOCK - 14) continue;
      let clear = true; for (const c of this.cars) if (Math.abs(c.pos.x - pos.x) + Math.abs(c.pos.z - pos.z) < 14) clear = false;
      if (clear) return { ...pos, dir };
    }
    return null;
  }
  walkSpot(minR, maxR) {
    const pl = G.player.pos;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU, r = minR + Math.random() * (maxR - minR), x = pl.x + Math.sin(a) * r, z = pl.z + Math.cos(a) * r;
      if (!G.world.isRoadChunk(x, z)) continue; const ax = Math.random() < 0.5;
      return ax ? { x: roadLine(x) + (Math.random() < 0.5 ? 9 : -9), z } : { x, z: roadLine(z) + (Math.random() < 0.5 ? 9 : -9) };
    }
    return null;
  }
  addCar(type, color, police, spot) { const c = new Car(type, color, police); c.place(spot.x, spot.z, spot.dir); this.cars.push(c); return c; }
  addNPC(kind, x, z, heavy) { const n = new NPC(kind, x, z, heavy); this.npcs.push(n); return n; }
  spawnGang() {
    const s = this.walkSpot(55, 110); if (!s) return; const g = { members: [], x: s.x, z: s.z }, n = 4 + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++) { const m = this.addNPC('thug', s.x + (Math.random() - 0.5) * 6, s.z + (Math.random() - 0.5) * 6, i === 0 && Math.random() < 0.7); m.gang = g; m.state = 'idle'; g.members.push(m); }
    this.gangs.push(g); G.ui.toast('Syndicate crew spotted nearby', 'They are marked red on your radar');
  }
  update(dt) {
    const pl = G.player.pos, urban = G.world.isRoadChunk(pl.x, pl.z);
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 0.25;
      const traffic = this.cars.filter(c => c.ai === 'traffic').length, peds = this.npcs.filter(n => n.kind === 'ped').length;
      if (urban && traffic < this.q.cars) { const s = this.roadSpot(70, 190); if (s) { const r = Math.random(); this.addCar(r < 0.6 ? 'sedan' : r < 0.8 ? 'sport' : 'van', CAR_COLORS[Math.random() * CAR_COLORS.length | 0], false, s); } }
      if (urban && peds < this.q.peds) { const s = this.walkSpot(35, 120); if (s) this.addNPC('ped', s.x, s.z); }
      for (let i = this.cars.length - 1; i >= 0; i--) { const c = this.cars[i], d = c.pos.distanceTo(pl); if (c !== G.player.car && (d > 260 || (c.dead && c.deadT > 25) || (c.ai === 'none' && !c.touched && d > 140))) { c.remove(); this.cars.splice(i, 1); } }
      for (let i = this.npcs.length - 1; i >= 0; i--) { const n = this.npcs[i], d = n.pos.distanceTo(pl); if (d > (n.kind === 'thug' ? 260 : 190) || (n.dead && n.deadT > 9) || (n.kind === 'cop' && G.wanted.level === 0 && d > 70)) { n.remove(); this.npcs.splice(i, 1); } }
      for (let i = this.gangs.length - 1; i >= 0; i--) { const g = this.gangs[i], alive = g.members.filter(m => !m.dead && this.npcs.includes(m)); if (!alive.length) { if (g.members.some(m => m.dead)) G.onGangCleared(); this.gangs.splice(i, 1); } else { g.x = alive[0].pos.x; g.z = alive[0].pos.z; } }
    }
    this.gangT -= dt; if (this.gangT <= 0 && urban) { this.gangT = 45 + Math.random() * 40; if (!this.gangs.length && G.wanted.level < 3) this.spawnGang(); }
    for (const c of this.cars) c.update(dt);
    for (const n of this.npcs) n.update(dt);
    // car against car, and cars against people
    const cs = this.cars;
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j], dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d2 = dx * dx + dz * dz; if (d2 > 9.6 || Math.abs(a.pos.y - b.pos.y) > 2) continue;
        const d = Math.sqrt(d2) || 0.01, nx = dx / d, nz = dz / d, pen = 3.1 - d, rel = (a.vel.x - b.vel.x) * nx + (a.vel.z - b.vel.z) * nz;
        a.pos.x -= nx * pen * 0.5; a.pos.z -= nz * pen * 0.5; b.pos.x += nx * pen * 0.5; b.pos.z += nz * pen * 0.5;
        if (rel > 0) {
          a.vel.x -= nx * rel * 0.6; a.vel.z -= nz * rel * 0.6; b.vel.x += nx * rel * 0.6; b.vel.z += nz * rel * 0.6;
          if (rel > 5) { const dmg = rel * 1.3; a.damage(dmg * (a === G.player.car ? 0.5 : 1)); b.damage(dmg * (b === G.player.car ? 0.5 : 1)); G.audio.crash(a.pos, rel); for (const c of [a, b]) { if (c.ai === 'traffic') { c.ai = 'none'; c.touched = true; } } if (a === G.player.car || b === G.player.car) { G.shake = Math.min(1, rel / 18); const o = a === G.player.car ? b : a; if (o.police) G.wanted.crime(0.6); } }
          if (a.infected > 0 && b.infected <= 0 && a.gen < 5) { b.infected = 9; b.gen = a.gen + 1; G.stats.infected++; } else if (b.infected > 0 && a.infected <= 0 && b.gen < 5) { a.infected = 9; a.gen = b.gen + 1; G.stats.infected++; }
        }
      }
      const sp = Math.hypot(a.vel.x, a.vel.z); if (sp < 4) continue;
      for (const n of this.npcs) {
        if (n.dead || n.state === 'down') continue; const dx = n.pos.x - a.pos.x, dz = n.pos.z - a.pos.z; if (dx * dx + dz * dz > 4.2 || Math.abs(n.pos.y - a.pos.y) > 2) continue;
        n.hit(sp * 2.4, _a.set(a.vel.x, 0, a.vel.z).normalize(), sp * 0.6, a === G.player.car ? 'player' : 'npc'); G.audio.hit(n.pos);
      }
      if (a !== G.player.car && G.player.mode === 'foot' && G.player.iframes <= 0) { const dx = pl.x - a.pos.x, dz = pl.z - a.pos.z; if (dx * dx + dz * dz < 4 && Math.abs(pl.y - a.pos.y) < 1.8 && sp > 6) { G.player.damage(sp * 0.9, a.pos); G.player.vel.set(a.vel.x * 0.8, 6, a.vel.z * 0.8); G.player.iframes = 0.6; } }
    }
  }
  clear() { for (const c of this.cars) c.remove(); for (const n of this.npcs) n.remove(); this.cars.length = 0; this.npcs.length = 0; this.gangs.length = 0; }
}

// ================= wanted =================
export class Wanted {
  constructor() { this.heat = 0; this.level = 0; this.state = 'none'; this.seen = false; this.unseen = 0; this.searchT = 0; this.last = V(); this.checkT = 0; this.spawnT = 0; this.heli = null; }
  crime(p) {
    const before = this.level; this.heat = Math.min(26, this.heat + p); const T = [1.2, 3.5, 7, 12, 19]; let l = 0; for (const t of T) if (this.heat >= t) l++;
    if (l > this.level) { this.level = l; if (!before) G.ui.toast('Police alerted', 'Break line of sight to lose them'); G.audio.siren(true); }
    if (this.level > 0) { this.last.copy(G.player.pos); this.unseen = Math.min(this.unseen, 2); if (this.state !== 'pursuit') { this.state = 'pursuit'; this.searchT = 0; } }
  }
  clearAll(msg = true) {
    if (this.level && msg) G.ui.toast('You lost them', 'Wanted level cleared'); this.heat = 0; this.level = 0; this.state = 'none'; this.seen = false; G.audio.siren(false);
    for (const c of G.ents.cars) if (c.ai === 'cop') c.ai = G.world.isRoadChunk(c.pos.x, c.pos.z) ? 'leave' : 'none';
    if (this.heli) this.heli.leave = true;
  }
  driveCop(c, dt) {
    const pl = G.player, tgt = this.seen ? pl.pos : this.last, d = c.pos.distanceTo(tgt);
    if (pl.mode === 'foot' && d < 16 && Math.abs(c.vf) < 7 && c.occupied) {         // officers get out
      c.occupied = false; c.ai = 'none'; c.touched = true;
      for (const s of [-1, 1]) { const n = G.ents.addNPC('cop', c.pos.x + Math.cos(c.yaw) * 1.8 * s, c.pos.z - Math.sin(c.yaw) * 1.8 * s); n.canSee = true; }
      return;
    }
    c.pursue(dt, tgt, this.state === 'search' ? 14 : 30 + this.level * 5);
  }
  update(dt) {
    const pl = G.player, E = G.ents;
    if (this.level === 0) { if (this.heat > 0) this.heat = Math.max(0, this.heat - dt * 0.05); if (this.heli) this.updateHeli(dt); return; }
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.3; let seen = false; const eye = _b.copy(pl.pos).setY(pl.pos.y + 1.2);
      if (!pl.invisible) {
        for (const n of E.npcs) { if (n.kind !== 'cop' || n.dead) continue; n.canSee = n.pos.distanceTo(pl.pos) < 95 && n.frozen <= 0 && G.world.los(_a.copy(n.pos).setY(n.pos.y + 1.6), eye); seen = seen || n.canSee; }
        for (const c of E.cars) if (c.ai === 'cop' && c.emp <= 0 && c.pos.distanceTo(pl.pos) < 130 && G.world.los(_a.copy(c.pos).setY(c.pos.y + 1.4), eye)) seen = true;
        if (this.heli && !this.heli.down && this.heli.pos.distanceTo(pl.pos) < 260 && G.world.los(this.heli.pos, eye)) seen = true;
      } else for (const n of E.npcs) n.canSee = false;
      this.seen = seen;
    }
    if (this.seen) { this.state = 'pursuit'; this.unseen = 0; this.searchT = 0; this.last.copy(pl.pos); }
    else { this.unseen += dt; if (this.unseen > 5) { this.state = 'search'; this.searchT += dt; if (this.searchT > 16 + this.level * 4) { this.clearAll(); return; } } }
    // reinforcements arrive by road, out of sight where possible
    this.spawnT -= dt; const units = E.cars.filter(c => c.ai === 'cop').length + E.npcs.filter(n => n.kind === 'cop' && !n.dead).length / 2;
    if (this.spawnT <= 0 && units < this.level + (this.level > 2 ? 1 : 0)) {
      this.spawnT = 3.5; let s = E.roadSpot(110, 190);
      if (!s) { const a = Math.random() * TAU; s = { x: pl.pos.x + Math.sin(a) * 150, z: pl.pos.z + Math.cos(a) * 150, dir: 0 }; if (Geo.height(s.x, s.z) < 0.5) s = null; }
      if (s) { const c = E.addCar(this.level > 3 ? 'sport' : 'sedan', 0xf4f4f0, true, s); c.ai = 'cop'; c.hp = 140; c.yaw = Math.atan2(pl.pos.x - s.x, pl.pos.z - s.z); }
    }
    if (this.level >= 4 && !this.heli) this.spawnHeli();
    if (this.heli) this.updateHeli(dt);
  }
  spawnHeli() { const h = makeHeli(); G.scene.add(h.root); this.heli = { m: h, pos: h.root.position, vel: V(), cool: 2, down: false, leave: false, hp: 120 }; this.heli.pos.copy(G.player.pos).add(_a.set(200, 120, 200)); }
  updateHeli(dt) {
    const h = this.heli, pl = G.player; h.m.rotor.rotation.y += dt * 30;
    if (h.down) { h.vel.y -= 14 * dt; h.pos.addScaledVector(h.vel, dt); h.m.root.rotation.y += dt * 5; h.m.root.rotation.z += dt; if (h.pos.y < Geo.height(h.pos.x, h.pos.z) + 1) { G.fx.explosion(h.pos.clone(), 2); G.ents.blast(h.pos, 14, 80, 14); G.scene.remove(h.m.root); this.heli = null; } return; }
    const tgt = _a.copy(this.seen ? pl.pos : this.last); tgt.y = Math.max(tgt.y + 55, Geo.height(tgt.x, tgt.z) + 70); if (h.leave) tgt.set(h.pos.x + 400, h.pos.y + 200, h.pos.z);
    _b.subVectors(tgt, h.pos); const d = _b.length(); h.vel.lerp(_b.multiplyScalar(Math.min(1, 34 / (d || 1))), 1 - Math.exp(-1.2 * dt)); h.pos.addScaledVector(h.vel, dt);
    h.m.root.rotation.y = Math.atan2(pl.pos.x - h.pos.x, pl.pos.z - h.pos.z); h.m.beam.lookAt(pl.pos); h.m.beam.rotateX(Math.PI / 2); h.m.beam.visible = G.sky.night > 0.3;
    G.audio.heli(h.pos.distanceTo(pl.pos));
    if (h.leave && h.pos.distanceTo(pl.pos) > 500) { G.scene.remove(h.m.root); this.heli = null; G.audio.heli(1e9); return; }
    h.cool -= dt; if (!h.leave && this.level >= 5 && this.seen && h.cool <= 0) { h.cool = 0.25 + (Math.random() < 0.2 ? 2 : 0); NPC.prototype.shoot.call({ pos: h.pos, kind: 'cop' }, pl, 4); }
  }
  hitHeli(dmg) { const h = this.heli; if (!h || h.down) return; h.hp -= dmg; if (h.hp <= 0) { h.down = true; G.fx.explosion(h.pos.clone(), 1); G.ui.toast('Helicopter down'); this.crime(3); } }
}
