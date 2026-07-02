import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';

export function App() {
  return (
    <>
      <Sidebar />
      <main id="main">
        <Outlet />
      </main>
      <Toast />
    </>
  );
}
