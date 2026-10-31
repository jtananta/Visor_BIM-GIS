import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { COLOR_TIPO, colorEstadoPaquete, compararNatural, ESTADOS_PAQUETE, type Componente, type Datos, type Estructura } from './datos';
import { guardarConexion, leerConexion, publicar, RAIZ_DATOS } from './admin/github';
import { urlTeselaEsri, zoomMaxEsri } from './esri';
import { formatoNumero as num, LINEALES, metradosPorModelo } from './metrados';

declare const __PUBLICADO__: string;

/** Columnas de metrados, en el orden en que se leen en obra. */
const COLUMNAS: { tipo: string; titulo: string; unidad: 'und' | 'ml' }[] = [
  { tipo: 'Buzón', titulo: 'Buzones', unidad: 'und' },
  { tipo: 'Sumidero', titulo: 'Sumideros', unidad: 'und' },
  { tipo: 'Tubería', titulo: 'Tubería', unidad: 'ml' },
  { tipo: 'Box', titulo: 'Box', unidad: 'ml' },
  { tipo: 'Canal', titulo: 'Canal', unidad: 'ml' },
  { tipo: 'Gaviones', titulo: 'Gaviones', unidad: 'ml' },
];
type Fila = Record<string, number>;
const vacia = (): Fila => Object.fromEntries(COLUMNAS.map((c) => [c.tipo, 0]));
const valor = (f: Fila, c: (typeof COLUMNAS)[number]) => (f[c.tipo] ? `${num(f[c.tipo])}` : '—');

interface Props {
  datos: Datos;
  sectores: string[];
  /** Abre el componente en la planta o en la vista 3D, enfocado. */
  verComponente: (componente: string, vista: 'plano' | '3d') => void;
}

/** Filtros del Dashboard. Como en Power BI, cada gráfico filtra a todos los demás y resalta lo elegido. */
interface Filtros { sector: string; paquete: string; estado: string; tipo: string; modelo: '' | 'con' | 'sin' }
const SIN_FILTROS: Filtros = { sector: '', paquete: '', estado: '', tipo: '', modelo: '' };
type Dim = keyof Filtros;

export default function Tablero({ datos, sectores, verComponente }: Props) {
  const [f, setF] = useState<Filtros>(SIN_FILTROS);
  const [soloConModelo, setSoloConModelo] = useState(true);
  const [estados, setEstados] = useState<Record<string, string>>(datos.estadosPaquete);
  const [colorMapa, setColorMapa] = useState<'tipo' | 'estado'>('tipo');
  const estadoDe = (paquete: string) => estados[paquete] || 'En diseño';
  const colorPaquete = useMemo(() => (colorMapa === 'tipo' ? null : (p: string) => colorEstadoPaquete(estados[p] || 'En diseño')), [colorMapa, estados]);
  /** Clic en algo ya elegido lo quita, como en Power BI. */
  const alternar = (d: Dim, v: string) => setF((x) => ({ ...x, [d]: x[d] === v ? '' : v }));
  const fijar = (d: Dim, v: string) => setF((x) => ({ ...x, [d]: v }));
  const hayFiltros = Object.values(f).some(Boolean);

  // Modelos asignados a un componente que no está en el Excel (p. ej. «por asignar») cuentan igual en su paquete.
  const comps = useMemo(() => [...datos.componentes, ...datos.manifest.modelos
    .filter((m, i, todos) => !datos.componentes.some((c) => c.componente === m.componente) && todos.findIndex((x) => x.componente === m.componente) === i)
    .map((m): Componente => ({ sector: m.sector, paquete: m.paquete, componente: m.componente, descripcion: m.componente_desc || m.modelo, estado: 'Sin asignar', avance: '', responsable: '', fecha: '', observaciones: '' }))].sort((a, b) =>
    compararNatural(a.sector, b.sector) || compararNatural(a.paquete, b.paquete) || compararNatural(a.componente, b.componente)), [datos.componentes, datos.manifest.modelos]);
  const metrados = useMemo(() => metradosPorModelo(datos), [datos]);
  const hayEstimados = [...metrados.values()].some((m) => m.estimado);

  // Cantidades por componente: unidades para buzones y sumideros, metros lineales para lo demás.
  const porComponente = useMemo(() => {
    const r = new Map<string, { fila: Fila; modelos: string[] }>();
    for (const m of datos.manifest.modelos) {
      const x = r.get(m.componente) ?? { fila: vacia(), modelos: [] };
      x.modelos.push(m.modelo);
      for (const [t, v] of Object.entries(metrados.get(m.codigo)?.porTipo ?? {})) {
        x.fila[t] = (x.fila[t] ?? 0) + (LINEALES.has(t) ? v.ml : v.n);
      }
      r.set(m.componente, x);
    }
    return r;
  }, [datos.manifest.modelos, metrados]);

  /** ¿El componente pasa los filtros? `excepto` deja fuera una dimensión: la del gráfico que la elige. */
  const pasa = (c: Componente, excepto?: Dim) => {
    const x = porComponente.get(c.componente);
    return (excepto === 'sector' || !f.sector || c.sector === f.sector)
      && (excepto === 'paquete' || !f.paquete || c.paquete === f.paquete)
      && (excepto === 'estado' || !f.estado || estadoDe(c.paquete) === f.estado)
      && (excepto === 'modelo' || !f.modelo || (f.modelo === 'con') === !!x)
      && (excepto === 'tipo' || !f.tipo || (x?.fila[f.tipo] ?? 0) > 0);
  };
  const sumar = (filas: Fila[]) => filas.reduce((acc, fl) => { for (const c of COLUMNAS) acc[c.tipo] += fl[c.tipo] ?? 0; return acc; }, vacia());
  const filaDe = (cs: Componente[]) => sumar(cs.flatMap((c): Fila[] => { const x = porComponente.get(c.componente); return x ? [x.fila] : []; }));
  const agruparPaquetes = (cs: Componente[]) => [...new Set(cs.map((c) => `${c.sector}|${c.paquete}`))].map((k) => {
    const [sector, paquete] = k.split('|');
    const del = cs.filter((c) => c.sector === sector && c.paquete === paquete);
    const con = del.filter((c) => porComponente.has(c.componente));
    return { sector, paquete, n: del.length, conModelo: con.length, fila: filaDe(con) };
  });

  const vis = comps.filter((c) => pasa(c));
  const paquetes = agruparPaquetes(vis);
  const total = filaDe(vis);
  const totalSinTipo = filaDe(comps.filter((c) => pasa(c, 'tipo')));
  const conModelo = vis.filter((c) => porComponente.has(c.componente)).length;
  const modelosVis = datos.manifest.modelos.filter((m) => vis.some((c) => c.componente === m.componente));

  // Cada gráfico se calcula sin su propio filtro, para poder ver y cambiar la selección.
  const compsSector = comps.filter((c) => pasa(c, 'sector'));
  const porSector = sectores.map((s) => {
    const cs = compsSector.filter((c) => c.sector === s);
    return { sector: s, componentes: cs.length, paquetes: agruparPaquetes(cs) };
  }).filter((s) => s.componentes);
  const maxPaquetes = Math.max(1, ...porSector.map((s) => s.paquetes.length));
  const paquetesBarras = agruparPaquetes(comps.filter((c) => pasa(c, 'paquete')));
  const maxComp = Math.max(1, ...paquetesBarras.map((p) => p.n));
  const paquetesEstado = agruparPaquetes(comps.filter((c) => pasa(c, 'estado')));
  const conteoEstados = Object.fromEntries(ESTADOS_PAQUETE.map((e) => [e.estado, paquetesEstado.filter((p) => estadoDe(p.paquete) === e.estado).length]));
  const filas = vis.filter((c) => !soloConModelo || porComponente.has(c.componente));
  const publicado = new Date(__PUBLICADO__);

  const opcionesPaquete = agruparPaquetes(comps.filter((c) => pasa(c, 'paquete'))).map((p) => p.paquete);
  const visible = useMemo(() => {
    const ok = new Set(vis.map((c) => c.componente));
    return (p: Estructura) => ok.has(p.componente) && (!f.tipo || p.tipo_estructura === f.tipo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vis.map((c) => c.componente).join('|'), f.tipo]);
  const atenuar = (activo: boolean, dim: string) => (dim && !activo ? ' atenuado' : '') + (dim && activo ? ' elegido' : '');

  return (
    <div className="tablero">
      <section className="segmentadores" aria-label="Filtros">
        <label>Sector<select value={f.sector} onChange={(e) => fijar('sector', e.target.value)}>
          <option value="">Todos</option>{sectores.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Paquete<select value={f.paquete} onChange={(e) => fijar('paquete', e.target.value)}>
          <option value="">Todos</option>{[...new Set([...opcionesPaquete, f.paquete].filter(Boolean))].map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>Estado<select value={f.estado} onChange={(e) => fijar('estado', e.target.value)}>
          <option value="">Todos</option>{ESTADOS_PAQUETE.map((e) => <option key={e.estado}>{e.estado}</option>)}</select></label>
        <label>Tipo de estructura<select value={f.tipo} onChange={(e) => fijar('tipo', e.target.value)}>
          <option value="">Todos</option>{COLUMNAS.map((c) => <option key={c.tipo} value={c.tipo}>{c.titulo}</option>)}</select></label>
        <label>Modelo BIM<select value={f.modelo} onChange={(e) => fijar('modelo', e.target.value)}>
          <option value="">Todos</option><option value="con">Con modelo</option><option value="sin">Sin modelo</option></select></label>
        <button className="btn chico" disabled={!hayFiltros} onClick={() => setF(SIN_FILTROS)}>Limpiar filtros</button>
        <span className="sutil pista-filtro">Clic en barras, indicadores, tabla o mapa para filtrar; otro clic quita el filtro.</span>
      </section>

      <section className="kpis" aria-label="Estructura del proyecto">
        <div className="kpi"><span className="kpi-titulo">Sectores</span><span className="kpi-valor">{new Set(vis.map((c) => c.sector)).size}</span>
          <span className="kpi-pie">{[...new Set(vis.map((c) => c.sector))].map((s) => s.replace('Sector ', 'S')).join(' · ') || '—'}</span></div>
        <div className="kpi"><span className="kpi-titulo">Paquetes</span><span className="kpi-valor">{paquetes.length}</span>
          <span className="kpi-pie">{ESTADOS_PAQUETE.slice().reverse().map((e) => [e, paquetes.filter((p) => estadoDe(p.paquete) === e.estado).length] as const).filter(([, n]) => n).map(([e, n]) => `${n} ${e.estado.toLowerCase()}`).join(' · ') || '—'}</span></div>
        <div className="kpi"><span className="kpi-titulo">Componentes</span><span className="kpi-valor">{vis.length}</span>
          <span className="kpi-pie">{conModelo} con modelo BIM publicado</span></div>
        <div className="kpi"><span className="kpi-titulo">Modelos BIM</span><span className="kpi-valor">{modelosVis.length}</span>
          <span className="kpi-pie">actualizado el {publicado.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}, {publicado.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span></div>
      </section>

      <section className="kpis metrados-kpi" aria-label="Metrados modelados">
        {COLUMNAS.map((c) => (
          <button key={c.tipo} className={`kpi kpi-boton${atenuar(f.tipo === c.tipo, f.tipo)}`} onClick={() => alternar('tipo', c.tipo)} aria-pressed={f.tipo === c.tipo} title={`Filtrar por ${c.titulo.toLowerCase()}`}>
            <span className="kpi-titulo"><span className="punto" style={{ background: COLOR_TIPO[c.tipo] ?? COLOR_TIPO.Otros }} />{c.titulo}</span>
            <span className="kpi-valor">{num(totalSinTipo[c.tipo])}<span className="kpi-de"> {c.unidad}</span></span>
          </button>
        ))}
        <p className="sutil nota-metrados">Metrados medidos sobre los modelos BIM publicados: solo cuentan lo que ya está modelado.
          {hayEstimados && ' ≈ Algunos modelos se convirtieron antes de medir longitudes y se estiman con su trazado en planta; vuelve a subir su IFC para el valor exacto.'}</p>
      </section>

      <section className="tarjeta-t avance-sector">
        <h2>Paquetes por sector y estado</h2>
        <div className="leyenda-linea" aria-label="Filtrar por estado">
          {ESTADOS_PAQUETE.slice().reverse().filter((e) => conteoEstados[e.estado] || f.estado === e.estado).map((e) => (
            <button key={e.estado} className={`chip-filtro${atenuar(f.estado === e.estado, f.estado)}`} aria-pressed={f.estado === e.estado} onClick={() => alternar('estado', e.estado)}>
              <span className="punto" style={{ background: e.color }} />{e.estado} ({conteoEstados[e.estado]})</button>
          ))}
        </div>
        <div className="barras">
          {porSector.map((s) => (
            <div key={s.sector} role="button" tabIndex={0} className={`barra-fila clic${atenuar(f.sector === s.sector, f.sector)}`}
              onClick={() => alternar('sector', s.sector)} onKeyDown={(e) => e.key === 'Enter' && alternar('sector', s.sector)}
              title={`${s.sector}: ${s.paquetes.length} paquetes, ${s.componentes} componentes\n${s.paquetes.map((p) => `${p.paquete}: ${estadoDe(p.paquete)}`).join('\n')}`}>
              <span className="barra-nombre">{s.sector}</span>
              <span className="barra-pista sin-fondo">
                <span className="pila" style={{ width: `${(s.paquetes.length / maxPaquetes) * 100}%` }}>
                  {ESTADOS_PAQUETE.slice().reverse().map((e) => {
                    const n = s.paquetes.filter((p) => estadoDe(p.paquete) === e.estado).length;
                    return n ? <span key={e.estado} style={{ flex: n, background: e.color, opacity: f.estado && f.estado !== e.estado ? 0.3 : 1 }} /> : null;
                  })}
                </span>
              </span>
              <span className="barra-num">{s.paquetes.length} <span className="sutil">· {s.componentes} comp.</span></span>
            </div>
          ))}
        </div>
      </section>

      <section className="tarjeta-t mapa-resumen">
        <div className="tabla-cab">
          <h2>{colorMapa === 'tipo' ? 'Estructuras por tipo' : 'Estructuras por estado del paquete'}</h2>
          <div className="segmento" role="group" aria-label="Colorear el mapa por">
            <button aria-pressed={colorMapa === 'tipo'} onClick={() => setColorMapa('tipo')}>Tipo</button>
            <button aria-pressed={colorMapa === 'estado'} onClick={() => setColorMapa('estado')}>Estado</button>
          </div>
        </div>
        {colorMapa === 'tipo' ? (
          <div className="leyenda-linea" aria-label="Leyenda de tipos">
            {Object.entries(COLOR_TIPO).filter(([t]) => datos.manifest.modelos.some((m) => m.tipos[t])).map(([t, c]) => (
              <span key={t}><span className="punto" style={{ background: c }} />{t}</span>
            ))}
          </div>
        ) : <LeyendaEstados />}
        <MapaResumen datos={datos} colorDe={colorPaquete} visible={visible} alElegir={(p) => alternar('paquete', p)} />
        <p className="sutil">Clic en una estructura para filtrar por su paquete.</p>
      </section>

      <section className="tarjeta-t estado-paquete">
        <h2>Componentes por paquete</h2>
        <div className="leyenda-linea">
          <span><span className="punto" style={{ background: 'var(--azul)' }} />con modelo BIM</span>
          <span><span className="punto" style={{ background: 'color-mix(in srgb, var(--azul) 25%, var(--panel))' }} />sin modelo todavía</span>
        </div>
        <div className="barras">
          {paquetesBarras.map((p, i) => (
            <div key={`${p.sector}${p.paquete}`}>
              {(i === 0 || paquetesBarras[i - 1].sector !== p.sector) && <div className="grupo-sector">{p.sector}</div>}
              <div role="button" tabIndex={0} className={`barra-fila clic${atenuar(f.paquete === p.paquete, f.paquete)}`}
                onClick={() => alternar('paquete', p.paquete)} onKeyDown={(e) => e.key === 'Enter' && alternar('paquete', p.paquete)}
                title={`${p.paquete} (${estadoDe(p.paquete)}): ${p.n} componentes, ${p.conModelo} con modelo`}>
                <span className="barra-nombre"><span className="punto" style={{ background: colorEstadoPaquete(estadoDe(p.paquete)) }} /> {p.paquete}</span>
                <span className="barra-pista sin-fondo">
                  <span className="pila" style={{ width: `${(p.n / maxComp) * 100}%` }}>
                    {p.conModelo > 0 && <span style={{ flex: p.conModelo, background: 'var(--azul)' }} />}
                    {p.n - p.conModelo > 0 && <span style={{ flex: p.n - p.conModelo, background: 'color-mix(in srgb, var(--azul) 25%, var(--panel))' }} />}
                  </span>
                </span>
                <span className="barra-num">{p.n} <span className="sutil">· ✔ {p.conModelo}</span></span>
              </div>
            </div>
          ))}
          {!paquetesBarras.length && <p className="sutil">Ningún paquete cumple los filtros.</p>}
        </div>
      </section>

      <section className="tarjeta-t tabla-paquetes">
        <EditorEstados estados={estados} paquetes={[...new Set(comps.map((c) => c.paquete))]} alGuardar={setEstados}>
          {(editando, borrador, cambiar) => (
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr><th>Paquete</th><th>Estado</th><th className="num">Comp.</th>
                    {COLUMNAS.map((c) => <th key={c.tipo} className={`num${f.tipo === c.tipo ? ' col-elegida' : ''}`}>{c.titulo} <span className="unidad">({c.unidad})</span></th>)}</tr>
                </thead>
                <tbody>
                  {(editando ? agruparPaquetes(comps) : paquetes).map((p, i, arr) => (
                    <FilaPaquete key={`${p.sector}${p.paquete}`} grupo={i === 0 || arr[i - 1].sector !== p.sector ? p.sector : null}
                      nombre={p.paquete} comp={`${p.conModelo}/${p.n}`} fila={p.fila} tipo={f.tipo}
                      elegido={f.paquete === p.paquete} alClic={editando ? undefined : () => alternar('paquete', p.paquete)}
                      estado={editando ? (
                        <select value={borrador[p.paquete] || 'En diseño'} onChange={(e) => cambiar(p.paquete, e.target.value)} aria-label={`Estado del ${p.paquete}`}>
                          {ESTADOS_PAQUETE.map((e) => <option key={e.estado}>{e.estado}</option>)}
                        </select>
                      ) : <ChipEstado estado={estadoDe(p.paquete)} />} />
                  ))}
                  {!paquetes.length && !editando && <tr><td colSpan={COLUMNAS.length + 3} className="sutil">Ningún paquete cumple los filtros.</td></tr>}
                  <tr className="total"><td>Total{hayFiltros ? ' filtrado' : ''}</td><td /><td className="num">{conModelo}/{vis.length}</td>
                    {COLUMNAS.map((c) => <td key={c.tipo} className="num">{valor(total, c)}</td>)}</tr>
                </tbody>
              </table>
            </div>
          )}
        </EditorEstados>
        <p className="sutil">Comp.: componentes con modelo / componentes del paquete. Clic en una fila para filtrar por ese paquete.</p>
      </section>

      <section className="tarjeta-t tabla-componentes">
        <div className="tabla-cab">
          <h2>Metrados por componente</h2>
          <label className="check"><input type="checkbox" checked={soloConModelo} onChange={(e) => setSoloConModelo(e.target.checked)} /> Solo con modelo</label>
        </div>
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Componente</th><th>Paquete</th>
                {COLUMNAS.map((c) => <th key={c.tipo} className={`num${f.tipo === c.tipo ? ' col-elegida' : ''}`}>{c.titulo} <span className="unidad">({c.unidad})</span></th>)}<th /></tr>
            </thead>
            <tbody>
              {filas.map((c) => {
                const x = porComponente.get(c.componente);
                return (
                  <tr key={c.componente}>
                    <td><strong>{c.componente}</strong><span className="sutil bloque">{c.descripcion}</span>
                      {x && <span className="sutil bloque">Modelo: {x.modelos.join(', ')}</span>}</td>
                    <td>{c.paquete}<span className="sutil bloque">{c.sector}</span></td>
                    {COLUMNAS.map((col) => <td key={col.tipo} className={`num${f.tipo === col.tipo ? ' col-elegida' : ''}`}>{x ? valor(x.fila, col) : '—'}</td>)}
                    <td className="acciones-fila">
                      {x && (
                        <>
                          <button className="btn chico" onClick={() => verComponente(c.componente, 'plano')}>Planta</button>
                          <button className="btn chico" onClick={() => verComponente(c.componente, '3d')}>→ 3D</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!filas.length && <tr><td colSpan={COLUMNAS.length + 3} className="sutil">Ningún componente cumple los filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FilaPaquete({ grupo, nombre, comp, fila, estado, tipo, elegido, alClic }: {
  grupo: string | null; nombre: string; comp: string; fila: Fila; estado: React.ReactNode; tipo: string; elegido: boolean; alClic?: () => void;
}) {
  return (
    <>
      {grupo && <tr className="grupo"><td colSpan={COLUMNAS.length + 3}>{grupo}</td></tr>}
      <tr className={`${alClic ? 'clic' : ''}${elegido ? ' elegido' : ''}`} onClick={alClic}>
        <td>{nombre}</td>
        <td>{estado}</td>
        <td className="num">{comp}</td>
        {COLUMNAS.map((c) => <td key={c.tipo} className={`num${tipo === c.tipo ? ' col-elegida' : ''}`}>{valor(fila, c)}</td>)}
      </tr>
    </>
  );
}

/** Mapa chico: las estructuras que pasan los filtros, con el color de su tipo o del estado de su paquete. */
function MapaResumen({ datos, colorDe, visible, alElegir }: {
  datos: Datos;
  colorDe: ((paquete: string) => string) | null;
  visible: (p: Estructura) => boolean;
  alElegir: (paquete: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const mapa = useRef<L.Map | null>(null);
  const elegir = useRef(alElegir);
  elegir.current = alElegir;
  useEffect(() => {
    if (!host.current) return;
    const { lat, lon } = datos.manifest.origen;
    const m = L.map(host.current, { center: [lat, lon], zoom: 14, preferCanvas: true, scrollWheelZoom: false });
    mapa.current = m;
    let vigente = true;
    void zoomMaxEsri(lon, lat).then((zmax) => {
      if (vigente) L.tileLayer(urlTeselaEsri('{z}', '{y}', '{x}'), { maxZoom: 21, maxNativeZoom: zmax, attribution: 'Imágenes © Esri' }).addTo(m);
    });
    const obs = new ResizeObserver(() => m.invalidateSize());
    obs.observe(host.current);
    return () => { vigente = false; obs.disconnect(); m.remove(); mapa.current = null; };
  }, [datos]);
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    const capa = L.geoJSON(datos.trazado as GeoJSON.FeatureCollection, {
      filter: (ft) => visible(ft.properties as Estructura),
      style: (ft) => {
        const color = colorDe ? colorDe(ft?.properties?.paquete) : COLOR_TIPO[ft?.properties?.tipo_estructura] ?? COLOR_TIPO.Otros;
        return { color, weight: 2, fillColor: color, fillOpacity: 0.7 };
      },
      onEachFeature: (ft, l) => {
        const p = ft.properties ?? {};
        const largo = p.longitud_m ? ` · ${num(p.longitud_m)} ml` : '';
        l.bindTooltip(`<strong>${p.nombre}</strong>${largo}<br>${p.paquete} · ${p.componente} · ${p.componente_desc ?? ''}`, { sticky: true });
        l.on('click', () => elegir.current(p.paquete));
      },
    }).addTo(m);
    const b = capa.getBounds();
    if (b.isValid()) m.fitBounds(b, { padding: [20, 20], maxZoom: 18 });
    return () => { capa.remove(); };
  }, [datos, colorDe, visible]);
  return <div ref={host} className="mapa-chico" />;
}

function ChipEstado({ estado }: { estado: string }) {
  return <span className="estado-celda"><span className="punto" style={{ background: colorEstadoPaquete(estado) }} />{estado}</span>;
}

function LeyendaEstados({ conteo }: { conteo?: Record<string, number> }) {
  return (
    <div className="leyenda-linea" aria-label="Leyenda de estados">
      {ESTADOS_PAQUETE.slice().reverse().filter((e) => !conteo || conteo[e.estado]).map((e) => (
        <span key={e.estado}><span className="punto" style={{ background: e.color }} />{e.estado}{conteo ? ` (${conteo[e.estado]})` : ''}</span>
      ))}
    </div>
  );
}

/**
 * Edición del estado de cada paquete: cambia los desplegables de la tabla y publica paquetes.json con la
 * clave de publicación, igual que «Subir IFC».
 */
function EditorEstados({ estados, paquetes, alGuardar, children }: {
  estados: Record<string, string>;
  paquetes: string[];
  alGuardar: (e: Record<string, string>) => void;
  children: (editando: boolean, borrador: Record<string, string>, cambiar: (p: string, e: string) => void) => React.ReactNode;
}) {
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState(estados);
  const [clave, setClave] = useState(() => leerConexion().clave);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState('');
  const [error, setError] = useState('');

  const guardar = async () => {
    setOcupado(true); setError(''); setAviso('Publicando…');
    const nuevo = Object.fromEntries(paquetes.map((p) => [p, borrador[p] || 'En diseño']));
    try {
      await publicar({ clave }, { [`${RAIZ_DATOS}paquetes.json`]: JSON.stringify(nuevo, null, 2) + '\n' }, 'Estado de paquetes actualizado desde el Dashboard', setAviso);
      guardarConexion({ clave }, true);
      alGuardar(nuevo);
      setEditando(false);
      setAviso('Publicado. Todos lo verán en uno o dos minutos, cuando Vercel termine de actualizar el sitio.');
    } catch (e) {
      setAviso('');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <div className="tabla-cab">
        <h2>Metrados por paquete</h2>
        {!editando ? (
          <button className="btn chico" onClick={() => { setBorrador(estados); setEditando(true); setAviso(''); setError(''); }}>Editar estados</button>
        ) : (
          <div className="filtros">
            <input type="password" className="clave-chica" placeholder="Clave de publicación" value={clave} onChange={(e) => setClave(e.target.value)} aria-label="Clave de publicación" />
            <button className="btn chico" disabled={ocupado} onClick={() => setEditando(false)}>Cancelar</button>
            <button className="btn chico btn-guardar" disabled={ocupado || !clave} onClick={guardar}>{ocupado ? 'Publicando…' : 'Publicar'}</button>
          </div>
        )}
      </div>
      {(aviso || error) && <p className={error ? 'error-linea' : 'sutil'}>{error || aviso}</p>}
      {children(editando, borrador, (p, e) => setBorrador((b) => ({ ...b, [p]: e })))}
    </>
  );
}
