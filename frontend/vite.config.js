import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allowedHosts, backendPort, bindHost, frontendPort } from '../network.config.mjs';

const proxy = {
  '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
  '/health': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: bindHost, port: frontendPort, strictPort: true,
    allowedHosts: allowedHosts(), proxy,
  },
  preview: { host: bindHost, port: frontendPort, strictPort: true, allowedHosts: allowedHosts(), proxy },
});
