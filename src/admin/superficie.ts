/**
 * Superficies topográficas propias (GeoTIFF de elevaciones o LandXML de Civil 3D) → grilla de elevaciones
 * en el CRS del proyecto, guardada como Uint16 (.bin) + metadatos en capas.json. Ambos formatos terminan en
 * la misma grilla, así la vista 3D dibuja todas igual.
 */
import proj4 from 'proj4';
import type { Grilla } from '../datos';
import { defCrs } from './raster';

/** Lado mayor de la grilla: 700 × 700 celdas son 1 MB, bajo el límite de publicación del visor. */
const MAX_LADO = 700;
const SIN_DATO = 65535;

export interface SuperficieLista {
  bin: Uint8Array;
  grilla: Grilla;
}

/** Cuantiza a Uint16 con el rango real de la superficie (precisión de milímetros en 65 m de desnivel). */
function empaquetar(z: Float32Array, base: Omit<Grilla, 'zmin' | 'zmax'>): SuperficieLista {
  let zmin = Infinity, zmax = -Infinity;
  for (const v of z) if (Number.isFinite(v)) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  if (!Number.isFinite(zmin)) throw new Error('la superficie no tiene elevaciones válidas en el área del archivo.');
  const rango = Math.max(zmax - zmin, 1e-6);
  const q = new Uint16Array(z.length);
  for (let i = 0; i < z.length; i++) q[i] = Number.isFinite(z[i]) ? Math.round(((z[i] - zmin) / rango) * (SIN_DATO - 1)) : SIN_DATO;
  return { bin: new Uint8Array(q.buffer), grilla: { ...base, zmin, zmax } };
}

/** Elevaciones de una grilla publicada; NaN donde no hay dato. */
export function desempaquetar(buf: ArrayBuffer, g: Grilla): Float32Array {
  const q = new Uint16Array(buf);
  const z = new Float32Array(q.length);
  const k = (g.zmax - g.zmin) / (SIN_DATO - 1);
  for (let i = 0; i < q.length; i++) z[i] = q[i] === SIN_DATO ? NaN : g.zmin + q[i] * k;
  return z;
}

function revisarUbicacion(e: number, n: number, origen: { e: number; n: number }) {
  if (Math.hypot(e - origen.e, n - origen.n) > 60000) {
    throw new Error('la superficie no cae en la zona del proyecto. Revisa que esté en UTM WGS 84 zona 17S (EPSG:32717).');
  }
}

/** ¿El GeoTIFF es de elevaciones (una banda con valores) y no una imagen? */
export async function esGeotiffDeElevaciones(buf: ArrayBuffer): Promise<boolean> {
  const g = await leerGeotiff(buf.slice(0));
  return g.numberOfRasters === 1 && !(g.maxs?.[0] <= 255 && g.mins?.[0] >= 0 && Number.isInteger(g.maxs?.[0]));
}

async function leerGeotiff(buf: ArrayBuffer) {
  // @ts-ignore — georaster no publica tipos propios.
  const gr = await import('georaster');
  const parse = (gr as any).default ?? gr;
  return parse(buf);
}

export async function superficieDeGeotiff(buf: ArrayBuffer, epsg: number, origen: { e: number; n: number }, avisar: (t: string) => void): Promise<SuperficieLista> {
  avisar('Leyendo el GeoTIFF de elevaciones…');
  const g = await leerGeotiff(buf);
  const srcEpsg = Number(g.projection);
  if (!srcEpsg || ![g.xmin, g.xmax, g.ymin, g.ymax].every(Number.isFinite)) throw new Error('el archivo no tiene georreferencia.');
  const mismo = srcEpsg === epsg;
  const p = mismo ? null : proj4(defCrs(epsg), defCrs(srcEpsg));
  const aProyecto = mismo ? null : proj4(defCrs(srcEpsg), defCrs(epsg));

  // Caja del ráster en el CRS del proyecto.
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const [x, y] of [[g.xmin, g.ymin], [g.xmin, g.ymax], [g.xmax, g.ymin], [g.xmax, g.ymax]]) {
    const [e, n] = aProyecto ? aProyecto.forward([x, y]) : [x, y];
    e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
  }
  revisarUbicacion((e0 + e1) / 2, (n0 + n1) / 2, origen);
  const pasoNativo = mismo ? Math.max(g.pixelWidth, g.pixelHeight) : (e1 - e0) / g.width;
  const paso = Math.max(pasoNativo, (e1 - e0) / MAX_LADO, (n1 - n0) / MAX_LADO);
  const ancho = Math.max(2, Math.floor((e1 - e0) / paso));
  const alto = Math.max(2, Math.floor((n1 - n0) / paso));
  const banda: number[][] = g.values[0];
  const z = new Float32Array(ancho * alto);
  for (let j = 0; j < alto; j++) {
    if (j % 100 === 0) { avisar(`Preparando la superficie… ${Math.round((j / alto) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
    const n = n1 - (j + 0.5) * paso;
    for (let i = 0; i < ancho; i++) {
      const e = e0 + (i + 0.5) * paso;
      const [x, y] = p ? p.forward([e, n]) : [e, n];
      const c = Math.floor((x - g.xmin) / g.pixelWidth);
      const r = Math.floor((g.ymax - y) / g.pixelHeight);
      const v = c >= 0 && r >= 0 && c < g.width && r < g.height ? banda[r][c] : NaN;
      z[j * ancho + i] = v === g.noDataValue || v < -1000 ? NaN : v;
    }
  }
  return empaquetar(z, { e0: e0 + paso / 2, n0: n1 - paso / 2, paso, ancho, alto });
}

/** Superficie TIN de LandXML (Civil 3D): <Pnts><P id>N E Z</P> y <Faces><F>a b c</F>, rasterizada a la grilla. */
export async function superficieDeLandXml(texto: string, origen: { e: number; n: number }, avisar: (t: string) => void): Promise<SuperficieLista & { nombre: string }> {
  avisar('Leyendo el LandXML…');
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('el archivo no es un XML válido.');
  const sup = [...doc.getElementsByTagName('Surface')].find((s) => s.getElementsByTagName('F').length);
  if (!sup) throw new Error('el LandXML no trae una superficie TIN (Surface con caras). Expórtala desde Civil 3D con «Exportar a LandXML».');
  const pts = new Map<string, [number, number, number]>();
  for (const p of sup.getElementsByTagName('P')) {
    const [n, e, z] = (p.textContent ?? '').trim().split(/\s+/).map(Number);
    if ([n, e, z].every(Number.isFinite)) pts.set(p.getAttribute('id') ?? '', [e, n, z]);
  }
  const caras: [number, number, number][][] = [];
  for (const f of sup.getElementsByTagName('F')) {
    if (f.getAttribute('i') === '1') continue; // cara invisible (borde o hueco)
    const t = (f.textContent ?? '').trim().split(/\s+/).map((id) => pts.get(id));
    if (t.length === 3 && t.every(Boolean)) caras.push(t as [number, number, number][]);
  }
  if (!caras.length) throw new Error('la superficie no tiene triángulos válidos.');
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const [e, n] of pts.values()) { e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n); }
  revisarUbicacion((e0 + e1) / 2, (n0 + n1) / 2, origen);

  const paso = Math.max((e1 - e0) / MAX_LADO, (n1 - n0) / MAX_LADO, 0.25);
  const ancho = Math.max(2, Math.ceil((e1 - e0) / paso) + 1);
  const alto = Math.max(2, Math.ceil((n1 - n0) / paso) + 1);
  const z = new Float32Array(ancho * alto).fill(NaN);
  // Cada celda toma la elevación del triángulo que contiene su centro (interpolación baricéntrica).
  for (const [k, [a, b, c]] of caras.entries()) {
    if (k % 20000 === 0) { avisar(`Preparando la superficie… ${Math.round((k / caras.length) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
    const iMin = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - e0) / paso));
    const iMax = Math.min(ancho - 1, Math.floor((Math.max(a[0], b[0], c[0]) - e0) / paso));
    const jMin = Math.max(0, Math.ceil((n1 - Math.max(a[1], b[1], c[1])) / paso));
    const jMax = Math.min(alto - 1, Math.floor((n1 - Math.min(a[1], b[1], c[1])) / paso));
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(det) < 1e-12) continue;
    for (let j = jMin; j <= jMax; j++) {
      const n = n1 - j * paso;
      for (let i = iMin; i <= iMax; i++) {
        const e = e0 + i * paso;
        const l1 = ((b[1] - c[1]) * (e - c[0]) + (c[0] - b[0]) * (n - c[1])) / det;
        const l2 = ((c[1] - a[1]) * (e - c[0]) + (a[0] - c[0]) * (n - c[1])) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        z[j * ancho + i] = l1 * a[2] + l2 * b[2] + l3 * c[2];
      }
    }
  }
  const nombre = sup.getAttribute('name') ?? '';
  return { ...empaquetar(z, { e0, n0: n1, paso, ancho, alto }), nombre };
}

/** Lee un archivo de superficie (.tif/.tiff de elevaciones o .xml LandXML). */
export async function leerSuperficie(f: File, epsg: number, origen: { e: number; n: number }, avisar: (t: string) => void): Promise<SuperficieLista & { nombre: string }> {
  const nombre = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  if (/\.(tif|tiff)$/i.test(f.name)) return { ...(await superficieDeGeotiff(await f.arrayBuffer(), epsg, origen, avisar)), nombre };
  if (/\.xml$/i.test(f.name)) {
    const r = await superficieDeLandXml(await f.text(), origen, avisar);
    return { ...r, nombre: r.nombre || nombre };
  }
  throw new Error('usa un GeoTIFF de elevaciones (.tif) o un LandXML de Civil 3D (.xml).');
}
