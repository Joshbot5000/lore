import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/app/index.ts'),
          headless: resolve(__dirname, 'src/app/headless.ts'),
          speech: resolve(__dirname, 'src/workers/speech.ts'),
          tts: resolve(__dirname, 'src/workers/tts.ts'),
          llm: resolve(__dirname, 'src/workers/llm.ts'),
        },
      },
    },
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/ui'),
    plugins: [react()],
    build: { target: 'es2022', rollupOptions: { input: resolve(__dirname, 'src/ui/index.html') } },
  },
});
