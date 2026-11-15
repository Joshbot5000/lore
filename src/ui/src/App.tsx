import { useEffect } from 'react';
import { useState } from 'react';
import { Brain, CalendarDays, LayoutGrid, Radio, RefreshCw, Settings as Cog, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { act, call, isPhone, set, toast, token, useLink, useSnap } from './link';
import { unlock } from './voice';
import { ClockCard, CoreCard, HomeCard, InboxCard, MoneyCard, MusicCard, NotebookCard, TasksCard, UpcomingCard, VitalsCard, WeatherCard } from './cards';
import { CountdownCard, FocusCard, HabitsCard, RevisionCard } from './life';
import { ACCENTS, LogPanel, MindPanel, Onboarding, PairPanel, SettingsPanel } from './panels';
import type { Integrations } from '../../shared/types';

const DOTS: [keyof Integrations, string][] = [['mail', 'MAIL'], ['calendar', 'CAL'], ['weather', 'WX'], ['home', 'HOME'], ['music', 'MUSIC'], ['hark', 'HARK']];

function TopBar() {
  const integrations = useSnap((s) => s.integrations);
  const speak = useSnap((s) => s.settings.speak);
  const name = useSnap((s) => s.settings.assistantName);
  const memories = useSnap((s) => s.memories.length);
  const online = useLink((s) => s.online);
  const broken = Object.entries(integrations).filter(([, i]) => i.state === 'error');
  const failing = broken.length;
  const NAMES: Record<string, string> = { mail: 'Mail', calendar: 'Calendar', weather: 'Weather', home: 'Home', music: 'Music', hark: 'Hark', system: 'System' };
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    if (busy) return;
    setBusy(true);
    void call('refresh').then(() => toast('Everything is up to date.'), (e: Error) => toast(e.message, 'alert')).finally(() => setBusy(false));
  };
  return (
    <header className="top">
      <div className="brand"><span className="brand-mark"><i /><i /><i /></span><b>{name.toUpperCase().split('').join(' ')}</b><span className="label dim">life · os</span></div>
      <div className="dots">
        {DOTS.map(([k, label]) => <span key={k} className={`idot ${integrations[k].state}`} title={integrations[k].detail ?? (integrations[k].state === 'ok' ? 'Connected' : 'Not connected')}><i />{label}</span>)}
      </div>
      <div className="top-right">
        {!online && <span className="label hot blink">reconnecting</span>}
        {online && failing > 0 && <button className="label hot fail" title={broken.map(([k, i]) => `${NAMES[k] ?? k}: ${i.detail ?? 'not responding'}`).join('\n')} onClick={() => broken.forEach(([k, i]) => toast(`${NAMES[k] ?? k}: ${i.detail ?? 'not responding'}`, 'alert'))}>{broken.map(([k]) => NAMES[k] ?? k).join(', ')} not working</button>}
        <button className={`chip ${busy ? 'spinning' : ''}`} onClick={refresh} title="Refresh calendar, mail, music and everything else now"><RefreshCw size={14} /></button>
        <button className="chip" onClick={() => set({ panel: 'mind' })} title="What I remember"><Brain size={14} /> {memories}</button>
        <button className={`chip ${speak ? 'on' : ''}`} onClick={() => (unlock(), act('saveSettings', { speak: !speak }))} title={speak ? 'Voice on' : 'Voice off'}>{speak ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
        {!isPhone && <button className="chip" onClick={() => set({ panel: 'pair' })} title="Pair your phone"><Smartphone size={14} /></button>}
        <button className="chip" onClick={() => set({ panel: 'settings' })} title="Settings"><Cog size={14} /></button>
      </div>
    </header>
  );
}

function Dock() {
  const tab = useLink((s) => s.tab);
  const items = [['core', 'Jarvis', <Radio size={18} key="a" />], ['today', 'Today', <CalendarDays size={18} key="b" />], ['life', 'Life', <LayoutGrid size={18} key="c" />]] as const;
  return (
    <nav className="dock">
      {items.map(([id, label, icon]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => set({ tab: id })}>{icon}<span>{label}</span></button>)}
      <button onClick={() => set({ panel: 'mind' })}><Brain size={18} /><span>Memory</span></button>
    </nav>
  );
}

export function App() {
  const ready = useLink((s) => !!s.snap);
  const online = useLink((s) => s.online);
  const everOnline = useLink((s) => s.everOnline);
  const panel = useLink((s) => s.panel);
  const tab = useLink((s) => s.tab);
  const toasts = useLink((s) => s.toasts);
  const accent = useLink((s) => s.snap?.settings.accent ?? 'arc');
  const onboarded = useLink((s) => s.snap?.settings.onboarded ?? true);
  useEffect(() => {
    document.documentElement.dataset.accent = ACCENTS.some((a) => a[0] === accent) ? accent : 'arc';
  }, [accent]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && set({ panel: null });
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  if (!ready)
    return (
      <div className="gate">
        <div className="gate-ring" />
        <p className="label">{!token() ? 'not paired' : everOnline || online ? 'linking' : 'looking for your mac'}</p>
        {!token() && <p className="gate-help">Open Jarvis on your Mac, tap the phone icon, and scan the code with this device.</p>}
        {token() && !online && <p className="gate-help">Make sure Jarvis is running on your Mac and that this device is on the same network (or connected through Tailscale).</p>}
      </div>
    );
  return (
    <div className={`shell ${isPhone ? 'phone' : 'desk'} tab-${tab}`} onPointerDown={unlock}>
      <div className="backdrop" />
      {!onboarded && !isPhone ? <Onboarding /> : (
        <>
          <TopBar />
          <main className="grid">
            <ClockCard /><WeatherCard /><UpcomingCard />
            <CoreCard compact={isPhone} />
            <InboxCard /><TasksCard />
            <MusicCard /><HomeCard /><MoneyCard />
            <FocusCard /><HabitsCard /><CountdownCard />
            <RevisionCard /><NotebookCard /><VitalsCard />
          </main>
          <Dock />
        </>
      )}
      {panel === 'settings' && <SettingsPanel />}
      {panel === 'mind' && <MindPanel />}
      {panel === 'pair' && <PairPanel />}
      {panel === 'log' && <LogPanel />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
    </div>
  );
}
