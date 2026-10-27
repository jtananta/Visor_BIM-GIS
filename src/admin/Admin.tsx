import { useEffect, useMemo, useRef, useState } from 'react';
import { compararNatural, type CapaFija, type Componente, type Manifest, type Modelo } from '../datos';
import { leerVector } from '../gis';
import { aCsv, CAMPOS_COMPONENTE, leerExcel, ubicacionDe } from './catalogo';
import type { Proyecto, Reglas, Resultado } from './convertir';
import type { Pedido } from './convertir.worker';
import { leerTexto, probarConexion, publicar, RAIZ_DATOS, type Cambios, type Conexion } from './github';
import { geotiffAWebp } from './raster';

const CLAVE = 'visor-gerencial-conexion';

function leerConexion(): Conexion {
  try {
    const c = JSON.parse(localStorage.getItem(CLAVE) ?? '{}');
    return { repo: c.repo ?? '', rama: c.rama ?? 'main', token: c.token ?? '' };
  } catch {
    return { repo: '', rama: 'main', token: '' };
  }
}

function parseCsv(t: string): Record<string, string>[] {
  const lineas = t.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const partir = (l: string) => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const cab = lineas.length ? partir(lineas[0]) : [];
  return lineas.slice(1).map((l) => { const v = partir(l); return Object.fromEntries(cab.map((k, i) => [k, v[i] ?? ''])); });
}

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
  tipo: 'raster' | 'vector';
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
      setCon((c) => (c.repo ? c : { ...c, repo: pr.repositorio ?? '' }));
    }).catch(() => setAviso({ tipo: 'error', texto: 'No se pudieron leer reglas.json y proyecto.json del sitio.' }));
  }, []);

  const conectar = async () => {
    setAviso(null);
    setOcupado('Conectando con GitHub…');
    try {
      await probarConexion(con);
      try {
        if (recordar) localStorage.setItem(CLAVE, JSON.stringify(con));
        else localStorage.removeItem(CLAVE);
      } catch { /* almacenamiento bloqueado: solo dura esta sesión */ }
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

  const convertirUno = (f: File) => new Promise<void>((fin) => {
    const actualizar = (patch: Partial<Pendiente>) => setPendientes((l) => l.map((x) => (x.archivo === f.name ? { ...x, ...patch } : x)));
    actualizar({ estado: 'convirtiendo', texto: 'Leyendo el archivo…' });
    const worker = new Worker(new URL('./convertir.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.tipo === 'avance') actualizar({ texto: m.texto, avance: m.fraccion ?? 0 });
      if (m.tipo === 'listo') {
        const r: Resultado = m.resultado;
        actualizar({ estado: 'listo', avance: 1, texto: 'Listo para publicar', resultado: r, componente: String(r.modelo.componente ?? '') });
        worker.terminate(); fin();
      }
      if (m.tipo === 'error') {
        actualizar({ estado: 'error', texto: `No se pudo convertir: ${m.mensaje}` });
        worker.terminate(); fin();
      }
    };
    worker.onerror = (e) => { actualizar({ estado: 'error', texto: `No se pudo convertir: ${e.message}` }); worker.terminate(); fin(); };
    f.arrayBuffer().then((datos) => {
      const pedido: Pedido = {
        datos, archivo: f.name, reglas: reglas!, proyecto: proyecto!, componentes: repo?.componentes ?? [], componente: '',
        wasmDir: new URL('wasm/', document.baseURI).href,
      };
      worker.postMessage(pedido, [datos]);
    });
  });

  const publicarModelos = async () => {
    if (!repo) return;
    const listos = pendientes.filter((p) => p.estado === 'listo' && p.resultado);
    setOcupado('Preparando la publicación…');
    setAviso(null);
    try {
      const cambios: Cambios = {};
      let modelos: Modelo[] = repo.manifest.modelos.filter((m) => !quitar.has(m.codigo));
      let features = repo.trazado.features.filter((f) => !quitar.has(String(f.properties?.modelo_codigo)));
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

      for (const p of listos) {
        const r = p.resultado!;
        const ub = ubicacionDe(repo.componentes.find((c) => c.componente === p.componente), p.componente);
        const modelo = { ...(r.modelo as unknown as Modelo), ...ub };
        modelos = [...modelos.filter((m) => m.codigo !== r.codigo), modelo];
        features = [...features.filter((f) => f.properties?.modelo_codigo !== r.codigo),
          ...r.features.map((f) => ({ ...f, properties: { ...f.properties, ...ub } }))];
        const i = catalogo.findIndex((c) => c.codigo === r.codigo);
        const fila = { codigo: r.codigo, modelo: r.descripcion, componente: p.componente, descripcion_ifc: r.edificio, revisado: 'sí' };
        if (i >= 0) catalogo[i] = fila; else catalogo.push(fila);
        cambios[`${RAIZ_DATOS}models/${r.codigo}.glb`] = r.glb;
      }

      modelos.sort((a, b) => compararNatural(a.codigo, b.codigo));
      cambios[`${RAIZ_DATOS}manifest.json`] = JSON.stringify({ ...repo.manifest, modelos }, null, 2);
      cambios[`${RAIZ_DATOS}trazado.geojson`] = JSON.stringify({ type: 'FeatureCollection', features });
      cambios[`${RAIZ_DATOS}catalogo.csv`] = aCsv(catalogo, ['codigo', 'modelo', 'componente', 'descripcion_ifc', 'revisado']);
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
      if (/\.(tif|tiff)$/i.test(f.name)) {
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
        throw new Error('el formato no se reconoce. Usa GeoTIFF, GeoJSON, KML o un Shapefile comprimido en .zip.');
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
          <h2>1. Conexión con el repositorio</h2>
          <p className="sutil">Lo que publiques aquí se guarda en el repositorio de GitHub del visor y el link público se actualiza solo.
            Necesitas un token de GitHub con permiso <strong>Contents: Read and write</strong> sobre ese repositorio.</p>
          <div className="campos">
            <label htmlFor="repo">Repositorio<input id="repo" value={con.repo} placeholder="usuario/visor-gerencial-drenaje" onChange={(e) => setCon({ ...con, repo: e.target.value.trim() })} /></label>
            <label htmlFor="rama">Rama<input id="rama" value={con.rama} onChange={(e) => setCon({ ...con, rama: e.target.value.trim() })} /></label>
            <label htmlFor="token" className="ancho">Token de GitHub<input id="token" type="password" value={con.token} placeholder="github_pat_…" onChange={(e) => setCon({ ...con, token: e.target.value.trim() })} /></label>
          </div>
          <div className="fila-acciones">
            <label className="check" htmlFor="recordar"><input id="recordar" type="checkbox" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} /> Recordar en este navegador</label>
            <button className="btn btn-primario angosto" onClick={conectar} disabled={!con.repo || !con.token || !reglas || !!ocupado}>{conectado ? 'Reconectar' : 'Conectar'}</button>
          </div>
          {conectado && <p className="ok-linea">Conectado a {con.repo} ({con.rama}).</p>}
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
              <p className="sutil">Ortofotos y rasters (GeoTIFF) o mapas GIS (GeoJSON, KML o Shapefile en .zip). Todos los que abran el link las ven.
                Una ortofoto marcada como suelo se usa además como terreno de la vista 3D.</p>
              <div className="tabla-scroll"><table className="tabla">
                <thead><tr><th>Capa</th><th>Tipo</th><th>Suelo 3D</th><th /></tr></thead>
                <tbody>
                  {repo.capas.length + capasNuevas.length === 0 && <tr><td colSpan={4} className="sutil">Todavía no hay capas fijas.</td></tr>}
                  {[...repo.capas.map((c) => ({ ...c, nueva: false })), ...capasNuevas.map((c) => ({ ...c, ...c.extra, visible: true, nueva: true }))].map((c) => (
                    <tr key={c.archivo} className={capasQuitar.has(c.archivo) ? 'tachado' : c.nueva ? 'pendiente' : ''}>
                      <td><strong>{c.nombre}</strong>{c.nueva && <span className="sutil bloque">Nueva</span>}</td>
                      <td>{c.tipo === 'raster' ? 'Ortofoto / ráster' : 'Mapa GIS'}</td>
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
              <input ref={inCapa} type="file" accept=".tif,.tiff,.geojson,.json,.kml,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void agregarCapa(f); e.target.value = ''; }} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
