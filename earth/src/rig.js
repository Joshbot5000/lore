// Procedural models: an articulated humanoid (shared by heroes, civilians, thugs, police),
// cars with a shaped body, and a helicopter. No external assets, so everything works offline.
import * as THREE from 'three';
import { clamp, lerp, damp } from './util.js';

const cap = (r, l) => { const g = new THREE.CapsuleGeometry(r, l, 3, 8); g.translate(0, -l / 2 - r * 0.2, 0); return g; };
const GEO = { upper: cap(0.075, 0.24), lower: cap(0.062, 0.24), thigh: cap(0.1, 0.34), shin: cap(0.08, 0.36), head: new THREE.SphereGeometry(0.125, 14, 10),
  torso: new THREE.CapsuleGeometry(0.19, 0.3, 4, 10), hips: new THREE.CapsuleGeometry(0.16, 0.08, 3, 8), foot: new THREE.BoxGeometry(0.11, 0.08, 0.26) };

export function makeRig(o) {
  const suit = new THREE.MeshStandardMaterial({ color: o.suit, roughness: o.rough ?? 0.6, metalness: o.metal ?? 0.1 });
  const second = new THREE.MeshStandardMaterial({ color: o.second ?? o.suit, roughness: 0.55, metalness: o.metal ?? 0.1 });
  const head = new THREE.MeshStandardMaterial({ color: o.head ?? o.suit, roughness: 0.5, emissive: o.glow ?? 0x000000, emissiveIntensity: o.glow ? 0.4 : 0 });
  const acc = new THREE.MeshStandardMaterial({ color: o.accent ?? o.suit, emissive: o.accent ?? 0x000000, emissiveIntensity: o.accentGlow ?? 0, roughness: 0.4 });
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body); body.position.y = 0.94;
  const mesh = (g, m, p) => { const x = new THREE.Mesh(g, m); x.castShadow = true; p.add(x); return x; };
  const piv = (p, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); p.add(g); return g; };
  mesh(GEO.hips, second, body).rotation.z = Math.PI / 2;
  const chest = piv(body, 0, 0.08, 0); const t = mesh(GEO.torso, suit, chest); t.position.y = 0.3; t.scale.set(1, 1, 0.72);
  const stripe = mesh(new THREE.BoxGeometry(0.2, 0.05, 0.02), acc, chest); stripe.position.set(0, 0.42, 0.135);
  const neck = piv(chest, 0, 0.62, 0); const hd = mesh(GEO.head, head, neck); hd.position.y = 0.1; hd.scale.set(0.92, 1.08, 1);
  if (o.visor) { const v = mesh(new THREE.BoxGeometry(0.17, 0.045, 0.06), acc, neck); v.position.set(0, 0.12, 0.1); }
  if (o.hat) { const h = mesh(new THREE.CylinderGeometry(0.13, 0.14, 0.07, 10), second, neck); h.position.y = 0.21; }
  const limb = (side, arm) => {
    const a = piv(arm ? chest : body, side * (arm ? 0.25 : 0.1), arm ? 0.5 : -0.04, 0); mesh(arm ? GEO.upper : GEO.thigh, arm ? suit : second, a);
    const b = piv(a, 0, arm ? -0.3 : -0.42, 0); mesh(arm ? GEO.lower : GEO.shin, arm ? second : suit, b);
    if (arm) { const hnd = mesh(new THREE.SphereGeometry(0.06, 8, 6), acc, b); hnd.position.y = -0.31; } else { const f = mesh(GEO.foot, acc, b); f.position.set(0, -0.45, 0.06); }
    return [a, b];
  };
  const [armL, foreL] = limb(1, true), [armR, foreR] = limb(-1, true), [legL, shinL] = limb(1, false), [legR, shinR] = limb(-1, false);
  if (o.scale) root.scale.setScalar(o.scale);
  return { root, body, chest, neck, armL, armR, foreL, foreR, legL, legR, shinL, shinR, mats: [suit, second, head, acc], phase: Math.random() * 6, pose: {} };
}
export function setRigOpacity(r, a) { for (const m of r.mats) { m.transparent = a < 1; m.opacity = a; m.depthWrite = a > 0.5; } }
export function tintRig(r, color, k) { for (const m of r.mats) { if (!m.userData.base) m.userData.base = m.emissive.clone(), m.userData.bi = m.emissiveIntensity; if (k > 0) { m.emissive.set(color); m.emissiveIntensity = k; } else { m.emissive.copy(m.userData.base); m.emissiveIntensity = m.userData.bi; } } }

// s: { speed, air, swing, wall, punch (0..1), punchSide, down, sit, fly, slide, aim, flail, vy }
export function animateRig(r, s, dt) {
  const sp = s.speed || 0, run = clamp(sp / 9, 0, 1.25); r.phase += dt * (4 + sp * 1.25) * (sp > 0.3 ? 1 : 0);
  const ph = r.phase, sn = Math.sin(ph), cs = Math.cos(ph);
  let T = { bodyX: run * 0.22, bodyY: 0.94 - Math.abs(cs) * 0.03 * run, bodyZ: 0, chestX: 0, chestY: sn * 0.12 * run,
    aLx: -sn * 0.9 * run, aRx: sn * 0.9 * run, aLz: 0.12, aRz: -0.12, fL: -0.25 - run * 0.9, fR: -0.25 - run * 0.9,
    lLx: sn * 0.95 * run, lRx: -sn * 0.95 * run, sL: Math.max(0, cs) * 1.5 * run + 0.05, sR: Math.max(0, -cs) * 1.5 * run + 0.05, rootX: 0 };
  if (s.air) { const up = clamp((s.vy || 0) / 12, -1, 1); Object.assign(T, { bodyX: 0.15 - up * 0.2, aLx: -0.4 + up * 1.2, aRx: -0.4 + up * 1.2, aLz: 0.8, aRz: -0.8, fL: -0.4, fR: -0.4, lLx: 0.5 + up * 0.3, lRx: -0.35, sL: 1.1, sR: 0.5 }); }
  if (s.swing) Object.assign(T, { bodyX: 0.25, aLx: -2.9, aRx: -2.6, aLz: 0.25, aRz: -0.1, fL: -0.15, fR: -0.5, lLx: 0.75, lRx: -0.25, sL: 1.25, sR: 0.45, chestY: 0.2 });
  if (s.fly) Object.assign(T, { bodyX: 1.25, aLx: 0.5, aRx: 0.5, aLz: 0.35, aRz: -0.35, fL: -0.1, fR: -0.1, lLx: 0.12, lRx: -0.08, sL: 0.15, sR: 0.25 });
  if (s.slide) Object.assign(T, { bodyX: 0.35, bodyY: 0.8, aLx: -0.9, aRx: 0.7, aLz: 1.0, aRz: -0.9, fL: -0.3, fR: -0.3, lLx: 0.75, lRx: -0.55, sL: 0.9, sR: 0.75, chestY: 0.5 });
  if (s.wall) Object.assign(T, { bodyX: 0.5, bodyZ: s.wall * 0.3 });
  if (s.sit) Object.assign(T, { bodyX: -0.1, bodyY: 0.55, aLx: -1.1, aRx: -1.1, fL: -0.5, fR: -0.5, lLx: -1.4, lRx: -1.4, sL: 1.3, sR: 1.3, aLz: 0.1, aRz: -0.1 });
  if (s.aim) Object.assign(T, { aRx: -1.5, fR: -0.05, aRz: 0, chestY: -0.25 });
  if (s.flail) { T.aLx = -2.4 + Math.sin(ph * 2.2) * 0.8; T.aRx = -2.4 + Math.cos(ph * 2.5) * 0.8; }
  if (s.punch > 0) { const k = Math.sin(clamp(s.punch, 0, 1) * Math.PI), R = s.punchSide > 0;
    if (s.punchSide === 2) Object.assign(T, { lRx: -1.7 * k, sR: 0.2, bodyX: -0.35 * k, chestY: 0.5 * k });
    else Object.assign(T, R ? { aRx: -1.55 * k - 0.2, fR: -1.6 * (1 - k), chestY: -0.6 * k } : { aLx: -1.55 * k - 0.2, fL: -1.6 * (1 - k), chestY: 0.6 * k }); T.bodyX += 0.2 * k; }
  if (s.down) Object.assign(T, { rootX: -1.5, bodyX: 0, bodyY: 0.2, aLx: -2.6, aRx: -0.4, aLz: 0.9, aRz: -0.7, lLx: 0.25, lRx: -0.2, sL: 0.3, sR: 0.1, fL: -0.2, fR: -0.4 });
  const P = r.pose, k = s.snap ? 1 : 1 - Math.exp(-14 * dt);
  for (const n in T) P[n] = P[n] === undefined ? T[n] : P[n] + (T[n] - P[n]) * k;
  r.body.rotation.x = P.bodyX; r.body.position.y = P.bodyY; r.body.rotation.z = P.bodyZ; r.chest.rotation.y = P.chestY;
  r.armL.rotation.set(P.aLx, 0, P.aLz); r.armR.rotation.set(P.aRx, 0, P.aRz); r.foreL.rotation.x = P.fL; r.foreR.rotation.x = P.fR;
  r.legL.rotation.x = -P.lLx; r.legR.rotation.x = -P.lRx; r.shinL.rotation.x = P.sL; r.shinR.rotation.x = P.sR;
  r.root.rotation.x = P.rootX;
}

// ---------- vehicles ----------
const profile = (pts, w) => { const s = new THREE.Shape(); pts.forEach((p, i) => i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1])); const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.07, bevelSegments: 2 }); g.translate(0, 0, -w / 2); g.rotateY(-Math.PI / 2); return g; };
const CAR = {
  sedan: { body: [[-2.2, 0.32], [-2.25, 0.78], [-1.5, 0.9], [-0.9, 0.92], [1.1, 0.92], [2.1, 0.82], [2.2, 0.36]], cab: [[-1.35, 0.9], [-0.85, 1.38], [0.55, 1.4], [1.25, 0.92]], w: 1.72, wheel: 0.34, wb: 1.35, max: 46, acc: 13 },
  sport: { body: [[-2.15, 0.26], [-2.2, 0.7], [-1.3, 0.8], [1.2, 0.74], [2.15, 0.56], [2.2, 0.3]], cab: [[-1.2, 0.78], [-0.55, 1.14], [0.35, 1.14], [1.05, 0.76]], w: 1.86, wheel: 0.33, wb: 1.35, max: 74, acc: 22 },
  van: { body: [[-2.3, 0.36], [-2.3, 1.0], [-1.6, 1.05], [1.6, 1.05], [2.3, 0.95], [2.3, 0.4]], cab: [[-2.2, 1.03], [-2.1, 1.85], [1.1, 1.85], [1.75, 1.05]], w: 1.9, wheel: 0.38, wb: 1.45, max: 38, acc: 10 },
};
const cache = {}, glass = new THREE.MeshStandardMaterial({ color: 0x0a1016, roughness: 0.06, metalness: 0.9 }), tire = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.9 }),
  headM = new THREE.MeshBasicMaterial({ color: 0xfff4d8 }), tailM = new THREE.MeshBasicMaterial({ color: 0xcc1a10 });
export function makeCar(type, color, police) {
  const d = CAR[type], g = cache[type] || (cache[type] = { body: profile(d.body, d.w), cab: profile(d.cab, d.w - 0.22), wheel: new THREE.CylinderGeometry(d.wheel, d.wheel, 0.24, 14).rotateZ(Math.PI / 2) });
  const root = new THREE.Group(), tilt = new THREE.Group(); root.add(tilt);
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 });
  const b = new THREE.Mesh(g.body, paint); b.castShadow = true; tilt.add(b);
  const c = new THREE.Mesh(g.cab, glass); tilt.add(c);
  const wheels = []; for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { const w = new THREE.Mesh(g.wheel, tire); w.position.set(x * (d.w / 2 - 0.02), d.wheel, z * d.wb); root.add(w); wheels.push(w); }
  for (const x of [-1, 1]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), headM); h.position.set(x * (d.w / 2 - 0.3), 0.62, 2.22); tilt.add(h); const t = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.06), tailM); t.position.set(x * (d.w / 2 - 0.3), 0.68, -2.26); tilt.add(t); }
  let bar = null;
  if (police) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(d.w + 0.18, 0.42, 1.5), new THREE.MeshStandardMaterial({ color: 0x0c0f16, roughness: 0.4 })); door.position.set(0, 0.62, 0); tilt.add(door);
    bar = [0xff2030, 0x2060ff].map((col, i) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.26), new THREE.MeshBasicMaterial({ color: col })); m.position.set(i ? 0.3 : -0.3, 1.48, 0.05); tilt.add(m); return m; });
  }
  return { root, tilt, wheels, paint, bar, spec: d };
}
export function makeHeli() {
  const root = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x151a22, roughness: 0.4, metalness: 0.6 });
  const b = new THREE.Mesh(new THREE.CapsuleGeometry(1.2, 2.6, 4, 10), m); b.rotation.x = Math.PI / 2; root.add(b);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, 4.5), m); tail.position.set(0, 0.4, -4); root.add(tail);
  const rotor = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.06, 0.34), m); rotor.position.y = 1.5; root.add(rotor);
  const beam = new THREE.Mesh(new THREE.ConeGeometry(9, 60, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xcfe4ff, transparent: true, opacity: 0.09, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  beam.geometry.translate(0, -30, 0); root.add(beam);
  const nav = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xff3030 })); nav.position.set(0, -1.1, 0); root.add(nav);
  return { root, rotor, beam };
}
