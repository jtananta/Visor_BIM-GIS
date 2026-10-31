import { useEffect, useMemo, useRef, useState } from 'react';
import { compararNatural, type CapaFija, type Componente, type Manifest, type Modelo } from '../datos';
import { leerVector } from '../gis';
import { aCsv, CAMPOS_COMPONENTE, leerExcel, ubicacionDe } from './catalogo';
import type { Proyecto, Reglas, Resultado } from './convertir';
import { guardarConexion, leerConexion, leerTexto, probarConexion, publicar, RAIZ_DATOS, type Cambios, type Conexion } from './github';
import { agregarModelos, archivosModelos, componentePorUbicacion, convertirEnWorker, parseCsv } from './modelos';
import { geotiffAWebp } from './raster';
import { esGeotiffDeElevaciones, leerSuperficie } from './superficie';

interface Pendiente {
  archivo: string;
  estado: 'esperando' | 'convirtiendo' | 'listo' | 'error';
  avance: number;
  texto: string;
  resultado?: Resultado;
  componente: string;
}

interface CapaNueva {
  nombre: string;
  archivo: string;
  tipo: CapaFija['tipo'];
  datos: Uint8Array;
  extra: Partial<CapaFija>;
}

/** Datos del repositorio que la página edita. */
interface Repo {
  manifest: Manifest;
  trazado: GeoJSON.FeatureCollection;
  componentes: Componente[];
  catalogo: Record<string, string>[];
  capas: CapaFija[];
}

export default function Admin() {
  const [con, setCon] = useState<Conexion>(leerConexion);
  const [recordar, setRecordar] = useState(true);
  const [conectado, setConectado] = useState(false);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [reglas, setReglas] = useState<Reglas | null>(null);
  const [proyecto, setProyecto] = useState<(Proyecto & { repositorio?: string }) | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error' | 'info'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [reasignar, setReasignar] = useState<Record<string, string>>({});
  const [quitar, setQuitar] = useState<Set<string>>(new Set());
  const [excel, setExcel] = useState<{ nombre: string; filas: Componente[] } | null>(null);
  const [capasNuevas, setCapasNuevas] = useState<CapaNueva[]>([]);
  const [capasQuitar, setCapasQuitar] = useState<Set<string>>(new Set());
  const [suelo, setSuelo] = useState<string | null>(null);
  const inIfc = useRef<HTMLInputElement | null>(null);
  const inExcel = useRef<HTMLInputElement | null>(null);
  const inCapa = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('data/reglas.json').then((r) => r.json()),
      fetch('data/proyecto.json').then((r) => r.json()),
    ]).then(([rg, pr]) => {
      setReglas(rg);
      setProyecto(pr);
    }).catch(() => setAviso({ tipo: 'error', texto: 'No se pudieron leer reglas.json y proyecto.json del sitio.' }));
  }, []);

  const conectar = async () => {
    setAviso(null);
    setOcupado('Conectando…');
    try {
      await probarConexion(con);
      guardarConexion(con, recordar);
      await recargar();
      setConectado(true);
    } catch (e) {
      setAviso({ tipo: 'error', texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setOcupado(null);
    }
  };

  const recargar = async () => {
    const [m, t, comp, cat, cap] = await Promise.all([
      leerTexto(con, `${RAIZ_DATOS}manifest.json`),
      leerTexto(con, `${RAIZ_DATOS}trazado.geojson`),
      leerTexto(con, `${RAIZ_DATOS}componentes.csv`),
      leerTexto(con, `${RAIZ_DATOS}catalogo.csv`),
      leerTexto(con, `${RAIZ_DATOS}capas/capas.json`),
    ]);
    const manifest: Manifest = m ? JSON.parse(m) : { proyecto: proyecto?.nombre ?? '', epsg: proyecto?.epsg ?? 32717, origen: { ...proyecto!.origen, lon: 0, lat: 0 }, modelos: [] };
    const capas: CapaFija[] = cap ? JSON.parse(cap) : [];
    setRepo({
      manifest,
      trazado: t ? JSON.parse(t) : { type: 'FeatureCollection', features: [] },
      componentes: comp ? (parseCsv(comp) as unknown as Componente[]) : [],
      catalogo: cat ? parseCsv(cat) : [],
      capas,
    });
    setSuelo(capas.find((c) => c.suelo)?.archivo ?? null);
    setReasignar({}); setQuitar(new Set()); setCapasQuitar(new Set());
  };

  const componentes = useMemo(() => [...(repo?.componentes ?? [])].sort((a, b) =>
    compararNatural(a.sector, b.sector) || compararNatural(a.paquete, b.paquete) || compararNatural(a.componente, b.componente)), [repo]);

  const selectorComponente = (valor: string, cambiar: (v: string) => void, id: string) => (
    <select id={id} value={valor} onChange={(e) => cambiar(e.target.value)}>
      {!componentes.some((c) => c.componente === valor) && <option value={valor}>{valor || 'Elegir componente…'}</option>}
      {[...new Set(componentes.map((c) => `${c.sector} · ${c.paquete}`))].map((g) => (
        <optgroup key={g} label={g}>
          {componentes.filter((c) => `${c.sector} · ${c.paquete}` === g).map((c) => (
            <option key={c.componente} value={c.componente}>{c.componente} · {c.descripcion}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  /* Modelos IFC ---------------------------------------------------------- */
  const agregarIfc = (files: File[]) => {
    const nuevos = files.filter((f) => /\.ifc$/i.test(f.name));
    if (nuevos.length < files.length) setAviso({ tipo: 'error', texto: 'Solo se aceptan archivos .ifc en esta sección.' });
    setPendientes((p) => [...p, ...nuevos.map((f) => ({ archivo: f.name, estado: 'esperando' as const, avance: 0, texto: 'En cola', componente: '' }))]);
    void convertirEnCola(nuevos);
  };

  const cola = useRef<Promise<void>>(Promise.resolve());
  const convertirEnCola = (files: File[]) => {
    for (const f of files) {
      cola.current = cola.current.then(() => convertirUno(f));
    }
  };

  const convertirUno = async (f: File) => {
    const actualizar = (patch: Partial<Pendiente>) => setPendientes((l) => l.map((x) => (x.archivo === f.name ? { ...x, ...patch } : x)));
    actualizar({ estado: 'convirtiendo', texto: 'Leyendo el archivo…' });
    try {
      const r = await convertirEnWorker(f, { reglas: reglas!, proyecto: proyecto!, componentes: repo?.componentes ?? [] },
        (texto, avance) => actualizar({ texto, avance }));
      const cerca = componentePorUbicacion(r.modelo.bbox_utm as number[], (repo?.manifest.modelos ?? []).filter((m) => m.codigo !== r.codigo));
      const porTexto = String(r.modelo.componente ?? '');
      const componente = cerca && repo?.componentes.some((c) => c.componente === cerca) ? cerca : porTexto;
      actualizar({ estado: 'listo', avance: 1, texto: componente !== porTexto ? 'Listo para publicar · componente sugerido por ubicación (revísalo)' : 'Listo para publicar', resultado: r, componente });
    } catch (e) {
      actualizar({ estado: 'error', texto: `No se pudo convertir: ${e instanceof Error ? e.message : e}` });
    }
  };

  const publicarModelos = async () => {
    if (!repo) return;
    const listos = pendientes.filter((p) => p.estado === 'listo' && p.resultado);
    setOcupado('Preparando la publicación…');
    setAviso(null);
    try {
      const cambios: Cambios = {};
      let modelos: Modelo[] = repo.manifest.modelos.filter((m) => !quitar.has(m.codigo));
      const features = repo.trazado.features.filter((f) => !quitar.has(String(f.properties?.modelo_codigo)));
      const catalogo = repo.catalogo.filter((c) => !quitar.has(c.codigo));
      for (const cod of quitar) cambios[`${RAIZ_DATOS}models/${cod}.glb`] = null;

      // Reasignaciones de componente de modelos ya publicados.
      modelos = modelos.map((m) => {
        const nuevo = reasignar[m.codigo];
        if (!nuevo || nuevo === m.componente) return m;
        const ub = ubicacionDe(repo.componentes.find((c) => c.componente === nuevo), nuevo);
        const fila = catalogo.find((c) => c.codigo === m.codigo);
        if (fila) { fila.componente = nuevo; fila.revisado = 'sí'; }
        return { ...m, ...ub };
      });

      const d = agregarModelos({ modelos, features, catalogo }, listos.map((p) => ({ resultado: p.resultado!, componente: p.componente })), repo.componentes, cambios);
      archivosModelos(repo.manifest, d, cambios);
      const partes = [
        listos.length ? `agrega/actualiza ${listos.map((p) => p.resultado!.descripcion).join(', ')}` : '',
        quitar.size ? `quita ${quitar.size} modelo(s)` : '',
        Object.keys(reasignar).length ? 'reasigna componentes' : '',
      ].filter(Boolean);
      await publicar(con, cambios, `Visor: ${partes.join('; ')}`, setOcupado);
      setPendientes((l) => l.filter((p) => p.estado !== 'listo'));
      await recargar();
      setAviso({ tipo: 'ok', texto: 'Publicado. El link público se actualiza solo en uno o dos minutos.' });
    } catch (e) {
      setAviso({ tipo: 'error', texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setOcupado(null);
    }
  };

  /* Catálogo (Excel de control) ---------------------------------------- */
  const leerCatalogo = async (f: File) => {
    setAviso(null);
    try {
      setExcel({ nombre: f.name, filas: await leerExcel(await f.arrayBuffer()) });
    } catch (e) {
      setAviso({ tipo: 'error', texto: `«${f.name}»: ${e instanceof Error ? e.message : e}` });
    }
  };

  const publicarCatalogo = async () => {
    if (!excel || !repo) return;
    setOcupado('Publicando el catálogo…');
    try {
      const cambios: Cambios = { [`${RAIZ_DATOS}componentes.csv`]: aCsv(excel.filas as unknown as Record<string, unknown>[], CAMPOS_COMPONENTE) };
      // Sector, paquete y descripción de cada modelo siguen al catálogo nuevo.
      const modelos = repo.manifest.modelos.map((m) => ({ ...m, ...ubicacionDe(excel.filas.find((c) => c.componente === m.componente), m.componente) }));
      cambios[`${RAIZ_DATOS}manifest.json`] = JSON.stringify({ ...repo.manifest, modelos }, null, 2);
      await publicar(con, cambios, `Visor: catálogo actualizado desde ${excel.nombre}`, setOcupado);
      setExcel(null);
      await recargar();
      setAviso({ tipo: 'ok', texto: 'Catálogo publicado. Los estados se ven en el link público en uno o dos minutos.' });
    } catch (e) {
      setAviso({ tipo: 'error', texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setOcupado(null);
    }
  };

  /* Capas GIS fijas ------------------------------------------------------ */
  const agregarCapa = async (f: File) => {
    setAviso(null);
    const base = f.name.replace(/\.[^.]+$/, '');
    const slug = base.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'capa';
    setOcupado(`Preparando «${f.name}»…`);
    try {
      if (/\.xml$/i.test(f.name) || (/\.(tif|tiff)$/i.test(f.name) && await esGeotiffDeElevaciones(await f.arrayBuffer()))) {
        // Superficie topográfica: se ve como relieve en la vista 3D.
        const r = await leerSuperficie(f, repo?.manifest.epsg ?? 32717, repo?.manifest.origen ?? proyecto!.origen, setOcupado);
        setCapasNuevas((l) => [...l, { nombre: r.nombre, archivo: `capas/${slug}.bin`, tipo: 'superficie', datos: r.bin, extra: { grilla: r.grilla } }]);
      } else if (/\.(tif|tiff)$/i.test(f.name)) {
        const r = await geotiffAWebp(await f.arrayBuffer(), setOcupado);
        setCapasNuevas((l) => [...l, { nombre: base.replace(/_/g, ' '), archivo: `capas/${slug}.webp`, tipo: 'raster', datos: r.webp, extra: { bounds: r.bounds } }]);
        if (!suelo) setSuelo(`capas/${slug}.webp`);
      } else if (/\.(geojson|json|kml|zip)$/i.test(f.name)) {
        const gj = await leerVector(f.name, await f.arrayBuffer());
        const colores = ['#E8590C', '#7048E8', '#0CA678', '#D6336C', '#1C7ED6', '#F59F00'];
        const n = (repo?.capas.length ?? 0) + capasNuevas.length;
        setCapasNuevas((l) => [...l, { nombre: base.replace(/_/g, ' '), archivo: `capas/${slug}.geojson`, tipo: 'vector',
          datos: new TextEncoder().encode(JSON.stringify(gj)), extra: { color: colores[n % colores.length] } }]);
      } else {
        throw new Error('el formato no se reconoce. Usa GeoTIFF, GeoJSON, KML, un Shapefile comprimido en .zip o un LandXML.');
      }
    } catch (e) {
      setAviso({ tipo: 'error', texto: `«${f.name}»: ${e instanceof Error ? e.message : e}` });
    } finally {
      setOcupado(null);
    }
  };

  const publicarCapas = async () => {
    if (!repo) return;
    setOcupado('Publicando capas…');
    try {
      const cambios: Cambios = {};
      const quedan = repo.capas.filter((c) => !capasQuitar.has(c.archivo));
      for (const a of capasQuitar) cambios[`${RAIZ_DATOS}${a}`] = null;
      const nuevas: CapaFija[] = capasNuevas.map((c) => {
        cambios[`${RAIZ_DATOS}${c.archivo}`] = c.datos;
        return { nombre: c.nombre, tipo: c.tipo, archivo: c.archivo, visible: true, ...c.extra };
      });
      const todas = [...quedan.filter((c) => !nuevas.some((n) => n.archivo === c.archivo)), ...nuevas]
        .map((c) => ({ ...c, suelo: c.tipo === 'raster' && c.archivo === suelo ? true : undefined }));
      cambios[`${RAIZ_DATOS}capas/capas.json`] = JSON.stringify(todas, null, 2);
      await publicar(con, cambios, 'Visor: capas GIS actualizadas', setOcupado);
      setCapasNuevas([]);
      await recargar();
      setAviso({ tipo: 'ok', texto: 'Capas publicadas. Se ven en el link público en uno o dos minutos.' });
    } catch (e) {
      setAviso({ tipo: 'error', texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setOcupado(null);
    }
  };

  const hayCambiosModelos = pendientes.some((p) => p.estado === 'listo') || quitar.size > 0 ||
    Object.entries(reasignar).some(([cod, v]) => repo?.manifest.modelos.find((m) => m.codigo === cod)?.componente !== v);
  const hayCambiosCapas = capasNuevas.length > 0 || capasQuitar.size > 0 || (repo && (repo.capas.find((c) => c.suelo)?.archivo ?? null) !== suelo);

  return (
    <div className="admin">
      <header className="barra">
        <div className="titulo">
          <span className="titulo-sup">Administrar visor</span>
          <span className="titulo-main">{proyecto?.nombre ?? 'Visor gerencial'}</span>
        </div>
        <a className="btn" href="./">Volver al visor</a>
      </header>

      <main className="admin-cuerpo">
        {aviso && <div className={`aviso-admin ${aviso.tipo}`} role="status" onClick={() => setAviso(null)}>{aviso.texto}</div>}
        {ocupado && <div className="aviso-admin info" role="status">{ocupado}</div>}

        <section className="tarjeta">
          <h2>1. Clave de publicación</h2>
          <p className="sutil">Lo que publiques aquí se guarda en el repositorio del visor y el link público se actualiza solo en uno o dos minutos.</p>
          <div className="campos">
            <label htmlFor="clave" className="ancho">Clave de publicación<input id="clave" type="password" value={con.clave} autoComplete="off"
              onChange={(e) => setCon({ clave: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && con.clave) void conectar(); }} /></label>
          </div>
          <div className="fila-acciones">
            <label className="check" htmlFor="recordar"><input id="recordar" type="checkbox" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} /> Recordar en este navegador</label>
            <button className="btn btn-primario angosto" onClick={conectar} disabled={!con.clave || !reglas || !!ocupado}>{conectado ? 'Volver a cargar' : 'Entrar'}</button>
          </div>
          {conectado && <p className="ok-linea">Listo: puedes publicar.</p>}
        </section>

        {conectado && repo && (
          <>
            <section className="tarjeta">
              <h2>2. Modelos BIM</h2>
              <p className="sutil">Elige uno o varios IFC. Se convierten en este navegador (no se suben los IFC, solo el modelo liviano).
                Revisa el componente sugerido y publica.</p>
              <div className="tabla-scroll"><table className="tabla">
                <thead><tr><th>Modelo</th><th>Componente</th><th className="num">Estructuras</th><th /></tr></thead>
                <tbody>
                  {repo.manifest.modelos.length === 0 && <tr><td colSpan={4} className="sutil">Todavía no hay modelos publicados.</td></tr>}
                  {repo.manifest.modelos.map((m) => (
                    <tr key={m.codigo} className={quitar.has(m.codigo) ? 'tachado' : ''}>
                      <td><strong>{m.modelo}</strong><span className="sutil bloque">{m.codigo}</span></td>
                      <td>{selectorComponente(reasignar[m.codigo] ?? m.componente, (v) => setReasignar({ ...reasignar, [m.codigo]: v }), `comp-${m.codigo}`)}</td>
                      <td className="num">{m.estructuras}</td>
                      <td><button className="btn chico" onClick={() => setQuitar((q) => { const n = new Set(q); if (n.has(m.codigo)) n.delete(m.codigo); else n.add(m.codigo); return n; })}>
                        {quitar.has(m.codigo) ? 'Mantener' : 'Quitar'}</button></td>
                    </tr>
                  ))}
                  {pendientes.map((p) => (
                    <tr key={p.archivo} className="pendiente">
                      <td><strong>{p.resultado?.descripcion ?? p.archivo}</strong><span className="sutil bloque">{p.archivo}</span>
                        {p.estado === 'convirtiendo' && <div className="barra-progreso"><span style={{ width: `${p.avance * 100}%` }} /></div>}
                        <span className={`sutil bloque ${p.estado === 'error' ? 'error-texto' : ''}`}>
                          {p.estado === 'listo' && p.resultado
                            ? `Nuevo · ${Object.entries(p.resultado.reporte.tipos).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(', ')} · ${p.resultado.reporte.kb} KB`
                            : p.texto}
                        </span>
                      </td>
                      <td>{p.estado === 'listo' && selectorComponente(p.componente, (v) => setPendientes((l) => l.map((x) => (x.archivo === p.archivo ? { ...x, componente: v } : x))), `comp-n-${p.archivo}`)}</td>
                      <td className="num">{p.resultado?.reporte.estructuras ?? ''}</td>
                      <td>{p.estado !== 'convirtiendo' && <button className="btn chico" onClick={() => setPendientes((l) => l.filter((x) => x !== p))}>Descartar</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <div className="fila-acciones">
                <button className="btn" onClick={() => inIfc.current?.click()}>Agregar IFC…</button>
                <button className="btn btn-primario angosto" onClick={publicarModelos} disabled={!hayCambiosModelos || !!ocupado || pendientes.some((p) => p.estado === 'convirtiendo')}>Publicar modelos</button>
              </div>
              <input ref={inIfc} type="file" accept=".ifc" multiple hidden onChange={(e) => { agregarIfc(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            </section>

            <section className="tarjeta">
              <h2>3. Catálogo y estados</h2>
              <p className="sutil">Sube el Excel «PAQUETES Y COMPONENTES» (hoja CONTROL GENERAL). El estado de cada componente que ve gerencia sale de la columna ESTADO.</p>
              <p>Catálogo actual: <strong>{repo.componentes.length}</strong> componentes en {new Set(repo.componentes.map((c) => c.paquete)).size} paquetes.</p>
              {excel && (
                <div className="vista-previa">
                  <strong>{excel.nombre}</strong>: {excel.filas.length} componentes ·{' '}
                  {Object.entries(excel.filas.reduce<Record<string, number>>((a, c) => ({ ...a, [c.estado]: (a[c.estado] ?? 0) + 1 }), {})).map(([e, n]) => `${n} ${e.toLowerCase()}`).join(', ')}
                </div>
              )}
              <div className="fila-acciones">
                <button className="btn" onClick={() => inExcel.current?.click()}>Elegir Excel…</button>
                <button className="btn btn-primario angosto" onClick={publicarCatalogo} disabled={!excel || !!ocupado}>Publicar catálogo</button>
              </div>
              <input ref={inExcel} type="file" accept=".xlsx,.xls" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void leerCatalogo(f); e.target.value = ''; }} />
            </section>

            <section className="tarjeta">
              <h2>4. Capas GIS fijas</h2>
              <p className="sutil">Ortofotos y rasters (GeoTIFF), mapas GIS (GeoJSON, KML o Shapefile en .zip) y superficies topográficas
                (GeoTIFF de elevaciones o LandXML de Civil 3D, que se ven con relieve en la vista 3D). Todos los que abran el link las ven.
                Una ortofoto marcada como suelo se usa además como terreno de la vista 3D.</p>
              <div className="tabla-scroll"><table className="tabla">
                <thead><tr><th>Capa</th><th>Tipo</th><th>Suelo 3D</th><th /></tr></thead>
                <tbody>
                  {repo.capas.length + capasNuevas.length === 0 && <tr><td colSpan={4} className="sutil">Todavía no hay capas fijas.</td></tr>}
                  {[...repo.capas.map((c) => ({ ...c, nueva: false })), ...capasNuevas.map((c) => ({ ...c, ...c.extra, visible: true, nueva: true }))].map((c) => (
                    <tr key={c.archivo} className={capasQuitar.has(c.archivo) ? 'tachado' : c.nueva ? 'pendiente' : ''}>
                      <td><strong>{c.nombre}</strong>{c.nueva && <span className="sutil bloque">Nueva</span>}</td>
                      <td>{{ raster: 'Ortofoto / ráster', vector: 'Mapa GIS', superficie: 'Superficie 3D' }[c.tipo]}</td>
                      <td>{c.tipo === 'raster' && <input type="radio" name="suelo" aria-label={`Usar ${c.nombre} como suelo 3D`} checked={suelo === c.archivo} onChange={() => setSuelo(c.archivo)} />}</td>
                      <td>{c.nueva
                        ? <button className="btn chico" onClick={() => setCapasNuevas((l) => l.filter((x) => x.archivo !== c.archivo))}>Descartar</button>
                        : <button className="btn chico" onClick={() => setCapasQuitar((q) => { const n = new Set(q); if (n.has(c.archivo)) n.delete(c.archivo); else n.add(c.archivo); return n; })}>
                          {capasQuitar.has(c.archivo) ? 'Mantener' : 'Quitar'}</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <div className="fila-acciones">
                <button className="btn" onClick={() => inCapa.current?.click()} disabled={!!ocupado}>Agregar capa…</button>
                <button className="btn btn-primario angosto" onClick={publicarCapas} disabled={!hayCambiosCapas || !!ocupado}>Publicar capas</button>
              </div>
              <input ref={inCapa} type="file" accept=".tif,.tiff,.geojson,.json,.kml,.zip,.xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void agregarCapa(f); e.target.value = ''; }} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
