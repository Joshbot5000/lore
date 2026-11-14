/**
 * Mind: a local LLM through llama.cpp (Metal on Apple Silicon, CPU elsewhere). Supports tool
 * calling: when the model wants to act, the call is sent to the brain and the result fed back.
 */
import { emit, serve } from './rpc';

type Lib = typeof import('node-llama-cpp');
let lib: Lib;
let llama: any = null;
let model: any = null;
let context: any = null;
let sequence: any = null;
let sideContext: any = null;
let sideSequence: any = null;
let loadedPath = '';
let chain: Promise<unknown> = Promise.resolve();
const aborts = new Map<string, AbortController>();
const toolWaits = new Map<string, (result: unknown) => void>();
let callSeq = 1;

const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

type Turn = { role: 'user' | 'assistant'; text: string };
type ToolDef = { name: string; description: string; params?: Record<string, unknown> };
type GenParams = { streamId: string; system: string; history?: Turn[]; prompt: string; maxTokens?: number; temperature?: number; tools?: ToolDef[]; prefix?: string; side?: boolean };

async function unload(): Promise<void> {
  await sideContext?.dispose?.().catch(() => undefined);
  sideContext = sideSequence = null;
  await context?.dispose?.().catch(() => undefined);
  await model?.dispose?.().catch(() => undefined);
  context = model = sequence = null;
  loadedPath = '';
}

serve({
  load: ({ modelPath, contextSize }: { modelPath: string; contextSize: number }) =>
    queued(async () => {
      if (model && loadedPath === modelPath) return { gpu: String(llama.gpu || 'cpu'), contextSize: context.contextSize };
      lib ??= await import('node-llama-cpp');
      llama ??= await lib.getLlama({ build: 'never', logLevel: lib.LlamaLogLevel.error });
      await unload();
      model = await llama.loadModel({ modelPath });
      context = await model.createContext({ contextSize: { min: 2048, max: contextSize } });
      sequence = context.getSequence();
      loadedPath = modelPath;
      return { gpu: String(llama.gpu || 'cpu'), contextSize: context.contextSize as number };
    }),
  unload: () => queued(unload),

  toolResult: ({ callId, result }: { callId: string; result: unknown }) => {
    toolWaits.get(callId)?.(result);
    toolWaits.delete(callId);
    return true;
  },

  generate: (p: GenParams) => {
    const abort = new AbortController();
    aborts.set(p.streamId, abort);
    return queued(async () => {
      if (!model) throw new Error('Language model is not loaded');
      if (abort.signal.aborted) return '';
      let seq = sequence;
      if (p.side) {
        // Background jobs (such as noting memories) get their own small context, so the main
        // conversation's cached prompt is not thrown away between turns.
        if (!sideSequence) {
          sideContext = await model.createContext({ contextSize: { min: 1024, max: 2048 } });
          sideSequence = sideContext.getSequence();
        }
        seq = sideSequence;
      }
      const session = new lib.LlamaChatSession({ contextSequence: seq, systemPrompt: p.system, autoDisposeSequence: false });
      try {
        if (p.history?.length) {
          session.setChatHistory([
            { type: 'system', text: p.system },
            ...p.history.map((t) => (t.role === 'user' ? { type: 'user' as const, text: t.text } : { type: 'model' as const, response: [t.text] })),
          ]);
        }
        const functions: Record<string, unknown> = {};
        for (const t of p.tools ?? []) {
          functions[t.name] = lib.defineChatSessionFunction({
            description: t.description,
            ...(t.params ? { params: t.params as never } : {}),
            handler: (args: unknown) =>
              new Promise((resolve) => {
                const callId = `c${callSeq++}`;
                toolWaits.set(callId, resolve);
                emit('tool', { streamId: p.streamId, callId, name: t.name, args: args ?? {} });
              }),
          } as never);
        }
        const text: string = await session.prompt(p.prompt, {
          maxTokens: p.maxTokens ?? 700,
          temperature: p.temperature ?? 0.4,
          budgets: { thoughtTokens: 0 },
          ...(p.tools?.length ? { functions: functions as never, maxParallelFunctionCalls: 2 } : {}),
          ...(p.prefix ? { responsePrefix: p.prefix } : {}),
          signal: abort.signal,
          stopOnAbortSignal: true,
          onTextChunk: (delta: string) => emit('chunk', { streamId: p.streamId, delta }),
        });
        return text.trim();
      } finally {
        aborts.delete(p.streamId);
        session.dispose();
      }
    });
  },

  abort: ({ streamId }: { streamId: string }) => {
    for (const [id, a] of aborts) if (id === streamId || id.startsWith(streamId + ':')) a.abort();
    return true;
  },
});
