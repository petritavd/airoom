import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The web client imports the shared contract directly via `@shared`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    // Allow importing files from ../shared (outside the web root).
    fs: { allow: ['..'] },
  },
});
