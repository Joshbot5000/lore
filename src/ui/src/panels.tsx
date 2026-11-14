import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Brain as BrainIcon, Check, Download, Pin, Play, Plus, Smartphone, Trash2, X } from 'lucide-react';
import { act, call, isPhone, set, toast, useLink, useSnap } from './link';
import { unlock } from './voice';
import { Core } from './Core';
import { gb } from './bits';
import { VOICES } from '../../shared/types';
import type { ModelInfo, Settings } from '../../shared/types';

const save = (patch: Partial<Settings>) => act('saveSettings', patch as Record<string, unknown>);
export const ACCENTS: [string, string, string][] = [['arc', 'Arc', '#5ee6ff'], ['ember', 'Ember', '#ff5a3c'], ['verdant', 'Verdant', '#5dfc9b'], ['violet', 'Violet', '#a78bfa'], ['gold', 'Gold', '#ffc857']];

function Drawer({ title, sub, children, wide }: { title: string; sub?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="veil" onMouseDown={() => set({ panel: null })}>
      <aside className={`drawer ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div><button className="ghost" onClick={() => set({ panel: null })}><X size={18} /></button></header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span><b>{label}</b>{hint && <i>{hint}</i>}</span>{children}</label>;
}
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={(e) => (e.preventDefault(), onChange(!on))}><i /></button>;
}
/** Text box that saves when you leave it or press Enter. */
function Text({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

export function ModelRow({ m, selected, onUse }: { m: ModelInfo; selected: boolean; onUse?: () => void }) {
  const dl = useSnap((s) => s.downloads.find((d) => d.id === m.id));
  const busy = dl && !dl.error;
  return (
    <div className={`model ${selected ? 'sel' : ''}`}>
      <div className="model-top"><b>{m.name}</b>{m.recommended && <span className="tag hot">best for this Mac</span>}{selected && m.installed && <span className="tag ok"><Check size={10} strokeWidth={3} /> in use</span>}<span className="grow" /><span className="mono dim">{gb(m.bytes)}</span></div>
      <p>{m.blurb}</p>
      {busy ? (
        <div className="dl"><div className="bar"><span style={{ width: `${(dl.received / Math.max(1, dl.total)) * 100}%` }} /></div><span className="mono dim">{Math.round((dl.received / Math.max(1, dl.total)) * 100)}%</span><button className="ghost label" onClick={() => act('cancelDownload', { id: m.id })}>pause</button></div>
      ) : (
        <div className="row">
          {!m.installed && <button className="btn small" onClick={() => act('downloadModel', { id: m.id })}><Download size={13} /> {dl?.error ? 'Resume' : 'Download'}</button>}
          {m.installed && !selected && onUse && <button className="btn small" onClick={onUse}>Use this</button>}
          {dl?.error && dl.error !== 'Cancelled' && <span className="bad-text">{dl.error}</span>}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel() {
  const s = useSnap((x) => x.settings);
  const models = useSnap((x) => x.models);
  const integrations = useSnap((x) => x.integrations);
  const version = useSnap((x) => x.version);
  const [shortcuts, setShortcuts] = useState<string[]>([]);
  const [cal, setCal] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => void call<string[]>('allShortcuts').then(setShortcuts).catch(() => undefined), []);
  const of = (k: string) => models.filter((m) => m.kind === k);
  const exportData = async () => {
    const json = await call<string>('exportData');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `jarvis-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  return (
    <Drawer title="Settings" sub={`Jarvis ${version} · everything runs and stays on your Mac`} wide>
      <h3>You</h3>
      <Field label="Your name"><Text value={s.userName} onSave={(v) => save({ userName: v })} placeholder="What should I call you?" /></Field>
      <Field label="How I address you"><div className="seg">{([['name', 'By name'], ['sir', 'Sir'], ['maam', "Ma'am"], ['boss', 'Boss']] as const).map(([k, l]) => <button key={k} className={s.address === k ? 'on' : ''} onClick={() => save({ address: k })}>{l}</button>)}</div></Field>
      <Field label="My name" hint="Also the word that wakes me in hands-free mode"><Text value={s.assistantName} onSave={(v) => v && save({ assistantName: v })} /></Field>
      <Field label="Your town" hint="For weather"><Text value={s.place} onSave={(v) => save({ place: v })} placeholder="e.g. Stockport" /></Field>
      <Field label="Temperature"><div className="seg"><button className={s.units === 'c' ? 'on' : ''} onClick={() => save({ units: 'c' })}>°C</button><button className={s.units === 'f' ? 'on' : ''} onClick={() => save({ units: 'f' })}>°F</button></div></Field>

      <h3>Voice</h3>
      <Field label="Speak replies aloud"><Toggle on={s.speak} onChange={(v) => save({ speak: v })} /></Field>
      <div className="voices">
        {VOICES.map(([id, label]) => (
          <button key={id} className={s.voice === id ? 'on' : ''} onClick={() => (unlock(), save({ voice: id }), void call('previewVoice', { voice: id }).catch((e: Error) => toast(e.message, 'alert')))}><Play size={12} /> {label}</button>
        ))}
      </div>
      <Field label="Pace" hint={`${s.speed.toFixed(2)}×`}><input type="range" min={0.8} max={1.4} step={0.05} value={s.speed} onChange={(e) => save({ speed: +e.target.value })} /></Field>

      <h3>Look</h3>
      <div className="accents">{ACCENTS.map(([id, label, color]) => <button key={id} className={s.accent === id ? 'on' : ''} style={{ ['--c' as string]: color }} onClick={() => save({ accent: id })}><i />{label}</button>)}</div>

      <h3>Connections</h3>
      <Field label="Apple Calendar" hint={integrations.calendar.detail ?? 'Reads the calendars in the Calendar app'}><Toggle on={s.useAppleCalendar} onChange={(v) => save({ useAppleCalendar: v })} /></Field>
      <div className="field stack"><span><b>Calendar links</b><i>Paste a calendar's private “iCal / ICS” address (Google Calendar: Settings → your calendar → Secret address in iCal format). Repeating events are handled.</i></span>
        {s.calendarUrls.map((u) => <div className="row" key={u}><code className="grow">{u.replace(/^https?:\/\//, '').slice(0, 46)}…</code><button className="ghost" onClick={() => save({ calendarUrls: s.calendarUrls.filter((x) => x !== u) })}><Trash2 size={14} /></button></div>)}
        <div className="row"><input className="grow" value={cal} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" onChange={(e) => setCal(e.target.value)} /><button className="btn small" disabled={!/^(https?|webcal):\/\//.test(cal.trim())} onClick={() => (save({ calendarUrls: [...s.calendarUrls, cal.trim()] }), setCal(''))}><Plus size={13} /> Add</button></div>
      </div>
      <Field label="Apple Mail" hint={integrations.mail.detail ?? 'Shows unread mail from the Mail app'}><Toggle on={s.useAppleMail} onChange={(v) => save({ useAppleMail: v })} /></Field>
      <Field label="Music app"><div className="seg">{(['Spotify', 'Music'] as const).map((a) => <button key={a} className={s.musicApp === a ? 'on' : ''} onClick={() => save({ musicApp: a })}>{a === 'Music' ? 'Apple Music' : a}</button>)}</div></Field>
      {!!shortcuts.length && (
        <div className="field stack"><span><b>Home shortcuts</b><i>Pick which of your Shortcuts appear on the Home card and can be run by voice. None picked shows the first eight.</i></span>
          <div className="chips">{shortcuts.map((n) => <button key={n} className={s.homeShortcuts.includes(n) ? 'on' : ''} onClick={() => save({ homeShortcuts: s.homeShortcuts.includes(n) ? s.homeShortcuts.filter((x) => x !== n) : [...s.homeShortcuts, n] })}>{n}</button>)}</div>
        </div>
      )}

      <HomeAssistantSettings />
      <MailAccounts />

      <h3>Routines</h3>
      <p className="lead">Say a routine's name and I run its steps in order. Each line is something you could say to me; “briefing” and “evening review” work too.</p>
      <Routines />

      <h3>Focus and summon</h3>
      <Field label="Daily focus goal" hint="Minutes of focused work to aim for each day."><Text value={String(s.focusGoal)} onSave={(v) => save({ focusGoal: Math.max(0, Math.min(960, Math.round(+v) || 0)) })} /></Field>
      <Field label="Summon shortcut" hint="Press this anywhere on your Mac to bring me up and start listening. Press again to send. Alt is the Option key. Leave empty to turn off."><Text value={s.hotkey} onSave={(v) => save({ hotkey: v.trim() })} placeholder="Alt+Space" /></Field>
      <Field label="Recordings from Hark" hint={integrations.hark.state === 'ok' ? `Connected: ${integrations.hark.detail ?? ''}. Ask me what was said or decided.` : 'If Hark is installed on this Mac, I can answer questions about your recorded conversations.'}><Toggle on={s.useHark} onChange={(v) => save({ useHark: v })} /></Field>

      <h3>On-device AI</h3>
      <p className="lead">No account, no API key, no usage limits. Models download once and then work offline.</p>
      <span className="label dim">Mind</span>
      {of('llm').map((m) => <ModelRow key={m.id} m={m} selected={s.llmModel === m.id} onUse={() => save({ llmModel: m.id })} />)}
      <span className="label dim">Ears</span>
      {of('asr').map((m) => <ModelRow key={m.id} m={m} selected={s.asrModel === m.id} onUse={() => save({ asrModel: m.id })} />)}
      <span className="label dim">Voice and memory</span>
      {[...of('voice'), ...of('support')].map((m) => <ModelRow key={m.id} m={m} selected={m.installed} />)}

      <h3>Your data</h3>
      <p className="lead">Memory, tasks, notes and chat live in one folder on this Mac. Export a copy to back it up or move it to another computer.</p>
      <div className="row">
        <button className="btn" onClick={() => void exportData()}>Export everything</button>
        <button className="btn" onClick={() => file.current?.click()}>Import…</button>
        <input ref={file} type="file" accept="application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f && confirm('Replace everything Jarvis knows with this backup?')) (await call('importData', { json: await f.text() }), toast('Imported.')); }} />
        <button className="btn danger" onClick={() => confirm('Clear the whole conversation log?') && act('clearChat')}>Clear chat log</button>
      </div>
    </Drawer>
  );
}

function HomeAssistantSettings() {
  const s = useSnap((x) => x.settings);
  const home = useSnap((x) => x.integrations.home);
  const [url, setUrl] = useState(s.haUrl);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [all, setAll] = useState<{ id: string; name: string; domain: string }[]>([]);
  useEffect(() => void (s.haUrl ? call<typeof all>('allHaEntities').then(setAll).catch(() => undefined) : setAll([])), [s.haUrl, home.detail]);
  const connect = async () => {
    setMsg('Connecting…');
    try {
      const r = await call<{ devices: number }>('saveHomeAssistant', { url, token });
      setToken('');
      setMsg(url.trim() ? `Connected: ${r.devices} devices found.` : 'Disconnected.');
    } catch (e) {
      setMsg(`Couldn't connect: ${(e as Error).message}.`);
    }
  };
  return (
    <div className="field stack">
      <span><b>Home Assistant</b><i>Control lights, heating, scenes and switches by voice or from the Home card. In Home Assistant, open your profile → Security → Long-lived access tokens → Create token, and paste it here. It is stored only on this Mac.</i></span>
      <div className="row">
        <input className="search" value={url} placeholder="http://homeassistant.local:8123" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        <input className="search" type="password" value={token} placeholder={s.haUrl ? 'Token saved (paste to replace)' : 'Access token'} onChange={(e) => setToken(e.target.value)} />
        <button className="btn small" onClick={() => void connect()}>{s.haUrl && !url.trim() ? 'Disconnect' : 'Connect'}</button>
      </div>
      {(msg || (s.haUrl && home.detail)) && <i className={/Couldn't|can't|rejected/.test(msg || home.detail || '') ? 'bad' : ''}>{msg || home.detail}</i>}
      {all.length > 0 && (
        <>
          <i>Pick what appears on the Home card. None picked shows the first eight. Everything can be controlled by voice either way: “turn off the kitchen lights”, “set the heating to 20”.</i>
          <div className="chips">{all.slice(0, 60).map((e) => <button key={e.id} className={s.haEntities.includes(e.id) ? 'on' : ''} onClick={() => save({ haEntities: s.haEntities.includes(e.id) ? s.haEntities.filter((x) => x !== e.id) : [...s.haEntities, e.id] })}>{e.name}</button>)}</div>
        </>
      )}
    </div>
  );
}

const MAIL_KINDS: [string, string, string][] = [
  ['gmail', 'Gmail', 'Use an app password, not your normal one: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.'],
  ['icloud', 'iCloud', 'Use an app-specific password from account.apple.com → Sign-In and Security.'],
  ['yahoo', 'Yahoo', 'Use an app password from Yahoo Account Security.'],
  ['fastmail', 'Fastmail', 'Use an app password from Settings → Privacy & Security.'],
  ['other', 'Other', "Enter your provider's IMAP server. Outlook.com and Hotmail are not supported: Microsoft only allows sign-in through its own apps."],
];

function MailAccounts() {
  const accounts = useSnap((x) => x.settings.mailAccounts);
  const mail = useSnap((x) => x.integrations.mail);
  const [f, setF] = useState({ preset: 'gmail', host: '', user: '', pass: '' });
  const [msg, setMsg] = useState('');
  const add = async () => {
    setMsg('Checking…');
    try {
      const r = await call<{ unread: number }>('saveMailAccount', f);
      setF({ ...f, user: '', pass: '' });
      setMsg(`Connected: ${r.unread} unread.`);
    } catch (e) {
      setMsg(`Couldn't sign in: ${(e as Error).message}.`);
    }
  };
  return (
    <div className="field stack">
      <span><b>Mail accounts</b><i>See unread mail from Gmail, iCloud, Yahoo or any IMAP mailbox without the Mail app. I only read the inbox; nothing is marked as read or changed. The password is stored only on this Mac.</i></span>
      {accounts.map((a) => <div className="row" key={a.id}><span className="grow">{a.label} <i>· {a.host}</i></span><button className="ghost" title="Remove" onClick={() => confirm(`Remove ${a.label}?`) && act('deleteMailAccount', { id: a.id })}><Trash2 size={14} /></button></div>)}
      <div className="row">
        <div className="seg">{MAIL_KINDS.map(([id, name]) => <button key={id} className={f.preset === id ? 'on' : ''} onClick={() => setF({ ...f, preset: id })}>{name}</button>)}</div>
      </div>
      <div className="row">
        {f.preset === 'other' && <input className="search" value={f.host} placeholder="imap.example.com" spellCheck={false} onChange={(e) => setF({ ...f, host: e.target.value })} />}
        <input className="search" value={f.user} placeholder="you@example.com" spellCheck={false} autoCapitalize="off" onChange={(e) => setF({ ...f, user: e.target.value })} />
        <input className="search" type="password" value={f.pass} placeholder="App password" onChange={(e) => setF({ ...f, pass: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button className="btn small" onClick={() => void add()}>Add</button>
      </div>
      <i className={/Couldn't/.test(msg) || (!msg && mail.state === 'error') ? 'bad' : ''}>{msg || (mail.state === 'error' && mail.detail) || MAIL_KINDS.find((k) => k[0] === f.preset)![2]}</i>
    </div>
  );
}

function Routines() {
  const routines = useSnap((x) => x.routines);
  return (
    <>
      {routines.map((r) => (
        <div className="routine" key={r.id}>
          <div className="routine-head">
            <input defaultValue={r.name} placeholder="Name (what you say)" onBlur={(e) => e.target.value.trim() && e.target.value !== r.name && act('saveRoutine', { id: r.id, name: e.target.value, steps: r.steps })} />
            <button className="ghost" title="Run now" onClick={() => (unlock(), set({ panel: null }), act('runRoutine', { name: r.name }))}><Play size={14} /></button>
            <button className="ghost" title="Delete" onClick={() => confirm(`Delete the “${r.name}” routine?`) && act('deleteRoutine', { id: r.id })}><Trash2 size={14} /></button>
          </div>
          <textarea defaultValue={r.steps.join('\n')} placeholder={'One step per line, e.g.\npause the music\nset the volume to 20\nevening review'} onBlur={(e) => act('saveRoutine', { id: r.id, name: r.name, steps: e.target.value.split('\n') })} />
        </div>
      ))}
      <button className="btn small" onClick={() => act('saveRoutine', { name: `Routine ${routines.length + 1}`, steps: [] })}><Plus size={13} /> New routine</button>
    </>
  );
}

export function MindPanel() {
  const mems = useSnap((s) => s.memories);
  const name = useSnap((s) => s.settings.userName);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const shown = mems.filter((m) => m.text.toLowerCase().includes(q.toLowerCase())).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at);
  return (
    <Drawer title="Memory" sub={`${mems.length} thing${mems.length === 1 ? '' : 's'} I remember${name ? ` about you, ${name}` : ''}. Shared with every device you pair.`}>
      <div className="adder big"><Plus size={15} /><input value={text} placeholder="Teach me something… “My sister Maya's birthday is 3 March”" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) (act('addMemory', { text: text.trim() }), setText('')); }} /></div>
      {mems.length > 6 && <input className="search" value={q} placeholder="Search memory" onChange={(e) => setQ(e.target.value)} />}
      <ul className="mems">
        {shown.map((m) => (
          <li key={m.id} className={m.pinned ? 'pinned' : ''}>
            <BrainIcon size={14} />
            <span className="grow">{m.text}<i>{m.source === 'jarvis' ? 'noticed' : 'you told me'} · {new Date(m.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</i></span>
            <button className={`ghost ${m.pinned ? 'on' : ''}`} title="Always keep this in mind" onClick={() => act('updateMemory', { id: m.id, pinned: !m.pinned })}><Pin size={13} /></button>
            <button className="ghost" title="Forget" onClick={() => act('deleteMemory', { id: m.id })}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {!mems.length && <p className="lead">Nothing yet. Tell me about yourself in conversation, or say “remember that…”. I also quietly note lasting things you mention: who people are, what you like, where you need to be.</p>}
    </Drawer>
  );
}

export function LogPanel() {
  const chat = useSnap((s) => s.chat);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView();
  }, [chat.length]);
  return (
    <Drawer title="Conversation log" sub="Everything said, across all your devices">
      <div className="log">
        {chat.map((c) => (
          <div key={c.id} className={`line ${c.role}`}>
            <span className="label dim">{c.role === 'user' ? (c.device === 'phone' ? 'you · phone' : 'you') : 'jarvis'} · {new Date(c.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            <p>{c.text}</p>
            {c.tools?.map((t, i) => <span key={i} className={`tool ${t.ok ? 'ok' : 'bad'}`}>{t.label}</span>)}
          </div>
        ))}
        {!chat.length && <p className="lead">Nothing said yet.</p>}
        <div ref={end} />
      </div>
    </Drawer>
  );
}

export function PairPanel() {
  const links = useSnap((s) => s.links);
  const [custom, setCustom] = useState(localStorage.getItem('jarvis.secure') ?? '');
  const lan = links.lan[0] ? `http://${links.lan[0]}:${links.port}/?k=${links.token}` : '';
  const secure = /^https:\/\//.test(custom.trim()) ? `${custom.trim().replace(/\/+$/, '')}/?k=${links.token}` : '';
  const url = secure || lan;
  const [qr, setQr] = useState('');
  useEffect(() => {
    if (url) void call<string>('qr', { url }).then(setQr).catch(() => setQr(''));
    if (secure) localStorage.setItem('jarvis.secure', custom.trim());
  }, [url, secure, custom]);
  return (
    <Drawer title="Pair your phone" sub="Same Jarvis, same memory, in your pocket">
      {isPhone ? <p className="lead">This device is already paired. In Safari, tap Share → Add to Home Screen to install Jarvis as an app.</p> : (
        <>
          <div className="qr">{qr ? <img src={qr} alt="Pairing code" /> : <span className="lead">No network address found. Is Wi-Fi on?</span>}</div>
          <ol className="steps">
            <li>Point your phone's camera at the code and open the link.</li>
            <li>In Safari tap <b>Share → Add to Home Screen</b>. Jarvis now opens like any app.</li>
            <li>Your phone talks to this Mac, so the Mac needs to be on and awake. Everything you say or save appears on both.</li>
          </ol>
          <h3>{secure ? 'Secure link active' : 'Talk to me from anywhere (recommended)'}</h3>
          <p className="lead">The code above works on your home Wi-Fi, with typing and your keyboard's dictation key. For the microphone button, and to reach me when you are out, give the phone a secure link with Tailscale (free):</p>
          <ol className="steps">
            <li>Install <b>Tailscale</b> on this Mac and on your phone, and sign in to both with the same account.</li>
            <li>On this Mac, open Terminal and run: <code>tailscale serve --bg {links.port}</code></li>
            <li>It prints an address starting with https. Paste it here and the code above updates:</li>
          </ol>
          <input className="search" value={custom} placeholder="https://your-mac.your-tailnet.ts.net" onChange={(e) => setCustom(e.target.value)} />
          <p className="lead dim">Keep the link private: anyone who has it can talk to your Jarvis.</p>
        </>
      )}
    </Drawer>
  );
}

const BOOT = ['POWER … OK', 'MEMORY CORE … ONLINE', 'SPEECH RECOGNITION … STANDING BY', 'VOICE SYNTHESIS … STANDING BY', 'LANGUAGE MODEL … LOCAL', 'UPLINK … NONE REQUIRED', 'ALL SYSTEMS NOMINAL'];

/** First run: a boot sequence, then three questions, then the downloads. */
export function Onboarding() {
  const s = useSnap((x) => x.settings);
  const models = useSnap((x) => x.models);
  const downloads = useSnap((x) => x.downloads);
  const [step, setStep] = useState(0);
  const [lines, setLines] = useState(0);
  const [name, setName] = useState(s.userName);
  const [place, setPlace] = useState(s.place);
  useEffect(() => {
    if (step !== 0) return;
    const t = setInterval(() => setLines((n) => (n >= BOOT.length ? (clearInterval(t), setTimeout(() => setStep(1), 500), n) : n + 1)), 260);
    return () => clearInterval(t);
  }, [step]);
  const need = [s.llmModel, s.asrModel, 'voice', 'embed'];
  const info = (id: string) => models.find((m) => m.id === id);
  const missing = need.filter((id) => !info(id)?.installed);
  const total = missing.reduce((n, id) => n + (info(id)?.bytes ?? 0), 0);
  const mindReady = !!info(s.llmModel)?.installed;
  const begin = () => {
    save({ userName: name.trim(), place: place.trim() });
    for (const id of ['embed', s.asrModel, 'voice', s.llmModel]) if (!info(id)?.installed) act('downloadModel', { id });
    setStep(3);
  };
  const finish = () => {
    unlock();
    save({ onboarded: true });
    setTimeout(() => act('briefing'), 600);
  };
  return (
    <div className="onboard">
      <div className="onboard-core"><Core size={step === 0 ? 240 : 200} /></div>
      {step === 0 && <pre className="boot mono">{BOOT.slice(0, lines).map((l) => `> ${l}`).join('\n')}<span className="caret" /></pre>}
      {step === 1 && (
        <div className="onboard-card">
          <h1>Hello. I'm Jarvis.</h1>
          <p>Your own assistant: I listen, speak, remember, and run your day from this Mac and your phone. Nothing I hear or learn ever leaves your devices.</p>
          <input autoFocus value={name} placeholder="What's your name?" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && setStep(2)} />
          <button className="btn big" disabled={!name.trim()} onClick={() => setStep(2)}>Continue <ArrowRight size={16} /></button>
        </div>
      )}
      {step === 2 && (
        <div className="onboard-card">
          <h1>Good to meet you, {name.trim()}.</h1>
          <p>Where are you based? I'll keep an eye on the weather. You can change everything later in Settings.</p>
          <input autoFocus value={place} placeholder="Your town or city" onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && begin()} />
          <div className="seg">{([['name', `Call me ${name.trim()}`], ['sir', 'Call me sir'], ['maam', "Call me ma'am"], ['boss', 'Call me boss']] as const).map(([k, l]) => <button key={k} className={s.address === k ? 'on' : ''} onClick={() => save({ address: k })}>{l}</button>)}</div>
          <button className="btn big" onClick={begin}>{total ? `Download my brain (${gb(total)})` : 'Continue'} <ArrowRight size={16} /></button>
          <p className="dim small">A one-time download of the on-device AI. After this I work with no internet at all.</p>
        </div>
      )}
      {step === 3 && (
        <div className="onboard-card">
          <h1>{missing.length ? 'Coming online…' : 'Online.'}</h1>
          <div className="dl-list">
            {need.map((id) => {
              const m = info(id), d = downloads.find((x) => x.id === id);
              if (!m) return null;
              const pct = m.installed ? 100 : d ? (d.received / Math.max(1, d.total)) * 100 : 0;
              return <div key={id} className={`dl-row ${m.installed ? 'done' : ''}`}><span className="label">{m.kind === 'llm' ? 'Mind' : m.kind === 'asr' ? 'Ears' : m.kind === 'voice' ? 'Voice' : 'Memory'}</span><div className="bar"><span style={{ width: `${pct}%` }} /></div><span className="mono dim">{m.installed ? 'ready' : d?.error && d.error !== 'Cancelled' ? 'retry' : `${Math.round(pct)}%`}</span></div>;
            })}
          </div>
          {downloads.some((d) => d.error && d.error !== 'Cancelled') && <button className="btn" onClick={() => missing.forEach((id) => act('downloadModel', { id }))}>Resume downloads</button>}
          <button className="btn big" disabled={!mindReady} onClick={finish}>{mindReady ? 'Wake me up' : 'Waiting for my mind…'} <ArrowRight size={16} /></button>
          <p className="dim small"><Smartphone size={13} /> Once I'm up, pair your phone from the phone icon in the top bar.</p>
        </div>
      )}
    </div>
  );
}
