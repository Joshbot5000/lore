/**
 * Hands on the Mac: music, mail, calendar, Shortcuts (HomeKit), system controls. Everything goes
 * through AppleScript / built-in command-line tools, so there is nothing to sign in to. A fake
 * bridge with believable data stands in on other platforms and in tests.
 */
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { CalEvent, MacVoice, Mail, NowPlaying } from '../shared/types';

export type MacBridge = {
  real: boolean;
  music(app: 'Spotify' | 'Music'): Promise<NowPlaying | null>;
  /** Play a specific thing: a spotify: address in Spotify, or something from the library by name in Music. True if it started. */
  playMusic(app: 'Spotify' | 'Music', what: string): Promise<boolean>;
  musicControl(app: 'Spotify' | 'Music', action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'volume' | 'search', value?: string | number): Promise<void>;
  mail(): Promise<{ unread: number; items: Mail[] } | null>;
  calendar(days: number): Promise<CalEvent[] | null>;
  shortcuts(): Promise<string[]>;
  runShortcut(name: string): Promise<void>;
  openApp(name: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  setVolume(percent: number): Promise<void>;
  battery(): Promise<{ percent: number; charging: boolean } | null>;
  system(action: 'lock' | 'sleep-display' | 'dark-mode' | 'mute' | 'unmute'): Promise<void>;
  /** English voices installed on this Mac, best first. */
  voices(): Promise<MacVoice[]>;
  /** Speak with one of the Mac's own voices. Returns 24 kHz 16-bit mono samples. */
  speak(voice: string, text: string, speed: number): Promise<Buffer>;
  /** The text currently on the clipboard (only read when the user asks about it). */
  clipboard(): Promise<string>;
  setClipboard(text: string): Promise<void>;
};

const run = (cmd: string, args: string[], timeout = 15000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout.trim())));
  });
const osa = (script: string, timeout?: number): Promise<string> => run('osascript', ['-e', script], timeout);
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const F = String.fromCharCode(30), R = String.fromCharCode(31);
const SEP = `set f to (ASCII character 30)\nset r to (ASCII character 31)\n`;

export const realMac: MacBridge = {
  real: true,

  async music(app) {
    const track =
      app === 'Spotify'
        ? `(name of t) & f & (artist of t) & f & (album of t) & f & art & f & (player position) & f & ((duration of t) / 1000) & f & (sound volume)`
        : `(name of t) & f & (artist of t) & f & (album of t) & f & "" & f & (player position) & f & (duration of t) & f & (sound volume)`;
    const out = await osa(`${SEP}if application ${q(app)} is running then
  tell application ${q(app)}
    set st to (player state as string)
    if st is "stopped" then return "stopped"
    set t to current track
    set art to ""
    try
      set art to (artwork url of t) as string
    end try
    return st & f & ${track}
  end tell
else
  return "off"
end if`);
    if (out === 'off') return null;
    if (out === 'stopped') return { app, state: 'stopped' };
    const [st, title, artist, album, art, pos, dur, vol] = out.split(F);
    return { app, state: st === 'playing' ? 'playing' : 'paused', title, artist, album, art: art || undefined, position: parseFloat(pos.replace(',', '.')) || 0, duration: parseFloat(dur.replace(',', '.')) || 0, volume: parseInt(vol, 10) || 0 };
  },

  async playMusic(app, what) {
    if (app === 'Spotify') {
      await osa(`tell application "Spotify" to play track ${q(what)}`);
      return true;
    }
    // Apple Music: a playlist of that name first, then any song, album or artist match in the library.
    const out = await osa(`tell application "Music"
  try
    play (first playlist whose name contains ${q(what)})
    return "ok"
  end try
  try
    set hits to (search library playlist 1 for ${q(what)})
    if (count of hits) > 0 then
      play item 1 of hits
      return "ok"
    end if
  end try
  return "none"
end tell`, 20000);
    return out === 'ok';
  },

  async musicControl(app, action, value) {
    if (action === 'search') {
      const term = encodeURIComponent(String(value ?? ''));
      await run('open', [app === 'Spotify' ? `spotify:search:${term}` : `music://music.apple.com/search?term=${term}`]);
      return;
    }
    const verb = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', previous: 'previous track', volume: `set sound volume to ${Math.max(0, Math.min(100, Math.round(Number(value) || 0)))}` }[action];
    await osa(`tell application ${q(app)} to ${verb}`);
  },

  async mail() {
    const out = await osa(
      `${SEP}if application "Mail" is running then
  tell application "Mail"
    set n to unread count of inbox
    set out to ""
    set msgs to (messages of inbox whose read status is false)
    set c to count of msgs
    if c > 12 then set c to 12
    repeat with i from 1 to c
      set m to item i of msgs
      set out to out & (id of m) & f & (sender of m) & f & (subject of m) & f & ((date received of m) as «class isot» as string) & r
    end repeat
    return (n as string) & r & out
  end tell
else
  return "off"
end if`,
      30000,
    );
    if (out === 'off') return null;
    const [n, ...rows] = out.split(R);
    return {
      unread: parseInt(n, 10) || 0,
      items: rows.filter(Boolean).map((row) => {
        const [id, from, subject, date] = row.split(F);
        return { id, from: from.replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '') || from, subject, at: Date.parse(date) || Date.now() };
      }),
    };
  },

  async calendar(days) {
    const out = await osa(
      `${SEP}tell application "Calendar"
  set t0 to (current date)
  set t1 to t0 + (${days} * days)
  set out to ""
  repeat with c in calendars
    try
      set evs to (every event of c whose start date ≥ t0 and start date ≤ t1)
      repeat with e in evs
        set out to out & (uid of e) & f & (summary of e) & f & ((start date of e) as «class isot» as string) & f & ((end date of e) as «class isot» as string) & f & (allday event of e) & f & (name of c) & r
      end repeat
    end try
  end repeat
  return out
end tell`,
      45000,
    );
    return out.split(R).filter(Boolean).map((row) => {
      const [id, title, start, end, allDay, calendar] = row.split(F);
      return { id, title, start: Date.parse(start), end: Date.parse(end), allDay: allDay === 'true', calendar };
    }).filter((e) => !Number.isNaN(e.start));
  },

  shortcuts: async () => (await run('shortcuts', ['list'])).split('\n').map((s) => s.trim()).filter(Boolean),
  runShortcut: async (name) => void (await run('shortcuts', ['run', name], 60000)),
  openApp: async (name) => void (await run('open', ['-a', name])),
  openUrl: async (url) => void (await run('open', [url])),
  setVolume: async (percent) => void (await osa(`set volume output volume ${Math.max(0, Math.min(100, Math.round(percent)))}`)),

  async battery() {
    const out = await run('pmset', ['-g', 'batt']);
    const m = out.match(/(\d+)%;\s*([a-z ]+);/i);
    return m ? { percent: +m[1], charging: !/discharging/i.test(m[2]) } : null;
  },

  async system(action) {
    if (action === 'lock' || action === 'sleep-display') await run('pmset', ['displaysleepnow']);
    else if (action === 'dark-mode') await osa('tell application "System Events" to tell appearance preferences to set dark mode to not dark mode');
    else await osa(`set volume output muted ${action === 'mute'}`);
  },

  async voices() {
    const out = await run('say', ['-v', '?']);
    return parseSayVoices(out);
  },
  async speak(voice, text, speed) {
    const file = path.join(os.tmpdir(), `jarvis-say-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    try {
      // 175 words a minute is the system's normal pace.
      await run('say', ['-v', voice, '-r', String(Math.round(178 * speed)), '--file-format=WAVE', '--data-format=LEI16@24000', '-o', file, '--', text], 30000);
      return wavSamples(fs.readFileSync(file));
    } finally {
      fs.rm(file, { force: true }, () => undefined);
    }
  },

  clipboard: () => run('pbpaste', []),
  setClipboard: (text) =>
    new Promise((resolve, reject) => {
      const p = spawn('pbcopy');
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('The clipboard could not be written.'))));
      p.stdin.end(text);
    }),
};

/** Stand-in used off the Mac and in tests: behaves like a small, stateful Mac. */
export function fakeMac(): MacBridge {
  const now = () => Date.now();
  const tracks = [['Midnight City', 'M83', "Hurry Up, We're Dreaming"], ['Intro', 'The xx', 'xx'], ['Time', 'Hans Zimmer', 'Inception']];
  let i = 0, state: NowPlaying['state'] = 'paused', volume = 55, started = now();
  let clip = process.env.JARVIS_FAKE_CLIPBOARD ?? '';
  const day = (d: number, h: number, m = 0) => {
    const t = new Date();
    t.setDate(t.getDate() + d);
    t.setHours(h, m, 0, 0);
    return t.getTime();
  };
  return {
    real: false,
    music: async (app) => ({ app, state, title: tracks[i][0], artist: tracks[i][1], album: tracks[i][2], position: state === 'playing' ? ((now() - started) / 1000) % 240 : 42, duration: 240, volume }),
    async playMusic(_app, what) {
      tracks.push([what.startsWith('spotify:') ? `Played ${what}` : what, 'Test artist', 'Test album']);
      i = tracks.length - 1;
      state = 'playing';
      started = now();
      return true;
    },
    async musicControl(_app, action, value) {
      if (action === 'play') state = 'playing';
      else if (action === 'pause') state = 'paused';
      else if (action === 'toggle') state = state === 'playing' ? 'paused' : 'playing';
      else if (action === 'next') i = (i + 1) % tracks.length;
      else if (action === 'previous') i = (i + tracks.length - 1) % tracks.length;
      else if (action === 'volume') volume = Number(value) || 0;
      if (state === 'playing') started = now();
    },
    mail: async () => ({
      unread: 3,
      items: [
        { id: '1', from: 'Dr Patel', subject: 'Seminar moved to Thursday 2pm', at: now() - 36e5 },
        { id: '2', from: 'Octopus Energy', subject: 'Your November statement is ready', at: now() - 5 * 36e5 },
        { id: '3', from: 'Sam', subject: 'Five-a-side on Sunday?', at: now() - 9 * 36e5 },
      ],
    }),
    calendar: async () => [
      { id: 'e1', title: 'Contract law seminar', start: day(0, 14), end: day(0, 15, 30), calendar: 'Uni' },
      { id: 'e2', title: 'Gym', start: day(1, 7, 30), end: day(1, 8, 30), calendar: 'Home' },
      { id: 'e3', title: 'Dinner with family', start: day(2, 18, 45), end: day(2, 21), calendar: 'Home' },
    ],
    shortcuts: async () => ['Lounge lights', 'Movie night', 'Good night', 'Heating boost'],
    runShortcut: async () => undefined,
    openApp: async () => undefined,
    openUrl: async () => undefined,
    setVolume: async (p) => void (volume = p),
    battery: async () => ({ percent: 82, charging: false }),
    system: async () => undefined,
    voices: async () => parseSayVoices('Daniel              en_GB    # Hello! My name is Daniel.\nJamie (Premium)     en_GB    # Hello! My name is Jamie.\nSerena (Enhanced)   en_GB    # Hello! My name is Serena.\nThomas              fr_FR    # Bonjour!\nZoe (Premium)       en_US    # Hello! My name is Zoe.'),
    async speak(_voice, text) {
      // A tone, padded with silence the way real voices are, so trimming can be tested.
      const n = Math.round(24000 * Math.min(4, 0.3 + text.length * 0.04)), pad = 4800;
      const b = Buffer.alloc((n + pad * 2) * 2);
      for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / 24000) * 2 * Math.PI * 220) * 9000), (pad + i) * 2);
      return b;
    },
    clipboard: async () => clip,
    setClipboard: async (t) => void (clip = t),
  };
}

/** `say -v ?` prints one voice per line: name, locale, then a sample sentence. */
export function parseSayVoices(out: string): MacVoice[] {
  const rank = { premium: 0, enhanced: 1, standard: 2 };
  return out.split('\n').map((line) => {
    const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/);
    if (!m || !/^en_/.test(m[2])) return null;
    const name = m[1].trim();
    const quality: MacVoice['quality'] = /\(Premium\)/i.test(name) ? 'premium' : /\(Enhanced\)/i.test(name) ? 'enhanced' : 'standard';
    return { id: `mac:${name}`, name, lang: m[2], quality };
  }).filter((v): v is MacVoice => !!v).sort((a, b) => rank[a.quality] - rank[b.quality] || (a.lang === 'en_GB' ? -1 : 1) - (b.lang === 'en_GB' ? -1 : 1) || a.name.localeCompare(b.name));
}

/** The samples inside a WAV file (skips the header, whatever its length). */
export function wavSamples(wav: Buffer): Buffer {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return wav.subarray(Math.min(44, wav.length));
}

export const pickMac = (): MacBridge => (process.env.JARVIS_FAKE_MAC || os.platform() !== 'darwin' ? fakeMac() : realMac);
