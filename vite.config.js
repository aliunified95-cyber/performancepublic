import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
const buildDate  = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: {
    __COMMIT__:     JSON.stringify(commitHash),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'firebase-app':       ['firebase/app'],
          'firebase-auth':      ['firebase/auth'],
          'firebase-firestore': ['firebase/firestore'],
          'firebase-analytics': ['firebase/analytics'],
          'react-vendor':       ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
