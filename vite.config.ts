import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Rutas relativas: el portable de Windows carga dist/index.html
  // con file://, donde las rutas absolutas /assets/... no funcionan.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
