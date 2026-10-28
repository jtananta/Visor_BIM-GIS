/**
 * GeoTIFF → WebP en Web Mercator + límites, el mismo formato que deja pipeline/capas.py, para que una
 * ortofoto subida desde el navegador sirva igual como capa del plano y como suelo de la vista 3D.
 */
import proj4 from 'proj4';

const MAX_PX = 3072;

export function defCrs(epsg: number): string {
  if (epsg === 4326) return 'EPSG:4326';
  if (Math.floor(epsg / 100) === 326 || Math.floor(epsg / 100) === 327) {
    return `+proj=utm +zone=${epsg % 100} ${Math.floor(epsg / 100) === 327 ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
  }
  throw new Error(`El GeoTIFF está en EPSG:${epsg}. Expórtalo en UTM WGS 84 (por ejemplo EPSG:32717) o en EPSG:4326.`);
}

const R = 6378137;
const aMerc = (lon: number, lat: number) => [(lon * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
const deMerc = (x: number, y: number) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];

export interface RasterListo {
  webp: Uint8Array;
  bounds: [[number, number], [number, number]];
  px: [number, number];
}

export async function geotiffAWebp(buf: ArrayBuffer, avisar: (t: string) => void): Promise<RasterListo> {
  // @ts-ignore — georaster no publica tipos propios.
  const gr = await import('georaster');
  const parse = (gr as any).default ?? gr;
  avisar('Leyendo el GeoTIFF…');
  const g = await parse(buf);
  const epsg = Number(g.projection);
  if (!epsg || ![g.xmin, g.xmax, g.ymin, g.ymax].every(Number.isFinite)) {
    throw new Error('El archivo no tiene georreferencia. Expórtalo como GeoTIFF georreferenciado.');
  }
  const p = proj4(defCrs(epsg), 'EPSG:4326');

  // Límites en Mercator a partir del contorno del ráster.
  let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
  for (let i = 0; i <= 10; i++) {
    for (const [x, y] of [[g.xmin + (g.xmax - g.xmin) * i / 10, g.ymin], [g.xmin + (g.xmax - g.xmin) * i / 10, g.ymax],
      [g.xmin, g.ymin + (g.ymax - g.ymin) * i / 10], [g.xmax, g.ymin + (g.ymax - g.ymin) * i / 10]]) {
      const [lon, lat] = p.forward([x, y]);
      const [mx, my] = aMerc(lon, lat);
      mx0 = Math.min(mx0, mx); mx1 = Math.max(mx1, mx); my0 = Math.min(my0, my); my1 = Math.max(my1, my);
    }
  }
  const escala = Math.max((mx1 - mx0) / Math.min(MAX_PX, g.width * 1.05), (my1 - my0) / Math.min(MAX_PX, g.height * 1.05));
  const w = Math.max(1, Math.round((mx1 - mx0) / escala));
  const h = Math.max(1, Math.round((my1 - my0) / escala));

  const bandas: number[][][] = g.values;
  const nb = bandas.length;
  const nodata = g.noDataValue;
  const esByte = nb >= 3 && (g.maxs?.slice(0, 3) ?? [255]).every((m: number) => m <= 255) && (g.mins?.slice(0, 3) ?? [0]).every((m: number) => m >= 0);
  // Ráster de valores (DEM, pendientes…): se estira a 0–255 con los percentiles 2 y 98 de una muestra.
  let lo = 0, hi = 255;
  if (!esByte) {
    const muestra: number[] = [];
    for (let i = 0; i < 20000; i++) {
      const v = bandas[0][Math.floor(Math.random() * g.height)][Math.floor(Math.random() * g.width)];
      if (Number.isFinite(v) && v !== nodata) muestra.push(v);
    }
    muestra.sort((a, b) => a - b);
    lo = muestra[Math.floor(muestra.length * 0.02)] ?? 0;
    hi = muestra[Math.floor(muestra.length * 0.98)] ?? 1;
  }
  const est = (v: number) => (esByte ? v : Math.max(0, Math.min(255, ((v - lo) / Math.max(hi - lo, 1e-9)) * 255)));

  const lienzo = document.createElement('canvas');
  lienzo.width = w; lienzo.height = h;
  const ctx = lienzo.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let fila = 0; fila < h; fila++) {
    if (fila % 64 === 0) {
      avisar(`Reproyectando la imagen… ${Math.round((fila / h) * 100)} %`);
      await new Promise((r) => setTimeout(r, 0));
    }
    const my = my1 - (fila + 0.5) * escala;
    for (let col = 0; col < w; col++) {
      const [lon, lat] = deMerc(mx0 + (col + 0.5) * escala, my);
      const [x, y] = p.inverse([lon, lat]);
      const c = Math.floor((x - g.xmin) / g.pixelWidth);
      const r = Math.floor((g.ymax - y) / g.pixelHeight);
      if (c < 0 || r < 0 || c >= g.width || r >= g.height) continue;
      const k = (fila * w + col) * 4;
      const v0 = bandas[0][r][c];
      if (v0 === nodata || !Number.isFinite(v0)) continue;
      if (nb >= 3) {
        const v1 = bandas[1][r][c], v2 = bandas[2][r][c];
        if (nodata === undefined && v0 === 0 && v1 === 0 && v2 === 0) continue; // borde negro de una ortofoto recortada
        d[k] = est(v0); d[k + 1] = est(v1); d[k + 2] = est(v2);
      } else {
        d[k] = d[k + 1] = d[k + 2] = est(v0);
      }
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  avisar('Comprimiendo la imagen…');
  const blob: Blob = await new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error('El navegador no pudo crear la imagen WebP.'))), 'image/webp', 0.82));
  const [lonO, latS] = deMerc(mx0, my0);
  const [lonE, latN] = deMerc(mx1, my1);
  return { webp: new Uint8Array(await blob.arrayBuffer()), bounds: [[latS, lonO], [latN, lonE]], px: [w, h] };
}
