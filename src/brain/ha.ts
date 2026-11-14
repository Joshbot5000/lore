/** Home Assistant: see and control the home through its local API. Needs the address and a long-lived token. */
import type { Fetch } from './weather';

export type HaEntity = { id: string; name: string; domain: string; state: string; brightness?: number; temperature?: number; current?: number; unit?: string };

const DOMAINS = ['light', 'switch', 'scene', 'script', 'climate', 'cover', 'fan', 'lock', 'input_boolean', 'media_player', 'vacuum', 'sensor'];
const TOGGLABLE = ['light', 'switch', 'fan', 'input_boolean', 'cover', 'media_player'];

export class HomeAssistant {
  constructor(private fetcher: Fetch, private url: string, private token: string) {}

  private async req(path: string, body?: unknown): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetcher(`${this.url.replace(/\/+$/, '')}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      } as never);
      if (res.status === 401) throw new Error('Home Assistant rejected the token');
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      return await res.json();
    } catch (err) {
      if ((err as Error).name === 'AbortError' || /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ERR_/i.test(String((err as Error).message))) throw new Error("can't reach Home Assistant at that address");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Everything controllable, plus temperature sensors. */
  async states(): Promise<HaEntity[]> {
    const all = (await this.req('states')) as { entity_id: string; state: string; attributes: Record<string, any> }[];
    return all
      .map((e) => {
        const domain = e.entity_id.split('.')[0];
        const a = e.attributes ?? {};
        return {
          id: e.entity_id, domain, state: String(e.state), name: String(a.friendly_name ?? e.entity_id.split('.')[1].replace(/_/g, ' ')),
          brightness: typeof a.brightness === 'number' ? Math.round((a.brightness / 255) * 100) : undefined,
          temperature: typeof a.temperature === 'number' ? a.temperature : undefined,
          current: typeof a.current_temperature === 'number' ? a.current_temperature : domain === 'sensor' && a.device_class === 'temperature' && !Number.isNaN(parseFloat(e.state)) ? parseFloat(e.state) : undefined,
          unit: a.unit_of_measurement, device_class: a.device_class,
        };
      })
      .filter((e) => DOMAINS.includes(e.domain) && e.state !== 'unavailable' && (e.domain !== 'sensor' || e.device_class === 'temperature'))
      .map(({ device_class: _d, ...e }) => e);
  }

  call(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    return this.req(`services/${domain}/${service}`, data);
  }
}

export type HomeCommand = { targets: HaEntity[]; domain: string; service: string; data?: Record<string, unknown>; reply: string } | { answer: string };

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const FILLER = new Set(['the', 'my', 'a', 'an', 'in', 'on', 'of', 'to', 'please', 'all', 'every', 'everything']);

/** The devices a phrase refers to: "kitchen lights" -> every light with kitchen in its name; "the lamp" -> the lamp. */
export function matchEntities(entities: HaEntity[], phrase: string, domains?: string[]): HaEntity[] {
  const p = norm(phrase);
  const pool = entities.filter((e) => e.domain !== 'sensor' && (!domains || domains.includes(e.domain)));
  const exact = pool.filter((e) => norm(e.name) === p);
  if (exact.length) return exact;
  const wantsLights = /\blights?\b|\blamps?\b/.test(p);
  const words = p.split(' ').filter((w) => !FILLER.has(w) && !/^(lights?|lamps?|scene|switch|blinds?|heating|thermostat)$/.test(w));
  if (!words.length) return /\b(all|every|everything)\b/.test(p) && wantsLights ? pool.filter((e) => e.domain === 'light') : wantsLights && pool.filter((e) => e.domain === 'light').length === 1 ? pool.filter((e) => e.domain === 'light') : [];
  const has = (e: HaEntity) => words.every((w) => norm(e.name).split(' ').some((n) => n === w || n === w + 's' || n + 's' === w));
  const hits = pool.filter(has);
  if (wantsLights) {
    const lights = hits.filter((e) => e.domain === 'light');
    if (lights.length) return lights;
  }
  // Several things share the words: prefer the shortest name (the closest match).
  if (hits.length > 1 && !/s$/.test(p)) return [hits.sort((a, b) => a.name.length - b.name.length)[0]];
  return hits;
}

const list = (es: HaEntity[]): string => (es.length === 1 ? es[0].name : es.length === 2 ? `${es[0].name} and ${es[1].name}` : `${es.length} devices`);

/** Understand a spoken home command against the devices that exist. Null means "not about the home". */
export function parseHomeCommand(text: string, entities: HaEntity[]): HomeCommand | null {
  const t = norm(text).replace(/^(please|can you|could you|will you) /, '');
  let m: RegExpMatchArray | null;

  // temperature questions
  if ((m = t.match(/^(?:what s|what is|whats|how s|how is) the (?:temperature|temp)(?: (?:in|of|at) (?:the )?(.+))?$/) ?? t.match(/^how (?:warm|cold|hot) is (?:it in )?(?:the )?(.+)$/))) {
    const temps = entities.filter((e) => e.current !== undefined);
    const words = norm(m[1] ?? '').split(' ').filter((w) => w && !FILLER.has(w) && w !== 'house' && w !== 'home' && w !== 'inside');
    const hit = words.length ? temps.find((e) => words.every((w) => norm(e.name).includes(w))) : temps.find((e) => e.domain === 'climate') ?? temps[0];
    return hit ? { answer: `${hit.name} is at ${Math.round(hit.current! * 10) / 10} degrees${hit.domain === 'climate' && hit.temperature !== undefined ? `, set to ${hit.temperature}` : ''}.` } : null;
  }
  // state questions: "is the kitchen light on"
  if ((m = t.match(/^(?:is|are) (?:the |my )?(.+?) (on|off|open|closed|locked|unlocked)$/))) {
    const es = matchEntities(entities, m[1]);
    if (!es.length) return null;
    const on = es.filter((e) => ['on', 'open', 'unlocked', 'playing', 'heat', 'cool', 'auto'].includes(e.state));
    return { answer: es.length === 1 ? `${es[0].name} is ${es[0].state}${es[0].brightness && es[0].state === 'on' ? `, at ${es[0].brightness} percent` : ''}.` : on.length ? `${on.length} of ${es.length} are on: ${on.slice(0, 4).map((e) => e.name).join(', ')}.` : `All ${es.length} are off.` };
  }
  // heating
  if ((m = t.match(/^(?:set|turn|put|change) (?:the |my )?(.+?) (?:to|at|up to|down to) (\d{1,2}(?:\.\d)?)(?: degrees?| c| celsius)?$/)) && (/heat|thermostat|temperature|climate|radiator/.test(m[1]) || entities.some((e) => e.domain === 'climate' && matchEntities([e], m![1]).length))) {
    const climates = entities.filter((e) => e.domain === 'climate');
    const es = matchEntities(climates, m[1]).length ? matchEntities(climates, m[1]) : climates.slice(0, 1);
    if (!es.length) return null;
    return { targets: es, domain: 'climate', service: 'set_temperature', data: { temperature: parseFloat(m[2]) }, reply: `${list(es)} set to ${m[2]} degrees.` };
  }
  // brightness
  if ((m = t.match(/^(?:set|dim|turn|put|brighten) (?:the |my )?(.+?)(?: brightness)? (?:to|at|down to|up to) (\d{1,3})(?: percent)?$/))) {
    const es = matchEntities(entities, m[1], ['light']);
    if (es.length) return { targets: es, domain: 'light', service: 'turn_on', data: { brightness_pct: Math.min(100, +m[2]) }, reply: `${list(es)} at ${Math.min(100, +m[2])} percent.` };
  }
  // scenes and scripts
  if ((m = t.match(/^(?:activate|run|start|set|turn on|switch on) (?:the |my )?(.+?)(?: scene| mode| script)?$/))) {
    const es = matchEntities(entities, m[1], ['scene', 'script']);
    if (es.length) return { targets: es.slice(0, 1), domain: es[0].domain, service: 'turn_on', reply: `${es[0].name} is on.` };
  }
  // on / off
  m = t.match(/^(?:turn|switch|put) (on|off) (?:the |my )?(.+)$/) ?? t.match(/^(?:turn|switch|put) (?:the |my )?(.+?) (on|off)$/) ?? t.match(/^(?:the |my )?(.+?) (on|off)$/) ?? (/^(lights|all the lights|everything) (on|off)$/.test(t) ? t.match(/^(.+) (on|off)$/) : null);
  if (m) {
    const [state, phrase] = /^(on|off)$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const es = matchEntities(entities, phrase).filter((e) => !['scene', 'script'].includes(e.domain) || state === 'on');
    if (!es.length) return null;
    return { targets: es, domain: 'homeassistant', service: `turn_${state}`, reply: es.length === 1 ? `${es[0].name} is ${state}.` : `${es.length} ${es.every((e) => e.domain === 'light') ? 'lights' : 'devices'} ${state}.` };
  }
  // covers and locks
  if ((m = t.match(/^(open|close|shut|lock|unlock) (?:the |my )?(.+)$/))) {
    const verb = m[1] === 'shut' ? 'close' : m[1];
    const domain = verb === 'lock' || verb === 'unlock' ? 'lock' : 'cover';
    const es = matchEntities(entities, m[2], [domain]);
    if (es.length) return { targets: es, domain, service: domain === 'lock' ? verb : `${verb}_cover`, reply: `${list(es)} ${verb === 'open' ? 'opening' : verb === 'close' ? 'closing' : verb + 'ed'}.` };
  }
  return null;
}

/** What tapping a tile should do. */
export function tapService(e: HaEntity): { domain: string; service: string } {
  if (e.domain === 'scene' || e.domain === 'script') return { domain: e.domain, service: 'turn_on' };
  if (e.domain === 'lock') return { domain: 'lock', service: e.state === 'locked' ? 'unlock' : 'lock' };
  if (e.domain === 'climate') return { domain: 'climate', service: e.state === 'off' ? 'turn_on' : 'turn_off' };
  return { domain: TOGGLABLE.includes(e.domain) ? 'homeassistant' : e.domain, service: 'toggle' };
}

export const isOn = (e: HaEntity): boolean => ['on', 'open', 'unlocked', 'playing', 'heat', 'cool', 'auto', 'heat_cool'].includes(e.state);
