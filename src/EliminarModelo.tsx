import { useState } from 'react';
import type { Modelo } from './datos';
import { guardarConexion, leerConexion } from './admin/github';
import { eliminarModelos } from './admin/modelos';

interface Props {
  modelo: Modelo;
  cerrar: () => void;
  /** Quita el modelo de este navegador en cuanto se publica el borrado. */
  alEliminar: (codigo: string) => void;
}

/** Confirmación para eliminar un IFC publicado, con la clave de publicación. */
export default function EliminarModelo({ modelo, cerrar, alEliminar }: Props) {
  const [clave, setClave] = useState(() => leerConexion().clave);
  const [ocupado, setOcupado] = useState('');
  const [error, setError] = useState('');

  const eliminar = async () => {
    setError(''); setOcupado('Eliminando…');
    try {
      await eliminarModelos({ clave }, [modelo.codigo], setOcupado);
      guardarConexion({ clave }, true);
      alEliminar(modelo.codigo);
      cerrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOcupado('');
    }
  };

  return (
    <div className="modal-fondo" onClick={(e) => { if (e.target === e.currentTarget && !ocupado) cerrar(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="eliminar-titulo">
        <div className="ficha-cab">
          <h2 id="eliminar-titulo">Eliminar IFC</h2>
          <button className="btn-icono" onClick={cerrar} disabled={Boolean(ocupado)} aria-label="Cerrar">✕</button>
        </div>
        <p>Se quitará <strong>{modelo.modelo}</strong> del visor para todos ({modelo.estructuras} estructuras de {modelo.componente}, {modelo.paquete}).</p>
        {modelo.modelo !== modelo.codigo && <p className="sutil">{modelo.codigo}</p>}
        <p className="sutil">Si fue un error, puedes volver a subir el IFC con «Subir IFC».</p>
        <label className="campo"><span>Clave de publicación</span>
          <input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter' && clave && !ocupado) void eliminar(); }} /></label>
        <button className="btn btn-peligro ancho" onClick={eliminar} disabled={Boolean(ocupado) || !clave}>Eliminar para todos</button>
        {ocupado && <div className="aviso-admin info" role="status">{ocupado}</div>}
        {error && <div className="aviso-admin error" role="status">{error}</div>}
      </section>
    </div>
  );
}
