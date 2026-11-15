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
  /** (Test double only) what has been opened. */
  opened?: string[];
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
  system(action: 'lock' | 'sleep-display' | 'dark-mode' | 'dark-on' | 'dark-off' | 'mute' | 'unmute' | 'louder' | 'quieter'): Promise<void>;
  /** Bring an event up in the Calendar app. False if it could not be found there. */
  showEvent(uid: string): Promise<boolean>;
  /** Bring an app to the front. */
  activate(name: string): Promise<void>;
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
    // First choice: JavaScript for Automation. Second: AppleScript with long, unmistakable names
    // (short ones such as "st" are reserved words in AppleScript and stop the whole script compiling).
    try {
      return parseMusicJson(app, await run('osascript', ['-l', 'JavaScript', '-e', musicJxa(app)]));
    } catch (first) {
      try {
        return parseMusic(app, await osa(musicAppleScript(app)));
      } catch (second) {
        throw new Error(`${(second as Error).message} (and: ${(first as Error).message})`);
      }
    }
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
      set messageKey to ""
      try
        set messageKey to (message id of m) as text
      end try
      set out to out & (id of m) & f & (sender of m) & f & (subject of m) & f & ((date received of m) as «class isot» as string) & f & messageKey & r
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
        const [id, from, subject, date, key] = row.split(F);
        // message: links open that exact email in the Mail app.
        return { id, from: from.replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '') || from, subject, at: Date.parse(date) || Date.now(), link: key ? `message://%3C${encodeURIComponent(key.replace(/^<|>$/g, ''))}%3E` : undefined };
      }),
    };
  },

  async calendar(days) {
    const out = await osa(
      `${SEP}tell application "Calendar"
  -- From the start of today, so today's all-day events and anything already under way are included.
  set t0 to (current date) - (time of (current date))
  set t1 to t0 + (${days} * days)
  set out to ""
  repeat with c in calendars
    try
      set evs to (every event of c whose end date ≥ t0 and start date ≤ t1)
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
      return { id, title, start: Date.parse(start), end: Date.parse(end), allDay: allDay === 'true', calendar, source: 'apple' as const };
    }).filter((e) => !Number.isNaN(e.start));
  },

  async showEvent(uid) {
    const found = await osa(`tell application "Calendar"
  activate
  repeat with oneCalendar in calendars
    try
      set matchingEvents to (every event of oneCalendar whose uid is ${q(uid)})
      if (count of matchingEvents) > 0 then
        show (item 1 of matchingEvents)
        return "shown"
      end if
    end try
  end repeat
  return "missing"
end tell`, 30000);
    return found === 'shown';
  },
  activate: async (name) => void (await run('open', ['-a', name])),

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
    else if (action === 'dark-on' || action === 'dark-off') await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${action === 'dark-on'}`);
    else if (action === 'louder' || action === 'quieter') await osa(`set volume output volume (((output volume of (get volume settings)) ${action === 'louder' ? '+' : '-'} 12))`);
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
  const opened: string[] = [];
  const day = (d: number, h: number, m = 0) => {
    const t = new Date();
    t.setDate(t.getDate() + d);
    t.setHours(h, m, 0, 0);
    return t.getTime();
  };
  return {
    real: false,
    music: async (app) => ({ app, state, uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh', title: tracks[i][0], artist: tracks[i][1], album: tracks[i][2], position: state === 'playing' ? ((now() - started) / 1000) % 240 : 42, duration: 240, volume }),
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
        { id: '1', from: 'Dr Patel', subject: 'Seminar moved to Thursday 2pm', at: now() - 36e5, link: 'message://%3Cabc%40uni.example%3E' },
        { id: '2', from: 'Octopus Energy', subject: 'Your November statement is ready', at: now() - 5 * 36e5 },
        { id: '3', from: 'Sam', subject: 'Five-a-side on Sunday?', at: now() - 9 * 36e5 },
      ],
    }),
    calendar: async () => [
      { id: 'e1', title: 'Contract law seminar', start: day(0, 14), end: day(0, 15, 30), calendar: 'Uni', source: 'apple' },
      { id: 'e2', title: 'Gym', start: day(1, 7, 30), end: day(1, 8, 30), calendar: 'Home', source: 'apple' },
      { id: 'e3', title: 'Dinner with family', start: day(2, 18, 45), end: day(2, 21), calendar: 'Home', source: 'apple' },
    ],
    shortcuts: async () => ['Lounge lights', 'Movie night', 'Good night', 'Heating boost'],
    runShortcut: async () => undefined,
    openApp: async (name) => void opened.push(`app:${name}`),
    openUrl: async (url) => void opened.push(url),
    opened,
    setVolume: async (p) => void (volume = p),
    battery: async () => ({ percent: 82, charging: false }),
    system: async () => undefined,
    showEvent: async (uid) => (opened.push(`event:${uid}`), true),
    activate: async (name) => void opened.push(`app:${name}`),
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

/** What is playing, asked in JavaScript for Automation. Each property is read on its own so one failure cannot hide the rest. */
export function musicJxa(app: 'Spotify' | 'Music'): string {
  return `(function () {
  var app = Application(${JSON.stringify(app)});
  if (!app.running()) return JSON.stringify({ off: true });
  function get(f, d) { try { var v = f(); return v === undefined || v === null ? d : v; } catch (e) { return d; } }
  var t = app.currentTrack;
  return JSON.stringify({
    state: String(get(function () { return app.playerState(); }, 'paused')),
    title: String(get(function () { return t.name(); }, '')),
    artist: String(get(function () { return t.artist(); }, '')),
    album: String(get(function () { return t.album(); }, '')),
    art: String(get(function () { return ${app === 'Spotify' ? 't.artworkUrl()' : "''"}; }, '')),
    uri: String(get(function () { return ${app === 'Spotify' ? 't.id()' : "''"}; }, '')),
    position: Number(get(function () { return app.playerPosition(); }, 0)),
    duration: Number(get(function () { return t.duration(); }, 0)),
    volume: Number(get(function () { return app.soundVolume(); }, 0))
  });
})()`;
}

export function musicAppleScript(app: 'Spotify' | 'Music'): string {
  const read = (variable: string, expr: string): string => `    try\n      set ${variable} to (${expr}) as text\n    end try`;
  return `if application ${q(app)} is running then
  tell application ${q(app)}
    set playerStatus to "paused"
    set trackTitle to ""
    set trackArtist to ""
    set trackAlbum to ""
    set trackArtwork to ""
    set trackAddress to ""
    set playPosition to "0"
    set trackLength to "0"
    set playerVolume to "0"
    try
      if player state is playing then set playerStatus to "playing"
    end try
    try
      if player state is stopped then set playerStatus to "stopped"
    end try
${read('trackTitle', 'name of current track')}
${read('trackArtist', 'artist of current track')}
${read('trackAlbum', 'album of current track')}
${app === 'Spotify' ? read('trackArtwork', 'artwork url of current track') + '\n' + read('trackAddress', 'id of current track') : ''}
${read('playPosition', 'player position')}
${read('trackLength', 'duration of current track')}
${read('playerVolume', 'sound volume')}
    return playerStatus & linefeed & trackTitle & linefeed & trackArtist & linefeed & trackAlbum & linefeed & trackArtwork & linefeed & playPosition & linefeed & trackLength & linefeed & playerVolume & linefeed & trackAddress
  end tell
else
  return "off"
end if`;
}

export function parseMusicJson(app: 'Spotify' | 'Music', out: string): NowPlaying | null {
  const j = JSON.parse(out) as { off?: boolean; state?: string; title?: string; artist?: string; album?: string; art?: string; uri?: string; position?: number; duration?: number; volume?: number };
  if (j.off) return null;
  if (!j.title) return { app, state: 'stopped', volume: Math.round(j.volume ?? 0) };
  const dur = j.duration ?? 0;
  return { app, state: j.state === 'playing' ? 'playing' : j.state === 'stopped' ? 'stopped' : 'paused', title: j.title, artist: j.artist ?? '', album: j.album ?? '', art: j.art || undefined, uri: /^spotify:/.test(j.uri ?? '') ? j.uri : undefined, position: j.position ?? 0, duration: dur > 36000 ? dur / 1000 : dur, volume: Math.round(j.volume ?? 0) };
}

/** Read the player's reply: eight lines (state, title, artist, album, artwork, position, duration, volume). */
export function parseMusic(app: 'Spotify' | 'Music', out: string): NowPlaying | null {
  if (out.trim() === 'off') return null;
  const [st = '', title = '', artist = '', album = '', art = '', pos = '0', dur = '0', vol = '0', uri = ''] = out.split(/\r?\n|\r/);
  const num = (v: string): number => parseFloat(v.replace(',', '.')) || 0;
  if (!title.trim()) return { app, state: 'stopped', volume: Math.round(num(vol)) };
  // Spotify reports a track's length in milliseconds, Music in seconds.
  const duration = num(dur) > 36000 ? num(dur) / 1000 : num(dur);
  return { app, state: st.trim() === 'playing' ? 'playing' : st.trim() === 'stopped' ? 'stopped' : 'paused', title: title.trim(), artist: artist.trim(), album: album.trim(), art: art.trim() || undefined, uri: /^spotify:/.test(uri.trim()) ? uri.trim() : undefined, position: num(pos), duration, volume: Math.round(num(vol)) };
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
