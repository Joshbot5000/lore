import { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, net, powerSaveBlocker, session, shell, systemPreferences, utilityProcess, ipcMain } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../brain/brain';
import { serveBrain } from '../brain/server';
import { pickMac } from '../brain/mac';

const dataDir = process.env.JARVIS_DATA_DIR || path.join(app.getPath('userData'), 'data');
const modelsDir = process.env.JARVIS_MODELS_DIR || path.join(app.getPath('userData'), 'models');
const logFile = path.join(app.getPath('userData'), 'engines.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

const log = (name: string) => (d: Buffer) => {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.rmSync(logFile);
    fs.appendFileSync(logFile, `[${name}] ${d}`);
  } catch {
    /* logging must never break the app */
  }
  if (process.env.JARVIS_DEBUG) process.stderr.write(`[${name}] ${d}`);
};

const fork = (script: string, name: string) => {
  const child = utilityProcess.fork(path.join(__dirname, script), [], { serviceName: `Jarvis ${name}`, stdio: 'pipe' });
  child.stdout?.on('data', log(name));
  child.stderr?.on('data', log(name));
  return child;
};

/**
 * The language model prefers a plain Node.js runtime when one is installed: Electron swaps in a
 * memory allocator that refuses the very large allocations some llama.cpp code paths make.
 */
function findNode(): string | null {
  const home = os.homedir();
  const hint = path.join(process.resourcesPath ?? '', 'node-path.txt');
  const nvm = path.join(home, '.nvm/versions/node');
  const candidates = [
    process.env.JARVIS_NODE,
    fs.existsSync(hint) ? fs.readFileSync(hint, 'utf8').trim() : undefined,
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'node')),
    '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', path.join(home, '.volta/bin/node'),
    ...(fs.existsSync(nvm) ? fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, 'bin/node')) : []),
  ];
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-v'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && parseInt(r.stdout.replace('v', ''), 10) >= 20) return c;
  }
  return null;
}
let nodeBin: string | null | undefined;
const forkLlm = (script: string, name: string) => {
  if (nodeBin === undefined) nodeBin = findNode();
  if (!nodeBin) return fork(script, name);
  const child = spawn(nodeBin, [path.join(__dirname, script)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout?.on('data', log(name));
  child.stderr?.on('data', log(name));
  child.on('error', () => undefined);
  return { postMessage: (m: unknown) => child.connected && child.send(m as never), on: (ev: string, cb: (...a: any[]) => void) => child.on(ev, cb), kill: () => child.kill() };
};

let win: BrowserWindow | null = null;
let url = '';

function createWindow(): void {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 420, minHeight: 640, show: false, backgroundColor: '#05070b', title: 'Jarvis',
    titleBarStyle: mac ? 'hiddenInset' : 'default', trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) void shell.openExternal(u);
    return { action: 'deny' };
  });
  win.on('closed', () => ((win = null), (loaded = false)));
  win.webContents.on('did-finish-load', () => (loaded = true));
  void win.loadURL(url);
}

let tray: Tray | null = null;
let loaded = false;

/** Bring the window forward (opening it if it was closed), then start listening. */
function summon(brain: Brain): void {
  if (!win) {
    loaded = false;
    createWindow();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (loaded) brain.summon();
  else win?.webContents.once('did-finish-load', () => setTimeout(() => brain.summon(), 900));
}

let hotkey = '';
function setHotkey(brain: Brain, accel: string): void {
  if (accel === hotkey) return;
  if (hotkey) globalShortcut.unregister(hotkey);
  hotkey = '';
  if (!accel) return;
  try {
    if (globalShortcut.register(accel, () => summon(brain))) hotkey = accel;
  } catch {
    /* not a valid key combination: leave the shortcut off */
  }
}

/** A menu-bar icon, so Jarvis is one click away even with the window closed. */
function makeTray(brain: Brain): void {
  try {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png')).resize({ width: 18, height: 18 });
    tray = new Tray(icon);
    tray.setToolTip('Jarvis');
    const say = (text: string) => () => void brain.say(text, { device: 'mac' });
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Talk to Jarvis', click: () => summon(brain) },
        { label: 'Open dashboard', click: () => (win ? (win.show(), win.focus()) : createWindow()) },
        { type: 'separator' },
        { label: 'Briefing', click: say('Briefing') },
        { label: 'Evening review', click: say('Evening review') },
        { label: 'Focus for 25 minutes', click: say('Start a focus session for 25 minutes') },
        { label: 'Focus for 50 minutes', click: say('Start a focus session for 50 minutes') },
        { type: 'separator' },
        { label: 'Quit Jarvis', click: () => app.quit() },
      ]),
    );
  } catch {
    /* no menu bar on this system */
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) (win.isMinimized() && win.restore(), win.focus());
    else if (url) createWindow();
  });
  void app.whenReady().then(async () => {
    const brain = new Brain({
      dataDir, modelsDir, fork: fork as never, forkLlm: forkLlm as never, fetch: (u, init) => net.fetch(u, init as never), mac: pickMac(), version: app.getVersion(),
      port: Number(process.env.JARVIS_PORT || 7717),
      notify: (title, body) => Notification.isSupported() && new Notification({ title, body, silent: true }).show(),
    });
    const uiDir = path.join(__dirname, '../renderer');
    // If the usual port is taken (another copy, another app), take any free one.
    const served = await serveBrain(brain, { port: Number(process.env.JARVIS_PORT || 7717), uiDir }).catch(() => serveBrain(brain, { port: 0, uiDir }));
    url = process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/?k=${brain.store.get('meta').token}&port=${served.port}` : `http://127.0.0.1:${served.port}/?k=${brain.store.get('meta').token}`;
    brain.start();
    // Keep answering the phone while the window is closed or in the background.
    powerSaveBlocker.start('prevent-app-suspension');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'clipboard-sanitized-write', 'notifications'].includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'clipboard-sanitized-write', 'notifications'].includes(permission));
    ipcMain.handle('mic', async () => (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted' ? true : systemPreferences.askForMediaAccess('microphone')));
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { role: 'editMenu' as const },
        { label: 'View', submenu: [{ role: 'togglefullscreen' as const }, { role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const }, { role: 'reload' as const }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }])] },
        { role: 'windowMenu' as const },
      ]),
    );
    createWindow();
    makeTray(brain);
    setHotkey(brain, brain.settings.hotkey);
    brain.on('push', (p: { type: string; data?: { settings?: { hotkey: string } } }) => {
      if (p.type === 'patch' && p.data?.settings) setHotkey(brain, p.data.settings.hotkey);
    });
    app.on('will-quit', () => globalShortcut.unregisterAll());
    app.on('activate', () => !BrowserWindow.getAllWindows().length && createWindow());
    app.on('before-quit', () => brain.stop());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
