import { defineConfig } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  resolve: {
    alias: {
      // Used by the vendored Macaron source (source.tsx, components/ui/*).
      // Points to /web/src/macaron-vendor — swap to the published npm package
      // (likely `@macaron/ui`) when Mindverse releases one and delete the vendor dir.
      '@': path.resolve(__dirname, 'src/macaron-vendor'),
    },
  },
  plugins: [
    react({
      // Process .tsx from node_modules too (partial-react ships raw TSX).
      include: /\.(jsx|tsx|mjs)$/,
    }),
  ],
  optimizeDeps: {
    // Pre-bundle partial-react and its TSX source via esbuild so Vite serves them
    // as plain JS to the browser. Without this Vite balks on the .tsx in deps.
    include: [
      'partial-react',
      'partial-react/compiler',
      'partial-react/import-map',
      'partial-react/render-context',
      'partial-tsx',
      '@esm.sh/tsx',
      'react-dom/server',
    ],
    esbuildOptions: {
      loader: { '.ts': 'tsx', '.tsx': 'tsx' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    commonjsOptions: { transformMixedEsModules: true },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7878', changeOrigin: true },
      '/mindlab-symbol.svg': { target: 'http://127.0.0.1:7878', changeOrigin: true },
    },
  },
});
