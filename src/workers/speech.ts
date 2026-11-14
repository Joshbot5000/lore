/** Ears and recall: speech-to-text (Whisper) and text embeddings (MiniLM), on the CPU, offline. */
import path from 'node:path';
import { serve } from './rpc';

type Tx = typeof import('@huggingface/transformers');
let tx: Tx;
let asr: any = null;
let asrRepo = '';
let embedder: any = null;
let chain: Promise<unknown> = Promise.resolve();
const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

serve({
  async init({ modelsDir }: { modelsDir: string }) {
    tx = await import('@huggingface/transformers');
    tx.env.allowRemoteModels = false;
    tx.env.allowLocalModels = true;
    tx.env.localModelPath = path.join(modelsDir, 'hf') + path.sep;
    return true;
  },
  loadAsr: ({ repo }: { repo: string }) =>
    queued(async () => {
      if (asr && asrRepo === repo) return true;
      await asr?.dispose?.().catch(() => undefined);
      asr = await tx.pipeline('automatic-speech-recognition', repo, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } as never, device: 'cpu' });
      asrRepo = repo;
      return true;
    }),
  transcribe: ({ pcm, language }: { pcm: Float32Array | number[]; language: string }) =>
    queued(async () => {
      if (!asr) throw new Error('Speech model is not loaded');
      const audio = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
      const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
      return String(out.text ?? '').replace(/[\[(][^\])]{0,40}[\])]/g, '').replace(/\s+/g, ' ').trim();
    }),
  embed: ({ texts }: { texts: string[] }) =>
    queued(async () => {
      embedder ??= await tx.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', device: 'cpu' });
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) out.push(...((await embedder(texts.slice(i, i + 16), { pooling: 'mean', normalize: true })).tolist() as number[][]));
      return out.map((v) => v.map((x) => Math.round(x * 1e4) / 1e4));
    }),
});
