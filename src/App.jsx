import React, { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import Login from './pages/Login';
import Admin from './pages/Admin';
import AgentsPerformance from './pages/AgentsPerformance';
import ActivationPerformance from './pages/ActivationPerformance';
import LogisticsPerformance from './pages/LogisticsPerformance';
import DeliveryPerformance from './pages/DeliveryPerformance';
import Dashboard from './pages/Dashboard';

export const AuthContext = createContext({ user: undefined });

export function useAuth() {
  return useContext(AuthContext);
}

function ProtectedRoute({ children }) {
  const { user } = useAuth();

  if (user === undefined) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#1B3A2D',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '16px',
      }}>
        <div className="spinner-lg" />
        <p style={{ color: 'rgba(216,245,236,0.5)', fontSize: '14px' }}>Loading…</p>
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function AuthRedirect() {
  const { user } = useAuth();
  if (user === undefined) return null;
  if (user) return <Navigate to="/dashboard" replace />;
  return <Navigate to="/login" replace />;
}

export default function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u ?? null);
    });
    return unsub;
  }, []);

  return (
    <AuthContext.Provider value={{ user }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/performance"
            element={
              <ProtectedRoute>
                <AgentsPerformance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/activation"
            element={
              <ProtectedRoute>
                <ActivationPerformance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/logistics"
            element={
              <ProtectedRoute>
                <LogisticsPerformance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/delivery"
            element={
              <ProtectedRoute>
                <DeliveryPerformance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <Admin />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<AuthRedirect />} />
        </Routes>
        <div style={{
          position: 'fixed',
          bottom: '8px',
          right: '12px',
          fontSize: '11px',
          color: 'rgba(255,255,255,0.25)',
          fontFamily: 'monospace',
          pointerEvents: 'none',
          zIndex: 9999,
          userSelect: 'none',
        }}>
          {__BUILD_DATE__} · {__COMMIT__}
        </div>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
