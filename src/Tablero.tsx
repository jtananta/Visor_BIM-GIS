import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { COLOR_ESTADO, compararNatural, type Componente, type Datos } from './datos';
import { urlTeselaEsri, zoomMaxEsri } from './esri';

declare const __PUBLICADO__: string;

/** Orden fijo de los estados del Excel de control: lo terminado primero, lo que no empezó al final. */
const ESTADOS = ['Completado', 'En proceso', 'Observado', 'Pendiente'] as const;
const colorEstado = (e: string) => COLOR_ESTADO[e] ?? COLOR_ESTADO['Sin asignar'];

interface Props {
  datos: Datos;
  sectores: string[];
  /** Abre el componente en la planta o en la vista 3D, enfocado. */
  verComponente: (componente: string, vista: 'plano' | '3d') => void;
}

/** % AVANCE del Excel como 0–100, venga como 0,35 o como 35. */
function avances(componentes: Componente[]): Map<string, number> {
  const crudo = componentes.map((c) => parseFloat(String(c.avance).replace('%', '').replace(',', '.')));
  const fraccion = crudo.every((v) => !Number.isFinite(v) || v <= 1);
  return new Map(componentes.map((c, i) => [c.componente, Number.isFinite(crudo[i]) ? Math.min(100, crudo[i] * (fraccion ? 100 : 1)) : 0]));
}

const promedio = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const pct = (v: number) => `${Math.round(v)} %`;

export default function Tablero({ datos, sectores, verComponente }: Props) {
  const [filtroSector, setFiltroSector] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [soloConModelo, setSoloConModelo] = useState(false);

  const comps = useMemo(() => [...datos.componentes].sort((a, b) =>
    compararNatural(a.sector, b.sector) || compararNatural(a.paquete, b.paquete) || compararNatural(a.componente, b.componente)), [datos.componentes]);
  const avance = useMemo(() => avances(datos.componentes), [datos.componentes]);
  const modelosDe = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const x of datos.manifest.modelos) m.set(x.componente, [...(m.get(x.componente) ?? []), x.modelo]);
    return m;
  }, [datos.manifest.modelos]);

  const conModelo = comps.filter((c) => modelosDe.has(c.componente)).length;
  const estados = useMemo(() => {
    const extra = [...new Set(comps.map((c) => c.estado || 'Sin asignar'))].filter((e) => !(ESTADOS as readonly string[]).includes(e));
    return [...ESTADOS, ...extra];
  }, [comps]);

  const porSector = sectores.map((s) => {
    const cs = comps.filter((c) => c.sector === s);
    return { sector: s, n: cs.length, avance: promedio(cs.map((c) => avance.get(c.componente) ?? 0)), conModelo: cs.filter((c) => modelosDe.has(c.componente)).length };
  }).filter((x) => x.n);

  const paquetes = [...new Set(comps.map((c) => `${c.sector}|${c.paquete}`))].map((k) => {
    const [sector, paquete] = k.split('|');
    const cs = comps.filter((c) => c.sector === sector && c.paquete === paquete);
    return {
      sector, paquete, n: cs.length,
      cuenta: estados.map((e) => [e, cs.filter((c) => (c.estado || 'Sin asignar') === e).length] as const).filter(([, n]) => n),
      conModelo: cs.filter((c) => modelosDe.has(c.componente)).length,
    };
  });
  const maxPaquete = Math.max(1, ...paquetes.map((p) => p.n));

  const filas = comps.filter((c) => (!filtroSector || c.sector === filtroSector)
    && (!filtroEstado || (c.estado || 'Sin asignar') === filtroEstado)
    && (!soloConModelo || modelosDe.has(c.componente)));

  const publicado = new Date(__PUBLICADO__);

  return (
    <div className="tablero">
      <section className="kpis" aria-label="Indicadores">
        <div className="kpi">
          <span className="kpi-titulo">Componentes</span>
          <span className="kpi-valor">{comps.length}</span>
          <span className="kpi-pie">{sectores.length} sectores · {paquetes.length} paquetes</span>
        </div>
        <div className="kpi">
          <span className="kpi-titulo">Con modelo BIM publicado</span>
          <span className="kpi-valor">{conModelo}<span className="kpi-de"> de {comps.length}</span></span>
          <span className="kpi-pie">{pct((conModelo / Math.max(1, comps.length)) * 100)} de los componentes</span>
        </div>
        <div className="kpi">
          <span className="kpi-titulo">Avance promedio</span>
          <span className="kpi-valor">{pct(promedio(comps.map((c) => avance.get(c.componente) ?? 0)))}</span>
          <span className="kpi-pie">según el Excel de control</span>
        </div>
        <div className="kpi">
          <span className="kpi-titulo">Última publicación</span>
          <span className="kpi-valor kpi-fecha">{publicado.toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <span className="kpi-pie">{publicado.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })} · modelos, catálogo o capas</span>
        </div>
      </section>

      <section className="tarjeta-t avance-sector">
        <h2>Avance por sector</h2>
        <p className="sutil">Promedio del % de avance de sus componentes.</p>
        <div className="barras">
          {porSector.map((s) => (
            <div key={s.sector} className="barra-fila" title={`${s.sector}: ${pct(s.avance)} de avance · ${s.conModelo} de ${s.n} componentes con modelo`}>
              <span className="barra-nombre">{s.sector}</span>
              <span className="barra-pista"><span className="barra-valor" style={{ width: `${s.avance}%` }} /></span>
              <span className="barra-num">{pct(s.avance)}</span>
            </div>
          ))}
          <div className="barra-eje" aria-hidden="true"><span /><span>0</span><span>50</span><span>100 %</span><span /></div>
        </div>
      </section>

      <section className="tarjeta-t mapa-resumen">
        <h2>Mapa por estado</h2>
        <p className="sutil">Estructuras con modelo, coloreadas por el estado de su componente. Clic para abrirla en la planta.</p>
        <MapaResumen datos={datos} verComponente={verComponente} />
      </section>

      <section className="tarjeta-t estado-paquete">
        <h2>Estado por paquete</h2>
        <div className="leyenda-linea" aria-label="Leyenda de estados">
          {estados.filter((e) => paquetes.some((p) => p.cuenta.some(([x]) => x === e))).map((e) => (
            <span key={e}><span className="punto" style={{ background: colorEstado(e) }} />{e}</span>
          ))}
          <span><span className="icono-modelo" aria-hidden="true">✔</span>con modelo publicado</span>
        </div>
        <div className="barras">
          {paquetes.map((p, i) => (
            <div key={`${p.sector}${p.paquete}`}>
              {(i === 0 || paquetes[i - 1].sector !== p.sector) && <div className="grupo-sector">{p.sector}</div>}
              <div className="barra-fila"
                title={`${p.paquete}: ${p.cuenta.map(([e, n]) => `${n} ${e.toLowerCase()}`).join(', ')} · ${p.conModelo} con modelo`}>
                <span className="barra-nombre">{p.paquete}</span>
                <span className="barra-pista sin-fondo">
                  <span className="pila" style={{ width: `${(p.n / maxPaquete) * 100}%` }}>
                    {p.cuenta.map(([e, n]) => <span key={e} style={{ flex: n, background: colorEstado(e) }} />)}
                  </span>
                </span>
                <span className="barra-num">{p.n} <span className="sutil">· ✔ {p.conModelo}</span></span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="tarjeta-t tabla-componentes">
        <div className="tabla-cab">
          <h2>Componentes</h2>
          <div className="filtros">
            <select value={filtroSector} onChange={(e) => setFiltroSector(e.target.value)} aria-label="Filtrar por sector">
              <option value="">Todos los sectores</option>
              {sectores.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)} aria-label="Filtrar por estado">
              <option value="">Todos los estados</option>
              {estados.map((s) => <option key={s}>{s}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={soloConModelo} onChange={(e) => setSoloConModelo(e.target.checked)} /> Solo con modelo</label>
          </div>
        </div>
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Sector</th><th>Paquete</th><th>Componente</th><th>Estado</th><th className="num">Avance</th><th>Modelo</th><th /></tr>
            </thead>
            <tbody>
              {filas.map((c) => {
                const mods = modelosDe.get(c.componente);
                const e = c.estado || 'Sin asignar';
                return (
                  <tr key={c.componente}>
                    <td>{c.sector}</td>
                    <td>{c.paquete}</td>
                    <td><strong>{c.componente}</strong><span className="sutil bloque">{c.descripcion}</span></td>
                    <td><span className="estado-celda"><span className="punto" style={{ background: colorEstado(e) }} />{e}</span>
                      {c.observaciones && <span className="sutil bloque">{c.observaciones}</span>}</td>
                    <td className="num">{pct(avance.get(c.componente) ?? 0)}</td>
                    <td>{mods ? <span title={mods.join(', ')}>✔ {mods.length}</span> : <span className="sutil">—</span>}</td>
                    <td className="acciones-fila">
                      {mods && (
                        <>
                          <button className="btn chico" onClick={() => verComponente(c.componente, 'plano')}>Planta</button>
                          <button className="btn chico" onClick={() => verComponente(c.componente, '3d')}>→ 3D</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!filas.length && <tr><td colSpan={7} className="sutil">Ningún componente cumple los filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Mapa chico: el trazado de cada estructura con el color del estado de su componente. */
function MapaResumen({ datos, verComponente }: Pick<Props, 'datos' | 'verComponente'>) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const { lat, lon } = datos.manifest.origen;
    const m = L.map(host.current, { center: [lat, lon], zoom: 14, preferCanvas: true, scrollWheelZoom: false, attributionControl: true });
    let vigente = true;
    void zoomMaxEsri(lon, lat).then((zmax) => {
      if (vigente) L.tileLayer(urlTeselaEsri('{z}', '{y}', '{x}'), { maxZoom: 21, maxNativeZoom: zmax, attribution: 'Imágenes © Esri' }).addTo(m);
    });
    const estadoDe = new Map(datos.componentes.map((c) => [c.componente, c.estado || 'Sin asignar']));
    const capa = L.geoJSON(datos.trazado as GeoJSON.FeatureCollection, {
      style: (f) => {
        const color = colorEstado(estadoDe.get(f?.properties?.componente) ?? 'Sin asignar');
        return { color, weight: 2, fillColor: color, fillOpacity: 0.6 };
      },
      onEachFeature: (f, l) => {
        const p = f.properties ?? {};
        l.bindTooltip(`<strong>${p.componente}</strong> · ${estadoDe.get(p.componente) ?? 'Sin asignar'}<br>${p.componente_desc ?? ''}`, { sticky: true });
        l.on('click', () => verComponente(p.componente, 'plano'));
      },
    }).addTo(m);
    const b = capa.getBounds();
    if (b.isValid()) m.fitBounds(b, { padding: [20, 20] });
    const obs = new ResizeObserver(() => m.invalidateSize());
    obs.observe(host.current);
    return () => { vigente = false; obs.disconnect(); m.remove(); };
  }, [datos, verComponente]);
  return <div ref={host} className="mapa-chico" />;
}
