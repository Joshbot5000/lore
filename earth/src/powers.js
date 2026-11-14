// The four playable heroes and their powers. Each hero has their own way of crossing the
// city (hold TRAVERSE) and three abilities on cooldowns that spend energy.
import * as THREE from 'three';
import { G, clamp, damp } from './util.js';
import { Geo } from './geo.js';
import { setRigOpacity } from './rig.js';

const V = () => new THREE.Vector3(), _a = V(), _b = V(), _c = V(), hit = {};

export const HEROES = [
  { id: 'vesper', name: 'VESPER', title: 'The Weaver', color: '#37f5d6', rope: 0xd8fff8, melee: 1.15,
    blurb: 'Swings between towers on silk lines. Fast, acrobatic, built for the skyline.',
    look: { suit: 0x15171d, second: 0x0d5f63, head: 0x15171d, accent: 0x37f5d6, accentGlow: 2.2, visor: true, rough: 0.42 },
    traverse: 'Silk Swing', tip: 'Hold in the air near buildings, release at the top of the arc',
    powers: [{ name: 'Zip Line', fn: 'zip', cost: 10, cd: 0.8, icon: '➶' }, { name: 'Web Burst', fn: 'webBurst', cost: 30, cd: 6, icon: '✺' }, { name: 'Silk Storm', fn: 'silkStorm', cost: 60, cd: 16, icon: '❋' }] },
  { id: 'cinder', name: 'CINDER', title: 'Hellfire Warden', color: '#ff7a2a', rope: 0xff8a30, armor: 0.75,
    blurb: 'Flies on jets of flame and drags enemies around on burning chains.',
    look: { suit: 0x2b0f09, second: 0x121214, head: 0x1a0a07, accent: 0xff6a1a, accentGlow: 3, glow: 0xff3a00, visor: true, scale: 1.06 },
    traverse: 'Jet Burst', tip: 'Hold to fly where you are looking',
    powers: [{ name: 'Hellfire Chains', fn: 'chains', cost: 28, cd: 5, icon: '⛓' }, { name: 'Fireball', fn: 'fireball', cost: 18, cd: 1.1, icon: '☄' }, { name: 'Meteor Dive', fn: 'meteor', cost: 55, cd: 14, icon: '✹' }] },
  { id: 'rime', name: 'RIME', title: "Winter's Edge", color: '#9fe8ff', rope: 0xbfeaff, freezesWater: true,
    blurb: 'Skates on ice built out of thin air. Freezes crowds, cars and the sea itself.',
    look: { suit: 0xdcf1fb, second: 0x3f95c8, head: 0xeaf7ff, accent: 0x9fe8ff, accentGlow: 2, rough: 0.2, metal: 0.3 },
    traverse: 'Ice Slide', tip: 'Hold to skate through the air where you look',
    powers: [{ name: 'Frost Blast', fn: 'frostBlast', cost: 26, cd: 5, icon: '❄' }, { name: 'Glacier Spikes', fn: 'spikes', cost: 30, cd: 6, icon: '▲' }, { name: 'Whiteout', fn: 'whiteout', cost: 65, cd: 22, icon: '☃' }] },
  { id: 'vector', name: 'VECTOR', title: 'Patient Zero', color: '#7dff3a', rope: 0x7dff3a, speed: 1.12, regen: 11,
    blurb: 'Vanishes, blinks through space and seeds a virus that spreads through people and machines.',
    look: { suit: 0x10140f, second: 0x1d3a14, head: 0x0c0f0b, accent: 0x7dff3a, accentGlow: 2.6, visor: true },
    traverse: 'Blink', tip: 'Tap to teleport forward, hold in the air to glide',
    powers: [{ name: 'Cloak', fn: 'cloak', cost: 30, cd: 14, icon: '◌' }, { name: 'Contagion', fn: 'contagion', cost: 24, cd: 3, icon: '☣' }, { name: 'Blackout', fn: 'blackout', cost: 60, cd: 20, icon: '⚡' }] },
];

const ICE_N = 260;
export class Powers {
  constructor() {
    this.cd = [0, 0, 0]; this.timers = []; this.shots = []; this.zones = []; this.cloakT = 0; this.blackoutT = 0; this.blizzard = null; this.met = null; this.retry = 0; this.iceI = 0; this.iceD = 0; this.jetS = 0;
    const g = new THREE.BoxGeometry(1.9, 0.18, 2.6);
    this.iceMat = new THREE.MeshStandardMaterial({ color: 0xbfeaff, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.78, emissive: 0x2a6f99, emissiveIntensity: 0.5 });
    this.ice = new THREE.InstancedMesh(g, this.iceMat, ICE_N); this.ice.frustumCulled = false; this.iceUntil = new Float32Array(ICE_N); this.iceM = new THREE.Matrix4();
    const z = new THREE.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < ICE_N; i++) this.ice.setMatrixAt(i, z); G.scene.add(this.ice);
    this.spikeGeo = new THREE.ConeGeometry(1.5, 1, 6); this.spikeGeo.translate(0, 0.5, 0);
    this.ballGeo = new THREE.SphereGeometry(0.55, 12, 8);
  }
  get pl() { return G.player; }
  reset() { this.uncloak(); this.met = null; if (this.blizzard) { this.blizzard = null; G.sky.override = null; } }
  after(t, fn) { this.timers.push({ t, fn }); }
  cast(i) {
    const p = this.pl, d = p.hero.powers[i]; if (this.cd[i] > 0 || p.zip || this.met) return;
    if (p.energy < d.cost) { G.ui.toast('Not enough energy'); G.audio.deny(); return; }
    if (this[d.fn]() === false) return; p.energy -= d.cost; this.cd[i] = d.cd; G.audio.power(p.heroIndex, i);
  }
  camF(flat) { G.camera.getWorldDirection(_a); if (flat) { _a.y = 0; _a.normalize(); } return _a.clone(); }
  hand() { return this.pl.pos.clone().setY(this.pl.pos.y + 1.5); }

  // ---------- traversal ----------
  traverse(dt, I, wish, wl) {
    const p = this.pl, v = p.vel, id = p.hero.id; this.retry -= dt;
    if (this.met) return this.meteorStep(dt);
    if (id === 'vesper') {
      if (I.down.traverse && !p.swing && !p.zip && (I.hit.traverse || !p.grounded) && this.retry <= 0) {
        if (!p.startSwing(wish)) { this.retry = 0.2; if (I.hit.traverse && p.grounded) { v.y = 15; v.addScaledVector(wl > 0.1 ? wish : this.camF(true), 9); p.grounded = false; p.pos.y += 0.2; G.audio.jump(); } }
      }
      return false;
    }
    if (id === 'cinder') {
      if (!I.down.traverse || p.energy < 2) { this.jetS = 0; return false; }
      p.endSwing(false); p.energy -= 17 * dt; const d = this.camF(false); if (p.grounded) { d.y = Math.max(d.y, 0.45); d.normalize(); p.pos.y += 0.15; p.grounded = false; }
      this.jetS = damp(this.jetS || Math.max(14, v.length()), 46, 1.2, dt); v.lerp(d.multiplyScalar(this.jetS), 1 - Math.exp(-4 * dt));
      for (const s of [-0.25, 0.25]) G.fx.burst(_b.copy(p.pos).add(_c.set(Math.cos(p.yaw) * s, 0.2, -Math.sin(p.yaw) * s)), Math.random() < 0.5 ? 0xff8a20 : 0xffd060, 2, 2, 0.35, 1.6, 0, 0.2, _c.copy(v).multiplyScalar(-0.25));
      p.override = { gravity: 0, yaw: Math.atan2(v.x, v.z), anim: { fly: true, air: false } }; G.audio.jet(true); return true;
    }
    if (id === 'rime') {
      if (!I.down.traverse || p.energy < 2) { this.iceS = 0; return false; }
      p.endSwing(false); p.energy -= 13.5 * dt; const d = this.camF(false); d.y = clamp(d.y, -0.5, 0.5); d.normalize();
      const g = Geo.height(p.pos.x, p.pos.z); if (p.pos.y < Math.max(g, 0) + 0.7) { d.y = Math.max(d.y, 0.12); d.normalize(); p.pos.y = Math.max(p.pos.y, Math.max(g, 0) + 0.25); }
      this.iceS = damp(this.iceS || Math.max(12, v.length()), 33, 1.4, dt); v.lerp(d.multiplyScalar(this.iceS), 1 - Math.exp(-7 * dt)); p.grounded = false;
      this.iceD += this.iceS * dt;
      if (this.iceD > 1.9) {
        this.iceD = 0; const i = this.iceI = (this.iceI + 1) % ICE_N; _b.copy(p.pos).setY(p.pos.y - 0.12);
        this.iceM.lookAt(_b, _c.copy(_b).add(v), THREE.Object3D.DEFAULT_UP); this.iceM.setPosition(_b); this.ice.setMatrixAt(i, this.iceM); this.iceUntil[i] = G.time + 5; this.ice.instanceMatrix.needsUpdate = true;
        G.fx.burst(_b, 0xcff4ff, 3, 2.5, 0.6, 1, 4, 1.2);
      }
      p.override = { gravity: 0, yaw: Math.atan2(v.x, v.z), anim: { slide: true, air: false } }; G.audio.jet(true, 1); return true;
    }
    if (id === 'vector') {
      if (I.hit.traverse) {
        if (p.energy < 8) { G.audio.deny(); return false; }
        p.energy -= 8; const d = this.camF(false), from = this.hand(); G.world.raycast(from, d, 36, hit); const dist = hit.hit ? Math.max(0, hit.t - 1.3) : 34;
        p.pos.addScaledVector(d, dist); const g = Geo.height(p.pos.x, p.pos.z); if (p.pos.y < g) p.pos.y = g + 0.1;
        const sp = Math.max(18, v.length()); v.copy(d).multiplyScalar(sp); v.y = Math.max(v.y, 4); p.jumps = 1; p.iframes = Math.max(p.iframes, 0.3); p.grounded = false;
        G.fx.line(from, this.hand(), 0x7dff3a, 0.12, 0.35); G.fx.burst(from, 0x7dff3a, 22, 5, 0.5, 1.3); G.fx.burst(this.hand(), 0x7dff3a, 22, 5, 0.5, 1.3); G.audio.blink();
      } else if (I.down.traverse && !p.grounded && v.y < -3.5) { v.y = damp(v.y, -3.5, 8, dt); if (wl > 0.1) v.addScaledVector(wish, 14 * dt); }
      return false;
    }
    return false;
  }

  // ---------- Vesper ----------
  zip() {
    const p = this.pl, a = p.aim(170); if (!a.hit) { G.ui.toast('Aim at a surface to zip'); return false; }
    p.endSwing(false); const to = a.point.clone().addScaledVector(a.dir, -0.9); to.y += a.ny > 0.5 ? 0.6 : 1.2;
    p.zip = { to, t: 0 }; p.rope.visible = true; if (p.grounded) { p.pos.y += 0.3; p.grounded = false; } G.audio.thwip(); G.fx.burst(to, p.hero.rope, 10, 3, 0.3, 1.2);
  }
  webBurst() {
    const p = this.pl, f = this.camF(true), h = this.hand(); let n = 0;
    G.ents.inRange(p.pos, 26, e => { _b.subVectors(e.pos, p.pos).setY(0).normalize(); if (_b.dot(f) < 0.3) return; e.web(8); n++; G.fx.line(h.clone(), e.pos.clone().setY(e.pos.y + 1.1), 0xffffff, 0.04, 0.45); });
    G.ents.carsIn(p.pos, 22, c => { _b.subVectors(c.pos, p.pos).setY(0).normalize(); if (_b.dot(f) < 0.3 || c === p.car) return; c.emp = 6; c.vel.multiplyScalar(0.2); G.fx.line(h.clone(), c.pos.clone().setY(c.pos.y + 1), 0xffffff, 0.06, 0.5); });
    for (let i = 0; i < 16; i++) G.fx.burst(_b.copy(h).addScaledVector(f, 2 + i * 1.3), 0xffffff, 3, 2 + i * 0.3, 0.5, 1.2);
    G.ents.panic(p.pos, 20);
  }
  silkStorm() {
    const p = this.pl, c = p.pos.clone().addScaledVector(this.camF(true), 5).setY(p.pos.y + 5), list = [];
    G.ents.inRange(p.pos, 22, e => { list.push(e); e.state = 'down'; e.t = 2.6; e.grounded = false; e.vel.subVectors(c, e.pos).multiplyScalar(2.1); e.vel.y += 6; G.fx.line(this.hand(), e.pos.clone().setY(e.pos.y + 1), 0xffffff, 0.04, 0.55); });
    G.ents.carsIn(p.pos, 16, k => { if (k === p.car) return; k.vel.subVectors(c, k.pos).setY(0).multiplyScalar(1.2); k.vy = 8; k.grounded = false; k.launch = 3; if (k.ai === 'traffic') k.ai = 'none'; k.touched = true; });
    this.after(0.55, () => { for (const e of list) { _b.subVectors(e.pos, c).setY(0).normalize(); e.hit(58, _b, 9, 'player'); e.vel.y = -14; } G.fx.ring(c.clone().setY(p.pos.y + 0.3), 0xffffff, 16, 0.5); G.shake = 0.7; G.audio.boom(c, 0.5); });
  }

  // ---------- Cinder ----------
  chains() {
    const p = this.pl, f = this.camF(true), h = this.hand(), tg = [];
    G.ents.inRange(p.pos, 30, e => { _b.subVectors(e.pos, p.pos).setY(0).normalize(); if (_b.dot(f) > 0 && tg.length < 5) tg.push(e); });
    const cars = []; G.ents.carsIn(p.pos, 26, c => { _b.subVectors(c.pos, p.pos).setY(0).normalize(); if (_b.dot(f) > 0.2 && cars.length < 2 && c !== p.car && !c.dead) cars.push(c); });
    const chain = to => { const m = G.fx.line(h.clone(), to.clone(), 0xff7a1a, 0.09, 0.6, false); m.userData.to = to; G.fx.items[G.fx.items.length - 1].fn = (x) => { G.fx.place(x, this.hand(), to.clone().setY(to.y + 1), 0.07 + Math.random() * 0.05); if (Math.random() < 0.6) G.fx.burst(_b.copy(to).setY(to.y + 1), 0xff8a20, 1, 3, 0.3, 1.4); }; };
    for (const e of tg) { chain(e.pos); e.state = 'stagger'; e.t = 0.5; }
    for (const c of cars) chain(c.pos);
    if (!tg.length && !cars.length) { G.fx.ring(p.pos.clone().setY(p.pos.y + 0.5), 0xff7a1a, 10, 0.5); G.ents.blast(p.pos, 9, 30, 6, null, 'burn'); return; }
    this.after(0.32, () => {
      const side = _c.set(-f.z, 0, f.x);
      for (const e of tg) { e.hit(40, _b.copy(side).multiplyScalar(Math.random() < 0.5 ? 1 : -1).addScaledVector(f, 0.6).normalize(), 14, 'player'); e.burning = 5; }
      for (const c of cars) { c.vel.addScaledVector(f, 16).addScaledVector(side, (Math.random() - 0.5) * 20); c.vy = 13; c.grounded = false; c.launch = (Math.random() - 0.5) * 8; if (c.ai !== 'cop') c.ai = 'none'; c.touched = true; c.damage(70); G.wanted.crime(0.5); }
      G.shake = 0.5; G.audio.boom(p.pos, 0.4);
    });
  }
  fireball() {
    const d = this.camF(false), m = new THREE.Mesh(this.ballGeo, new THREE.MeshBasicMaterial({ color: 0xffa040 })); m.position.copy(this.hand()).addScaledVector(d, 1.2); G.scene.add(m);
    this.shots.push({ m, vel: d.multiplyScalar(72), life: 4 });
  }
  explodeFire(pt, big) {
    G.fx.explosion(pt, big); G.ents.blast(pt, 9 * big, 78 * big, 11 * big, null, 'burn'); this.zones.push({ p: pt.clone(), r: 4.5 * big, t: 5, tick: 0 });
    const h = G.wanted.heli; if (h && h.pos.distanceTo(pt) < 12 * big) G.wanted.hitHeli(130);
  }
  meteor() {
    const p = this.pl, a = p.aim(130); p.endSwing(false); this.met = { to: a.point.clone(), t: 0, down: false };
    if (p.grounded) { p.pos.y += 0.3; p.grounded = false; } p.vel.set(0, 40, 0); p.iframes = 3;
  }
  meteorStep(dt) {
    const p = this.pl, m = this.met, v = p.vel; m.t += dt;
    G.fx.burst(_b.copy(p.pos).setY(p.pos.y + 0.8), Math.random() < 0.5 ? 0xff7a1a : 0xffd060, 5, 4, 0.6, 2.4, -2, 0.8);
    if (!m.down) { if (m.t > 0.5) { m.down = true; m.t = 0; } p.override = { gravity: 30, anim: { fly: false, air: true } }; return true; }
    _b.subVectors(m.to, p.pos); const l = _b.length();
    if (l < 3.5 || p.grounded || m.t > 2.5) {
      this.met = null; v.set(0, 0, 0); const pt = p.pos.clone().setY(p.pos.y + 0.5); this.explodeFire(pt, 2.1); G.fx.ring(pt, 0xff7a1a, 26, 0.7); G.shake = 1; return false;
    }
    v.copy(_b.multiplyScalar(1 / l)).multiplyScalar(100); p.override = { gravity: 0, yaw: Math.atan2(v.x, v.z), anim: { fly: true, air: false } }; return true;
  }

  // ---------- Rime ----------
  frostBlast() {
    const p = this.pl, f = this.camF(false), h = this.hand();
    G.ents.inRange(p.pos, 34, e => { _b.subVectors(e.pos, p.pos).normalize(); if (_b.dot(f) > 0.55) e.freeze(9); });
    G.ents.carsIn(p.pos, 34, c => { _b.subVectors(c.pos, p.pos).normalize(); if (_b.dot(f) > 0.5 && c !== p.car) this.freezeCar(c, 9); });
    for (let i = 0; i < 22; i++) G.fx.burst(_b.copy(h).addScaledVector(f, 1.5 + i * 1.4), i % 2 ? 0xbfeaff : 0xffffff, 4, 1.5 + i * 0.35, 0.7, 1.5, 0, 0.5, _c.copy(f).multiplyScalar(6));
    G.fx.flash(h, 0x9fe8ff, 120, 0.3);
  }
  freezeCar(c, t) { c.frozen = t; c.m.paint.emissive.set(0x2f6f96); c.vel.multiplyScalar(0.1); if (c.ai === 'traffic') c.touched = true; }
  spikes() {
    const p = this.pl, f = this.camF(true), o = p.pos.clone();
    for (let i = 0; i < 9; i++) this.after(i * 0.055, () => {
      const x = o.x + f.x * (4.5 + i * 3.4), z = o.z + f.z * (4.5 + i * 3.4), y = Math.max(Geo.height(x, z), 0), ht = 4.5 + i * 0.35 + Math.random() * 1.5;
      const m = new THREE.Mesh(this.spikeGeo, this.iceMat); m.position.set(x, y - 0.3, z); m.scale.set(1, 0.01, 1); m.rotation.y = Math.random() * 6; m.castShadow = true; G.scene.add(m);
      G.world.dyn.push({ minx: x - 0.9, maxx: x + 0.9, minz: z - 0.9, maxz: z + 0.9, miny: y - 1, maxy: y + ht * 0.8, until: G.time + 9, mesh: m, solid: true, grow: ht, born: G.time });
      _b.set(x, y, z); G.fx.burst(_b, 0xcff4ff, 14, 7, 0.6, 1.3, 12, 1);
      G.ents.inRange(_b, 3.6, e => { e.hit(36, f, 6, 'player'); e.vel.y = 15; });
      G.ents.carsIn(_b, 4.2, c => { if (c === p.car) return; c.vy = 14; c.grounded = false; c.launch = (Math.random() - 0.5) * 7; c.vel.addScaledVector(f, 5); c.damage(45); if (c.ai === 'traffic') c.ai = 'none'; c.touched = true; });
      G.audio.shatter(_b);
    });
  }
  whiteout() { this.blizzard = { t: 13, tick: 0 }; G.sky.override = { snow: 1, cloud: 1, fog: 0.22, wind: 14 }; G.fx.ring(this.pl.pos.clone().setY(this.pl.pos.y + 0.5), 0xbfeaff, 34, 1); }

  // ---------- Vector ----------
  cloak() { const p = this.pl; this.cloakT = 12; p.invisible = true; setRigOpacity(p.rig, 0.16); G.fx.burst(this.hand(), 0x7dff3a, 30, 4, 0.5, 1.2); }
  uncloak() { const p = this.pl; if (!p || !p.invisible) return; this.cloakT = 0; p.invisible = false; setRigOpacity(p.rig, 1); }
  contagion() {
    const p = this.pl, f = this.camF(false), from = G.camera.position; let best = null, bs = 0.9, car = null;
    for (const e of G.ents.npcs) { if (e.dead || e.infected > 0) continue; _b.subVectors(e.pos, from).setY(e.pos.y + 1 - from.y); const l = _b.length(); if (l > 60) continue; const s = _b.dot(f) / l - l * 0.0015; if (s > bs) { bs = s; best = e; car = null; } }
    for (const c of G.ents.cars) { if (c.dead || c.infected > 0 || c === p.car) continue; _b.subVectors(c.pos, from); const l = _b.length(); if (l > 70) continue; const s = _b.dot(f) / l - l * 0.0015; if (s > bs) { bs = s; car = c; best = null; } }
    if (!best && !car) best = G.ents.nearest(p.pos, 22, e => e.infected <= 0);
    if (!best && !car) { G.ui.toast('No host in range'); return false; }
    const to = (best || car).pos.clone().setY((best || car).pos.y + 1); G.fx.line(this.hand(), to, 0x7dff3a, 0.05, 0.4); G.fx.burst(to, 0x7dff3a, 26, 5, 0.7, 1.4);
    if (best) best.infect(0); else { car.infected = 11; car.gen = 0; car.touched = true; G.stats.infected++; if (car.ai === 'none') car.ai = 'traffic'; }
  }
  blackout() {
    const p = this.pl; this.blackoutT = 11; G.fx.ring(p.pos.clone().setY(p.pos.y + 1), 0x9dff6a, 75, 0.9); G.fx.flash(this.hand(), 0xaaffcc, 500, 0.4); G.shake = 0.5;
    G.ents.carsIn(p.pos, 80, c => { if (c !== p.car) { c.emp = 11; G.fx.burst(c.pos.clone().setY(c.pos.y + 1), 0xaaffee, 10, 4, 0.4, 1); } });
    G.ents.inRange(p.pos, 40, e => { if (e.state !== 'down') { e.state = 'stagger'; e.t = 2.8; } });
    G.wanted.hitHeli(999); G.wanted.unseen = Math.max(G.wanted.unseen, 3);
  }

  update(dt) {
    const p = this.pl; for (let i = 0; i < 3; i++) this.cd[i] = Math.max(0, this.cd[i] - dt);
    for (let i = this.timers.length - 1; i >= 0; i--) { const t = this.timers[i]; t.t -= dt; if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); } }
    if (this.cloakT > 0) { this.cloakT -= dt; if (this.cloakT <= 0) this.uncloak(); }
    this.blackoutT = Math.max(0, this.blackoutT - dt);
    if (p.hero.id !== 'cinder' && p.hero.id !== 'rime' || !G.input.down.traverse) G.audio.jet(false);
    // fireballs
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i], m = s.m; s.life -= dt; s.vel.y -= 5 * dt; const l = s.vel.length() * dt; _a.copy(s.vel).normalize();
      G.world.raycast(m.position, _a, l, hit); let boom = hit.hit || s.life <= 0; m.position.addScaledVector(_a, hit.hit ? hit.t : l);
      if (!boom) { if (G.ents.nearest(m.position, 2, null)) boom = true; else for (const c of G.ents.cars) if (c !== p.car && c.pos.distanceTo(m.position) < 2.6) boom = true; const h = G.wanted.heli; if (h && h.pos.distanceTo(m.position) < 7) boom = true; }
      G.fx.burst(m.position, Math.random() < 0.5 ? 0xff7a1a : 0xffd060, 3, 2, 0.4, 2, -2, 0.4);
      if (boom) { this.explodeFire(m.position.clone(), 1); G.scene.remove(m); m.material.dispose(); this.shots.splice(i, 1); }
    }
    // burning ground
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i]; z.t -= dt; z.tick -= dt; if (z.t <= 0) { this.zones.splice(i, 1); continue; }
      for (let k = 0; k < 3; k++) { const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * z.r; G.fx.burst(_b.set(z.p.x + Math.cos(a) * r, z.p.y, z.p.z + Math.sin(a) * r), 0xff6a10, 1, 0.8, 0.7, 2.2, -5, 0.3); }
      if (z.tick <= 0) { z.tick = 0.4; G.ents.inRange(z.p, z.r, e => { e.burning = Math.max(e.burning, 3); }); }
    }
    if (this.blizzard) {
      const b = this.blizzard; b.t -= dt; b.tick -= dt;
      for (let k = 0; k < 4; k++) { const a = Math.random() * 6.28, r = Math.random() * 32; G.fx.burst(_b.set(p.pos.x + Math.cos(a) * r, p.pos.y + Math.random() * 8, p.pos.z + Math.sin(a) * r), 0xe8f8ff, 1, 5, 0.9, 1.4, 2, 0.5, _c.set(-Math.sin(a) * 10, 0, Math.cos(a) * 10)); }
      if (b.tick <= 0) { b.tick = 0.5; G.ents.inRange(p.pos, 34, e => { if (e.frozen <= 0) e.freeze(6); }); G.ents.carsIn(p.pos, 34, c => { if (c !== p.car && c.frozen <= 0) this.freezeCar(c, 6); }); }
      if (b.t <= 0) { this.blizzard = null; G.sky.override = null; }
    }
    // melt old ice, grow fresh spikes
    let ch = false; for (let i = 0; i < ICE_N; i++) if (this.iceUntil[i] && this.iceUntil[i] < G.time) { this.iceUntil[i] = 0; this.iceM.makeScale(0, 0, 0); this.ice.setMatrixAt(i, this.iceM); ch = true; }
    if (ch) this.ice.instanceMatrix.needsUpdate = true;
    for (const d of G.world.dyn) if (d.grow) { const a = clamp((G.time - d.born) / 0.14, 0, 1), e = clamp((d.until - G.time) / 0.6, 0, 1); d.mesh.scale.y = d.grow * a * e + 0.01; }
  }
}
