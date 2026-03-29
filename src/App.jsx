import React, { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import Login from './pages/Login';
import Admin from './pages/Admin';
import AgentsPerformance from './pages/AgentsPerformance';

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
  if (user) return <Navigate to="/performance" replace />;
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
            path="/performance"
            element={
              <ProtectedRoute>
                <AgentsPerformance />
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
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
