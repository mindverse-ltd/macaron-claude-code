// Codex WebUI entry. Separate from the claude entry so it doesn't pull in
// the GenUI runtime, macaron-vendor, UnoCSS, etc. This bundle stays small
// and focused on chat.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { CodexApp } from './CodexApp';
import { CodexChat } from './CodexChat';
import { CodexSettings } from './CodexSettings';
import { CodexWorkspace } from './CodexWorkspace';
import { AuthGate } from '../components/AuthGate';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/Confirm';
import { clearToken, consumeTokenFromUrl } from '../lib/auth';
import { consumeServerFromUrl } from '../lib/apiBase';
import { registerServiceWorker } from '../lib/pwa';
import './styles.css';
import '../chat-code.css';

// Pick up a ?server=... then ?token=... bootstrap from a shared link before
// anything fetches. clearToken lets a server switch drop a stale credential.
consumeServerFromUrl(clearToken);
consumeTokenFromUrl();

const router = createHashRouter([
  {
    path: '/',
    element: <CodexApp />,
    children: [
      { index: true, element: <CodexChat /> },
      { path: 't/:sid', element: <CodexChat /> },
      { path: 'w/:project', element: <CodexWorkspace /> },
      { path: 'w/:project/t/:sid', element: <CodexWorkspace /> },
      { path: 'settings', element: <CodexSettings /> },
    ],
  },
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

registerServiceWorker();
