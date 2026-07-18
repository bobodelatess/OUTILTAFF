import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CADENCE est une appli web personnelle, 100 % côté client.
// base relative ('./') : les assets se résolvent quel que soit le sous-chemin,
// y compris sur GitHub Pages (https://<user>.github.io/<repo>/). Pas de routeur,
// donc rien d'autre à configurer.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}', 'scripts/**/*.test.js'],
  },
});
