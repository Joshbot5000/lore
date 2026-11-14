/** Run the brain without a window: `node out/main/headless.js`. Used for tests and for running on a home server. */
import { fork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from '../brain/brain';
import { serveBrain, lanAddresses } from '../brain/server';
import { pickMac } from '../brain/mac';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.JARVIS_DATA_DIR || path.join(os.homedir(), '.jarvis', 'data');
const modelsDir = process.env.JARVIS_MODELS_DIR || path.join(os.homedir(), '.jarvis', 'models');
const port = Number(process.env.JARVIS_PORT || 7717);

const spawn = (script: string) => {
  const child = fork(path.join(here, script), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return { postMessage: (m: unknown) => child.connected && child.send(m as never), on: (ev: string, cb: (...a: any[]) => void) => child.on(ev, cb), kill: () => child.kill() };
};

const brain = new Brain({ dataDir, modelsDir, fork: spawn as never, forkLlm: spawn as never, fetch: (url, init) => fetch(url, init), mac: pickMac(), version: '1.0.0', port });
const { port: bound } = await serveBrain(brain, { port, uiDir: path.join(here, '../renderer') });
brain.start();
const k = brain.store.get('meta').token;
console.log(`Jarvis is up: http://localhost:${bound}/?k=${k}`);
for (const ip of lanAddresses()) console.log(`  on your network: http://${ip}:${bound}/?k=${k}`);
const bye = () => (brain.stop(), process.exit(0));
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
