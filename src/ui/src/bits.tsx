import type { ReactNode } from 'react';
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun } from 'lucide-react';

export function Card({ id, tab, label, right, children, className = '' }: { id: string; tab: 'core' | 'today' | 'life'; label: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card card-${id} ${className}`} data-tab={tab} style={{ gridArea: id }}>
      <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
      <header className="card-head"><span className="label">{label}</span><span className="card-right">{right}</span></header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function WeatherIcon({ code, day = true, size = 20 }: { code: number; day?: boolean; size?: number }) {
  const p = { size, strokeWidth: 1.6 };
  if (code === 0 || code === 1) return day ? <Sun {...p} /> : <Moon {...p} />;
  if (code === 2) return day ? <CloudSun {...p} /> : <CloudMoon {...p} />;
  if (code === 3) return <Cloud {...p} />;
  if (code === 45 || code === 48) return <CloudFog {...p} />;
  if (code >= 51 && code <= 57) return <CloudDrizzle {...p} />;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow {...p} />;
  if (code >= 95) return <CloudLightning {...p} />;
  return <CloudRain {...p} />;
}

export const clock = (ts: number): string => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dayName = (ts: number): string => {
  const d = new Date(ts), n = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff < 7 && diff > 0 ? d.toLocaleDateString('en-GB', { weekday: 'short' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
export const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 6e4);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
export const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const gb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
