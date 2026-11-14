/** Weather from Open-Meteo: free, no key, no account. */
import type { Weather } from '../shared/types';

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
  73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};
export const weatherLabel = (code: number): string => WMO[code] ?? 'Unsettled';

export async function geocode(fetcher: Fetch, place: string): Promise<{ name: string; lat: number; lon: number } | null> {
  const res = await fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
  if (!res.ok) throw new Error(`Weather lookup failed (${res.status})`);
  const hit = ((await res.json()) as { results?: { name: string; latitude: number; longitude: number; admin1?: string; country_code?: string }[] }).results?.[0];
  return hit ? { name: hit.name, lat: hit.latitude, lon: hit.longitude } : null;
}

export async function forecast(fetcher: Fetch, lat: number, lon: number, place: string, units: 'c' | 'f'): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,is_day` +
    `&hourly=temperature_2m,weather_code,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=5&forecast_hours=12&wind_speed_unit=mph${units === 'f' ? '&temperature_unit=fahrenheit' : ''}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  return parseForecast(await res.json(), place);
}

export function parseForecast(j: any, place: string): Weather {
  const c = j.current ?? {}, d = j.daily ?? {}, h = j.hourly ?? {};
  return {
    place, at: Date.now(),
    temp: Math.round(c.temperature_2m ?? 0), feels: Math.round(c.apparent_temperature ?? c.temperature_2m ?? 0), code: c.weather_code ?? 0, label: weatherLabel(c.weather_code ?? 0),
    wind: Math.round(c.wind_speed_10m ?? 0), rain: c.precipitation ?? 0, isDay: c.is_day !== 0,
    days: (d.time ?? []).map((date: string, i: number) => ({ date, hi: Math.round(d.temperature_2m_max?.[i] ?? 0), lo: Math.round(d.temperature_2m_min?.[i] ?? 0), code: d.weather_code?.[i] ?? 0, label: weatherLabel(d.weather_code?.[i] ?? 0), rain: d.precipitation_probability_max?.[i] ?? 0 })),
    hours: (h.time ?? []).slice(0, 12).map((t: string, i: number) => ({ t: Date.parse(t), temp: Math.round(h.temperature_2m?.[i] ?? 0), code: h.weather_code?.[i] ?? 0, rain: h.precipitation_probability?.[i] ?? 0 })),
  };
}

/** One spoken sentence about the weather. */
export function weatherSentence(w: Weather): string {
  const today = w.days[0];
  const rain = today && today.rain >= 50 ? `, with a ${today.rain}% chance of rain` : '';
  return `${w.label.toLowerCase()} and ${w.temp}° in ${w.place}${w.feels !== w.temp ? `, feels like ${w.feels}°` : ''}${today ? `. High of ${today.hi}°, low of ${today.lo}°${rain}` : ''}`;
}
