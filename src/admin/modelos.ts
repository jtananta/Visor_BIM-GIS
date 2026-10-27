/**
 * Conversión y publicación de modelos IFC, compartida por la página de administración y el botón
 * «Subir IFC» del visor.
 */
import { compararNatural, type Componente, type Manifest, type Modelo } from '../datos';
import { aCsv, ubicacionDe } from './catalogo';
import type { Proyecto, Reglas, Resultado } from './convertir';
import type { Pedido } from './convertir.worker';
import { leerTexto, publicar, RAIZ_DATOS, type Cambios, type Conexion } from './github';

export interface Contexto {
  reglas: Reglas;
  proyecto: Proyecto;
  componentes: Componente[];
}

export async function leerContexto(componentes: Componente[]): Promise<Contexto> {
  const [reglas, proyecto] = await Promise.all([
    fetch('data/reglas.json').then((r) => r.json()),
    fetch('data/proyecto.json').then((r) => r.json()),
  ]);
  return { reglas, proyecto, componentes };
}

/** Convierte un IFC en un worker para que la página no se congele con archivos de 100 MB o más. */
export function convertirEnWorker(f: File, ctx: Contexto, avance: (texto: string, fraccion: number) => void): Promise<Resultado> {
  return new Promise((ok, mal) => {
    const worker = new Worker(new URL('./convertir.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.tipo === 'avance') avance(m.texto, m.fraccion ?? 0);
      if (m.tipo === 'listo') { worker.terminate(); ok(m.resultado); }
      if (m.tipo === 'error') { worker.terminate(); mal(new Error(m.mensaje)); }
    };
    worker.onerror = (e) => { worker.terminate(); mal(new Error(e.message)); };
    f.arrayBuffer().then((datos) => {
      const pedido: Pedido = {
        datos, archivo: f.name, reglas: ctx.reglas, proyecto: ctx.proyecto, componentes: ctx.componentes, componente: '',
        wasmDir: new URL('wasm/', document.baseURI).href,
      };
      worker.postMessage(pedido, [datos]);
    }, mal);
  });
}

/** Modelo listo para el manifest y su trazado, ya ubicados en el componente elegido. */
export function ubicarResultado(r: Resultado, componente: string, componentes: Componente[]) {
  const ub = ubicacionDe(componentes.find((c) => c.componente === componente), componente);
  return {
    modelo: { ...(r.modelo as unknown as Modelo), ...ub },
    features: r.features.map((f) => ({ ...f, properties: { ...f.properties, ...ub } })),
  };
}

export interface Listo {
  resultado: Resultado;
  componente: string;
}

export interface DatosModelos {
  modelos: Modelo[];
  features: GeoJSON.Feature[];
  catalogo: Record<string, string>[];
}

/** Agrega o reemplaza modelos convertidos; deja en `cambios` los GLB a subir. */
export function agregarModelos(base: DatosModelos, listos: Listo[], componentes: Componente[], cambios: Cambios): DatosModelos {
  let { modelos, features } = base;
  const catalogo = [...base.catalogo];
  for (const { resultado: r, componente } of listos) {
    const u = ubicarResultado(r, componente, componentes);
    modelos = [...modelos.filter((m) => m.codigo !== r.codigo), u.modelo];
    features = [...features.filter((f) => f.properties?.modelo_codigo !== r.codigo), ...u.features];
    const fila = { codigo: r.codigo, modelo: r.descripcion, componente, descripcion_ifc: r.edificio, revisado: 'sí' };
    const i = catalogo.findIndex((c) => c.codigo === r.codigo);
    if (i >= 0) catalogo[i] = fila; else catalogo.push(fila);
    cambios[`${RAIZ_DATOS}models/${r.codigo}.glb`] = r.glb;
  }
  modelos = [...modelos].sort((a, b) => compararNatural(a.codigo, b.codigo));
  return { modelos, features, catalogo };
}

/** Archivos de datos que cambian al publicar modelos. */
export function archivosModelos(manifest: Manifest, d: DatosModelos, cambios: Cambios) {
  cambios[`${RAIZ_DATOS}manifest.json`] = JSON.stringify({ ...manifest, modelos: d.modelos }, null, 2);
  cambios[`${RAIZ_DATOS}trazado.geojson`] = JSON.stringify({ type: 'FeatureCollection', features: d.features });
  cambios[`${RAIZ_DATOS}catalogo.csv`] = aCsv(d.catalogo, ['codigo', 'modelo', 'componente', 'descripcion_ifc', 'revisado']);
}

export function parseCsv(t: string): Record<string, string>[] {
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

/** Publica modelos leyendo antes el estado actual del repositorio, para no pisar cambios de otros. */
export async function publicarModelos(con: Conexion, listos: Listo[], componentes: Componente[], avisar: (t: string) => void): Promise<void> {
  avisar('Leyendo el estado actual del visor…');
  const [m, t, cat] = await Promise.all([
    leerTexto(con, `${RAIZ_DATOS}manifest.json`),
    leerTexto(con, `${RAIZ_DATOS}trazado.geojson`),
    leerTexto(con, `${RAIZ_DATOS}catalogo.csv`),
  ]);
  if (!m) throw new Error(`No encontré ${RAIZ_DATOS}manifest.json en el repositorio.`);
  const manifest: Manifest = JSON.parse(m);
  const cambios: Cambios = {};
  const d = agregarModelos({
    modelos: manifest.modelos,
    features: t ? JSON.parse(t).features : [],
    catalogo: cat ? parseCsv(cat) : [],
  }, listos, componentes, cambios);
  archivosModelos(manifest, d, cambios);
  await publicar(con, cambios, `Visor: agrega/actualiza ${listos.map((l) => l.resultado.descripcion).join(', ')}`, avisar);
}
