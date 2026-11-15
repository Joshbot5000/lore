/**
 * Optional cloud voices (ElevenLabs, OpenAI): far more lifelike than anything that runs on a small
 * Mac, at the price of an account, a key, and each reply's text being sent to that company to be
 * spoken. Off unless a key is saved. Returns MP3 audio.
 */
import type { Fetch } from './weather';

export type CloudVoice = { id: string; name: string; note: string };

const ELEVEN = (): string => process.env.JARVIS_ELEVEN_URL ?? 'https://api.elevenlabs.io';
const OPENAI = (): string => process.env.JARVIS_OPENAI_URL ?? 'https://api.openai.com';

async function fail(res: Response, who: string): Promise<never> {
  let detail = '';
  try {
    const j = (await res.json()) as any;
    detail = String(j?.detail?.message ?? j?.detail?.status ?? j?.error?.message ?? j?.detail ?? '').slice(0, 200);
  } catch {
    /* no body */
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${who} rejected the key${detail ? ` (${detail})` : ''}`);
  if (res.status === 429 || /quota|credit|limit|billing/i.test(detail)) throw new Error(`${who} says the account is out of credit or over its limit${detail ? ` (${detail})` : ''}`);
  throw new Error(`${who} answered ${res.status}${detail ? `: ${detail}` : ''}`);
}

const timed = async (fetcher: Fetch, url: string, init: Record<string, unknown>, who: string, ms = 20000): Promise<Response> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetcher(url, { ...init, signal: ctrl.signal } as never);
  } catch (err) {
    throw new Error((err as Error).name === 'AbortError' ? `${who} took too long to answer` : `can't reach ${who} (offline?)`);
  } finally {
    clearTimeout(timer);
  }
};

/** The voices this ElevenLabs account can use. Doubles as the check that a key works. */
export async function elevenVoices(fetcher: Fetch, key: string): Promise<CloudVoice[]> {
  const res = await timed(fetcher, `${ELEVEN()}/v1/voices`, { headers: { 'xi-api-key': key } }, 'ElevenLabs');
  if (!res.ok) await fail(res, 'ElevenLabs');
  const voices = ((await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] }).voices ?? [];
  const british = (v: { labels?: Record<string, string> }) => (/british|english/i.test(v.labels?.accent ?? '') ? 0 : 1);
  return voices
    .map((v) => ({ id: `eleven:${v.voice_id}`, name: v.name.split(/ [-–] /)[0], note: [v.labels?.accent, v.labels?.gender, v.labels?.description ?? v.labels?.descriptive].filter(Boolean).join(', '), _v: v }))
    .sort((a, b) => british(a._v) - british(b._v) || a.name.localeCompare(b.name))
    .map(({ _v, ...v }) => v);
}

export async function elevenSpeak(fetcher: Fetch, key: string, voiceId: string, text: string, speed: number): Promise<Buffer> {
  // The "flash" model is built for conversation: it answers in a fraction of a second.
  const res = await timed(fetcher, `${ELEVEN()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: Math.max(0.7, Math.min(1.2, speed)) } }),
  }, 'ElevenLabs');
  if (!res.ok) await fail(res, 'ElevenLabs');
  return Buffer.from(await res.arrayBuffer());
}

export const OPENAI_VOICES: CloudVoice[] = [
  ['fable', 'British, expressive'], ['ash', 'warm, male'], ['onyx', 'deep, male'], ['echo', 'clear, male'], ['ballad', 'soft, male'], ['verse', 'lively, male'],
  ['coral', 'bright, female'], ['sage', 'calm, female'], ['nova', 'friendly, female'], ['shimmer', 'light, female'], ['alloy', 'neutral'],
].map(([id, note]) => ({ id: `openai:${id}`, name: id[0].toUpperCase() + id.slice(1), note }));

/** A free call that fails if the key is wrong. */
export async function openaiCheck(fetcher: Fetch, key: string): Promise<void> {
  const res = await timed(fetcher, `${OPENAI()}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }, 'OpenAI');
  if (!res.ok) await fail(res, 'OpenAI');
}

export async function openaiSpeak(fetcher: Fetch, key: string, voice: string, text: string, assistant: string): Promise<Buffer> {
  const res = await timed(fetcher, `${OPENAI()}/v1/audio/speech`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', instructions: `You are ${assistant}, a calm, warm, quick-witted British personal assistant. Speak naturally and conversationally, as if talking to someone you know well, at an easy brisk pace.` }),
  }, 'OpenAI');
  if (!res.ok) await fail(res, 'OpenAI');
  return Buffer.from(await res.arrayBuffer());
}

/** Read raw 16-bit audio from a response as it arrives, handing it on in playable pieces. Returns the bytes delivered. */
async function pump(res: Response, onPcm: (pcm: Buffer) => void): Promise<number> {
  const reader = (res.body as unknown as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }).getReader();
  let carry: Buffer = Buffer.alloc(0);
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value?.length) carry = carry.length ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
    // The first piece goes out almost at once so speech starts; later ones are a third of a second each.
    const need = total === 0 ? 4800 : 16000;
    if (carry.length >= need || (done && carry.length >= 2)) {
      const n = carry.length - (carry.length % 2);
      onPcm(carry.subarray(0, n));
      total += n;
      carry = carry.subarray(n);
    }
    if (done) break;
  }
  return total;
}

/** Speak with ElevenLabs, playing the audio as it is produced (24 kHz, 16-bit). */
export async function elevenStream(fetcher: Fetch, key: string, voiceId: string, text: string, speed: number, onPcm: (pcm: Buffer) => void): Promise<number> {
  const res = await timed(fetcher, `${ELEVEN()}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: Math.max(0.7, Math.min(1.2, speed)) } }),
  }, 'ElevenLabs');
  if (!res.ok) await fail(res, 'ElevenLabs');
  return pump(res, onPcm);
}

/** Speak with OpenAI, playing the audio as it is produced (24 kHz, 16-bit). */
export async function openaiStream(fetcher: Fetch, key: string, voice: string, text: string, assistant: string, onPcm: (pcm: Buffer) => void): Promise<number> {
  const res = await timed(fetcher, `${OPENAI()}/v1/audio/speech`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm', instructions: `You are ${assistant}, a calm, warm, quick-witted British personal assistant. Speak naturally and conversationally, as if talking to someone you know well, at an easy brisk pace.` }),
  }, 'OpenAI');
  if (!res.ok) await fail(res, 'OpenAI');
  return pump(res, onPcm);
}
