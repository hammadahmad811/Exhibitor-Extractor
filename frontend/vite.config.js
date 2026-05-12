import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Include all three HTML entry points so history.html and intelligence.html
    // are copied into frontend/dist/ and served correctly in production.
    rollupOptions: {
      input: {
        main:         resolve(__dirname, 'index.html'),
        history:      resolve(__dirname, 'history.html'),
        intelligence: resolve(__dirname, 'intelligence.html'),
      },
    },
  },
});
