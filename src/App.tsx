import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cargarDatos, compararNatural, unirCajas, type Caja, type Datos, type Estructura, type ModoColor } from './datos';
import Panel from './Panel';
import Ficha from './Ficha';
import Leyenda from './Leyenda';
import PlanoGeneral from './PlanoGeneral';

// three.js solo se descarga cuando alguien abre la vista 3D.
const Vista3D = lazy(() => import('./Vista3D'));

type Vista = 'plano' | '3d';

/** Pedido de encuadre: el número cambia en cada pedido para que la vista lo atienda aunque la caja se repita. */
export interface Encuadre {
  caja: Caja;
  n: number;
}

/** Sector o paquete enfocado: el resto se atenúa sin ocultarse. */
export interface Foco {
  campo: 'sector' | 'paquete' | 'componente';
  valor: string;
}

export function fueraDeFoco(foco: Foco | null, e: Pick<Estructura, 'sector' | 'paquete' | 'componente'>): boolean {
  return foco !== null && e[foco.campo] !== foco.valor;
}

export interface EstadoVisor {
  datos: Datos;
  sectores: string[];
  paquetes: string[];
  ocultos: Set<string>;
  foco: Foco | null;
  modoColor: ModoColor;
  seleccion: Estructura | null;
  encuadre: Encuadre | null;
  seleccionar: (e: Estructura | null) => void;
  /** Las vistas avisan lo que muestran para conservar el encuadre al cambiar de vista. */
  reportarEncuadre: (c: Caja) => void;
}

export default function App() {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista>('plano');
  const [ocultos, setOcultos] = useState<Set<string>>(new Set());
  const [foco, setFoco] = useState<Foco | null>(null);
  const [modoColor, setModoColor] = useState<ModoColor>('sector');
  const [seleccion, setSeleccion] = useState<Estructura | null>(null);
  const [encuadre, setEncuadre] = useState<Encuadre | null>(null);
  const [panelAbierto, setPanelAbierto] = useState(() => window.innerWidth > 760);
  const ultimoEncuadre = useRef<Caja | null>(null);

  useEffect(() => {
    cargarDatos().then(setDatos).catch((e) => setError(`No se pudieron leer los datos del proyecto (${e.message}).`));
  }, []);

  // Sectores y paquetes salen del catálogo completo, así el panel muestra también lo que aún no tiene modelo.
  const sectores = useMemo(() => {
    if (!datos) return [];
    const s = new Set([...datos.componentes.map((c) => c.sector), ...datos.manifest.modelos.map((m) => m.sector)]);
    return [...s].sort(compararNatural);
  }, [datos]);
  const paquetes = useMemo(() => {
    if (!datos) return [];
    const s = new Set([...datos.componentes.map((c) => c.paquete), ...datos.manifest.modelos.map((m) => m.paquete)]);
    return [...s].sort(compararNatural);
  }, [datos]);

  const cajaTotal = useMemo(() => (datos ? unirCajas(datos.manifest.modelos.map((m) => m.bbox_utm)) : null), [datos]);

  const encuadrar = useCallback((caja: Caja | null) => {
    if (caja) setEncuadre((prev) => ({ caja, n: (prev?.n ?? 0) + 1 }));
  }, []);

  const verTodo = () => {
    setFoco(null);
    setOcultos(new Set());
    encuadrar(cajaTotal);
  };

  /** Enfoca un sector, paquete o componente: lo muestra, atenúa el resto y encuadra sus modelos. */
  const enfocar = (f: Foco) => {
    if (!datos) return;
    const mods = datos.manifest.modelos.filter((m) => m[f.campo] === f.valor);
    if (!mods.length) return;
    setFoco(f);
    setOcultos((prev) => {
      const next = new Set(prev);
      mods.forEach((m) => next.delete(m.codigo));
      return next;
    });
    encuadrar(unirCajas(mods.map((m) => m.bbox_utm)));
  };

  const cambiarVista = (v: Vista) => {
    if (v === vista) return;
    encuadrar(ultimoEncuadre.current ?? cajaTotal);
    setVista(v);
  };

  const reportarEncuadre = useCallback((c: Caja) => { ultimoEncuadre.current = c; }, []);

  if (error) return <div className="pantalla-mensaje">{error}</div>;
  if (!datos) return <div className="pantalla-mensaje">Cargando el proyecto…</div>;

  const estado: EstadoVisor = {
    datos, sectores, paquetes, ocultos, foco, modoColor, seleccion,
    encuadre: encuadre ?? (cajaTotal ? { caja: cajaTotal, n: 0 } : null),
    seleccionar: setSeleccion, reportarEncuadre,
  };

  return (
    <div className="app">
      <header className="barra">
        <button className="btn-icono solo-movil" onClick={() => setPanelAbierto((x) => !x)} aria-label="Mostrar paquetes">☰</button>
        <div className="titulo">
          <span className="titulo-sup">Drenaje pluvial integral</span>
          <span className="titulo-main">{datos.manifest.proyecto}</span>
        </div>
        <div className="segmentado" role="tablist" aria-label="Vista">
          <button role="tab" aria-selected={vista === 'plano'} onClick={() => cambiarVista('plano')}>Plano general</button>
          <button role="tab" aria-selected={vista === '3d'} onClick={() => cambiarVista('3d')}>Vista 3D</button>
        </div>
        <label className="selector">
          <span>Color</span>
          <select value={modoColor} onChange={(e) => setModoColor(e.target.value as ModoColor)}>
            <option value="sector">Por sector</option>
            <option value="paquete">Por paquete</option>
            <option value="estado">Por estado</option>
            <option value="tipo">Por tipo</option>
          </select>
        </label>
        <button className="btn" onClick={verTodo}>Ver todo</button>
      </header>

      <div className="cuerpo">
        <Panel
          abierto={panelAbierto}
          cerrar={() => setPanelAbierto(false)}
          datos={datos}
          sectores={sectores}
          paquetes={paquetes}
          ocultos={ocultos}
          foco={foco}
          setOcultos={setOcultos}
          enfocar={enfocar}
          quitarFoco={() => setFoco(null)}
        />
        <main className="lienzo">
          {vista === 'plano' ? (
            <PlanoGeneral {...estado} />
          ) : (
            <Suspense fallback={<div className="cargando">Preparando la vista 3D…</div>}>
              <Vista3D {...estado} />
            </Suspense>
          )}
          <Leyenda modo={modoColor} datos={datos} sectores={sectores} paquetes={paquetes} />
          {seleccion && (
            <Ficha
              estructura={seleccion}
              datos={datos}
              cerrar={() => setSeleccion(null)}
              enfocar={() => enfocar({ campo: 'componente', valor: seleccion.componente })}
            />
          )}
        </main>
      </div>
    </div>
  );
}
