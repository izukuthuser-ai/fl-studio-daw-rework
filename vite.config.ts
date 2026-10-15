import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120', sourcemap: false },
  server: { port: 5173, strictPort: true },
});
