/** The door: serves the interface and a WebSocket to every paired device (this Mac's window, the phone). */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import QRCode from 'qrcode';
import type { Brain } from './brain';
import type { Push } from '../shared/types';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.wav': 'audio/wav',
};

export const lanAddresses = (): string[] =>
  Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

export function serveBrain(brain: Brain, opts: { port: number; uiDir: string; host?: string }): Promise<{ port: number; close: () => void }> {
  const token = brain.store.get('meta').token;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"app":"jarvis"}');
    if (url.pathname === '/manifest.webmanifest') {
      const file = path.join(opts.uiDir, 'manifest.webmanifest');
      if (!fs.existsSync(file)) return void res.writeHead(404).end();
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Carry the pairing key into the installed app (its storage is separate from the browser's on iOS).
      if (url.searchParams.get('k') === token) manifest.start_url = `./?k=${token}`;
      return void res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store' }).end(JSON.stringify(manifest));
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.join(opts.uiDir, rel);
    if (!file.startsWith(opts.uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) (rel = 'index.html'), (file = path.join(opts.uiDir, rel));
    if (!fs.existsSync(file)) return void res.writeHead(404).end('Interface not built');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': rel === 'index.html' || rel === 'sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || url.searchParams.get('k') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      const device = url.searchParams.get('d') ?? 'device';
      ws.send(JSON.stringify({ type: 'snapshot', data: brain.snapshot(lanAddresses()) }));
      ws.on('message', async (raw) => {
        let msg: { id?: number; method?: string; params?: any };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        const fn =
          msg.method === 'snapshot' ? () => brain.snapshot(lanAddresses())
          : msg.method === 'qr' ? (p: { url: string }) => QRCode.toDataURL(p.url, { margin: 1, width: 440, color: { dark: '#05070bff', light: '#ffffffff' } })
          : brain.actions[msg.method ?? ''];
        if (!fn) return void ws.send(JSON.stringify({ id: msg.id, error: `Unknown action ${msg.method}` }));
        try {
          const result = await fn({ ...(msg.params ?? {}), device });
          ws.send(JSON.stringify({ id: msg.id, result: result === undefined ? null : result }));
        } catch (err) {
          ws.send(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }));
        }
      });
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });

  brain.on('push', (p: Push) => {
    const data = JSON.stringify(p);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => (wss.close(), server.close()) });
    });
  });
}
