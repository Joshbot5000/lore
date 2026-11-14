import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';
import { connect, restoreCache } from './link';
import { initVoice } from './voice';

restoreCache();
initVoice();
connect();
createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator && location.protocol === 'https:') void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
