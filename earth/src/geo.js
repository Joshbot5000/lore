// Real-Earth data layer: coastlines, elevation, satellite colour and 7,300 real cities,
// all bundled so the game works with no network.
import landUrl from '../assets/land.png';
import topoUrl from '../assets/topo.png';
import dayUrl from '../assets/day.jpg';
import nightUrl from '../assets/night.jpg';
import CITIES from '../assets/cities.json';
import { clamp, smooth, fbm } from './util.js';

export const CH = 192;          // chunk size in metres (two city blocks)
export const BLOCK = 96;
const M = 111320;               // metres per degree of latitude

const img = {};
function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}
function pixels(image, channels) {
  const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(image, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height, out = new Uint8Array(n * channels);
  for (let i = 0; i < n; i++) for (let k = 0; k < channels; k++) out[i * channels + k] = d[i * 4 + k];
  return { w: c.width, h: c.height, d: out, ch: channels };
}
function sample(im, lat, lon, k = 0) {
  let fx = ((lon + 180) / 360) * im.w - 0.5, fy = ((90 - lat) / 180) * im.h - 0.5;
  fy = clamp(fy, 0, im.h - 1.001);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % im.w) + im.w) % im.w, xb = (xa + 1) % im.w, c = im.ch;
  const a = im.d[(y0 * im.w + xa) * c + k], b = im.d[(y0 * im.w + xb) * c + k];
  const e = im.d[((y0 + 1) * im.w + xa) * c + k], f = im.d[((y0 + 1) * im.w + xb) * c + k];
  return (a + (b - a) * tx) * (1 - ty) + (e + (f - e) * tx) * ty;
}

const grid = new Map();
export const Geo = {
  cities: CITIES, dayImage: null, nightImage: null,
  lat0: 0, lon0: 0, cosB: 1, ox: 0, oz: 0, band: 0,
  async load() {
    const [l, t, d, n] = await Promise.all([landUrl, topoUrl, dayUrl, nightUrl].map(loadImage));
    img.land = pixels(l, 1); img.topo = pixels(t, 1); img.day = pixels(d, 3);
    this.dayImage = d; this.nightImage = n;
    CITIES.forEach((c, i) => {
      const k = Math.floor(c[1]) + ',' + Math.floor(c[2]);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
  },
  land: (lat, lon) => sample(img.land, lat, lon) / 255,
  elev: (lat, lon) => sample(img.topo, lat, lon) / 255,
  color(lat, lon, out) { out[0] = sample(img.day, lat, lon, 0) / 255; out[1] = sample(img.day, lat, lon, 1) / 255; out[2] = sample(img.day, lat, lon, 2) / 255; return out; },

  // ---- local metric frame: x = east, z = south, anchored to a global chunk grid so places persist
  setOrigin(lat, lon) {
    lat = clamp(lat, -84, 84);
    this.band = Math.round(lat); this.cosB = Math.cos(this.band * Math.PI / 180);
    this.oz = Math.round(-lat * M / CH); this.ox = Math.round(lon * M * this.cosB / CH);
    this.lat0 = lat; this.lon0 = lon; ucache.clear();
    // local position of the exact requested point
    return { x: lon * M * this.cosB - this.ox * CH, z: -lat * M - this.oz * CH };
  },
  toLat: z => -(Geo.oz * CH + z) / M,
  toLon(x) { let l = (this.ox * CH + x) / (M * this.cosB); return ((l + 540) % 360) - 180; },

  citiesNear(lat, lon, cb) {
    const span = Math.min(3, Math.ceil(0.35 / Math.max(0.15, Math.cos(lat * Math.PI / 180))));
    const la = Math.floor(lat), lo = Math.floor(lon);
    for (let i = -1; i <= 1; i++) for (let j = -span; j <= span; j++) {
      const b = grid.get((la + i) + ',' + (((lo + j + 540) % 360) - 180)); if (b) for (const c of b) cb(CITIES[c]);
    }
  },
  distKm(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * 111.32; let dl = lon2 - lon1; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
    const dx = dl * 111.32 * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180); return Math.hypot(dx, dy);
  },
  nearestCity(lat, lon) {
    let best = null, bd = 1e9;
    this.citiesNear(lat, lon, c => { const d = this.distKm(lat, lon, c[1], c[2]); if (d < bd) { bd = d; best = c; } });
    if (!best) for (let i = 0; i < 400; i++) { const c = CITIES[i], d = this.distKm(lat, lon, c[1], c[2]); if (d < bd) { bd = d; best = c; } }
    return { city: best, km: bd };
  },
  cityRadiusKm: pop => clamp(0.9 * Math.pow(Math.max(pop, 4000) / 1e5, 0.42), 0.55, 13),
  cityTier: pop => clamp((Math.log10(Math.max(pop, 4000)) - 3.7) / 3.6, 0.06, 1),
  // urban density 0..1, city size tier 0..1 and the dominant city at a lat/lon
  urbanLL(lat, lon) {
    let u = 0, tier = 0, city = null;
    this.citiesNear(lat, lon, c => {
      const r = this.cityRadiusKm(c[3]), d = this.distKm(lat, lon, c[1], c[2]);
      if (d > r) return; const f = 1 - smooth(0.08 * r, r, d);
      if (f > u) { u = f; tier = this.cityTier(c[3]); city = c; }
    });
    return { u, tier, city };
  },
  // cached at chunk corners, bilinear in between
  urbanCorner(cx, cz) {
    const k = cx + ',' + cz; let v = ucache.get(k);
    if (!v) { v = this.urbanLL(this.toLat(cz * CH), this.toLon(cx * CH)); ucache.set(k, v); }
    return v;
  },
  urban(x, z) {
    const fx = x / CH, fz = z / CH, cx = Math.floor(fx), cz = Math.floor(fz), tx = fx - cx, tz = fz - cz;
    const a = this.urbanCorner(cx, cz).u, b = this.urbanCorner(cx + 1, cz).u, c = this.urbanCorner(cx, cz + 1).u, d = this.urbanCorner(cx + 1, cz + 1).u;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  },
  // terrain height in metres above sea level at a local position
  height(x, z) {
    const lat = this.toLat(z), lon = this.toLon(x);
    const shore = (this.land(lat, lon) - 0.5) * 2;
    if (shore < 0) return Math.max(shore * 70, -60);
    const u = this.urban(x, z), e = this.elev(lat, lon), inl = smooth(0, 0.45, shore);
    const ax = this.ox * CH + x, az = this.oz * CH + z;
    const amp = (10 + e * 1100) * (1 - 0.94 * smooth(0.05, 0.3, u));
    const hills = (fbm(ax / 1100, az / 1100, 5) - 0.47) * 2 * amp + (fbm(ax / 90, az / 90, 2) - 0.5) * 5 * (1 - u);
    const h = shore * 9 + (e * 5200 + hills) * inl;
    return Math.max(h, Math.min(shore * 30, 0.5 + shore * 2.5));
  },
};
const ucache = new Map();
