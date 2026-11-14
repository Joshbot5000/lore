// Live sky: the sun and moon are placed from the real clock and your position on Earth,
// and the weather is the real current weather there (cached; a climate model fills in offline).
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { G, clamp, lerp, smooth, damp, rad, hash2 } from './util.js';
import { Geo } from './geo.js';

const sin = Math.sin, cos = Math.cos;
export function sunMoon(ms, lat, lon) {
  const d = ms / 86400000 - 10957.5;                       // days since J2000
  const eps = rad(23.439 - 4e-7 * d), la = rad(lat);
  const lst = rad(((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon);
  const place = lam => {
    const ra = Math.atan2(cos(eps) * sin(lam), cos(lam)), dec = Math.asin(sin(eps) * sin(lam)), ha = lst - ra;
    const alt = Math.asin(sin(la) * sin(dec) + cos(la) * cos(dec) * cos(ha));
    const az = Math.atan2(-sin(ha), Math.tan(dec) * cos(la) - sin(la) * cos(ha));
    return { alt, dir: new THREE.Vector3(sin(az) * cos(alt), sin(alt), -cos(az) * cos(alt)) };
  };
  const g = rad(357.528 + 0.9856003 * d);
  const sl = rad(280.46 + 0.9856474 * d) + rad(1.915) * sin(g) + rad(0.02) * sin(2 * g);
  const ml = rad(218.316 + 13.176396 * d) + rad(6.289) * sin(rad(134.963 + 13.064993 * d));
  return { sun: place(sl), moon: place(ml), phase: (1 - cos(ml - sl)) / 2 };   // phase 0 new .. 1 full
}

// ---------- weather ----------
const WMO = c => c === 0 ? 'Clear' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Overcast' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain'
  : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorm';
function fromCode(code, cloud, temp, wind) {
  const w = { label: WMO(code), cloud: cloud / 100, rain: 0, snow: 0, fog: 0, thunder: 0, temp, wind: wind / 3.6, live: true };
  if (code >= 45 && code <= 48) w.fog = 1;
  else if (code >= 51 && code <= 57) w.rain = 0.3;
  else if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) w.rain = code === 61 || code === 80 ? 0.5 : code === 63 || code === 81 ? 0.75 : 1;
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) w.snow = code === 71 ? 0.4 : 0.9;
  else if (code >= 95) { w.rain = 1; w.thunder = 1; }
  if (w.rain || w.snow) w.cloud = Math.max(w.cloud, 0.85);
  return w;
}
// Offline fallback: plausible weather for this latitude, season, hour and how green the land is.
function climate(lat, lon, ms) {
  const doy = (ms / 86400000) % 365.25, season = cos((doy - 200) / 365.25 * 6.283) * Math.sign(lat || 1);
  const e = Geo.elev(lat, lon), c = Geo.color(lat, lon, [0, 0, 0]);
  const hourLocal = ((ms / 3600000 + lon / 15) % 24 + 24) % 24;
  let temp = 29 - 48 * Math.pow(Math.abs(sin(rad(lat))), 1.6) + season * 16 * Math.abs(lat) / 70 - e * 30 + 4 * cos((hourLocal - 15) / 24 * 6.283);
  const wet = clamp((c[1] - Math.max(c[0], c[2] * 0.8)) * 6 + 0.35, 0.05, 0.9);
  const slot = Math.floor(ms / 10800000), a = hash2(Math.round(lat * 2), Math.round(lon * 2), slot), b = hash2(Math.round(lat * 2), Math.round(lon * 2), slot + 7);
  const w = { label: 'Clear', cloud: clamp(b * wet * 1.6, 0, 1), rain: 0, snow: 0, fog: 0, thunder: 0, temp: Math.round(temp), wind: 1 + b * 7, live: false };
  if (a < wet * 0.4) {
    const s = 0.35 + a / (wet * 0.4) * 0.65; w.cloud = Math.max(w.cloud, 0.9);
    if (temp < 1) { w.snow = s; w.label = 'Snow'; } else { w.rain = s; w.label = s > 0.8 ? 'Heavy rain' : 'Rain'; if (temp > 22 && b > 0.7) { w.thunder = 1; w.label = 'Thunderstorm'; } }
  } else if (a > 0.95 && hourLocal < 9) { w.fog = 1; w.label = 'Fog'; }
  else w.label = w.cloud > 0.75 ? 'Overcast' : w.cloud > 0.3 ? 'Partly cloudy' : 'Clear';
  return w;
}
async function fetchWeather(lat, lon) {
  const key = 'eh.wx.' + Math.round(lat * 4) + '.' + Math.round(lon * 4);
  let cached = null; try { cached = JSON.parse(localStorage.getItem(key)); } catch (e) { }
  if (cached && Date.now() - cached.t < 30 * 60000) return cached.w;
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m`, { signal: ctl.signal });
    const j = (await r.json()).current;
    const w = fromCode(j.weather_code, j.cloud_cover, Math.round(j.temperature_2m), j.wind_speed_10m);
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), w })); } catch (e) { }
    return w;
  } catch (e) {
    if (cached && Date.now() - cached.t < 3 * 3600000) return cached.w;   // recent real reading still beats a guess
    return null;
  }
}

export class SkySystem {
  constructor(scene, renderer, mobile) {
    this.scene = scene; this.renderer = renderer;
    this.sky = new Sky(); this.sky.scale.setScalar(40000); this.sky.material.fog = false; scene.add(this.sky);
    const u = this.sky.material.uniforms; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    this.sun = new THREE.DirectionalLight(0xffffff, 3); this.sun.castShadow = true;
    const S = mobile ? 90 : 150, sh = this.sun.shadow;
    sh.mapSize.setScalar(mobile ? 1024 : 2048); sh.camera.left = -S; sh.camera.right = S; sh.camera.top = S; sh.camera.bottom = -S;
    sh.camera.near = 1; sh.camera.far = 900; sh.bias = -0.0004; sh.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a4438, 1); scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0x9db8d8, 0.00016);
    // stars
    const n = 1800, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, y = Math.random() * 1.9 - 0.9, r = Math.sqrt(1 - y * y); p.set([cos(a) * r * 30000, y * 30000, sin(a) * r * 30000], i * 3); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false; scene.add(this.stars);
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(700, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf2efe2, fog: false }));
    scene.add(this.moon);
    // precipitation: rain streaks and snow flakes wrap around the camera in the vertex shader
    const N = mobile ? 2500 : 7000, base = new Float32Array(N * 6), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { const x = Math.random(), y = Math.random(), z = Math.random(); base.set([x, y, z, x, y, z], i * 6); end[i * 2 + 1] = 1; }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(base, 3)); pg.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const vs = (pt) => `uniform float uT; uniform vec3 uCam; uniform vec3 uVel; uniform float uLen; attribute float aEnd; varying float vA;
      void main(){ vec3 box=vec3(70.,50.,70.); vec3 p=position*box + uVel*uT; ${pt ? 'p.x+=sin(uT*1.3+position.y*40.)*1.5;' : ''}
      p=mod(p-uCam,box)-box*.5; vA=1.-smoothstep(20.,35.,length(p)); p+=uCam; p-=normalize(uVel)*aEnd*uLen;
      gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); ${pt ? 'gl_PointSize=min(6., 90./gl_Position.w);' : ''} }`;
    const fs = `uniform float uA; uniform vec3 uCol; varying float vA; void main(){ gl_FragColor=vec4(uCol, uA*vA); }`;
    const mk = pt => new THREE.ShaderMaterial({ vertexShader: vs(pt), fragmentShader: fs, transparent: true, depthWrite: false,
      uniforms: { uT: { value: 0 }, uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -30, 0) }, uLen: { value: 0.9 }, uA: { value: 0 }, uCol: { value: new THREE.Color(0xaec4dd) } } });
    this.rain = new THREE.LineSegments(pg, mk(false)); this.snow = new THREE.Points(pg, mk(true));
    this.snow.material.uniforms.uCol.value.set(0xffffff); this.snow.material.uniforms.uLen.value = 0;
    for (const o of [this.rain, this.snow]) { o.frustumCulled = false; o.visible = false; scene.add(o); }
    this.pmrem = new THREE.PMREMGenerator(renderer); this.envScene = new THREE.Scene(); this.envSky = new Sky(); this.envSky.scale.setScalar(1000); this.envScene.add(this.envSky);
    this.w = { label: '…', cloud: 0.3, rain: 0, snow: 0, fog: 0, thunder: 0, temp: 15, wind: 2, live: false };
    this.cur = { cloud: 0.3, rain: 0, snow: 0, fog: 0 };
    this.night = 0; this.dayF = 1; this.flash = 0; this.override = null; this.lastEnv = -1e9; this.envKey = 0; this.t = 0; this.nextFetch = 0;
    this.timeOffset = 0;      // debug: hours added to the real clock
  }
  now() { return Date.now() + this.timeOffset * 3600000; }
  refreshWeather(lat, lon) {
    this.w = climate(lat, lon, this.now()); this.nextFetch = performance.now() + 20 * 60000;
    fetchWeather(lat, lon).then(w => { if (w) this.w = w; });
  }
  update(dt, cam) {
    this.t += dt;
    const lat = Geo.toLat(cam.position.z), lon = Geo.toLon(cam.position.x);
    if (performance.now() > this.nextFetch) this.refreshWeather(lat, lon);
    const sm = sunMoon(this.now(), lat, lon), alt = sm.sun.alt;
    const w = this.override ? { ...this.w, ...this.override } : this.w, c = this.cur;
    for (const k in c) c[k] = damp(c[k], w[k], 0.6, dt);
    const dayF = this.dayF = smooth(-0.1, 0.12, alt), night = this.night = 1 - smooth(-0.2, 0.02, alt);
    const dim = 1 - 0.8 * c.cloud * c.cloud;
    // sky dome
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sm.sun.dir); u.turbidity.value = 2 + c.cloud * 9 + c.fog * 8; u.rayleigh.value = lerp(1.6, 0.5, c.cloud);
    u.cloudCoverage.value = clamp(c.cloud * 1.05, 0, 1); u.cloudDensity.value = 0.35 + c.cloud * 0.5; u.time.value = this.t * (1 + w.wind * 0.4);
    this.sky.position.copy(cam.position);
    this.stars.position.copy(cam.position); this.stars.material.opacity = night * (1 - c.cloud) * 0.9;
    this.moon.position.copy(cam.position).addScaledVector(sm.moon.dir, 28000); this.moon.visible = sm.moon.alt > -0.05;
    this.moon.material.color.setScalar(0.25 + 0.75 * sm.phase).multiplyScalar(1 - c.cloud * 0.8);
    // light: the sun by day, the moon by night
    const useMoon = alt < -0.06 && sm.moon.alt > 0.03, dir = useMoon ? sm.moon.dir : sm.sun.dir;
    const warm = smooth(0.45, 0.02, alt);
    this.sun.color.setRGB(1, lerp(0.96, 0.62, warm), lerp(0.9, 0.36, warm));
    let inten = smooth(-0.04, 0.3, alt) * 3.4 * dim;
    if (useMoon) { this.sun.color.setRGB(0.55, 0.68, 1); inten = 0.22 * sm.phase * (1 - c.cloud * 0.7) * smooth(0.03, 0.3, sm.moon.alt); }
    this.sun.intensity = inten; this.sun.castShadow = inten > 0.05;
    const tgt = G.player ? G.player.pos : cam.position;
    this.sun.target.position.copy(tgt); this.sun.position.copy(tgt).addScaledVector(dir.y > 0.05 ? dir : new THREE.Vector3(dir.x, 0.05, dir.z).normalize(), 400);
    this.flash = Math.max(0, this.flash - dt * 4);
    if (w.thunder && Math.random() < dt * 0.12) { this.flash = 1; G.audio && G.audio.thunder(); }
    this.hemi.intensity = lerp(0.1, 1.15, dayF) * lerp(1, 0.7, c.cloud) + this.flash * 4;
    this.hemi.color.setRGB(lerp(0.3, 0.75, dayF), lerp(0.4, 0.85, dayF), 1); this.hemi.groundColor.setRGB(0.29 * dayF + 0.08, 0.26 * dayF + 0.07, 0.22 * dayF + 0.07);
    // fog and haze take the horizon colour
    const f = this.scene.fog, grey = 0.55 * dayF + 0.03;
    const r = lerp(lerp(0.02, 0.56, dayF), grey, c.cloud * 0.8) + warm * dayF * 0.25, g = lerp(lerp(0.03, 0.7, dayF), grey, c.cloud * 0.8) + warm * dayF * 0.05, b = lerp(lerp(0.07, 0.9, dayF), grey * 1.05, c.cloud * 0.8) - warm * dayF * 0.15;
    f.color.setRGB(r + this.flash, g + this.flash, b + this.flash);
    f.density = 0.00013 + c.cloud * 0.00008 + c.rain * 0.0007 + c.snow * 0.0012 + c.fog * 0.006;
    this.renderer.toneMappingExposure = lerp(0.62, 0.42, dayF);
    this.scene.environmentIntensity = lerp(0.18, 0.9, dayF) * dim;
    // precipitation
    const wind = w.wind, p = (o, a, vy, len) => {
      o.visible = a > 0.02; if (!o.visible) return; const m = o.material.uniforms;
      m.uT.value = this.t; m.uCam.value.copy(cam.position); m.uVel.value.set(wind * 1.2, vy, wind * 0.5); m.uA.value = a; m.uLen.value = len;
    };
    p(this.rain, c.rain * 0.55, -34, 1.1); p(this.snow, Math.min(1, c.snow * 1.2), -2.6, 0);
    this.wet = damp(this.wet || 0, c.rain > 0.1 ? 1 : 0, 0.2, dt);
    // image-based lighting from the same sky, refreshed when the light has changed
    const key = Math.round(alt * 40) + Math.round(c.cloud * 8) * 100;
    if (key !== this.envKey && this.t - this.lastEnv > 2) {
      this.envKey = key; this.lastEnv = this.t;
      const e = this.envSky.material.uniforms; for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity']) e[k].value = u[k].value;
      e.sunPosition.value.copy(sm.sun.dir); e.showSunDisc.value = 0;
      const old = this.env, exp = this.renderer.toneMappingExposure;
      this.env = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000); this.scene.environment = this.env.texture; if (old) old.dispose();
      this.renderer.toneMappingExposure = exp;
    }
    this.sm = sm;
  }
  localTime(lon) { const d = new Date(this.now() + Math.round(lon / 15) * 3600000); return d.toISOString().substr(11, 5); }
}
