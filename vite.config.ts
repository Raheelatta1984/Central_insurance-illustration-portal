import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { outDir: '../../dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
});
