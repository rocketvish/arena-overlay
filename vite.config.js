import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * Production builds drop the dev-server origins from the CSP and lock down
 * the rest (no plugins, no <base> rewrites, no form posts).
 */
function productionCsp() {
  return {
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/(http-equiv="Content-Security-Policy"\s+content=")([^"]*)"/, (_, pre, csp) => {
        const tightened = csp
          .replace(/\s*(https?|wss?):\/\/localhost:\d+/g, '')
          .trim()
          .replace(/;?$/, "; object-src 'none'; base-uri 'none'; form-action 'none';");
        return `${pre}${tightened}"`;
      });
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), productionCsp()],
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        control: resolve(__dirname, 'src/renderer/control/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
