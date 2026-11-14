// Streaming world: terrain from real elevation and coastlines, cities grown at real city
// locations sized by real population, plus collision and ray queries against all of it.
import * as THREE from 'three';
import { G, clamp, lerp, smooth, hash2, rng, fbm } from './util.js';
import { Geo, CH, BLOCK } from './geo.js';

const key = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
const ROAD = 7, WALK = 4, INSET = ROAD + WALK;

// Famous skylines get their signature tower at the right height (metres). [width, height] tiers, bottom to top.
const LANDMARKS = {
  'Paris': { t: [[62, 57], [36, 58], [17, 160], [4, 55]], c: 0x5b4636, s: 3 },
  'Tokyo': { t: [[80, 100], [42, 90], [18, 90], [4, 53]], c: 0xd8552a, s: 3 },
  'London': { t: [[15, 60], [17, 14], [12, 10], [4, 12]], c: 0xb49a68, s: 1 },
  'New York': { t: [[58, 250], [42, 80], [22, 50], [4, 63]], c: 0x9aa3ab, s: 0 },
  'Dubai': { t: [[72, 200], [54, 200], [38, 180], [22, 150], [6, 98]], c: 0xaab6c2, s: 0 },
  'Shanghai': { t: [[72, 400], [52, 150], [20, 82]], c: 0x7f97ad, s: 0 },
  'Toronto': { t: [[28, 335], [42, 22], [10, 100], [3, 96]], c: 0xb5b2aa, s: 4 },
  'Chicago': { t: [[70, 300], [50, 100], [4, 42]], c: 0x2c2f33, s: 2 },
  'Sydney': { t: [[13, 220], [30, 30], [5, 59]], c: 0xc9b98a, s: 4 },
  'Kuala Lumpur': { t: [[46, 300], [34, 80], [16, 40], [4, 32]], c: 0xb9c0c4, s: 2 },
  'Taipei': { t: [[60, 120], [52, 70], [56, 70], [52, 70], [56, 70], [40, 48], [6, 60]], c: 0x6fa39a, s: 0 },
  'Cairo': { t: Array.from({ length: 14 }, (_, i) => [230 - i * 16.2, 9.9]), c: 0xc8a96a, s: 4 },
};

function canvasTex(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
}
function speckle(x, S, n, a) { for (let i = 0; i < n; i++) { x.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * a})`; x.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 1 + Math.random() * 3); } }
function cityTexture(lot) {
  return canvasTex(1024, (x, S) => {
    const m = S / BLOCK, r = ROAD * m, w = WALK * m;
    x.fillStyle = '#2b2d30'; x.fillRect(0, 0, S, S); speckle(x, S, 9000, 0.07);
    x.fillStyle = '#8d8c88'; x.fillRect(r, r, S - 2 * r, S - 2 * r);                       // pavement
    x.strokeStyle = '#6f6e6a'; x.lineWidth = 1;
    for (let i = r; i < S - r; i += 2.2 * m) { x.beginPath(); x.moveTo(i, r); x.lineTo(i, r + w); x.moveTo(i, S - r - w); x.lineTo(i, S - r); x.moveTo(r, i); x.lineTo(r + w, i); x.moveTo(S - r - w, i); x.lineTo(S - r, i); x.stroke(); }
    x.strokeStyle = '#b9b7b0'; x.lineWidth = 3; x.strokeRect(r, r, S - 2 * r, S - 2 * r);    // kerb
    x.fillStyle = lot; x.fillRect(r + w, r + w, S - 2 * (r + w), S - 2 * (r + w));
    x.save(); x.beginPath(); x.rect(r + w, r + w, S - 2 * (r + w), S - 2 * (r + w)); x.clip(); speckle(x, S, 14000, 0.06); x.restore();
    // lane markings: centre lines sit on the block edges, so draw them on all four sides
    x.fillStyle = '#d9b846';
    for (let i = r + 6 * m; i < S - r - 6 * m; i += 6 * m) { x.fillRect(0, i, 1.6, 3 * m); x.fillRect(S - 1.6, i, 1.6, 3 * m); x.fillRect(i, 0, 3 * m, 1.6); x.fillRect(i, S - 1.6, 3 * m, 1.6); }
    x.fillStyle = '#d6d6d2';                                                                  // zebra crossings
    for (const e of [r + 0.6 * m, S - r - 3.2 * m]) for (let i = 0.8 * m; i < r - 2; i += 1.3 * m) {
      x.fillRect(i, e, 0.6 * m, 2.6 * m); x.fillRect(S - i - 0.6 * m, e, 0.6 * m, 2.6 * m); x.fillRect(e, i, 2.6 * m, 0.6 * m); x.fillRect(e, S - i - 0.6 * m, 2.6 * m, 0.6 * m);
    }
  });
}

export class World {
  constructor(scene, q) {
    this.scene = scene; this.q = q; this.chunks = new Map(); this.dyn = []; this.dirty = true; this.queue = [];
    this.collected = new Set(); try { this.collected = new Set(JSON.parse(localStorage.getItem('eh.orbs') || '[]')); } catch (e) { }
    const detail = canvasTex(256, (x, S) => { x.fillStyle = '#b8b8b8'; x.fillRect(0, 0, S, S); speckle(x, S, 9000, 0.16); });
    this.matRural = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.95, metalness: 0 });
    this.matFar = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.matCity = new THREE.MeshStandardMaterial({ map: cityTexture('#77766f'), roughness: 0.88 });
    this.matSuburb = new THREE.MeshStandardMaterial({ map: cityTexture('#4f6b3a'), roughness: 0.9 });
    // ---- instanced props
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    this.bMat = this.buildingMaterial();
    this.bMesh = this.inst(box, this.bMat, q.maxBuildings, true);
    this.bInfo = new THREE.InstancedBufferAttribute(new Float32Array(q.maxBuildings * 3), 3); box.setAttribute('aInfo', this.bInfo);
    const roof = new THREE.BufferGeometry();
    roof.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-.5, 0, -.5, .5, 0, -.5, 0, 1, -.5, -.5, 0, .5, .5, 0, .5, 0, 1, .5]), 3));
    roof.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4]); const rg = roof.toNonIndexed(); rg.computeVertexNormals();
    this.roofMesh = this.inst(rg, new THREE.MeshStandardMaterial({ roughness: 0.8 }), 2500, true);
    const trunk = new THREE.CylinderGeometry(0.12, 0.2, 1, 6); trunk.translate(0, 0.5, 0);
    this.trunkMesh = this.inst(trunk, new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }), q.maxTrees, true);
    this.crownMesh = this.inst(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), q.maxTrees, true);
    const pole = new THREE.CylinderGeometry(0.07, 0.1, 7, 5); pole.translate(0, 3.5, 0);
    this.poleMesh = this.inst(pole, new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0.6 }), 3000, false);
    this.bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    this.bulbMesh = this.inst(new THREE.SphereGeometry(0.28, 8, 6), this.bulbMat, 3000, false);
    this.orbMesh = this.inst(new THREE.OctahedronGeometry(0.9, 0), new THREE.MeshBasicMaterial({ color: 0x66f6ff }), 600, false);
    // ---- ocean
    const wn = canvasTex(256, (x, S) => {
      const id = x.createImageData(S, S), H = (u, v) => { let h = 0; for (let k = 1; k <= 6; k++) h += Math.sin((u * k * 1.0 + v * (7 - k)) * 6.283 + k * 1.7) / k + Math.sin((u * (k + 2) - v * k * 2) * 6.283 + k) / (k + 1); return h; };
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const u = i / S, v = j / S, e = 1 / S, dx = (H(u + e, v) - H(u - e, v)) * 0.9, dy = (H(u, v + e) - H(u, v - e)) * 0.9, o = (j * S + i) * 4;
        id.data[o] = 128 + clamp(dx * 127, -127, 127); id.data[o + 1] = 128 + clamp(dy * 127, -127, 127); id.data[o + 2] = 255; id.data[o + 3] = 255;
      } x.putImageData(id, 0, 0);
    }, false);
    wn.repeat.set(900, 900);
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshStandardMaterial({ color: 0x0b3350, roughness: 0.1, metalness: 0.35, normalMap: wn, normalScale: new THREE.Vector2(0.6, 0.6), transparent: true, opacity: 0.93 }));
    this.water.rotation.x = -Math.PI / 2; this.water.receiveShadow = true; scene.add(this.water);
    // ---- distant terrain
    const N = q.farCells; this.farN = N;
    const fg = new THREE.PlaneGeometry(N * CH, N * CH, N, N); fg.rotateX(-Math.PI / 2);
    fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
    this.far = new THREE.Mesh(fg, this.matFar); this.far.frustumCulled = false; this.far.receiveShadow = false; scene.add(this.far); this.farKey = null;
    this.cc = { x: 1e9, z: 1e9 };
  }
  inst(geo, mat, n, shadow) {
    const m = new THREE.InstancedMesh(geo, mat, n); m.count = 0; m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = shadow;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(m); return m;
  }
  buildingMaterial() {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.05 });
    m.userData.u = { uLit: { value: 0 }, uGlow: { value: 0 } };
    m.onBeforeCompile = s => {
      Object.assign(s.uniforms, m.userData.u);
      s.vertexShader = 'attribute vec3 aInfo; varying vec3 vBL; varying vec3 vBN; varying vec3 vInfo;\n' + s.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         vBL = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)); vBN = normal; vInfo = aInfo;`);
      s.fragmentShader = `uniform float uLit; uniform float uGlow; varying vec3 vBL; varying vec3 vBN; varying vec3 vInfo;
        float bh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n` + s.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          float bWin = 0.0, bLit = 0.0, bR = 0.0;
          if (vBN.y > 0.5) diffuseColor.rgb = diffuseColor.rgb * 0.3 + 0.07;
          else if (abs(vBN.y) < 0.5 && vInfo.y < 3.5) {
            float hu = abs(vBN.x) > 0.5 ? vBL.z : vBL.x;
            vec2 cs = vInfo.y < 0.5 ? vec2(2.4, 3.5) : vInfo.y < 1.5 ? vec2(3.4, 3.4) : vInfo.y < 2.5 ? vec2(1.7, 3.9) : vec2(7.0, 7.0);
            vec2 mg = vInfo.y < 0.5 ? vec2(0.05, 0.09) : vInfo.y < 1.5 ? vec2(0.24, 0.22) : vInfo.y < 2.5 ? vec2(0.03, 0.3) : vec2(0.0);
            vec2 q = vec2(hu, vBL.y - 4.0) / cs; vec2 id = floor(q), f = fract(q), fw = fwidth(q) * 1.2;
            if (vInfo.y > 2.5) {       // open lattice: see-through diamonds
              vec2 d = abs(fract(vec2(q.x + q.y, q.x - q.y)) - 0.5);
              if (min(d.x, d.y) > 0.09 && max(fw.x, fw.y) < 0.35 && abs(fract(q.y) - 0.5) < 0.44) discard;
            } else {
              vec2 w2 = smoothstep(mg - fw, mg + fw, f) * (1.0 - smoothstep(1.0 - mg - fw, 1.0 - mg + fw, f));
              float cover = (1.0 - 2.0 * mg.x) * (1.0 - 2.0 * mg.y);
              bWin = mix(w2.x * w2.y, cover, smoothstep(0.25, 0.7, max(fw.x, fw.y)));
              if (vBL.y < 4.0) bWin = 0.0;
              bR = bh(id + vInfo.x * 91.7);
              bLit = bWin * step(bR, uLit) * mix(1.0, 0.45, smoothstep(0.25, 0.7, max(fw.x, fw.y)));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.055, 0.075) + bR * 0.03, bWin);
            }
          }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.07, bWin);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 0.9, bWin);')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += bLit * uGlow * mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.88, 1.0), step(0.6, fract(bR * 17.0))) * (0.5 + fract(bR * 7.0));`);
    };
    return m;
  }

  // ---------- generation ----------
  groundColor(x, z, h, slope, out) {
    const lat = Geo.toLat(z), lon = Geo.toLon(x); Geo.color(lat, lon, out);
    const n = 0.86 + 0.28 * fbm((Geo.ox * CH + x) / 140, (Geo.oz * CH + z) / 140, 3);
    out[0] = out[0] * 1.35 * n + 0.03; out[1] = out[1] * 1.3 * n + 0.035; out[2] = out[2] * 1.2 * n + 0.02;
    const rock = smooth(0.55, 1.1, slope), sand = (1 - smooth(0.4, 3.2, h)) * (h > -4 ? 1 : 0.3), snow = smooth(0, 500, h - (4700 - Math.abs(lat) * 62));
    const mix = (r, g, b, t) => { out[0] = lerp(out[0], r, t); out[1] = lerp(out[1], g, t); out[2] = lerp(out[2], b, t); };
    mix(0.36, 0.34, 0.32, rock); mix(0.74, 0.68, 0.5, sand); mix(0.93, 0.95, 0.98, snow * (1 - rock * 0.5));
    return out;
  }
  genChunk(cx, cz) {
    const x0 = cx * CH, z0 = cz * CH, c00 = Geo.urbanCorner(cx, cz), mid = Geo.urbanLL(Geo.toLat(z0 + CH / 2), Geo.toLon(x0 + CH / 2));
    const ax = Geo.ox + cx, az = Geo.oz + cz, R = rng((hash2(ax, az, Geo.band) * 4294967296) | 0);
    const ch = { cx, cz, x0, z0, u: mid.u, tier: mid.tier, city: mid.city, urban: mid.u > 0.1, boxes: [], bld: [], roofs: [], trees: [], lamps: [], orbs: [], ground: null, cars: 0 };
    const col = [0, 0, 0];
    if (ch.urban) {
      // is the city's landmark in this chunk?
      let lm = null, lmB = -1; const L = mid.city && LANDMARKS[mid.city[0]];
      if (L) { const lx = mid.city[2] * 111320 * Geo.cosB - Geo.ox * CH, lz = -mid.city[1] * 111320 - Geo.oz * CH; if (lx >= x0 && lx < x0 + CH && lz >= z0 && lz < z0 + CH) { lm = L; lmB = 0; } }
      for (let b = 0; b < 4; b++) {
        const bx = x0 + (b & 1) * BLOCK, bz = z0 + (b >> 1) * BLOCK, mx = bx + BLOCK / 2, mz = bz + BLOCK / 2;
        const g = Geo.height(mx, mz); if (g < 0.8) continue;
        const u = clamp(Geo.urban(mx, mz) + (R() - 0.5) * 0.12, 0, 1), y0 = g;
        ch.lamps.push([bx + ROAD + 1, Geo.height(bx + ROAD + 1, bz + ROAD + 1), bz + ROAD + 1], [bx + BLOCK - ROAD - 1, Geo.height(bx + BLOCK - ROAD - 1, bz + BLOCK - ROAD - 1), bz + BLOCK - ROAD - 1]);
        if (b === lmB) { this.addTower(ch, mx, mz, y0, lm.t, new THREE.Color(lm.c), lm.s, R()); continue; }
        const lotSpan = BLOCK - 2 * INSET, r0 = R();
        if (r0 < 0.07 + (u < 0.3 ? 0.08 : 0)) {           // park
          for (let i = 0; i < 14; i++) { const tx = bx + INSET + R() * lotSpan, tz = bz + INSET + R() * lotSpan; ch.trees.push([tx, Geo.height(tx, tz), tz, 5 + R() * 6, 0.25, 0.5 + R() * 0.2, 0.2]); }
          continue;
        }
        const n = u > 0.72 ? (R() < 0.45 ? 1 : 2) : u > 0.36 ? 2 : 3, ls = lotSpan / n;
        const maxH = 9 + Math.pow(mid.tier, 1.5) * 360 * Math.pow(u, 2.3);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          if (R() < 0.06) continue;
          const lx = bx + INSET + (i + 0.5) * ls, lz = bz + INSET + (j + 0.5) * ls;
          if (n === 3) {                                    // houses with pitched roofs and garden trees
            const w = 8 + R() * 5, d = 8 + R() * 4, h = 3.2 + (R() < 0.4 ? 3 : 0), gy = Geo.height(lx, lz);
            const c = new THREE.Color().setHSL(0.06 + R() * 0.08, 0.15 + R() * 0.25, 0.55 + R() * 0.3);
            this.addBox(ch, lx, gy, lz, w, h, d, c, 4, R());
            ch.roofs.push([lx, gy + h, lz, w + 1, 2.6 + R() * 1.5, d + 1, new THREE.Color().setHSL(0.02 + R() * 0.05, 0.4, 0.2 + R() * 0.15)]);
            if (R() < 0.7) { const tx = lx + (R() - 0.5) * (ls - 4), tz = lz + ls * 0.38; ch.trees.push([tx, Geo.height(tx, tz), tz, 4 + R() * 4, 0.27, 0.5, 0.18]); }
            continue;
          }
          const pad = 1.5 + R() * 3, w = ls - pad * 2 - R() * 4, d = ls - pad * 2 - R() * 4;
          let h = 9 + maxH * Math.pow(R(), n === 1 ? 1.3 : 2.4); h = Math.round(h / 3.5) * 3.5;
          const style = h > 45 ? (R() < 0.6 ? 0 : 2) : (R() < 0.55 ? 1 : R() < 0.5 ? 2 : 0);
          const c = new THREE.Color();
          if (style === 0) c.setHSL(0.55 + R() * 0.08, 0.1 + R() * 0.2, 0.3 + R() * 0.25); else if (style === 1) c.setHSL(0.03 + R() * 0.07, 0.25 + R() * 0.3, 0.3 + R() * 0.3); else c.setHSL(0.08 + R() * 0.5, 0.04, 0.45 + R() * 0.35);
          if (h > 70 && R() < 0.6) this.addTower(ch, lx, lz, y0, [[w, h * 0.62], [w * 0.74, h * 0.26], [w * 0.45, h * 0.12], ...(R() < 0.4 ? [[2.5, h * 0.14]] : [])], c, style, R());
          else this.addTower(ch, lx, lz, y0, [[w, h]], c, style, R(), d);
          if (h > 55 && R() < 0.3) { const id = ax + '.' + az + '.' + b + i + j; if (!this.collected.has(id)) ch.orbs.push([lx, ch.boxes[ch.boxes.length - 1].maxy + 2.2, lz, id]); }
        }
        if (u < 0.75) for (let i = 0; i < 3; i++) if (R() < 0.6) { const tx = bx + ROAD + 1.6, tz = bz + 20 + i * 26; ch.trees.push([tx, Geo.height(tx, tz), tz, 5 + R() * 3, 0.26, 0.5, 0.2]); }
      }
    } else {
      // countryside: tree cover follows how green the satellite image is here
      Geo.color(Geo.toLat(z0 + CH / 2), Geo.toLon(x0 + CH / 2), col);
      const green = clamp((col[1] - Math.max(col[0], col[2])) * 9 + 0.25 - Math.max(0, col[0] - 0.35) * 2, 0, 1), lat = Math.abs(Geo.toLat(z0));
      const n = Math.round(green * this.q.treeDensity * (0.5 + R()));
      for (let i = 0; i < n; i++) {
        const tx = x0 + R() * CH, tz = z0 + R() * CH, h = Geo.height(tx, tz); if (h < 1.5 || h > 3600) continue;
        const conifer = lat > 48 || h > 1500 || R() < 0.15, s = 5 + R() * 9;
        ch.trees.push([tx, h, tz, s, conifer ? 0.38 : 0.2 + R() * 0.12, conifer ? 0.35 : 0.45 + R() * 0.2, conifer ? 0.16 : 0.22, conifer]);
      }
    }
    return ch;
  }
  addBox(ch, x, y, z, w, h, d, color, style, seed) {
    ch.bld.push({ x, y: y - 5, z, w, h: h + 5, d, color, style, seed });
    ch.boxes.push({ minx: x - w / 2, maxx: x + w / 2, miny: y - 5, maxy: y + h, minz: z - d / 2, maxz: z + d / 2 });
  }
  addTower(ch, x, z, y, tiers, color, style, seed, d0) {
    let yy = y; tiers.forEach((t, i) => { this.addBox(ch, x, i ? yy + 5 : yy, z, t[0], i ? t[1] - 5 : t[1], i || !d0 ? t[0] : d0, color, style, seed); if (i) { const b = ch.bld[ch.bld.length - 1]; b.y = yy; b.h = t[1]; ch.boxes[ch.boxes.length - 1].miny = yy; } yy += t[1]; });
  }
  buildGround(ch) {
    const N = this.q.groundSeg, g = new THREE.PlaneGeometry(CH, CH, N, N); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position, uv = g.attributes.uv, col = new Float32Array(p.count * 3), c = [0, 0, 0];
    for (let i = 0; i < p.count; i++) {
      const lx = p.getX(i) + CH / 2, lz = p.getZ(i) + CH / 2, x = ch.x0 + lx, z = ch.z0 + lz, h = Geo.height(x, z);
      p.setXYZ(i, lx, h, lz); uv.setXY(i, lx / BLOCK, -lz / BLOCK);
      if (!ch.urban) { const s = Math.abs(Geo.height(x + 6, z) - h) / 6 + Math.abs(Geo.height(x, z + 6) - h) / 6; this.groundColor(x, z, h, s, c); col.set(c, i * 3); }
    }
    if (!ch.urban) { g.setAttribute('color', new THREE.BufferAttribute(col, 3)); for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 8, uv.getY(i) * 8); }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, ch.urban ? (ch.u > 0.36 ? this.matCity : this.matSuburb) : this.matRural);
    m.position.set(ch.x0, 0, ch.z0); m.receiveShadow = true; m.frustumCulled = true; g.computeBoundingSphere();
    ch.ground = m; this.scene.add(m);
  }
  dropGround(ch) { if (ch.ground) { this.scene.remove(ch.ground); ch.ground.geometry.dispose(); ch.ground = null; } }

  // ---------- streaming ----------
  update(px, pz, budget = 3) {
    const cx = Math.floor(px / CH), cz = Math.floor(pz / CH), Rb = this.q.buildR, Rg = this.q.groundR;
    if (cx !== this.cc.x || cz !== this.cc.z) {
      this.cc = { x: cx, z: cz }; this.queue.length = 0;
      for (const [k, ch] of this.chunks) {
        const d = Math.max(Math.abs(ch.cx - cx), Math.abs(ch.cz - cz));
        if (d > Rb + 1) { this.dropGround(ch); this.chunks.delete(k); this.dirty = true; } else if (d > Rg + 1) this.dropGround(ch);
      }
      for (let r = 0; r <= Rb; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const ch = this.chunks.get(key(cx + i, cz + j)); if (!ch || (r <= Rg && !ch.ground)) this.queue.push([cx + i, cz + j, r <= Rg]);
      }
      this.updateFar(cx, cz);
    }
    while (budget > 0 && this.queue.length) {
      const [x, z, gnd] = this.queue.shift(), k = key(x, z); let ch = this.chunks.get(k);
      if (!ch) { ch = this.genChunk(x, z); this.chunks.set(k, ch); this.dirty = true; budget -= 0.34; }
      if (gnd && !ch.ground) { this.buildGround(ch); budget -= 1; }
    }
    this.water.position.set(Math.round(px / 44.4) * 44.4, 0, Math.round(pz / 44.4) * 44.4);
    if (this.dirty) { this.dirty = false; this.rebuildInstances(); }
    for (let i = this.dyn.length - 1; i >= 0; i--) if (this.dyn[i].until < G.time) { const d = this.dyn[i]; if (d.mesh) { this.scene.remove(d.mesh); } this.dyn.splice(i, 1); }
  }
  loadAll(px, pz) { this.cc = { x: 1e9, z: 1e9 }; this.update(px, pz, 1e9); }
  reset() { for (const ch of this.chunks.values()) this.dropGround(ch); this.chunks.clear(); this.queue.length = 0; this.cc = { x: 1e9, z: 1e9 }; this.farKey = null; this.dirty = true; for (const d of this.dyn) if (d.mesh) this.scene.remove(d.mesh); this.dyn.length = 0; }
  updateFar(cx, cz) {
    const N = this.farN, g = this.far.geometry, p = g.attributes.position, col = g.attributes.color, c = [0, 0, 0], Rg = this.q.groundR;
    this.far.position.set((cx + 0.5 - N / 2 + N / 2) * CH - CH / 2, 0, (cz + 0.5) * CH - CH / 2);   // grid vertices sit on chunk corners
    const ox = this.far.position.x, oz = this.far.position.z;
    for (let i = 0; i < p.count; i++) {
      const x = ox + p.getX(i), z = oz + p.getZ(i), h = Geo.height(x, z), u = Geo.urban(x, z);
      const near = Math.max(Math.abs(x / CH - cx - 0.5), Math.abs(z / CH - cz - 0.5)) < Rg - 0.6;
      p.setY(i, near ? h - 60 : h - 1.5);
      this.groundColor(x, z, h, 0, c); const t = smooth(0.1, 0.4, u);
      col.setXYZ(i, lerp(c[0], 0.33, t), lerp(c[1], 0.33, t), lerp(c[2], 0.34, t));
    }
    p.needsUpdate = true; col.needsUpdate = true; g.computeVertexNormals();
  }
  rebuildInstances() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color();
    let nb = 0, nr = 0, nt = 0, nl = 0, no = 0; const B = this.bMesh, info = this.bInfo.array;
    for (const ch of this.chunks.values()) {
      for (const b of ch.bld) { if (nb >= this.q.maxBuildings) break; m.compose(v.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d)); B.setMatrixAt(nb, m); B.setColorAt(nb, b.color); info[nb * 3] = b.seed; info[nb * 3 + 1] = b.style; nb++; }
      for (const r of ch.roofs) { if (nr >= 2500) break; m.compose(v.set(r[0], r[1], r[2]), q, s.set(r[3], r[4], r[5])); this.roofMesh.setMatrixAt(nr, m); this.roofMesh.setColorAt(nr, r[6]); nr++; }
      for (const t of ch.trees) {
        if (nt >= this.q.maxTrees) break; const h = t[3];
        m.compose(v.set(t[0], t[1] - 0.3, t[2]), q, s.set(h * 0.18, h * 0.6, h * 0.18)); this.trunkMesh.setMatrixAt(nt, m);
        const cw = t[7] ? h * 0.22 : h * 0.36; m.compose(v.set(t[0], t[1] + h * (t[7] ? 0.62 : 0.72), t[2]), q, s.set(cw, t[7] ? h * 0.45 : h * 0.33, cw)); this.crownMesh.setMatrixAt(nt, m);
        this.crownMesh.setColorAt(nt, col.setHSL(t[4], t[5], t[6])); nt++;
      }
      for (const l of ch.lamps) { if (nl >= 3000) break; m.compose(v.set(l[0], l[1], l[2]), q, s.set(1, 1, 1)); this.poleMesh.setMatrixAt(nl, m); m.setPosition(l[0], l[1] + 7.1, l[2]); this.bulbMesh.setMatrixAt(nl, m); nl++; }
      for (const o of ch.orbs) { if (no >= 600) break; m.compose(v.set(o[0], o[1], o[2]), q, s.set(1, 1, 1)); this.orbMesh.setMatrixAt(no, m); no++; }
    }
    const fin = (mesh, n) => { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; };
    fin(B, nb); this.bInfo.needsUpdate = true; fin(this.roofMesh, nr); fin(this.trunkMesh, nt); fin(this.crownMesh, nt); fin(this.poleMesh, nl); fin(this.bulbMesh, nl); fin(this.orbMesh, no);
  }
  setLighting(night, blackout) {
    const u = this.bMat.userData.u, on = blackout ? 0 : 1;
    u.uLit.value = on * lerp(0.04, 0.42, night); u.uGlow.value = on * lerp(0.15, 2.4, night);
    this.bulbMat.color.setRGB(1, 0.85, 0.62).multiplyScalar(on * lerp(0.25, 2.6, smooth(0.25, 0.7, night)));
    const wet = G.sky.wet || 0; this.matCity.roughness = lerp(0.88, 0.3, wet); this.matSuburb.roughness = lerp(0.9, 0.45, wet);
    this.water.material.normalMap.offset.set(G.time * 0.004, G.time * 0.0027);
  }

  // ---------- queries ----------
  chunkAt(x, z) { return this.chunks.get(key(Math.floor(x / CH), Math.floor(z / CH))); }
  isRoadChunk(x, z) { const c = this.chunkAt(x, z); return !!(c && c.urban && Geo.height(x, z) > 1); }
  forBoxes(minx, minz, maxx, maxz, cb) {
    for (let cx = Math.floor(minx / CH); cx <= Math.floor(maxx / CH); cx++) for (let cz = Math.floor(minz / CH); cz <= Math.floor(maxz / CH); cz++) {
      const ch = this.chunks.get(key(cx, cz)); if (ch) for (const b of ch.boxes) if (b.maxx > minx && b.minx < maxx && b.maxz > minz && b.minz < maxz) cb(b);
    }
    for (const b of this.dyn) if (b.solid && b.maxx > minx && b.minx < maxx && b.maxz > minz && b.minz < maxz) cb(b);
  }
  // Move a vertical cylinder out of buildings and onto the ground. Mutates p and v.
  collide(p, r, h, v, out) {
    out.grounded = false; out.wall = null; out.box = null; out.water = false;
    this.forBoxes(p.x - r, p.z - r, p.x + r, p.z + r, b => {
      if (p.y >= b.maxy || p.y + h <= b.miny) return;
      const nx = clamp(p.x, b.minx, b.maxx), nz = clamp(p.z, b.minz, b.maxz), dx = p.x - nx, dz = p.z - nz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      if (p.y > b.maxy - 0.7 - Math.max(0, -v.y) * 0.035 && v.y <= 0.5) { p.y = b.maxy; if (v.y < 0) v.y = 0; out.grounded = true; out.box = b; return; }
      let ox, oz;
      if (d2 > 1e-6) { const d = Math.sqrt(d2); ox = dx / d; oz = dz / d; p.x = nx + ox * r; p.z = nz + oz * r; }
      else { const a = p.x - b.minx, c = b.maxx - p.x, e = p.z - b.minz, f = b.maxz - p.z, m = Math.min(a, c, e, f); ox = oz = 0; if (m === a) { ox = -1; p.x = b.minx - r; } else if (m === c) { ox = 1; p.x = b.maxx + r; } else if (m === e) { oz = -1; p.z = b.minz - r; } else { oz = 1; p.z = b.maxz + r; } }
      const vn = v.x * ox + v.z * oz; if (vn < 0) { v.x -= vn * ox; v.z -= vn * oz; }
      out.wall = { x: ox, z: oz, box: b };
    });
    const g = Geo.height(p.x, p.z);
    if (p.y <= g) { p.y = g; if (v.y < 0) v.y = 0; out.grounded = true; }
    out.ground = g; return out;
  }
  // First hit along a ray against buildings and terrain.
  raycast(o, d, max, hit = {}) {
    let best = max, nx = 0, ny = 0, nz = 0, box = null;
    const ex = o.x + d.x * max, ez = o.z + d.z * max;
    this.forBoxes(Math.min(o.x, ex), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.z, ez), b => {
      let t0 = 0, t1 = best, ax = -1, sg = 0;
      for (let a = 0; a < 3; a++) {
        const oo = a === 0 ? o.x : a === 1 ? o.y : o.z, dd = a === 0 ? d.x : a === 1 ? d.y : d.z, mn = a === 0 ? b.minx : a === 1 ? b.miny : b.minz, mx = a === 0 ? b.maxx : a === 1 ? b.maxy : b.maxz;
        if (Math.abs(dd) < 1e-8) { if (oo < mn || oo > mx) return; continue; }
        let ta = (mn - oo) / dd, tb = (mx - oo) / dd, s = -1; if (ta > tb) { const t = ta; ta = tb; tb = t; s = 1; }
        if (ta > t0) { t0 = ta; ax = a; sg = s; } if (tb < t1) t1 = tb; if (t0 > t1) return;
      }
      if (ax >= 0 && t0 < best) { best = t0; nx = ax === 0 ? sg : 0; ny = ax === 1 ? sg : 0; nz = ax === 2 ? sg : 0; box = b; }
    });
    // terrain: march, then refine
    let t = 0, step = 3, prev = 0;
    while (t < best) {
      if (o.y + d.y * t < Geo.height(o.x + d.x * t, o.z + d.z * t)) {
        let a = prev, b2 = t; for (let i = 0; i < 6; i++) { const m = (a + b2) / 2; if (o.y + d.y * m < Geo.height(o.x + d.x * m, o.z + d.z * m)) b2 = m; else a = m; }
        best = b2; nx = 0; ny = 1; nz = 0; box = null; break;
      }
      prev = t; t += step; step = Math.min(step * 1.15, 14);
    }
    hit.hit = best < max; hit.t = best; hit.x = o.x + d.x * best; hit.y = o.y + d.y * best; hit.z = o.z + d.z * best; hit.nx = nx; hit.ny = ny; hit.nz = nz; hit.box = box;
    return hit;
  }
  los(a, b) { const d = _d.set(b.x - a.x, b.y - a.y, b.z - a.z), l = d.length(); if (l < 0.01) return true; d.multiplyScalar(1 / l); return !this.raycast(a, d, l - 0.5, _h).hit; }
  collectOrbs(p) {
    const ch = this.chunkAt(p.x, p.z); if (!ch) return 0; let n = 0;
    for (let i = ch.orbs.length - 1; i >= 0; i--) { const o = ch.orbs[i]; if (Math.abs(o[0] - p.x) < 3 && Math.abs(o[2] - p.z) < 3 && Math.abs(o[1] - p.y - 1) < 4) { this.collected.add(o[3]); ch.orbs.splice(i, 1); n++; this.dirty = true; } }
    if (n) try { localStorage.setItem('eh.orbs', JSON.stringify([...this.collected].slice(-4000))); } catch (e) { }
    return n;
  }
}
const _d = new THREE.Vector3(), _h = {};
