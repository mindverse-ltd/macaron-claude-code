import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { useMacaronConfig } from './lib/configStore';

export function App() {
  const cfg = useMacaronConfig();
  const showBanner = cfg && !cfg.configured;
  return (
    <>
      <Sidebar />
      <main id="main">
        {showBanner && (
          <div className="cfg-banner">
            <strong>Macaron API not configured.</strong> Claude features work
            as-is. To enable GenUI Builder and the Macaron-0.6 model, set{' '}
            <code>MACARON_API_BASE</code> and <code>MACARON_API_KEY</code>{' '}
            in the plugin's <code>.env</code> (see{' '}
            <code>.env.example</code>) and restart the server.
          </div>
        )}
        <Outlet />
      </main>
      <Toast />
    </>
  );
}
