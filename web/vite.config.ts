import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Split by how often a thing CHANGES, not only by size. React and the phone-number library are the same bytes release
    // after release, so giving them their own chunks means a returning family re-downloads only the app code that actually
    // changed. On a weak connection that is the difference that shows.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
            { name: 'phone', test: /node_modules\/libphonenumber-js\// },
          ],
        },
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
