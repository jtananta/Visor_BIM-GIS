import { useEffect, useState } from 'react';
import type { Componente, Modelo } from './datos';
import ElegirComponente from './ElegirComponente';
import { guardarConexion, leerConexion } from './admin/github';
import { moverModelos } from './admin/modelos';
import { ubicacionDe } from './admin/catalogo';

interface Props {
  modelo: Modelo;
  componentes: Componente[];
  cerrar: () => void;
  /** Cambia la ubicación del modelo en este navegador en cuanto se publica el cambio. */
  alMover: (codigo: string, ubicacion: Pick<Modelo, 'sector' | 'paquete' | 'componente' | 'componente_desc'>) => void;
}

/** Mueve un IFC publicado a otro componente, paquete o sector, con la clave de publicación. */
export default function MoverModelo({ modelo, componentes, cerrar, alMover }: Props) {
  const [destino, setDestino] = useState('');
  const [clave, setClave] = useState(() => leerConexion().clave);
  const [ocupado, setOcupado] = useState('');
  const [error, setError] = useState('');
  const elegido = componentes.find((c) => c.componente === destino);
  const listo = Boolean(elegido) && destino !== modelo.componente && Boolean(clave) && !ocupado;

  useEffect(() => {
    const cerrarConEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ocupado) cerrar(); };
    window.addEventListener('keydown', cerrarConEsc);
    return () => window.removeEventListener('keydown', cerrarConEsc);
  }, [cerrar, ocupado]);

  const mover = async () => {
    if (!listo || !elegido) return;
    setError(''); setOcupado('Moviendo…');
    try {
      await moverModelos({ clave }, [modelo.codigo], destino, componentes, setOcupado);
      guardarConexion({ clave }, true);
      alMover(modelo.codigo, ubicacionDe(elegido));
      cerrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOcupado('');
    }
  };

  return (
    <div className="modal-fondo" onClick={(e) => { if (e.target === e.currentTarget && !ocupado) cerrar(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="mover-titulo">
        <div className="ficha-cab">
          <h2 id="mover-titulo">Mover IFC</h2>
          <button className="btn-icono" onClick={cerrar} disabled={Boolean(ocupado)} aria-label="Cerrar">✕</button>
        </div>
        <p><strong>{modelo.modelo}</strong> ({modelo.estructuras} estructuras)</p>
        {modelo.modelo !== modelo.codigo && <p className="sutil">{modelo.codigo}</p>}
        <p className="sutil">Ahora está en {modelo.sector} · {modelo.paquete} · {modelo.componente}{modelo.componente_desc ? ` (${modelo.componente_desc})` : ''}.</p>
        <label className="campo"><span>Mover a</span>
          <ElegirComponente componentes={componentes} valor={destino} cambiar={setDestino} desactivado={Boolean(ocupado)} /></label>
        {elegido && destino !== modelo.componente && (
          <p className="sutil">Quedará en {elegido.sector} · {elegido.paquete} · {elegido.componente} ({elegido.descripcion}). No hace falta volver a subir el IFC.</p>
        )}
        {destino === modelo.componente && <p className="sutil">El IFC ya está en ese componente.</p>}
        <label className="campo"><span>Clave de publicación</span>
          <input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter') void mover(); }} /></label>
        <button className="btn btn-primario ancho" onClick={mover} disabled={!listo}>Mover para todos</button>
        {ocupado && <div className="aviso-admin info" role="status">{ocupado}</div>}
        {error && <div className="aviso-admin error" role="status">{error}</div>}
      </section>
    </div>
  );
}
