import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Rutas relativas: el build funciona igual en Vercel, en un Artifact o abierto desde una subcarpeta.
  base: './',
  // georaster/geotiff se publican como CommonJS y esperan `global` (igual que en el visor técnico).
  define: {
    global: 'globalThis',
    // Cada publicación es un commit y Vercel vuelve a compilar: la hora de compilación es la de la última publicación.
    __PUBLICADO__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
});
