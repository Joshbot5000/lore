/** Voice: Kokoro neural text-to-speech, on the CPU, offline. Returns 24 kHz mono samples. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { serve } from './rpc';

let tts: any = null;
let Tensor: any = null;
let voicesDir = '';
const voiceData = new Map<string, Float32Array>();

/** A voice is one of Kokoro's, or a blend such as "bm_george*0.6+bm_fable*0.4". */
function parseVoice(spec: string): { id: string; weight: number }[] {
  const parts = spec.split('+').map((p) => {
    const [id, w] = p.trim().split('*');
    return { id: id.trim(), weight: w === undefined ? 1 : Math.max(0, parseFloat(w) || 0) };
  }).filter((p) => /^[a-z]{2}_[a-z]+$/.test(p.id) && p.weight > 0);
  const total = parts.reduce((n, p) => n + p.weight, 0) || 1;
  return parts.map((p) => ({ id: p.id, weight: p.weight / total }));
}

function loadVoice(id: string): Float32Array {
  let v = voiceData.get(id);
  if (!v) {
    const buf = fs.readFileSync(path.join(voicesDir, `${id}.bin`));
    v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
    voiceData.set(id, v);
  }
  return v;
}
let chain: Promise<unknown> = Promise.resolve();
const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

serve({
  async init({ modelsDir }: { modelsDir: string }) {
    // kokoro-js carries its own copy of transformers.js; point that copy at the local model folder.
    const req = createRequire(import.meta.url);
    const nested = path.join(path.dirname(req.resolve('kokoro-js')), '..', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
    const tx = fs.existsSync(nested) ? await import(pathToFileURL(nested).href) : await import('@huggingface/transformers');
    tx.env.allowRemoteModels = false;
    tx.env.allowLocalModels = true;
    tx.env.localModelPath = path.join(modelsDir, 'hf') + path.sep;
    const { KokoroTTS } = await import('kokoro-js');
    Tensor = tx.Tensor;
    voicesDir = path.join(path.dirname(req.resolve('kokoro-js')), '..', 'voices');
    // The full-precision model: it sounds cleaner than the compressed one and, on a CPU, runs about twice as fast.
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
    // Take over the last step of synthesis so a voice can be a blend of several: the character of
    // each voice is a short vector, and mixing vectors mixes voices.
    let style: { id: string; weight: number }[] = [{ id: 'bm_george', weight: 1 }];
    tts.generate_from_ids = async (ids: any, { speed = 1 }: { speed?: number } = {}) => {
      const at = 256 * Math.min(Math.max(ids.dims.at(-1) - 2, 0), 509);
      const mix = new Float32Array(256);
      for (const { id, weight } of style) {
        const v = loadVoice(id);
        for (let i = 0; i < 256; i++) mix[i] += v[at + i] * weight;
      }
      const { waveform } = await tts.model({ input_ids: ids, style: new Tensor('float32', mix, [1, 256]), speed: new Tensor('float32', [speed], [1]) });
      return { audio: waveform.data as Float32Array, sampling_rate: 24000 };
    };
    tts.setStyle = (spec: string) => {
      const parsed = parseVoice(spec);
      if (!parsed.length) throw new Error(`Unknown voice ${spec}`);
      for (const p of parsed) loadVoice(p.id);
      style = parsed;
      return parsed[0].id; // its accent decides how words are pronounced
    };
    tts.setStyle('bm_george');
    await tts.generate('Ready.', { voice: 'bm_george', speed: 1 }).catch(() => undefined); // first run is slow: get it out of the way
    return true;
  },
  speak: ({ text, voice, speed }: { text: string; voice: string; speed: number }) =>
    queued(async () => {
      if (!tts) throw new Error('Voice model is not loaded');
      const base = tts.setStyle(voice);
      const out = await tts.generate(text, { voice: base, speed });
      let f32: Float32Array = out.audio;
      // The model pads every clip with a quarter to half a second of silence at each end. Left in,
      // that makes speech arrive late and stop dead between sentences. Trim it; the player adds
      // a natural pause instead.
      const rate: number = out.sampling_rate;
      const quiet = 0.006, keep = Math.round(rate * 0.012);
      let a = 0, b = f32.length - 1;
      while (a < b && Math.abs(f32[a]) < quiet) a++;
      while (b > a && Math.abs(f32[b]) < quiet) b--;
      a = Math.max(0, a - keep);
      b = Math.min(f32.length - 1, b + keep * 3);
      f32 = f32.slice(a, b + 1);
      const fade = Math.min(Math.round(rate * 0.006), f32.length >> 1);
      for (let i = 0; i < fade; i++) {
        f32[i] *= i / fade;
        f32[f32.length - 1 - i] *= i / fade;
      }
      // 16-bit PCM is plenty for speech and a quarter of the size on the wire.
      const pcm = Buffer.alloc(f32.length * 2);
      for (let i = 0; i < f32.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), i * 2);
      return { pcm: pcm.toString('base64'), rate: out.sampling_rate as number };
    }),
});
