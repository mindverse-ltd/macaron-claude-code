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
import './styles.css';

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
    <RouterProvider router={router} />
  </React.StrictMode>,
);
