import proj4 from 'proj4';

/** Metadata mínima de una estructura: lo único que ve gerencia. */
export interface Estructura {
  codigo: string;
  nombre: string;
  paquete: string;
  componente: string;
  componente_desc: string;
  modelo: string;
  modelo_codigo: string;
  tipo_estructura: string;
  sector: string;
}

export interface Modelo {
  codigo: string;
  modelo: string;
  paquete: string;
  sector: string;
  componente: string;
  componente_desc: string;
  glb: string;
  estructuras: number;
  tipos: Record<string, number>;
  /** [minE, minN, maxE, maxN] en el CRS del proyecto. */
  bbox_utm: [number, number, number, number];
}

export interface Manifest {
  proyecto: string;
  epsg: number;
  origen: { e: number; n: number; z: number; lon: number; lat: number };
  modelos: Modelo[];
}

/** Fila del Excel de control de paquetes y componentes. */
export interface Componente {
  sector: string;
  paquete: string;
  componente: string;
  descripcion: string;
  estado: string;
  avance: string;
  responsable: string;
  fecha: string;
  observaciones: string;
}

/** Capa GIS fija del proyecto, preparada por pipeline/capas.py. */
/** Grilla de una superficie topográfica en el CRS del proyecto (archivo .bin de Uint16). */
export interface Grilla {
  /** Esquina noroeste: este de la primera columna y norte de la primera fila, en el centro de la celda. */
  e0: number;
  n0: number;
  paso: number;
  ancho: number;
  alto: number;
  zmin: number;
  zmax: number;
}

export interface CapaFija {
  nombre: string;
  tipo: 'raster' | 'vector' | 'superficie';
  archivo: string;
  visible: boolean;
  color?: string;
  /** [[latS, lonO], [latN, lonE]] de la imagen en Web Mercator. */
  bounds?: [[number, number], [number, number]];
  suelo?: boolean;
  /** Solo superficies: ubicación de la grilla de elevaciones. */
  grilla?: Grilla;
  /** Capa subida en este navegador y aún no publicada: su archivo vive en memoria. */
  local?: Uint8Array;
}

export type Trazado = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point, Estructura>;

export interface Datos {
  manifest: Manifest;
  trazado: Trazado;
  /** Catálogo completo, incluidos los componentes que aún no tienen modelo. */
  componentes: Componente[];
  capas: CapaFija[];
}

/** Caja en el CRS del proyecto: [minE, minN, maxE, maxN]. */
export type Caja = [number, number, number, number];

/* ------------------------------------------------------------------ */
/* Carga                                                               */
/* ------------------------------------------------------------------ */

function parseCsv(texto: string): Record<string, string>[] {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return [];
  const partir = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) {
        if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === ';') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const cab = partir(lineas[0]);
  return lineas.slice(1).map((l) => {
    const v = partir(l);
    return Object.fromEntries(cab.map((k, i) => [k, v[i] ?? '']));
  });
}

export async function cargarDatos(base = 'data/'): Promise<Datos> {
  const [manifest, trazado, compTxt, capas] = await Promise.all([
    fetch(`${base}manifest.json`).then((r) => { if (!r.ok) throw new Error('manifest.json'); return r.json(); }),
    fetch(`${base}trazado.geojson`).then((r) => { if (!r.ok) throw new Error('trazado.geojson'); return r.json(); }),
    fetch(`${base}componentes.csv`).then((r) => (r.ok ? r.text() : '')).catch(() => ''),
    fetch(`${base}capas/capas.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  const componentes = parseCsv(compTxt).filter((f) => f.componente) as unknown as Componente[];
  for (const f of (trazado as Trazado).features) Object.assign(f.properties, ubicacionModelo(manifest, f.properties.modelo_codigo));
  return { manifest, trazado, componentes, capas: Array.isArray(capas) ? capas : [] };
}

/**
 * Sector, paquete y componente de un modelo según el manifest. Prevalecen sobre lo grabado en el GLB,
 * así reasignar un modelo a otro componente solo cambia el manifest y no obliga a reconvertir el IFC.
 */
export function ubicacionModelo(manifest: Manifest, codigo: string): Partial<Estructura> {
  const m = manifest.modelos.find((x) => x.codigo === codigo);
  return m ? { sector: m.sector, paquete: m.paquete, componente: m.componente, componente_desc: m.componente_desc, modelo: m.modelo } : {};
}

export interface Estado {
  estado: string;
  observaciones: string;
}

/** El estado de coordinación es el del componente en el Excel de control. */
export function estadoDe(datos: Datos, componente: string): Estado {
  const c = datos.componentes.find((x) => x.componente === componente);
  return { estado: c?.estado || 'Sin asignar', observaciones: c?.observaciones || '' };
}

/** Orden natural: "Paquete 9" antes que "Paquete 20", "Componente 11.3" después de "Componente 5". */
export function compararNatural(a: string, b: string): number {
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

/* ------------------------------------------------------------------ */
/* Coordenadas                                                         */
/* ------------------------------------------------------------------ */

function defUtm(epsg: number): string {
  // 326xx = UTM norte, 327xx = UTM sur (WGS 84).
  const zona = epsg % 100;
  const sur = Math.floor(epsg / 100) === 327;
  return `+proj=utm +zone=${zona} ${sur ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
}

export function crearProyeccion(epsg: number) {
  const p = proj4('EPSG:4326', defUtm(epsg));
  return {
    aUtm: (lon: number, lat: number) => p.forward([lon, lat]) as [number, number],
    aLonLat: (e: number, n: number) => p.inverse([e, n]) as [number, number],
  };
}

export function unirCajas(cajas: Caja[]): Caja | null {
  if (!cajas.length) return null;
  return cajas.reduce<Caja>(
    (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

/* ------------------------------------------------------------------ */
/* Colores                                                             */
/* ------------------------------------------------------------------ */

export type ModoColor = 'sector' | 'paquete' | 'estado' | 'tipo';

/** Estados del Excel de control (Completado, En proceso, Observado, Pendiente). */
export const COLOR_ESTADO: Record<string, string> = {
  Completado: '#2E8B57',
  'En proceso': '#D99A1E',
  Observado: '#C62828',
  Pendiente: '#7A8794',
  'Sin asignar': '#9AA5B1',
};

export const COLOR_TIPO: Record<string, string> = {
  Buzón: '#2F6FB5',
  Sumidero: '#1A9A8B',
  Tubería: '#D98A26',
  Gaviones: '#8C7F66',
  Canal: '#8E979F',
  Otros: '#A3A3A3',
};

const PALETA_SECTOR = ['#1769AA', '#E07B39', '#2E9E6A', '#8E5CC2', '#C9405A', '#3AA7C9', '#B8A030', '#6B7A8F'];

export function colorSector(sectores: string[], s: string): string {
  const i = sectores.indexOf(s);
  return PALETA_SECTOR[(i < 0 ? 0 : i) % PALETA_SECTOR.length];
}

export function colorDe(modo: ModoColor, datos: Datos, sectores: string[], e: Estructura, paquetes: string[] = []): string {
  if (modo === 'estado') return COLOR_ESTADO[estadoDe(datos, e.componente).estado] ?? COLOR_ESTADO['Sin asignar'];
  if (modo === 'paquete') return colorSector(paquetes, e.paquete);
  if (modo === 'tipo') return COLOR_TIPO[e.tipo_estructura] ?? COLOR_TIPO.Otros;
  return colorSector(sectores, e.sector);
}
