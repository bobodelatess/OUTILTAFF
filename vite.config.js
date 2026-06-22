import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CADENCE est une appli web personnelle, 100 % côté client.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
});
