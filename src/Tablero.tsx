import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { COLOR_TIPO, colorEstadoPaquete, compararNatural, ESTADOS_PAQUETE, type Datos } from './datos';
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

export default function Tablero({ datos, sectores, verComponente }: Props) {
  const [filtroSector, setFiltroSector] = useState('');
  const [soloConModelo, setSoloConModelo] = useState(true);
  const [estados, setEstados] = useState<Record<string, string>>(datos.estadosPaquete);
  const [colorMapa, setColorMapa] = useState<'tipo' | 'estado'>('tipo');
  const estadoDe = (paquete: string) => estados[paquete] || 'En diseño';
  const colorPaquete = useMemo(() => (colorMapa === 'tipo' ? null : (p: string) => colorEstadoPaquete(estados[p] || 'En diseño')), [colorMapa, estados]);

  const comps = useMemo(() => [...datos.componentes].sort((a, b) =>
    compararNatural(a.sector, b.sector) || compararNatural(a.paquete, b.paquete) || compararNatural(a.componente, b.componente)), [datos.componentes]);
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

  const sumar = (filas: Fila[]) => filas.reduce((acc, f) => { for (const c of COLUMNAS) acc[c.tipo] += f[c.tipo] ?? 0; return acc; }, vacia());
  const total = sumar([...porComponente.values()].map((x) => x.fila));

  const paquetes = [...new Set(comps.map((c) => `${c.sector}|${c.paquete}`))].map((k) => {
    const [sector, paquete] = k.split('|');
    const cs = comps.filter((c) => c.sector === sector && c.paquete === paquete);
    const conModelo = cs.filter((c) => porComponente.has(c.componente));
    return { sector, paquete, n: cs.length, conModelo: conModelo.length, fila: sumar(conModelo.map((c) => porComponente.get(c.componente)!.fila)) };
  });
  const porSector = sectores.map((s) => ({
    sector: s,
    paquetes: paquetes.filter((p) => p.sector === s).length,
    componentes: comps.filter((c) => c.sector === s).length,
  })).filter((s) => s.componentes);
  const maxPaquetes = Math.max(1, ...porSector.map((s) => s.paquetes));
  const maxComp = Math.max(1, ...paquetes.map((p) => p.n));
  const conModelo = comps.filter((c) => porComponente.has(c.componente)).length;
  const conteoEstados = Object.fromEntries(ESTADOS_PAQUETE.map((e) => [e.estado, paquetes.filter((p) => estadoDe(p.paquete) === e.estado).length]));

  const filas = comps.filter((c) => (!filtroSector || c.sector === filtroSector) && (!soloConModelo || porComponente.has(c.componente)));
  const publicado = new Date(__PUBLICADO__);

  return (
    <div className="tablero">
      <section className="kpis" aria-label="Estructura del proyecto">
        <div className="kpi"><span className="kpi-titulo">Sectores</span><span className="kpi-valor">{porSector.length}</span>
          <span className="kpi-pie">{porSector.map((s) => s.sector.replace('Sector ', 'S')).join(' · ')}</span></div>
        <div className="kpi"><span className="kpi-titulo">Paquetes</span><span className="kpi-valor">{paquetes.length}</span>
          <span className="kpi-pie">{ESTADOS_PAQUETE.slice().reverse().filter((e) => conteoEstados[e.estado]).map((e) => `${conteoEstados[e.estado]} ${e.estado.toLowerCase()}`).join(' · ')}</span></div>
        <div className="kpi"><span className="kpi-titulo">Componentes</span><span className="kpi-valor">{comps.length}</span>
          <span className="kpi-pie">{conModelo} con modelo BIM publicado</span></div>
        <div className="kpi"><span className="kpi-titulo">Modelos BIM</span><span className="kpi-valor">{datos.manifest.modelos.length}</span>
          <span className="kpi-pie">actualizado el {publicado.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}, {publicado.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span></div>
      </section>

      <section className="kpis metrados-kpi" aria-label="Metrados modelados">
        {COLUMNAS.map((c) => (
          <div key={c.tipo} className="kpi">
            <span className="kpi-titulo"><span className="punto" style={{ background: COLOR_TIPO[c.tipo] ?? COLOR_TIPO.Otros }} />{c.titulo}</span>
            <span className="kpi-valor">{num(total[c.tipo])}<span className="kpi-de"> {c.unidad}</span></span>
          </div>
        ))}
        <p className="sutil nota-metrados">Metrados medidos sobre los modelos BIM publicados: solo cuentan lo que ya está modelado.
          {hayEstimados && ' ≈ Algunos modelos se convirtieron antes de medir longitudes y se estiman con su trazado en planta; vuelve a subir su IFC para el valor exacto.'}</p>
      </section>

      <section className="tarjeta-t avance-sector">
        <h2>Paquetes por sector y estado</h2>
        <LeyendaEstados conteo={conteoEstados} />
        <div className="barras">
          {porSector.map((s) => {
            const ps = paquetes.filter((p) => p.sector === s.sector);
            return (
              <div key={s.sector} className="barra-fila" title={`${s.sector}: ${s.paquetes} paquetes, ${s.componentes} componentes\n${ps.map((p) => `${p.paquete}: ${estadoDe(p.paquete)}`).join('\n')}`}>
                <span className="barra-nombre">{s.sector}</span>
                <span className="barra-pista sin-fondo">
                  <span className="pila" style={{ width: `${(s.paquetes / maxPaquetes) * 100}%` }}>
                    {ESTADOS_PAQUETE.slice().reverse().map((e) => {
                      const n = ps.filter((p) => estadoDe(p.paquete) === e.estado).length;
                      return n ? <span key={e.estado} style={{ flex: n, background: e.color }} /> : null;
                    })}
                  </span>
                </span>
                <span className="barra-num">{s.paquetes} <span className="sutil">· {s.componentes} comp.</span></span>
              </div>
            );
          })}
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
        <MapaResumen datos={datos} verComponente={verComponente} colorDe={colorPaquete} />
      </section>

      <section className="tarjeta-t estado-paquete">
        <h2>Componentes por paquete</h2>
        <div className="leyenda-linea">
          <span><span className="punto" style={{ background: 'var(--azul)' }} />con modelo BIM</span>
          <span><span className="punto" style={{ background: 'color-mix(in srgb, var(--azul) 25%, var(--panel))' }} />sin modelo todavía</span>
        </div>
        <div className="barras">
          {paquetes.map((p, i) => (
            <div key={`${p.sector}${p.paquete}`}>
              {(i === 0 || paquetes[i - 1].sector !== p.sector) && <div className="grupo-sector">{p.sector}</div>}
              <div className="barra-fila" title={`${p.paquete}: ${p.n} componentes, ${p.conModelo} con modelo`}>
                <span className="barra-nombre" title={estadoDe(p.paquete)}><span className="punto" style={{ background: colorEstadoPaquete(estadoDe(p.paquete)) }} /> {p.paquete}</span>
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
        </div>
      </section>

      <section className="tarjeta-t tabla-paquetes">
        <EditorEstados estados={estados} paquetes={paquetes.map((p) => p.paquete)} alGuardar={setEstados}>
          {(editando, borrador, cambiar) => (
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Paquete</th><th>Estado</th><th className="num">Comp.</th>
                {COLUMNAS.map((c) => <th key={c.tipo} className="num">{c.titulo} <span className="unidad">({c.unidad})</span></th>)}</tr>
            </thead>
            <tbody>
              {paquetes.map((p, i) => (
                <FilaPaquete key={`${p.sector}${p.paquete}`} grupo={i === 0 || paquetes[i - 1].sector !== p.sector ? p.sector : null}
                  nombre={p.paquete} comp={`${p.conModelo}/${p.n}`} fila={p.fila}
                  estado={editando ? (
                    <select value={borrador[p.paquete] || 'En diseño'} onChange={(e) => cambiar(p.paquete, e.target.value)} aria-label={`Estado del ${p.paquete}`}>
                      {ESTADOS_PAQUETE.map((e) => <option key={e.estado}>{e.estado}</option>)}
                    </select>
                  ) : <ChipEstado estado={estadoDe(p.paquete)} />} />
              ))}
              <tr className="total"><td>Total</td><td /><td className="num">{conModelo}/{comps.length}</td>
                {COLUMNAS.map((c) => <td key={c.tipo} className="num">{valor(total, c)}</td>)}</tr>
            </tbody>
          </table>
        </div>
          )}
        </EditorEstados>
        <p className="sutil">Comp.: componentes con modelo / componentes del paquete.</p>
      </section>

      <section className="tarjeta-t tabla-componentes">
        <div className="tabla-cab">
          <h2>Metrados por componente</h2>
          <div className="filtros">
            <select value={filtroSector} onChange={(e) => setFiltroSector(e.target.value)} aria-label="Filtrar por sector">
              <option value="">Todos los sectores</option>
              {sectores.map((s) => <option key={s}>{s}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={soloConModelo} onChange={(e) => setSoloConModelo(e.target.checked)} /> Solo con modelo</label>
          </div>
        </div>
        <div className="tabla-scroll">
          <table className="tabla">
            <thead>
              <tr><th>Componente</th><th>Paquete</th>
                {COLUMNAS.map((c) => <th key={c.tipo} className="num">{c.titulo} <span className="unidad">({c.unidad})</span></th>)}<th /></tr>
            </thead>
            <tbody>
              {filas.map((c) => {
                const x = porComponente.get(c.componente);
                return (
                  <tr key={c.componente}>
                    <td><strong>{c.componente}</strong><span className="sutil bloque">{c.descripcion}</span>
                      {x && <span className="sutil bloque">Modelo: {x.modelos.join(', ')}</span>}</td>
                    <td>{c.paquete}<span className="sutil bloque">{c.sector}</span></td>
                    {COLUMNAS.map((col) => <td key={col.tipo} className="num">{x ? valor(x.fila, col) : '—'}</td>)}
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

function FilaPaquete({ grupo, nombre, comp, fila, estado }: { grupo: string | null; nombre: string; comp: string; fila: Fila; estado: React.ReactNode }) {
  return (
    <>
      {grupo && <tr className="grupo"><td colSpan={COLUMNAS.length + 3}>{grupo}</td></tr>}
      <tr>
        <td>{nombre}</td>
        <td>{estado}</td>
        <td className="num">{comp}</td>
        {COLUMNAS.map((c) => <td key={c.tipo} className="num">{valor(fila, c)}</td>)}
      </tr>
    </>
  );
}

/** Mapa chico: cada estructura con el color de su tipo. Clic para abrir su componente en la planta. */
function MapaResumen({ datos, verComponente, colorDe }: Pick<Props, 'datos' | 'verComponente'> & { colorDe: ((paquete: string) => string) | null }) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const { lat, lon } = datos.manifest.origen;
    const m = L.map(host.current, { center: [lat, lon], zoom: 14, preferCanvas: true, scrollWheelZoom: false });
    let vigente = true;
    void zoomMaxEsri(lon, lat).then((zmax) => {
      if (vigente) L.tileLayer(urlTeselaEsri('{z}', '{y}', '{x}'), { maxZoom: 21, maxNativeZoom: zmax, attribution: 'Imágenes © Esri' }).addTo(m);
    });
    const capa = L.geoJSON(datos.trazado as GeoJSON.FeatureCollection, {
      style: (f) => {
        const color = colorDe ? colorDe(f?.properties?.paquete) : COLOR_TIPO[f?.properties?.tipo_estructura] ?? COLOR_TIPO.Otros;
        return { color, weight: 2, fillColor: color, fillOpacity: 0.7 };
      },
      onEachFeature: (f, l) => {
        const p = f.properties ?? {};
        const largo = p.longitud_m ? ` · ${num(p.longitud_m)} ml` : '';
        l.bindTooltip(`<strong>${p.nombre}</strong>${largo}<br>${p.componente} · ${p.componente_desc ?? ''}`, { sticky: true });
        l.on('click', () => verComponente(p.componente, 'plano'));
      },
    }).addTo(m);
    const b = capa.getBounds();
    if (b.isValid()) m.fitBounds(b, { padding: [20, 20] });
    const obs = new ResizeObserver(() => m.invalidateSize());
    obs.observe(host.current);
    return () => { vigente = false; obs.disconnect(); m.remove(); };
  }, [datos, verComponente, colorDe]);
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
