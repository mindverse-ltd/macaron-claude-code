import React from 'react';
import * as ReactNamespace from 'react';
import * as JSXRuntime from 'react/jsx-runtime';
import * as JSXDevRuntime from 'react/jsx-dev-runtime';
import * as ReactDOMNamespace from 'react-dom';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';

// --- Vendored Macaron GenUI runtime ---
// SWAP NOTE: when @macaron/ui ships on npm, replace these imports with:
//   import * as MacaronUI from '@macaron/ui';
//   import * as MacaronCharts from '@macaron/ui/charts';
// and delete the macaron-vendor/ directory. See web/src/macaron-vendor/README.md.
import * as MacaronUI from './macaron-vendor/macaron/source';
import * as MacaronCharts from './macaron-vendor/genui/charts';
import * as MacaronLucide from './macaron-vendor/genui/lucide-react';
import * as Motion from 'motion/react';

// CSS variables that source.tsx + components/ui depend on
import './macaron-vendor/base.css';

// $macaron/ui primitives assume a Tailwind element reset (button/input/list normalize);
// without it native <button> UA borders leak through the GenUI preview (e.g. Tabs triggers).
// Imported before styles.css so the app's hand-written paper theme wins on conflicts.
import '@unocss/reset/tailwind.css';

// UnoCSS runtime — generates utility classes from DOM (matches macaron's uno.config.ts)
import initUnocssRuntime from '@unocss/runtime';
import presetWind3 from '@unocss/preset-wind3';
import presetAnimations from 'unocss-preset-animations';
import { unoTheme, unoShortcuts, unoRules } from './macaron-vendor/lib/standalone-uno';

import { App } from './App';
import { Dashboard } from './views/Dashboard';
import { Workspace } from './views/Workspace';
import { FileExplorer } from './views/FileExplorer';
import { Settings } from './views/Settings';
import { ShareView } from './views/ShareView';
import { Mcp } from './views/Mcp';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/Confirm';
import { AuthGate } from './components/AuthGate';
import { consumeTokenFromUrl } from './lib/auth';
import { preloadRendererRuntime } from './macaron-vendor/StaticGenUIRenderer';
import { registerServiceWorker } from './lib/pwa';
import './styles.css';

// Pick up a ?token=... bootstrap from a shared link before anything fetches.
consumeTokenFromUrl();

// Boot UnoCSS runtime: scans the DOM for utility classes and injects CSS as
// elements appear. Required because the GenUI preview renders model-generated
// className strings at runtime that don't exist at build time.
initUnocssRuntime({
  defaults: {
    presets: [presetWind3({ dark: 'class' }), presetAnimations()],
    theme: unoTheme,
    shortcuts: unoShortcuts,
    rules: unoRules,
  },
});

// Expose to the GenUI sandbox importmap so user TSX, our shims, and partial-react
// all share ONE instance of React + the real Macaron UI library.
(globalThis as any).__macaron_React = ReactNamespace;
(globalThis as any).__macaron_JSXRuntime = JSXRuntime;
(globalThis as any).__macaron_JSXDevRuntime = JSXDevRuntime;
(globalThis as any).__macaron_ReactDOM = ReactDOMNamespace;
(globalThis as any).__macaron_UI = MacaronUI;
(globalThis as any).__macaron_Charts = MacaronCharts;
(globalThis as any).__macaron_Lucide = MacaronLucide;
(globalThis as any).__macaron_Motion = Motion;

// eslint-disable-next-line no-console
console.log('[macaron] globals ready', {
  UI: Object.keys(MacaronUI).filter((k) => /^[A-Z]/.test(k)).length + ' components',
  Charts: Object.keys(MacaronCharts).filter((k) => /^[A-Z]/.test(k)).length + ' chart parts',
  Motion: Object.keys(Motion).length + ' motion exports',
  React: 'v' + (React as any).version,
});

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'settings', element: <Settings /> },
      { path: 'mcp', element: <Mcp /> },
      { path: 'w/:project', element: <Workspace /> },
      { path: 'w/:project/files', element: <FileExplorer /> },
      { path: 'w/:project/s/:sid', element: <Workspace /> },
    ],
  },
  // Public read-only share viewer — a sibling of <App> so it renders WITHOUT
  // the sidebar/composer chrome. Reuses the same GenUI boot below.
  { path: 'share/:token', element: <ShareView /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </AuthGate>
  </React.StrictMode>,
);

// Register the push service worker (best-effort; no-ops on insecure origins).
registerServiceWorker();

// Warm up the GenUI renderer runtime (TSX wasm + compiler) on idle so the
// first render_ui call doesn't pay the ~400-500ms init cost inside the
// streaming render loop. requestIdleCallback keeps it off the critical path
// of the initial paint; if the browser is busy, the warm-up defers until a
// quiet moment, but still completes well before the user sends a prompt.
if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(() => void preloadRendererRuntime().catch(() => { /* warm-up is best-effort */ }), { timeout: 2000 });
} else {
  void preloadRendererRuntime().catch(() => { /* warm-up is best-effort */ });
}
