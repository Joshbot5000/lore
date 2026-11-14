// Input (keyboard + mouse, touch, gamepad), the HUD, radar, and the tap-anywhere globe map.
import * as THREE from 'three';
import { G, clamp, rad, isTouch } from './util.js';
import { Geo, BLOCK, CH } from './geo.js';
import { HEROES } from './powers.js';

const $ = id => document.getElementById(id);
const KEYS = { KeyW: 'up', ArrowUp: 'up', KeyS: 'dn', ArrowDown: 'dn', KeyA: 'lf', ArrowLeft: 'lf', KeyD: 'rt', ArrowRight: 'rt', Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyE: 'traverse', KeyQ: 'p1', KeyR: 'p2', KeyX: 'p3', Digit1: 'p1', Digit2: 'p2', Digit3: 'p3', KeyC: 'dodge', KeyF: 'interact', Enter: 'interact' };
const HELP = [['Move', 'W A S D · left stick'], ['Look', 'Mouse · drag right side'], ['Jump / double jump', 'Space · JUMP'], ['Sprint', 'Shift · push stick fully'], ['Traverse (hold)', 'E or right mouse · HOLD'],
  ['Attack', 'Left mouse · HIT'], ['Dodge', 'C · DODGE'], ['Powers', 'Q · R · X'], ['Enter / leave car', 'F · CAR'], ['Handbrake', 'Space · JUMP'], ['Wall-run / climb', 'Run or jump into a wall and keep pushing'], ['Switch hero', 'Z · ⇄'], ['World map', 'M · 🌍'], ['Pause', 'Esc · Ⅱ']];

export class UI {
  constructor() {
    const I = G.input = { mx: 0, my: 0, lookX: 0, lookY: 0, down: {}, hit: {} }; this.keys = {}; this.touch = isTouch(); this.stick = { id: -1, x: 0, y: 0 }; this.lookId = -1; this.tAcc = 0; this.toasts = [];
    document.body.classList.toggle('touch', this.touch);
    const press = (k, v) => { if (v && !I.down[k]) I.hit[k] = true; I.down[k] = v; };
    this.press = press;
    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return; const k = KEYS[e.code];
      if (k) { if (!e.repeat) { this.keys[k] = true; press(k, true); } e.preventDefault(); }
      if (e.repeat) return;
      if (e.code === 'KeyM') G.state === 'map' ? G.closeMap() : G.state === 'play' && G.openMap();
      if (e.code === 'KeyZ' && G.state === 'play') G.cycleHero();
      if ((e.code === 'KeyP' || e.code === 'Escape') && (G.state === 'play' || G.state === 'pause')) G.setPause(G.state === 'play');
      if (e.code === 'Tab') e.preventDefault();
    });
    addEventListener('keyup', e => { const k = KEYS[e.code]; if (k) { this.keys[k] = false; press(k, false); } });
    addEventListener('blur', () => { for (const k in this.keys) this.keys[k] = false; for (const k in I.down) I.down[k] = false; });
    const cv = $('c');
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      if (G.state !== 'play') return;
      if (e.pointerType === 'touch') { if (this.lookId < 0) { this.lookId = e.pointerId; this.lx = e.clientX; this.ly = e.clientY; } return; }
      if (!document.pointerLockElement && cv.requestPointerLock) { const p = cv.requestPointerLock(); if (p && p.catch) p.catch(() => { }); }
      if (e.button === 0) press('attack', true); if (e.button === 2) press('traverse', true); this.drag = true;
    });
    addEventListener('pointerup', e => { if (e.pointerId === this.lookId) this.lookId = -1; if (e.pointerType !== 'touch') { if (e.button === 0) press('attack', false); if (e.button === 2) press('traverse', false); this.drag = false; } });
    addEventListener('pointercancel', e => { if (e.pointerId === this.lookId) this.lookId = -1; });
    addEventListener('pointermove', e => {
      if (G.state !== 'play') return;
      if (e.pointerType === 'touch') { if (e.pointerId === this.lookId) { I.lookX += (e.clientX - this.lx) * 0.0052; I.lookY += (e.clientY - this.ly) * 0.0042; this.lx = e.clientX; this.ly = e.clientY; } return; }
      if (document.pointerLockElement === cv || this.drag) { I.lookX += e.movementX * 0.0024; I.lookY += e.movementY * 0.0021; }
    });
    // virtual stick appears wherever the left thumb lands
    const zone = $('stickZone'), st = $('stick'), nub = st.firstElementChild;
    zone.addEventListener('pointerdown', e => { this.stick.id = e.pointerId; this.sx = e.clientX; this.sy = e.clientY; st.style.display = 'block'; st.style.left = e.clientX + 'px'; st.style.top = e.clientY + 'px'; zone.setPointerCapture(e.pointerId); e.preventDefault(); });
    zone.addEventListener('pointermove', e => { if (e.pointerId !== this.stick.id) return; let dx = (e.clientX - this.sx) / 52, dy = (e.clientY - this.sy) / 52; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } this.stick.x = dx; this.stick.y = dy; nub.style.transform = `translate(${dx * 38}px,${dy * 38}px)`; });
    const end = e => { if (e.pointerId !== this.stick.id) return; this.stick.id = -1; this.stick.x = this.stick.y = 0; st.style.display = 'none'; nub.style.transform = ''; };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
    const hold = (el, k) => { el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('dn'); press(k, true); el.setPointerCapture(e.pointerId); }); const up = () => { el.classList.remove('dn'); press(k, false); }; el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); };
    hold($('t-jump'), 'jump'); hold($('t-trav'), 'traverse'); hold($('t-atk'), 'attack'); hold($('t-dodge'), 'dodge'); hold($('t-use'), 'interact');
    // HUD skeleton
    $('stars').innerHTML = '<i>★</i>'.repeat(5);
    this.pw = [0, 1, 2].map(i => { const b = document.createElement('button'); b.className = 'pw glass'; b.innerHTML = `<kbd>${'QRX'[i]}</kbd><b></b><small></small><u></u>`; $('powers').appendChild(b); hold(b, 'p' + (i + 1)); return b; });
    $('keys').innerHTML = HELP.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
    $('b-map').onclick = () => G.openMap(); $('b-pause').onclick = () => G.setPause(true); $('b-hero').onclick = () => G.cycleHero();
    $('p-resume').onclick = () => G.setPause(false); $('p-map').onclick = () => { G.setPause(false); G.openMap(); };
    $('p-mute').onclick = e => { G.muted = !G.muted; G.audio.mute(G.muted); e.target.textContent = 'Sound: ' + (G.muted ? 'Off' : 'On'); };
    $('p-q').textContent = 'Graphics: ' + G.qName; $('p-q').onclick = () => { const o = ['Auto', 'Low', 'Medium', 'High'], n = o[(o.indexOf(G.qName) + 1) % 4]; try { localStorage.setItem('eh.q', n); } catch (e) { } location.reload(); };
    $('heroes').innerHTML = HEROES.map((h, i) => `<button class="hero glass" data-i="${i}" style="--c:${h.color}"><b>${h.name}</b><i>${h.title}</i><span>${h.blurb}</span></button>`).join('');
    $('heroes').onclick = e => { const b = e.target.closest('.hero'); if (b) G.setHero(+b.dataset.i); };
    this.mini = $('mini').getContext('2d'); this.map = new GlobeMap();
  }
  setHero(h, i) {
    document.documentElement.style.setProperty('--hero', h.color);
    $('heroName').innerHTML = `${h.name}<span>${h.traverse}</span>`; $('t-trav').textContent = h.traverse.split(' ').pop().toUpperCase();
    h.powers.forEach((p, k) => { this.pw[k].children[1].textContent = p.icon; this.pw[k].children[2].textContent = p.name; });
    document.querySelectorAll('.hero').forEach((b, k) => b.classList.toggle('sel', k === i));
  }
  toast(title, sub) {
    const d = document.createElement('div'); d.className = 'toast glass'; d.innerHTML = `<b>${title}</b>` + (sub ? `<span>${sub}</span>` : ''); const box = $('toasts'); box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove(); setTimeout(() => d.remove(), 3600);
  }
  hurt() { const h = $('hurt'); h.style.opacity = 1; clearTimeout(this.hT); this.hT = setTimeout(() => h.style.opacity = 0, 180); }
  poll() {
    const I = G.input, k = this.keys; let mx = (k.rt ? 1 : 0) - (k.lf ? 1 : 0), my = (k.up ? 1 : 0) - (k.dn ? 1 : 0);
    if (this.stick.id >= 0) { mx = this.stick.x; my = -this.stick.y; I.down.sprint = Math.hypot(mx, my) > 0.88; }
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(g => g && g.connected) : null;
    if (gp) {
      const dz = v => Math.abs(v) < 0.16 ? 0 : v; if (dz(gp.axes[0]) || dz(gp.axes[1])) { mx = dz(gp.axes[0]); my = -dz(gp.axes[1]); }
      I.lookX += dz(gp.axes[2]) * 0.05; I.lookY += dz(gp.axes[3]) * 0.035;
      const map = { 0: 'jump', 1: 'dodge', 2: 'attack', 3: 'interact', 7: 'traverse', 6: 'sprint', 4: 'p1', 5: 'p2', 10: 'sprint', 11: 'p3' };
      this.gpd = this.gpd || {}; for (const b in map) { const v = gp.buttons[b] && gp.buttons[b].pressed; if (v !== !!this.gpd[b]) { this.gpd[b] = v; this.press(map[b], v); } }
    }
    const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; } I.mx = mx; I.my = my;
  }
  frame(dt) {
    const p = G.player, w = G.wanted; this.tAcc += dt;
    $('hp').firstChild.style.width = clamp(p.hp, 0, 100) + '%'; $('en').firstChild.style.width = p.energy + '%';
    p.hero.powers.forEach((d, i) => { const c = G.powers.cd[i]; this.pw[i].lastChild.style.height = (c > 0 ? c / d.cd * 100 : p.energy < d.cost ? 100 : 0) + '%'; });
    if (this.tAcc < 0.2) return; this.tAcc = 0;
    const st = $('stars'); for (let i = 0; i < 5; i++) st.children[i].className = i < w.level ? 'on' : ''; st.className = w.state === 'search' ? 'search' : ''; st.style.display = w.level ? 'flex' : 'none';
    const car = p.mode === 'car'; $('speedo').style.display = car ? 'block' : 'none'; if (car) $('speedo').firstChild.textContent = Math.round(Math.abs(p.car.vf) * 3.6);
    const near = !car && p.nearestCar(), pr = $('prompt'); $('t-use').style.display = (near || car) ? 'grid' : 'none'; $('t-use').textContent = car ? 'EXIT' : 'CAR';
    pr.style.display = (near || car) && !this.touch ? 'block' : 'none'; pr.textContent = car ? 'F · Leave car    E · Leap out' : 'F · Drive';
    const lat = Geo.toLat(p.pos.z), lon = Geo.toLon(p.pos.x), nc = Geo.nearestCity(lat, lon), c = nc.city, sea = Geo.land(lat, lon) < 0.5;
    const inCity = c && nc.km < Geo.cityRadiusKm(c[3]);
    $('place').textContent = !c ? (sea ? 'Open ocean' : 'Wilderness') : inCity ? `${c[0]}, ${c[4]}` : `${sea ? 'At sea · ' : ''}${nc.km < 10 ? nc.km.toFixed(1) : Math.round(nc.km)} km from ${c[0]}`;
    const wx = G.sky.override ? { label: 'Whiteout', temp: -12 } : G.sky.w;
    $('meta').textContent = `${G.sky.localTime(lon)} local · ${wx.label} ${wx.temp}°C${G.sky.w.live ? '' : ' (est.)'} · ${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
    this.radar();
  }
  radar() {
    const x = this.mini, S = 264, R = 170, k = S / (2 * R), p = G.player, px = p.pos.x, pz = p.pos.z, T = (wx, wz) => [S / 2 + (wx - px) * k, S / 2 + (wz - pz) * k];
    x.clearRect(0, 0, S, S); x.save(); x.beginPath(); x.arc(S / 2, S / 2, S / 2, 0, 7); x.clip();
    const ch = G.world.chunkAt(px, pz), urban = ch && ch.urban; x.fillStyle = Geo.height(px, pz) < 0 ? '#0d2a44' : urban ? '#3b3f47' : '#22301f'; x.fillRect(0, 0, S, S);
    if (urban) { x.fillStyle = '#23262c'; for (let gx = Math.floor((px - R) / BLOCK); gx <= Math.ceil((px + R) / BLOCK); gx++) for (let gz = Math.floor((pz - R) / BLOCK); gz <= Math.ceil((pz + R) / BLOCK); gz++) { const [a, b] = T(gx * BLOCK + 7, gz * BLOCK + 7); x.fillRect(a, b, (BLOCK - 14) * k, (BLOCK - 14) * k); } }
    x.fillStyle = '#8791a3'; G.world.forBoxes(px - R, pz - R, px + R, pz + R, b => { const [a, c] = T(b.minx, b.minz); x.fillRect(a, c, (b.maxx - b.minx) * k, (b.maxz - b.minz) * k); });
    const dot = (wx, wz, col, r) => { const [a, b] = T(wx, wz); x.fillStyle = col; x.beginPath(); x.arc(a, b, r, 0, 7); x.fill(); };
    for (const c of G.ents.cars) if (!c.dead && c !== p.car) dot(c.pos.x, c.pos.z, c.ai === 'cop' ? '#4f8dff' : '#e9edf3', c.ai === 'cop' ? 5 : 3);
    for (const n of G.ents.npcs) if (!n.dead && n.kind !== 'ped') dot(n.pos.x, n.pos.z, n.kind === 'cop' ? '#4f8dff' : '#ff4455', 4);
    const cc = G.world.chunks; for (const c of cc.values()) for (const o of c.orbs) if (Math.abs(o[0] - px) < R && Math.abs(o[2] - pz) < R) dot(o[0], o[2], '#66f6ff', 3);
    for (const g of G.ents.gangs) { const dx = g.x - px, dz = g.z - pz, d = Math.hypot(dx, dz), m = Math.min(d, R - 8); const [a, b] = T(px + dx / (d || 1) * m, pz + dz / (d || 1) * m); x.strokeStyle = '#ff4455'; x.lineWidth = 3; x.beginPath(); x.arc(a, b, 9 + Math.sin(G.time * 5) * 2, 0, 7); x.stroke(); }
    x.translate(S / 2, S / 2); x.rotate(-p.camYaw); x.fillStyle = 'rgba(255,255,255,.14)'; x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, S / 2, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); x.fill(); x.rotate(p.camYaw);
    x.rotate(Math.PI - (p.mode === 'car' ? p.car.yaw : p.yaw)); x.fillStyle = p.hero.color; x.beginPath(); x.moveTo(0, -11); x.lineTo(8, 9); x.lineTo(0, 4); x.lineTo(-8, 9); x.fill(); x.restore();
    x.fillStyle = '#fff'; x.font = '700 18px system-ui'; x.textAlign = 'center'; x.fillText('N', S / 2, 20);
  }
}

// ---------- globe ----------
const ll2v = (lat, lon, r = 1) => { const ph = rad(lon + 180), th = rad(90 - lat); return new THREE.Vector3(-Math.cos(ph) * Math.sin(th) * r, Math.cos(th) * r, Math.sin(ph) * Math.sin(th) * r); };
class GlobeMap {
  constructor() {
    this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(40, 1, 0.01, 50); this.lat = 30; this.lon = 0; this.dist = 3.1; this.sel = null; this.ptr = new Map(); this.moved = 0;
    const day = new THREE.Texture(Geo.dayImage), night = new THREE.Texture(Geo.nightImage); for (const t of [day, night]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; }
    this.mat = new THREE.ShaderMaterial({ uniforms: { uDay: { value: day }, uNight: { value: night }, uSun: { value: new THREE.Vector3(1, 0, 0) } },
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vN=normalize(position); vec4 w=modelMatrix*vec4(position,1.); vV=normalize(cameraPosition-w.xyz); gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `uniform sampler2D uDay,uNight; uniform vec3 uSun; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ float d=dot(vN,uSun); float k=smoothstep(-0.12,0.22,d); vec3 day=texture2D(uDay,vUv).rgb*(0.35+0.95*max(d,0.)); vec3 nt=texture2D(uNight,vUv).rgb*1.6+texture2D(uDay,vUv).rgb*0.05;
          vec3 c=mix(nt,day,k); float rim=pow(1.-max(dot(vN,vV),0.),3.); c+=vec3(.3,.55,1.)*rim*(0.25+0.75*k); gl_FragColor=vec4(c,1.);
#include <colorspace_fragment>
        }` });
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 80), this.mat); this.scene.add(this.globe);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 40), new THREE.ShaderMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vN; void main(){ vN=normalize(normalMatrix*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`, fragmentShader: `varying vec3 vN; void main(){ float a=pow(0.72-dot(vN,vec3(0,0,1.)),3.); gl_FragColor=vec4(.35,.6,1.,clamp(a,0.,1.)*1.4); }` })); this.scene.add(halo);
    const pin = c => { const g = new THREE.Group(), m = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: c })), r = new THREE.Mesh(new THREE.RingGeometry(0.014, 0.019, 32), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); g.add(m, r); g.visible = false; this.scene.add(g); return g; };
    this.pinSel = pin(0xffd24a); this.pinMe = pin(0x37f5d6); this.ray = new THREE.Raycaster();
    this.labels = Array.from({ length: 46 }, () => { const s = document.createElement('span'); $('labels').appendChild(s); return s; });
    const el = $('mapScreen');
    el.addEventListener('pointerdown', e => { if (e.target.closest('button,input,#mapInfo,#results')) return; this.ptr.set(e.pointerId, [e.clientX, e.clientY]); this.moved = 0; $('search').blur(); });
    el.addEventListener('pointermove', e => {
      const p = this.ptr.get(e.pointerId); if (!p) return; const dx = e.clientX - p[0], dy = e.clientY - p[1];
      if (this.ptr.size === 2) { const o = [...this.ptr.entries()].find(q => q[0] !== e.pointerId)[1], d0 = Math.hypot(p[0] - o[0], p[1] - o[1]), d1 = Math.hypot(e.clientX - o[0], e.clientY - o[1]); this.zoom(d0 / Math.max(1, d1)); this.moved = 99; }
      else { const k = (this.dist - 1) * 0.13; this.lon -= dx * k; this.lat = clamp(this.lat + dy * k, -85, 85); this.moved += Math.abs(dx) + Math.abs(dy); }
      p[0] = e.clientX; p[1] = e.clientY;
    });
    const up = e => { if (!this.ptr.delete(e.pointerId)) return; if (this.moved < 9 && e.type === 'pointerup') this.pick(e.clientX, e.clientY); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { this.zoom(Math.exp(e.deltaY * 0.0012)); e.preventDefault(); }, { passive: false });
    $('m-close').onclick = () => G.closeMap(); $('m-go').onclick = () => this.sel && G.travel(this.sel.lat, this.sel.lon);
    $('m-city').onclick = () => this.sel && this.sel.city && G.travel(this.sel.city[1], this.sel.city[2]);
    const sr = $('search'), res = $('results');
    sr.oninput = () => { const q = sr.value.trim().toLowerCase(); if (q.length < 2) { res.style.display = 'none'; return; } const m = []; for (const c of Geo.cities) { const n = c[0].toLowerCase(); if (n.startsWith(q)) m.unshift(c); else if (n.includes(q)) m.push(c); if (m.length > 60) break; }
      m.sort((a, b) => (b[0].toLowerCase().startsWith(q) - a[0].toLowerCase().startsWith(q)) || b[3] - a[3]); res.innerHTML = ''; m.slice(0, 7).forEach(c => { const b = document.createElement('button'); b.innerHTML = `${c[0]}<span>${c[4]}</span>`; b.onclick = () => { this.select(c[1], c[2]); this.lat = c[1]; this.lon = c[2]; this.dist = Math.min(this.dist, 1.5); res.style.display = 'none'; sr.value = ''; sr.blur(); }; res.appendChild(b); }); res.style.display = m.length ? 'block' : 'none'; };
  }
  zoom(f) { this.dist = clamp(1 + (this.dist - 1) * f, 1.035, 4.2); }
  open(lat, lon) { this.lat = lat; this.lon = lon; this.dist = Math.max(this.dist, 1.6); this.me = { lat, lon }; this.place(this.pinMe, lat, lon); }
  place(pin, lat, lon) { pin.position.copy(ll2v(lat, lon, 1.002)); pin.lookAt(0, 0, 0); pin.visible = true; }
  pick(cx, cy) {
    this.ray.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), this.cam); const h = this.ray.intersectObject(this.globe)[0]; if (!h) return;
    this.select(h.uv.y * 180 - 90, h.uv.x * 360 - 180);
  }
  select(lat, lon) {
    const nc = Geo.nearestCity(lat, lon), c = nc.city, sea = Geo.land(lat, lon) < 0.5; this.sel = { lat, lon, city: c && nc.km < 400 ? c : null }; this.place(this.pinSel, lat, lon);
    const inCity = c && nc.km < Geo.cityRadiusKm(c[3]);
    $('mi-t').textContent = inCity ? `${c[0]}, ${c[4]}` : sea ? 'Open ocean' : c && nc.km < 400 ? `${Math.round(nc.km)} km from ${c[0]}` : 'Wilderness';
    $('mi-s').textContent = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}` + (sea ? ' · you will land on the water' : '') + (c && !inCity && nc.km < 400 ? ` · nearest city: ${c[0]}, ${c[4]}` : '');
    $('m-go').style.display = ''; const mc = $('m-city'); mc.style.display = c && !inCity && nc.km < 400 ? '' : 'none'; if (c) mc.textContent = `Go to ${c[0]}`;
  }
  render(renderer) {
    const now = new Date(G.sky.now()), h = now.getUTCHours() + now.getUTCMinutes() / 60, doy = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / 864e5;
    this.mat.uniforms.uSun.value.copy(ll2v(-23.44 * Math.cos(6.283 * (doy + 10) / 365), -(h - 12) * 15));
    this.cam.aspect = innerWidth / innerHeight; this.cam.fov = this.cam.aspect < 1 ? 58 : 40; this.cam.updateProjectionMatrix(); this.cam.position.copy(ll2v(this.lat, this.lon, this.dist)); this.cam.lookAt(0, 0, 0);
    const s = (this.dist - 1) * 1.6 + 0.12; this.pinSel.scale.setScalar(s); this.pinMe.scale.setScalar(s);
    const exp = renderer.toneMappingExposure, tm = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping; renderer.setClearColor(0x02040a); renderer.render(this.scene, this.cam); renderer.toneMapping = tm; renderer.toneMappingExposure = exp;
    // label the biggest cities facing the camera
    const N = clamp(Math.round(14 / Math.pow(this.dist - 1, 1.3)), 14, 900), cd = this.cam.position.clone().normalize(), lim = Math.cos(Math.acos(1 / this.dist) * 0.92), v = new THREE.Vector3(); let k = 0;
    for (let i = 0; i < N && k < this.labels.length; i++) { const c = Geo.cities[i]; v.copy(ll2v(c[1], c[2])); if (v.dot(cd) < lim) continue; v.project(this.cam); if (Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.9) continue; const s2 = this.labels[k++]; s2.style.display = ''; s2.style.left = ((v.x + 1) / 2 * innerWidth) + 'px'; s2.style.top = ((1 - v.y) / 2 * innerHeight) + 'px'; if (s2.textContent !== c[0]) s2.textContent = c[0]; }
    for (; k < this.labels.length; k++) this.labels[k].style.display = 'none';
  }
}
