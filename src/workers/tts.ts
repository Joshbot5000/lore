/** Voice: Kokoro neural text-to-speech, on the CPU, offline. Returns 24 kHz mono samples. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { serve } from './rpc';

let tts: any = null;
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
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
    return true;
  },
  speak: ({ text, voice, speed }: { text: string; voice: string; speed: number }) =>
    queued(async () => {
      if (!tts) throw new Error('Voice model is not loaded');
      const out = await tts.generate(text, { voice, speed });
      const f32: Float32Array = out.audio;
      // 16-bit PCM is plenty for speech and a quarter of the size on the wire.
      const pcm = Buffer.alloc(f32.length * 2);
      for (let i = 0; i < f32.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), i * 2);
      return { pcm: pcm.toString('base64'), rate: out.sampling_rate as number };
    }),
});
