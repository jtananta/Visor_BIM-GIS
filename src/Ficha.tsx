import { COLOR_ESTADO, estadoDe, type Datos, type Estructura } from './datos';

interface Props {
  estructura: Estructura;
  datos: Datos;
  cerrar: () => void;
  enfocar: () => void;
}

/** Solo información general: nada de GlobalId, Psets ni atributos IFC. */
export default function Ficha({ estructura: e, datos, cerrar, enfocar }: Props) {
  const est = estadoDe(datos, e.componente);
  const color = COLOR_ESTADO[est.estado] ?? COLOR_ESTADO['Sin asignar'];
  return (
    <div className="ficha" role="dialog" aria-label={`Información de ${e.nombre}`}>
      <div className="ficha-cab">
        <h3>{e.nombre}</h3>
        <button className="btn-icono" onClick={cerrar} aria-label="Cerrar">✕</button>
      </div>
      <dl>
        <dt>Componente</dt>
        <dd>{e.componente_desc || e.componente}<span className="observacion">{e.componente} · modelo {e.modelo}</span></dd>
        <dt>Sector / paquete</dt>
        <dd>{e.sector} · {e.paquete}</dd>
        <dt>Tipo de estructura</dt>
        <dd>{e.tipo_estructura}</dd>
        <dt>Estado de coordinación</dt>
        <dd>
          <span className="chip" style={{ borderColor: color, color }}>
            <span className="chip-punto" style={{ background: color }} />
            {est.estado}
          </span>
          {est.observaciones && <span className="observacion">{est.observaciones}</span>}
        </dd>
      </dl>
      <button className="btn btn-primario" onClick={enfocar}>Enfocar componente</button>
    </div>
  );
}
