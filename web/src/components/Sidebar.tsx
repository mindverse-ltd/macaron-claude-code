import { useEffect, useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { api } from '../lib/api';

export function Sidebar() {
  const [status, setStatus] = useState<'connecting' | 'ok' | 'bad'>('connecting');
  const [model, setModel] = useState<string>('');

  useEffect(() => {
    api
      .health()
      .then((j) => {
        setStatus('ok');
        setModel(j.model);
      })
      .catch(() => setStatus('bad'));
  }, []);

  const port = window.location.port || '80';

  return (
    <aside className="sidebar">
      <Link className="brand" to="/">
        <img className="logo" src="/mindlab-symbol.svg" alt="Macaron" />
        <div>
          <div className="brand-name">Macaron</div>
          <div className="brand-sub">Claude Code plugin</div>
        </div>
      </Link>

      <nav className="nav">
        <NavLink to="/" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
          <span>Dashboard</span>
          <small>workspaces &amp; sessions</small>
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
          <span>Settings</span>
          <small>provider &amp; API key</small>
        </NavLink>
      </nav>

      <footer className="footer">
        <div className={'status ' + status}>{status === 'ok' ? `online · ${model}` : status === 'bad' ? 'offline' : 'connecting…'}</div>
        <div>port <code>{port}</code></div>
      </footer>
    </aside>
  );
}
