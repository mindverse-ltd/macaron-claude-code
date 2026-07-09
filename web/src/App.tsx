import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { NotifyStack } from './components/NotifyStack';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsHelp } from './components/ShortcutsHelp';

export function App() {
  return (
    <>
      <Sidebar />
      <main id="main">
        <Outlet />
      </main>
      <Toast />
      <NotifyStack />
      <CommandPalette />
      <ShortcutsHelp />
    </>
  );
}
