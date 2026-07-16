import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { NotifyStack } from './components/NotifyStack';
import { CommandPalette } from './components/CommandPalette';
import { SearchPalette } from './components/SearchPalette';
import { ShortcutsHelp } from './components/ShortcutsHelp';

export function App() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  // Tapping a workspace/session in the drawer navigates; close it on every route change.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  return (
    <>
      <button className="mobile-nav-toggle" aria-label="Toggle navigation" onClick={() => setNavOpen((v) => !v)}>
        <Menu size={20} aria-hidden="true" />
      </button>
      <div className={`sb-drawer${navOpen ? ' open' : ''}`}>
        <Sidebar />
      </div>
      {navOpen && <div className="sb-backdrop" onClick={() => setNavOpen(false)} />}
      <main id="main">
        <Outlet />
      </main>
      <Toast />
      <NotifyStack />
      <CommandPalette />
      <SearchPalette />
      <ShortcutsHelp />
    </>
  );
}
