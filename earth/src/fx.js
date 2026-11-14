// Effects: one pooled additive particle cloud, plus short-lived meshes (ropes, rings, tracers, ice).
import * as THREE from 'three';
import { G } from './util.js';

const N = 4000;
export class FX {
  constructor(scene) {
    this.scene = scene; this.n = 0; this.items = [];
    this.pos = new Float32Array(N * 3); this.col = new Float32Array(N * 4); this.size = new Float32Array(N);
    this.vel = new Float32Array(N * 3); this.life = new Float32Array(N); this.max = new Float32Array(N); this.grav = new Float32Array(N); this.base = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec4 aCol; attribute float aSize; varying vec4 vC; void main(){ vC=aCol; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; gl_PointSize=aSize*420./max(1.,-mv.z); }`,
      fragmentShader: `varying vec4 vC; void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,.05,d); gl_FragColor=vec4(vC.rgb*a*vC.a,1.); }`,
    }));
    this.points.frustumCulled = false; scene.add(this.points);
    this.rope = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true); this.rope.translate(0, 0.5, 0); this.rope.rotateX(Math.PI / 2);
    this.c = new THREE.Color();
  }
  // spawn n particles around p
  burst(p, color, n, speed, life, size, grav = 0, spread = 0.3, dir = null) {
    this.c.set(color);
    for (let i = 0; i < n; i++) {
      const k = this.n = (this.n + 1) % N, a = Math.random() * 6.283, y = Math.random() * 2 - 1, r = Math.sqrt(1 - y * y), s = speed * (0.3 + Math.random() * 0.7);
      this.pos[k * 3] = p.x + (Math.random() - 0.5) * spread; this.pos[k * 3 + 1] = p.y + (Math.random() - 0.5) * spread; this.pos[k * 3 + 2] = p.z + (Math.random() - 0.5) * spread;
      this.vel[k * 3] = Math.cos(a) * r * s + (dir ? dir.x : 0); this.vel[k * 3 + 1] = y * s + (dir ? dir.y : 0); this.vel[k * 3 + 2] = Math.sin(a) * r * s + (dir ? dir.z : 0);
      this.base[k * 3] = this.c.r; this.base[k * 3 + 1] = this.c.g; this.base[k * 3 + 2] = this.c.b;
      this.life[k] = this.max[k] = life * (0.5 + Math.random() * 0.5); this.size[k] = size * (0.6 + Math.random() * 0.8); this.grav[k] = grav;
    }
  }
  // mesh that lives for `life` seconds; fn(mesh, age01, dt) each frame
  add(mesh, life, fn) { this.scene.add(mesh); this.items.push({ mesh, life, age: 0, fn }); return mesh; }
  line(a, b, color, width, life, fade = true) {
    const m = new THREE.Mesh(this.rope, new THREE.MeshBasicMaterial({ color, transparent: true }));
    this.place(m, a, b, width); return this.add(m, life, fade ? (x, t) => { x.material.opacity = 1 - t; } : null);
  }
  place(m, a, b, width) { m.position.copy(a); m.lookAt(b); m.scale.set(width, width, Math.max(0.01, a.distanceTo(b))); }
  ring(p, color, radius, life) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 6, 40), new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = Math.PI / 2; m.position.copy(p); return this.add(m, life, (x, t) => { const s = 1 + (radius - 1) * (1 - (1 - t) * (1 - t)); x.scale.set(s, s, s * 2); x.material.opacity = 1 - t; });
  }
  flash(p, color, intensity, life) {
    const l = new THREE.PointLight(color, intensity, 90, 1.6); l.position.copy(p); return this.add(l, life, (x, t) => { x.intensity = intensity * (1 - t); });
  }
  explosion(p, big = 1) {
    this.burst(p, 0xffb040, 60 * big, 16 * big, 0.9, 2.2 * big, 6, 1); this.burst(p, 0xff4010, 40 * big, 8 * big, 1.4, 3.2 * big, -3, 1.5); this.burst(p, 0x555555, 30, 5, 2.4, 3, -2, 2);
    this.ring(p, 0xffc070, 12 * big, 0.5); this.flash(p, 0xff9040, 400 * big, 0.5); G.audio && G.audio.boom(p); G.shake = Math.max(G.shake || 0, 0.8 * big / (1 + G.player.pos.distanceTo(p) / 25));
  }
  update(dt) {
    const { pos, vel, life, max, col, base, grav } = this;
    for (let k = 0; k < N; k++) {
      if (life[k] <= 0) { if (col[k * 4 + 3] !== 0) col[k * 4 + 3] = 0; continue; }
      life[k] -= dt; vel[k * 3 + 1] -= grav[k] * dt; const d = 1 - 1.2 * dt;
      vel[k * 3] *= d; vel[k * 3 + 2] *= d;
      pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      col[k * 4] = base[k * 3]; col[k * 4 + 1] = base[k * 3 + 1]; col[k * 4 + 2] = base[k * 3 + 2]; col[k * 4 + 3] = Math.max(0, life[k] / max[k]);
    }
    const a = this.points.geometry.attributes; a.position.needsUpdate = a.aCol.needsUpdate = a.aSize.needsUpdate = true;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]; it.age += dt;
      if (it.age >= it.life) { this.scene.remove(it.mesh); if (it.mesh.material && it.mesh.geometry !== this.rope) it.mesh.geometry.dispose(); if (it.mesh.material) it.mesh.material.dispose(); this.items.splice(i, 1); continue; }
      if (it.fn) it.fn(it.mesh, it.age / it.life, dt);
    }
  }
}
