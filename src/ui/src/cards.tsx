import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BatteryCharging, Check, ChevronRight, Cpu, Lightbulb, Mail as MailIcon, Mic, Pause, Play, Plus, SkipBack, SkipForward, Sparkles, Square, Timer as TimerIcon, Trash2, Volume2, X, Zap } from 'lucide-react';
import { act, call, get, set, toast, useLink, useSnap } from './link';
import { hush, setHandsFree, talkEnd, talkStart, unlock } from './voice';
import { Core } from './Core';
import { Card, WeatherIcon, ago, clock, dayName, mmss } from './bits';
import { describeWhen, eventOver } from '../../shared/when';
import type { Task } from '../../shared/types';

function useNow(ms = 1000): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ClockCard() {
  const now = useNow();
  const name = useSnap((s) => s.settings.userName);
  const h = now.getHours();
  const dayPct = ((h * 60 + now.getMinutes()) / 1440) * 100;
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    <Card id="clock" tab="today" label={`Good ${h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}${name ? `, ${name}` : ''}`} right={<span className="label dim">{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>}>
      <div className="clock">
        <span className="digits">{two(h)}<i>:</i>{two(now.getMinutes())}</span>
        <span className="secs mono">{two(now.getSeconds())}</span>
      </div>
      <div className="daybar" title="How much of today has gone"><span style={{ width: `${dayPct}%` }} /><b style={{ left: `${dayPct}%` }} /></div>
      <div className="daybar-scale mono"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    </Card>
  );
}

export function WeatherCard() {
  const w = useSnap((s) => s.weather);
  const state = useSnap((s) => s.integrations.weather);
  const units = useSnap((s) => s.settings.units);
  return (
    <Card id="weather" tab="today" label="Weather" right={<span className="label dim">{w?.place ?? ''}</span>}>
      {!w ? (
        <button className="empty" onClick={() => set({ panel: 'settings' })}>{state.state === 'setup' ? 'Tell me your town in Settings and I will watch the sky for you.' : state.detail ?? 'Fetching the forecast…'}</button>
      ) : (
        <>
          <div className="wx-now">
            <span className="wx-icon"><WeatherIcon code={w.code} day={w.isDay} size={44} /></span>
            <span className="wx-temp">{w.temp}<sup>°{units.toUpperCase()}</sup></span>
            <span className="wx-meta"><b>{w.label}</b><i>Feels {w.feels}° · wind {w.wind} mph</i></span>
          </div>
          <div className="wx-hours">
            {w.hours.filter((_, i) => i % 2 === 0).slice(0, 6).map((h) => (
              <span key={h.t}><i className="mono">{new Date(h.t).getHours()}h</i><WeatherIcon code={h.code} size={15} /><b>{h.temp}°</b><em style={{ height: `${Math.max(2, h.rain * 0.22)}px` }} title={`${h.rain}% chance of rain`} /></span>
            ))}
          </div>
          <div className="wx-days">
            {w.days.slice(1, 5).map((d) => (
              <span key={d.date}><i>{new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short' })}</i><WeatherIcon code={d.code} size={17} /><b>{d.hi}°</b><em>{d.lo}°</em></span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export function UpcomingCard() {
  const events = useSnap((s) => s.events);
  const state = useSnap((s) => s.integrations.calendar);
  useNow(30000);
  const next = events.filter((e) => !eventOver(e)).slice(0, 6);
  return (
    <Card id="upcoming" tab="today" label="Upcoming" right={<span className="label dim">{next.filter((e) => new Date(e.start).toDateString() === new Date().toDateString()).length} today</span>}>
      {!next.length ? (
        <button className="empty" onClick={() => set({ panel: 'settings' })}>{state.state === 'setup' ? 'Connect a calendar in Settings, or just say “schedule dinner on Friday at 7”.' : 'Nothing coming up. Enjoy it.'}</button>
      ) : (
        <ul className="rows">
          {next.map((e) => {
            const live = e.start <= Date.now() && !e.allDay;
            return (
              <li key={e.id} className={live ? 'live' : ''}>
                <span className="when mono">{e.allDay ? 'all day' : clock(e.start)}</span>
                <span className="grow"><b>{e.title}</b>{e.where && <i>{e.where}</i>}</span>
                <span className="tag">{live ? 'now' : e.allDay && e.start <= Date.now() ? 'Today' : dayName(e.start)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function InboxCard() {
  const mail = useSnap((s) => s.mail);
  const unread = useSnap((s) => s.unread);
  const state = useSnap((s) => s.integrations.mail);
  return (
    <Card id="inbox" tab="today" label="Inbox" right={<span className={`label ${unread ? 'hot' : 'dim'}`}>{unread} unread</span>}>
      {state.state !== 'ok' ? (
        <div className="empty"><MailIcon size={18} /> {state.detail ?? 'Mail is not connected.'}</div>
      ) : !mail.length ? (
        <div className="empty">Inbox zero. Suspicious, but well done.</div>
      ) : (
        <ul className="rows mail">
          {mail.slice(0, 6).map((m) => (
            <li key={m.id}><span className="dot" /><span className="grow"><b>{m.from}</b><i>{m.subject}</i></span><span className="when mono">{ago(m.at)}</span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TasksCard() {
  const tasks = useSnap((s) => s.tasks);
  const [view, setView] = useState<'now' | 'week' | 'later' | 'done'>('now');
  const [text, setText] = useState('');
  const now = Date.now();
  const endToday = new Date().setHours(23, 59, 59, 999);
  const buckets = useMemo(() => {
    const open = tasks.filter((t) => !t.done);
    return {
      now: open.filter((t) => !t.due || t.due <= endToday),
      week: open.filter((t) => t.due && t.due > endToday && t.due <= endToday + 7 * 864e5),
      later: open.filter((t) => t.due && t.due > endToday + 7 * 864e5),
      done: tasks.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 12),
    };
  }, [tasks, endToday]);
  const add = () => {
    if (!text.trim()) return;
    // "call mum tomorrow 5pm": the time is understood by the brain.
    const m = text.match(/^(.*?)(?:\s+(?:at|on|by|in|tomorrow|today|tonight|next|this)\b.*)$/i);
    act('addTask', m && m[1].trim() ? { title: m[1].trim(), when: text.slice(m[1].length).trim() } : { title: text.trim() });
    setText('');
  };
  const list: Task[] = buckets[view];
  return (
    <Card id="tasks" tab="today" label="Tasks & reminders" right={<span className="label dim">{buckets.now.length} now · {tasks.filter((t) => !t.done).length} open</span>}>
      <div className="seg">
        {(['now', 'week', 'later', 'done'] as const).map((v) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v}{buckets[v].length ? <i>{buckets[v].length}</i> : null}</button>)}
      </div>
      <ul className="rows tasks">
        {list.map((t) => (
          <li key={t.id} className={`${t.done ? 'done' : ''} ${!t.done && t.due && t.due < now ? 'late' : ''}`}>
            <button className="check" onClick={() => act('updateTask', { id: t.id, patch: { done: !t.done } })}>{t.done && <Check size={12} strokeWidth={3} />}</button>
            <span className="grow"><b>{t.title}</b>{t.due && <i>{describeWhen(t.due)}</i>}</span>
            <button className="ghost" onClick={() => act('deleteTask', { id: t.id })}><X size={13} /></button>
          </li>
        ))}
        {!list.length && <li className="empty-row">{view === 'now' ? 'Nothing here. The queue is clear.' : 'Nothing in this view.'}</li>}
      </ul>
      <div className="adder"><Plus size={14} /><input value={text} placeholder="Add a task… “call mum tomorrow 5pm”" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} /></div>
    </Card>
  );
}

export function MusicCard() {
  const m = useSnap((s) => s.music);
  const app = useSnap((s) => s.settings.musicApp);
  const state = useSnap((s) => s.integrations.music);
  const [pos, setPos] = useState(m?.position ?? 0);
  useEffect(() => setPos(m?.position ?? 0), [m?.position, m?.title]);
  useEffect(() => {
    if (m?.state !== 'playing') return;
    const t = setInterval(() => setPos((p) => Math.min(m.duration ?? p + 1, p + 1)), 1000);
    return () => clearInterval(t);
  }, [m?.state, m?.duration, m?.title]);
  const playing = m?.state === 'playing';
  return (
    <Card id="music" tab="life" label="Now playing" right={<span className="label dim">{app}</span>}>
      {!m || !m.title ? (
        <div className="empty">{state.state === 'error' ? `I can't read ${app} right now: ${state.detail}` : m ? `Nothing playing in ${app}.` : `${app} isn't open. Open it and I will take the controls.`}</div>
      ) : (
        <div className="music">
          <div className={`art ${playing ? 'spin' : ''}`} style={m.art ? { backgroundImage: `url(${m.art})` } : undefined}>{!m.art && <span className="eq"><i /><i /><i /><i /></span>}</div>
          <div className="grow">
            <b className="track">{m.title}</b>
            <i className="artist">{m.artist}</i>
            <div className="scrub"><span style={{ width: `${m.duration ? (pos / m.duration) * 100 : 0}%` }} /></div>
            <div className="scrub-t mono"><span>{mmss(pos)}</span><span>{mmss(m.duration ?? 0)}</span></div>
          </div>
        </div>
      )}
      <div className="transport">
        <button onClick={() => act('music', { action: 'previous' })}><SkipBack size={16} /></button>
        <button className="main" onClick={() => act('music', { action: 'toggle' })}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <button onClick={() => act('music', { action: 'next' })}><SkipForward size={16} /></button>
        <span className="vol"><Volume2 size={14} /><input type="range" min={0} max={100} defaultValue={m?.volume ?? 50} key={m?.volume} onChange={(e) => act('music', { action: 'volume', value: +e.target.value })} /></span>
      </div>
    </Card>
  );
}

export function HomeCard() {
  const home = useSnap((s) => s.home);
  const state = useSnap((s) => s.integrations.home);
  const [busy, setBusy] = useState('');
  const run = async (name: string, h?: { id: string; kind?: string }) => {
    setBusy(name);
    try {
      if (h?.kind === 'ha') await call('tapHome', { id: h.id });
      else (await call('runShortcut', { name }), toast(`${name}: done`));
    } catch (e) {
      toast((e as Error).message, 'alert');
    }
    setBusy('');
  };
  return (
    <Card id="home" tab="life" label="Home" right={<span className="label dim">{home.some((h) => h.kind === 'ha') ? `${home.filter((h) => h.on).length} on` : 'Shortcuts'}</span>}>
      {!home.length ? (
        <div className="empty"><Lightbulb size={18} /> {state.detail ?? 'Make a shortcut in the Shortcuts app (“Lounge lights”, “Movie night”) and it appears here, ready for a tap or a word.'}</div>
      ) : (
        <div className="tiles">
          {home.map((h) => (
            <button key={h.id} className={`${busy === h.name ? 'busy' : ''} ${h.on ? 'lit' : ''}`} onClick={() => void run(h.name, h)}>
              {h.kind === 'ha' && (h.domain === 'light' || h.domain === 'switch') ? <Lightbulb size={15} /> : <Zap size={15} />}
              <span className="grow">{h.name}</span>
              {h.detail && <em>{h.detail}</em>}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function MoneyCard() {
  const money = useSnap((s) => s.money);
  const cur = useSnap((s) => s.settings.currency);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', amount: '', kind: 'bill', day: '' });
  const perMonth = (m: (typeof money)[number]) => (m.every === 'year' ? m.amount / 12 : m.every === 'week' ? m.amount * 4.33 : m.every === 'once' ? 0 : m.amount);
  const out = money.filter((m) => m.kind === 'bill').reduce((n, m) => n + perMonth(m), 0);
  const inc = money.filter((m) => m.kind === 'income').reduce((n, m) => n + perMonth(m), 0);
  const save = () => {
    if (!f.name.trim() || !+f.amount) return;
    act('addMoney', { name: f.name.trim(), amount: +f.amount, kind: f.kind, day: +f.day || undefined });
    setF({ name: '', amount: '', kind: 'bill', day: '' });
    setAdding(false);
  };
  return (
    <Card id="money" tab="life" label="Money" right={<button className="ghost label" onClick={() => setAdding((a) => !a)}>{adding ? 'close' : '+ add'}</button>}>
      <div className="money-top">
        <div><span className="label dim">Out / month</span><b>{cur}{Math.round(out).toLocaleString()}</b></div>
        {inc > 0 && <div><span className="label dim">Left over</span><b className={inc - out < 0 ? 'neg' : 'pos'}>{cur}{Math.round(inc - out).toLocaleString()}</b></div>}
      </div>
      {inc > 0 && <div className="daybar"><span style={{ width: `${Math.min(100, (out / inc) * 100)}%` }} /></div>}
      {adding && (
        <div className="money-form">
          <input placeholder="Name (Spotify, rent…)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          <input placeholder={cur} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <input placeholder="Day" inputMode="numeric" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} title="Day of the month it is paid" />
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="bill">Bill</option><option value="income">Income</option></select>
          <button className="btn" onClick={save}>Add</button>
        </div>
      )}
      <ul className="rows money">
        {money.slice(0, 6).map((m) => (
          <li key={m.id}><span className="grow"><b>{m.name}</b>{m.day ? <i>on the {m.day}{[, 'st', 'nd', 'rd'][m.day % 10 > 3 || Math.floor(m.day / 10) === 1 ? 0 : m.day % 10] ?? 'th'}</i> : null}</span><span className={`mono ${m.kind === 'income' ? 'pos' : ''}`}>{m.kind === 'income' ? '+' : ''}{cur}{m.amount}<em>/{m.every === 'month' ? 'mo' : m.every === 'year' ? 'yr' : 'wk'}</em></span><button className="ghost" onClick={() => act('deleteMoney', { id: m.id })}><X size={13} /></button></li>
        ))}
        {!money.length && !adding && <li className="empty-row">Tell me your bills and subscriptions and I will keep watch. “Track Spotify, £11.99 a month.”</li>}
      </ul>
    </Card>
  );
}

export function NotebookCard() {
  const notes = useSnap((s) => s.notes);
  const [text, setText] = useState('');
  const add = () => text.trim() && (act('addNote', { text: text.trim() }), setText(''));
  return (
    <Card id="notebook" tab="life" label="Notebook" right={<span className="label dim">{notes.length} notes</span>}>
      <div className="adder"><Plus size={14} /><input value={text} placeholder="Jot something down…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} /></div>
      <ul className="rows notes">
        {notes.slice(0, 6).map((n) => (
          <li key={n.id}><span className="grow"><b>{n.text}</b></span><span className="when mono">{dayName(n.at)}</span><button className="ghost" onClick={() => act('deleteNote', { id: n.id })}><X size={13} /></button></li>
        ))}
        {!notes.length && <li className="empty-row">Ideas, lists, things people said. “Note that the gate code is 4417.”</li>}
      </ul>
    </Card>
  );
}

export function VitalsCard() {
  const v = useSnap((s) => s.vitals);
  const status = useSnap((s) => s.status);
  const timers = useSnap((s) => s.timers);
  const now = useNow();
  const gauge = (label: string, value: number, unit = '%') => (
    <div className="gauge">
      <svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="25" className="g-bg" /><circle cx="30" cy="30" r="25" className="g-fg" strokeDasharray={157} strokeDashoffset={157 * (1 - Math.min(100, value) / 100)} transform="rotate(-90 30 30)" /></svg>
      <b className="mono">{Math.round(value)}<i>{unit}</i></b><span className="label dim">{label}</span>
    </div>
  );
  return (
    <Card id="vitals" tab="life" label="Systems" right={<span className="label dim">{v.host}</span>}>
      <div className="gauges">
        {gauge('CPU', v.cpu)}{gauge('Memory', v.mem)}{v.battery !== undefined && gauge(v.charging ? 'Charging' : 'Battery', v.battery)}
      </div>
      <div className="engines">
        <span className={`eng ${status.llm}`}><Sparkles size={12} /> Mind <i>{status.llm}</i></span>
        <span className={`eng ${status.asr}`}><Mic size={12} /> Ears <i>{status.asr}</i></span>
        <span className={`eng ${status.voice}`}><Volume2 size={12} /> Voice <i>{status.voice}</i></span>
        <span className="eng ready">{status.gpu === 'metal' ? <Zap size={12} /> : <Cpu size={12} />} {status.gpu === 'metal' ? 'Apple GPU' : (status.gpu ?? 'local').toUpperCase()}</span>
        {v.charging && <span className="eng ready"><BatteryCharging size={12} /> Mains</span>}
      </div>
      {!!timers.length && (
        <ul className="rows timers">
          {timers.map((t) => {
            const left = Math.max(0, (t.endsAt - now.getTime()) / 1000);
            return <li key={t.id}><TimerIcon size={14} /><span className="grow"><b>{t.label || 'Timer'}</b><div className="scrub"><span style={{ width: `${100 - (left * 1000 / t.total) * 100}%` }} /></div></span><span className="mono">{mmss(left)}</span><button className="ghost" onClick={() => act('cancelTimer', { id: t.id })}><X size={13} /></button></li>;
          })}
        </ul>
      )}
    </Card>
  );
}

/** The centrepiece: the core, what Jarvis just heard and said, what needs you, and the input line. */
export function CoreCard({ compact }: { compact: boolean }) {
  const mode = useLink((s) => s.mode);
  const turn = useLink((s) => s.turn);
  const handsFree = useLink((s) => s.handsFree);
  const online = useLink((s) => s.online);
  const needs = useSnap((s) => s.needs);
  const chat = useSnap((s) => s.chat);
  const name = useSnap((s) => s.settings.assistantName);
  const status = useSnap((s) => s.status);
  const [text, setText] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(320);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize(Math.round(Math.max(190, Math.min(e.contentRect.width * 0.9, e.contentRect.height, compact ? 300 : 460)))));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, [compact]);
  useEffect(() => {
    // Hold the space bar to talk, from anywhere that isn't a text box.
    const typing = (e: KeyboardEvent) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !typing(e) && !get().panel) (e.preventDefault(), void talkStart());
      if (e.key === 'Escape') (hush(), act('stop'));
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && !typing(e) && talkEnd();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => (window.removeEventListener('keydown', down), window.removeEventListener('keyup', up));
  }, []);
  const send = () => {
    if (!text.trim()) return;
    unlock();
    hush();
    set({ mode: 'thinking' });
    act('say', { text: text.trim() });
    setText('');
  };
  const last = chat[chat.length - 1];
  const showing = turn && (!turn.done || !last || Date.now() - last.at < 120000) ? turn : null;
  const stateLabel = !online ? 'offline' : mode === 'idle' ? (handsFree ? `say “${name}”` : status.llm === 'loading' ? 'waking up' : 'standing by') : mode;
  return (
    <section className={`card card-core mode-${mode}`} data-tab="core" style={{ gridArea: 'core' }}>
      <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
      <header className="card-head">
        <span className="label">{name}</span>
        <span className="card-right">
          <span className={`state label ${mode}`}><i />{stateLabel}</span>
          <button className={`pill ${handsFree ? 'on' : ''}`} onClick={() => void setHandsFree(!handsFree)} title={`Hands-free: say “${name}” to talk`}><Mic size={12} /> hands-free</button>
          <button className="pill" onClick={() => (unlock(), act('briefing'))} title="Hear your briefing"><Sparkles size={12} /> brief me</button>
        </span>
      </header>
      <div className="core-stage" ref={wrap}>
        <button className="core-btn" aria-label="Hold to talk" onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), void talkStart())} onPointerUp={talkEnd} onPointerCancel={talkEnd} onContextMenu={(e) => e.preventDefault()}>
          <Core size={size} />
        </button>
        <p className="core-hint label dim">{mode === 'listening' ? 'listening… release to send' : mode === 'speaking' || mode === 'thinking' ? 'press esc to interrupt' : compact ? 'hold the core to talk' : 'hold space or the core to talk'}</p>
      </div>
      <div className="exchange">
        {showing ? (
          <>
            {showing.heard && <p className="heard"><span className="label dim">you</span>{showing.heard}</p>}
            <p className="said">{showing.text || <span className="dots"><i /><i /><i /></span>}{!showing.done && showing.text && <span className="caret" />}</p>
            {!!showing.tools.length && <p className="tools">{showing.tools.map((t, i) => <span key={i} className={t.ok ? 'ok' : 'bad'}>{t.ok ? <Check size={11} strokeWidth={3} /> : <X size={11} />}{t.label}</span>)}</p>}
            {showing.timing && <p className="timing mono" title="How long each stage took">{[showing.timing.asr !== undefined && `heard ${(showing.timing.asr / 1000).toFixed(1)}s`, showing.timing.think !== undefined && `thought ${(showing.timing.think / 1000).toFixed(1)}s`, showing.timing.voice !== undefined && `voice ${(showing.timing.voice / 1000).toFixed(1)}s`].filter(Boolean).join(' · ')}</p>}
          </>
        ) : (
          <div className="needs">
            <span className="label dim">What needs you</span>
            {needs.length ? needs.map((n) => (
              <button key={n.id} className={`need ${n.tone}`} onClick={() => n.action && set({ panel: n.action.view === 'settings' ? 'settings' : null, tab: n.action.view === 'tasks' ? 'today' : get().tab })}><i />{n.text}{n.action && <ChevronRight size={13} />}</button>
            )) : <p className="calm">Nothing. All quiet on every front.</p>}
          </div>
        )}
      </div>
      <div className="say">
        <input value={text} placeholder={`Ask ${name} anything, or tell him what to do…`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} onFocus={unlock} />
        {mode === 'thinking' || mode === 'speaking' ? <button className="send stop" onClick={() => (hush(), act('stop'))}><Square size={13} fill="currentColor" /></button> : <button className="send" disabled={!text.trim()} onClick={send}><ArrowUp size={16} /></button>}
        <button className="log-btn label" onClick={() => set({ panel: 'log' })}>log</button>
      </div>
    </section>
  );
}

export const _unused = Trash2;
