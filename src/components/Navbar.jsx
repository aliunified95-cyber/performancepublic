import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { useAuth } from '../App';

export default function Navbar({ activeLink }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [dataSource, setDataSource] = useState('demo');

  useEffect(() => {
    const src = localStorage.getItem('tpw_data_source') || 'demo';
    setDataSource(src);
  }, []);

  async function handleSignOut() {
    try {
      await signOut(auth);
      navigate('/login');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  }

  const initials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : 'AM';

  return (
    <nav className="nav">
      <button
        className="nav-logo"
        onClick={() => navigate('/dashboard')}
        aria-label="Go to dashboard"
      >
        <div className="nav-logo-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="12" width="4" height="9" rx="1"/>
            <rect x="10" y="7" width="4" height="14" rx="1"/>
            <rect x="17" y="3" width="4" height="18" rx="1"/>
          </svg>
        </div>
        <span className="nav-logo-text">Team Performance</span>
      </button>

      <div className="nav-links">
        <Link
          to="/dashboard"
          className={`nav-link${activeLink === 'dashboard' ? ' active' : ''}`}
        >
          Dashboard
        </Link>
        <Link
          to="/performance"
          className={`nav-link${activeLink === 'performance' ? ' active' : ''}`}
        >
          Sales
        </Link>
        <Link
          to="/logistics"
          className={`nav-link${activeLink === 'logistics' ? ' active' : ''}`}
        >
          Logistics
        </Link>
        <Link
          to="/activation"
          className={`nav-link${activeLink === 'activation' ? ' active' : ''}`}
        >
          Activation
        </Link>
        <Link
          to="/admin"
          className={`nav-link${activeLink === 'admin' ? ' active' : ''}`}
        >
          Admin
        </Link>
      </div>

      <div className="nav-right">
        <span className={`data-source-pill ${dataSource === 'live' ? 'pill-live' : 'pill-demo'}`}>
          {dataSource === 'live' ? 'Live Data' : 'Demo Data'}
        </span>

        <div className="nav-avatar" title={user?.email || 'User'}>
          {initials}
        </div>

        <button
          className="signout-btn"
          onClick={handleSignOut}
          title="Sign out"
          aria-label="Sign out"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Sign out
        </button>
      </div>
    </nav>
  );
}
