import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jarvisDesktop', { mic: () => ipcRenderer.invoke('mic') as Promise<boolean>, platform: process.platform });
