import { Outlet } from 'react-router-dom';
import { CodexSidebar } from './CodexSidebar';

export function CodexApp() {
  return (
    <div className="cx-app">
      <CodexSidebar />
      <main className="cx-view"><Outlet /></main>
    </div>
  );
}
