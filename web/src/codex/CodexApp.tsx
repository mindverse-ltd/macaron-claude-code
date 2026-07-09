import { Outlet } from 'react-router-dom';
import { CodexSidebar } from './CodexSidebar';
import { NotifyStack } from '../components/NotifyStack';

export function CodexApp() {
  return (
    <div className="cx-app">
      <CodexSidebar />
      <main className="cx-view"><Outlet /></main>
      <NotifyStack />
    </div>
  );
}
