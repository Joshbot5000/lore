/** Momentum cards: focus sessions, daily habits and countdowns. */
import { useEffect, useMemo, useState } from 'react';
import { Check, Flame, Play, Plus, Square, X } from 'lucide-react';
import { act, useSnap } from './link';
import { Card, mmss } from './bits';
import { dayKey, daysUntil, focusStats, streak } from '../../brain/life';

const hm = (m: number): string => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`);

export function FocusCard() {
  const focus = useSnap((s) => s.focus);
  const live = useSnap((s) => s.focusNow);
  const goal = useSnap((s) => s.settings.focusGoal);
  const [subject, setSubject] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [live]);
  const st = useMemo(() => focusStats(focus), [focus]);
  const top = Math.max(goal || 1, ...st.last7, 1);
  const letters = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 864e5).toLocaleDateString('en-GB', { weekday: 'narrow' }));
  const left = live ? Math.max(0, (live.endsAt - Date.now()) / 1000) : 0;
  return (
    <Card id="focus" tab="today" label="Focus" right={st.streak > 1 ? <span className="label hot"><Flame size={11} /> {st.streak} day streak</span> : <span className="label dim">goal {hm(goal)}</span>}>
      {live ? (
        <div className="focus-live">
          <span className="label">{live.subject || 'deep work'}</span>
          <div className="digits focus-digits">{mmss(left)}</div>
          <div className="daybar"><span style={{ width: `${Math.min(100, (1 - (left * 1000) / live.total) * 100)}%` }} /></div>
          <button className="btn small" onClick={() => act('stopFocus')}><Square size={12} /> Finish now</button>
        </div>
      ) : (
        <>
          <div className="focus-top">
            <div><span className="label dim">Today</span><b>{hm(st.today)}</b></div>
            <div><span className="label dim">7 days</span><b>{hm(st.week)}</b></div>
            <div className="week">{st.last7.map((m, i) => <span key={i} title={`${m} min`}><i className={m >= goal && goal > 0 ? 'hit' : ''} style={{ height: `${Math.max(4, (m / top) * 100)}%` }} /><em>{letters[i]}</em></span>)}</div>
          </div>
          <div className="daybar"><span style={{ width: `${Math.min(100, goal ? (st.today / goal) * 100 : 0)}%` }} /></div>
          {st.bySubject.length > 0 && <p className="subjects">{st.bySubject.slice(0, 3).map(([k, v]) => <span key={k}>{k} <b>{hm(v)}</b></span>)}</p>}
          <div className="focus-start">
            <input value={subject} placeholder="On what? (optional)" onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && act('startFocus', { minutes: 25, subject })} />
            {[25, 45, 60].map((m) => <button key={m} className="btn small" onClick={() => (act('startFocus', { minutes: m, subject }), setSubject(''))}><Play size={11} /> {m}</button>)}
          </div>
        </>
      )}
    </Card>
  );
}

export function HabitsCard() {
  const habits = useSnap((s) => s.habits);
  const [text, setText] = useState('');
  const today = dayKey();
  const week = Array.from({ length: 7 }, (_, i) => dayKey(Date.now() - (6 - i) * 864e5));
  const done = habits.filter((h) => h.days.includes(today)).length;
  const add = () => {
    if (!text.trim()) return;
    act('addHabit', { name: text.trim() });
    setText('');
  };
  return (
    <Card id="habits" tab="life" label="Habits" right={<span className="label dim">{habits.length ? `${done} of ${habits.length} today` : 'daily'}</span>}>
      <ul className="rows habits">
        {habits.map((h) => {
          const on = h.days.includes(today);
          const n = streak(h.days, today);
          return (
            <li key={h.id} className={on ? 'done' : ''}>
              <button className={`check ${on ? 'on' : ''}`} onClick={() => act('toggleHabit', { id: h.id })}>{on && <Check size={12} strokeWidth={3} />}</button>
              <span className="grow"><b>{h.name}</b></span>
              <span className="dots7">{week.map((d) => <i key={d} className={h.days.includes(d) ? 'on' : ''} />)}</span>
              <span className={`streak mono ${n > 1 ? 'hot' : ''}`}><Flame size={12} />{n}</span>
              <button className="ghost" onClick={() => confirm(`Stop tracking “${h.name}”?`) && act('deleteHabit', { id: h.id })}><X size={13} /></button>
            </li>
          );
        })}
        {!habits.length && <li className="empty-row">Small things, every day. Add one here, or say “add a habit called reading”. Then just tell me “I did my reading”.</li>}
      </ul>
      <div className="adder"><Plus size={14} /><input value={text} placeholder="Add a daily habit…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} /></div>
    </Card>
  );
}

export function CountdownCard() {
  const all = useSnap((s) => s.countdowns);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: '', when: '' });
  const list = useMemo(() => all.filter((c) => daysUntil(c.date) >= 0).sort((a, b) => a.date - b.date), [all]);
  const save = () => {
    if (!f.title.trim() || !f.when.trim()) return;
    act('addCountdown', { title: f.title.trim(), when: f.when.trim() });
    setF({ title: '', when: '' });
    setAdding(false);
  };
  return (
    <Card id="dates" tab="life" label="Countdown" right={<button className="ghost label" onClick={() => setAdding((a) => !a)}>{adding ? 'close' : '+ add'}</button>}>
      {adding && (
        <div className="cd-form">
          <input placeholder="What? (Tort exam)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />
          <input placeholder="When? (12 January)" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="btn small" onClick={save}>Add</button>
        </div>
      )}
      <ul className="rows cds">
        {list.slice(0, 5).map((c) => {
          const n = daysUntil(c.date);
          return (
            <li key={c.id} className={n <= 7 ? 'near' : ''}>
              <span className="cd-n"><b>{n}</b><em>{n === 1 ? 'day' : 'days'}</em></span>
              <span className="grow"><b>{c.title}</b><i>{new Date(c.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: new Date(c.date).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })}</i></span>
              <button className="ghost" onClick={() => act('deleteCountdown', { id: c.id })}><X size={13} /></button>
            </li>
          );
        })}
        {!list.length && !adding && <li className="empty-row">Exams, deadlines, holidays. “Count down to my tort exam on 12 January.”</li>}
      </ul>
    </Card>
  );
}
