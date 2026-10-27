import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// La administración (conversión de IFC, publicación) solo se descarga al abrir #admin.
const Admin = lazy(() => import('./admin/Admin'));

function Raiz() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return hash === '#admin' ? (
    <Suspense fallback={<div className="pantalla-mensaje">Cargando la administración…</div>}><Admin /></Suspense>
  ) : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Raiz />
  </StrictMode>,
);
