// Boot, quality presets, the frame loop and travel between places on Earth.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { G, clamp, isTouch } from './util.js';
import { Geo } from './geo.js';
import { SkySystem } from './sky.js';
import { World } from './world.js';
import { FX } from './fx.js';
import { Ents, Wanted } from './entities.js';
import { Player } from './player.js';
import { Powers, HEROES } from './powers.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';

const $ = id => document.getElementById(id), qs = new URLSearchParams(location.search);
const PRESETS = {
  Low: { buildR: 5, groundR: 3, farCells: 44, groundSeg: 10, maxBuildings: 3500, maxTrees: 3500, treeDensity: 22, cars: 7, peds: 7, bloom: false, msaa: 0, dpr: 1.1 },
  Medium: { buildR: 6, groundR: 3, farCells: 52, groundSeg: 12, maxBuildings: 5000, maxTrees: 5000, treeDensity: 30, cars: 10, peds: 10, bloom: true, msaa: 0, dpr: 1.5 },
  High: { buildR: 9, groundR: 5, farCells: 76, groundSeg: 14, maxBuildings: 9500, maxTrees: 9000, treeDensity: 46, cars: 15, peds: 16, bloom: true, msaa: 4, dpr: 2 },
};
const mobile = isTouch();
let qName = 'Auto'; try { qName = localStorage.getItem('eh.q') || 'Auto'; } catch (e) { }
if (qs.get('q')) qName = qs.get('q');
const q = PRESETS[qName] || (mobile ? PRESETS.Medium : PRESETS.High);
G.qName = qName; G.time = 0; G.state = 'boot'; G.shake = 0;
G.stats = { renown: 0, defeated: 0, orbs: 0, infected: 0, crews: 0 };
let save = {}; try { save = JSON.parse(localStorage.getItem('eh.save') || '{}'); } catch (e) { }
if (save.stats) Object.assign(G.stats, save.stats);

async function boot() {
  await Geo.load();
  const canvas = $('c'), renderer = new THREE.WebGLRenderer({ canvas, antialias: !q.bloom, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let scale = 1; const baseDpr = Math.min(devicePixelRatio || 1, q.dpr); renderer.setPixelRatio(baseDpr);
  const scene = G.scene = new THREE.Scene(), camera = G.camera = new THREE.PerspectiveCamera(62, 1, 0.25, 60000);
  let composer = null, bloom = null;
  if (q.bloom) {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: q.msaa });
    composer = new EffectComposer(renderer, rt); composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.6, 0.92); composer.addPass(bloom); composer.addPass(new OutputPass());
  }
  const resize = () => { const w = innerWidth, h = innerHeight; renderer.setPixelRatio(baseDpr * scale); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); if (composer) { composer.setPixelRatio(baseDpr * scale); composer.setSize(w, h); } };
  addEventListener('resize', resize); addEventListener('orientationchange', () => setTimeout(resize, 200));

  G.audio = new Audio(); G.fx = new FX(scene); G.sky = new SkySystem(scene, renderer, mobile); G.world = new World(scene, q);
  G.ents = new Ents(q); G.wanted = new Wanted(); G.ui = new UI(); G.player = new Player(HEROES); G.powers = new Powers();
  if (qs.get('t')) G.sky.timeOffset = +qs.get('t');

  G.setHero = i => { G.player.setHero(i); G.ui.setHero(HEROES[i], i); };
  G.cycleHero = () => { if (G.player.mode !== 'foot') return; G.setHero((G.player.heroIndex + 1) % HEROES.length); const h = G.player.hero; G.ui.toast(`${h.name} · ${h.title}`, `${h.traverse}: ${h.tip}`); G.fx.burst(G.player.pos.clone().setY(G.player.pos.y + 1), h.rope, 40, 6, 0.6, 1.4); };
  G.onDefeat = n => { G.stats.defeated++; if (n.kind === 'thug') { G.stats.renown += n.heavy ? 25 : 10; G.player.energy = Math.min(100, G.player.energy + 12); } };
  G.onGangCleared = () => { G.stats.crews++; G.stats.renown += 100; G.ui.toast('Crew cleared', '+100 renown'); };
  G.onOrb = n => { G.stats.orbs += n; G.stats.renown += 20 * n; G.player.energy = 100; G.ui.toast('Signal shard recovered', `${G.stats.orbs} found · they sit on tall rooftops`); G.audio.power(2, 2); };
  G.travel = (lat, lon) => {
    $('loading').style.display = 'grid'; $('loading').style.opacity = 1; $('loadMsg').textContent = 'Travelling…';
    setTimeout(() => {
      G.ents.clear(); G.wanted.clearAll(false); G.world.reset(); G.powers.reset();
      const p = Geo.setOrigin(lat, lon); G.world.loadAll(p.x, p.z); G.player.teleport(p.x, p.z); G.player.camYaw = Math.random() * 6;
      G.sky.refreshWeather(lat, lon); if (G.state === 'map' || G.state === 'title') G.closeMap(true);
      const nc = Geo.nearestCity(lat, lon); if (nc.city && nc.km < 60) G.ui.toast(nc.km < Geo.cityRadiusKm(nc.city[3]) ? `Welcome to ${nc.city[0]}` : `${Math.round(nc.km)} km outside ${nc.city[0]}`, nc.city[4]);
      persist(); $('loading').style.opacity = 0; setTimeout(() => $('loading').style.display = 'none', 500);
    }, 60);
  };
  const setState = s => { G.state = s; $('hud').classList.toggle('on', s === 'play'); $('title').classList.toggle('on', s === 'title'); $('mapScreen').classList.toggle('on', s === 'map'); $('pause').classList.toggle('on', s === 'pause'); if (s !== 'play' && document.pointerLockElement) document.exitPointerLock(); };
  G.openMap = () => { G.ui.map.open(Geo.toLat(G.player.pos.z), Geo.toLon(G.player.pos.x)); setState('map'); };
  G.closeMap = () => { G.audio.start(); setState('play'); };
  G.setPause = on => { if (on) $('stats').textContent = `Renown ${G.stats.renown} · Crews cleared ${G.stats.crews} · Defeated ${G.stats.defeated} · Shards ${G.stats.orbs} · Infected ${G.stats.infected}`; setState(on ? 'pause' : 'play'); };
  const persist = () => { try { localStorage.setItem('eh.save', JSON.stringify({ lat: Geo.toLat(G.player.pos.z), lon: Geo.toLon(G.player.pos.x), hero: G.player.heroIndex, stats: G.stats })); } catch (e) { } };
  setInterval(() => G.state === 'play' && persist(), 8000); addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play') G.setPause(true); });

  // first location: last save, URL, or midtown Manhattan
  const lat = +(qs.get('lat') ?? save.lat ?? 40.7549), lon = +(qs.get('lon') ?? save.lon ?? -73.984);
  const p0 = Geo.setOrigin(lat, lon); G.world.loadAll(p0.x, p0.z); G.player.teleport(p0.x, p0.z); G.sky.refreshWeather(lat, lon);
  G.setHero(+(qs.get('hero') ?? save.hero ?? 0)); resize();
  const start = () => { G.audio.start(); G.ents.gangT = 25; setState('play'); const h = G.player.hero; G.ui.toast(`${h.name} · ${h.title}`, `${h.traverse}: ${h.tip}`); };
  $('s-go').onclick = start; $('s-map').onclick = () => { G.audio.start(); G.openMap(); };
  $('s-here').onclick = () => { G.audio.start(); if (!navigator.geolocation) return G.ui.toast('Location is not available'); $('s-here').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(g => { setState('play'); G.travel(g.coords.latitude, g.coords.longitude); }, () => { $('s-here').textContent = 'Location blocked'; }, { timeout: 10000, maximumAge: 600000 }); };
  setState('title'); if (qs.get('autostart')) start();
  $('loading').style.opacity = 0; setTimeout(() => $('loading').style.display = 'none', 500);

  let last = performance.now(), acc = 0, frames = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = (now - last) / 1000; last = now; const dt = Math.min(0.05, raw);
    if (G.state === 'map') { G.ui.map.render(renderer); return; }
    if (G.state === 'pause') return;
    G.time += dt; const I = G.input; G.ui.poll();
    if (G.state === 'title') { I.mx = I.my = 0; I.lookX = dt * 0.12; I.lookY = (0.12 - G.player.camPitch) * dt; for (const k in I.hit) I.hit[k] = false; }
    G.player.update(dt); G.powers.update(dt); G.ents.update(dt); G.wanted.update(dt);
    G.world.update(G.player.pos.x, G.player.pos.z, 2.5); G.sky.update(dt, camera); G.world.setLighting(G.sky.night, G.powers.blackoutT > 0);
    G.fx.update(dt); G.audio.frame(dt); if (G.state === 'play') G.ui.frame(dt);
    I.lookX = I.lookY = 0; for (const k in I.hit) I.hit[k] = false;
    if (bloom) bloom.strength = 0.22 + G.sky.night * 0.5;
    if (composer) composer.render(); else renderer.render(scene, camera);
    // dynamic resolution keeps the frame rate up on slower devices
    acc += raw; frames++;
    if (acc > 1.5) { const fps = frames / acc; acc = 0; frames = 0; G.fps = fps; const ns = clamp(scale * (fps < 42 ? 0.88 : fps > 56 ? 1.06 : 1), 0.5, 1); if (Math.abs(ns - scale) > 0.02 && !qs.get('fixed')) { scale = ns; resize(); } }
  }
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
}
boot().catch(e => { console.error(e); $('loadMsg').textContent = 'Could not start: ' + e.message; });
