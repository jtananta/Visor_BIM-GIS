/**
 * Cantidades y metros lineales por modelo. Los modelos convertidos traen `metrados` en el manifest (medidos
 * sobre la geometría del IFC); para los que se convirtieron antes se estiman con su trazado en planta.
 */
import { crearProyeccion, type Datos } from './datos';

export interface Metrado { n: number; ml: number }
export interface MetradoModelo {
  porTipo: Record<string, Metrado>;
  /** true si salió del trazado en planta y no de la geometría del IFC. */
  estimado: boolean;
}

/** Tipos de estructura que se miden en metros lineales; el resto, en unidades. */
export const LINEALES = new Set(['Tubería', 'Canal', 'Box', 'Gaviones']);

function largoEje(puntos: number[][]): number {
  if (puntos.length < 2) return 0;
  const m = [0, 0];
  for (const p of puntos) { m[0] += p[0]; m[1] += p[1]; }
  m[0] /= puntos.length; m[1] /= puntos.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of puntos) { sxx += (x - m[0]) ** 2; syy += (y - m[1]) ** 2; sxy += (x - m[0]) * (y - m[1]); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const e = [Math.cos(ang), Math.sin(ang)];
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of puntos) { const t = (x - m[0]) * e[0] + (y - m[1]) * e[1]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  return hi - lo;
}

function perimetro(anillo: number[][]): number {
  let s = 0;
  for (let i = 1; i < anillo.length; i++) s += Math.hypot(anillo[i][0] - anillo[i - 1][0], anillo[i][1] - anillo[i - 1][1]);
  return s;
}

export function metradosPorModelo(datos: Datos): Map<string, MetradoModelo> {
  const out = new Map<string, MetradoModelo>();
  const proy = crearProyeccion(datos.manifest.epsg);
  const faltan = new Set<string>();
  for (const m of datos.manifest.modelos) {
    if (m.metrados) {
      out.set(m.codigo, { estimado: false, porTipo: Object.fromEntries(Object.entries(m.metrados).map(([t, v]) => [t, { n: v.n, ml: v.ml ?? 0 }])) });
    } else {
      out.set(m.codigo, { estimado: true, porTipo: {} });
      faltan.add(m.codigo);
    }
  }
  // Estimación desde el trazado: un tubo fino tiene un perímetro de casi dos veces su largo; un tramo de
  // canal o box mide lo que su huella a lo largo del eje.
  for (const f of datos.trazado.features) {
    const p = f.properties;
    if (!p || !faltan.has(p.modelo_codigo)) continue;
    const reg = out.get(p.modelo_codigo)!;
    const t = (reg.porTipo[p.tipo_estructura] ??= { n: 0, ml: 0 });
    t.n++;
    if (!LINEALES.has(p.tipo_estructura)) continue;
    const g = f.geometry as GeoJSON.Geometry;
    const poligonos = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    const utm = poligonos.map((pol) => pol[0].map(([lo, la]) => proy.aUtm(lo, la)));
    if (p.tipo_estructura === 'Tubería') t.ml += utm.reduce((s, a) => s + perimetro(a) / 2, 0);
    else t.ml += largoEje(utm.flat());
  }
  return out;
}

const fmt0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 });
export const formatoNumero = (v: number) => fmt0.format(v);
