/**
 * Silueta en planta (huella 2D) de un elemento IFC triangulado.
 *
 * Antes cada elemento se dibujaba con la envolvente convexa de sus vértices. Sirve para un buzón o una losa,
 * pero un elemento largo y quebrado (un canal modelado como un solo barrido de cientos de metros) se
 * convertía en un triángulo enorme que tapaba manzanas enteras. Ahora:
 *
 * - Los triángulos de la malla se proyectan en planta sobre una grilla y se calca el contorno de las celdas
 *   ocupadas: la forma real, con sus quiebres y sin rellenar los huecos entre tramos. (Unir miles de
 *   triángulos largos y finos con polygon-clipping falla con «Unable to find segment … in SweepLine tree».)
 * - Si la envolvente convexa casi no se aleja de ese calco (elemento compacto), se usa la envolvente, como
 *   antes: su contorno es más limpio y deja igual a buzones, sumideros, losas, etc.
 *
 * Las coordenadas de entrada son E, N, Z (m); las de salida, relativas a (oe, on) y redondeadas al centímetro,
 * porque polygon-clipping pierde precisión con coordenadas UTM completas.
 */
import type { Pair, Polygon } from 'polygon-clipping';

/** Si la envolvente mide más que esto por la huella calcada, el elemento no es convexo y se usa el calco. */
const HOLGURA = 1.25;
/** Triángulos con menos área en planta que esto (m²) son caras verticales: no aportan a la huella. */
const AREA_MIN = 1e-4;
/** Lado de celda mínimo (m) y celdas máximas de la grilla (memoria y tiempo acotados en elementos de km). */
const CELDA_MIN = 0.1;
const CELDAS_MAX = 4e6;

const cm = (x: number) => Math.round(x * 100) / 100;

/** Envolvente convexa 2D (cadena monótona). */
export function envolvente(xy: number[][]): number[][] {
  const pts = xy.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cruz = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [];
  for (const p of pts) { while (lo.length >= 2 && cruz(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const hi: number[][] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cruz(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

export function areaAnillo(r: number[][]): number {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}

/** Douglas-Peucker iterativo sobre un anillo cerrado (primer punto = último). */
function simplificarAnillo(r: number[][], tol: number): number[][] {
  const pts = r.slice(0, -1);
  if (pts.length <= 4) return r;
  // Se corta el anillo en el vértice más lejano al primero, para no perder una esquina.
  let lejos = 0, dmax = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > dmax) { dmax = d; lejos = i; }
  }
  const linea = [...pts, pts[0]];
  const queda = new Uint8Array(linea.length);
  queda[0] = queda[lejos] = queda[linea.length - 1] = 1;
  const pila: [number, number][] = [[0, lejos], [lejos, linea.length - 1]];
  while (pila.length) {
    const [i0, i1] = pila.pop()!;
    const a = linea[i0], b = linea[i1];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    let imax = -1, d = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const di = l === 0 ? Math.hypot(linea[i][0] - a[0], linea[i][1] - a[1])
        : Math.abs(dy * (linea[i][0] - a[0]) - dx * (linea[i][1] - a[1])) / l;
      if (di > d) { d = di; imax = i; }
    }
    if (imax >= 0) { queda[imax] = 1; pila.push([i0, imax], [imax, i1]); }
  }
  const out = linea.filter((_, i) => queda[i]);
  return out.length >= 4 ? out : r;
}

function dentro(p: number[], r: number[][]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}

/**
 * Proyecta los triángulos en una grilla y devuelve el contorno de las celdas ocupadas como polígonos
 * [exterior, ...huecos] en metros relativos a (oe, on).
 */
function siluetaGrilla(v: Float64Array, f: Uint32Array, oe: number, on: number): Polygon[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < v.length; k += 3) {
    x0 = Math.min(x0, v[k] - oe); x1 = Math.max(x1, v[k] - oe);
    y0 = Math.min(y0, v[k + 1] - on); y1 = Math.max(y1, v[k + 1] - on);
  }
  const t = Math.max(CELDA_MIN, Math.sqrt(((x1 - x0) * (y1 - y0)) / CELDAS_MAX));
  // Una celda de margen alrededor: el contorno nunca toca el borde de la grilla.
  x0 -= t; y0 -= t;
  const W = Math.ceil((x1 - x0) / t) + 2, H = Math.ceil((y1 - y0) / t) + 2;
  const lleno = new Uint8Array(W * H);
  const marcar = (x: number, y: number) => {
    const i = Math.floor((x - x0) / t), j = Math.floor((y - y0) / t);
    if (i >= 0 && j >= 0 && i < W && j < H) lleno[j * W + i] = 1;
  };

  for (let k = 0; k + 2 < f.length; k += 3) {
    const ax = v[f[k] * 3] - oe, ay = v[f[k] * 3 + 1] - on;
    const bx = v[f[k + 1] * 3] - oe, by = v[f[k + 1] * 3 + 1] - on;
    const cx = v[f[k + 2] * 3] - oe, cy = v[f[k + 2] * 3 + 1] - on;
    const s = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(s) / 2 < AREA_MIN) continue; // cara vertical
    // Bordes: así un triángulo más fino que una celda igual marca las celdas que cruza.
    for (const [px, py, qx, qy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
      const pasos = Math.ceil(Math.hypot(qx - px, qy - py) / (t / 2)) + 1;
      for (let p = 0; p <= pasos; p++) marcar(px + ((qx - px) * p) / pasos, py + ((qy - py) * p) / pasos);
    }
    // Interior: centros de celda dentro del triángulo.
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / t)), i1 = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - x0) / t));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / t)), j1 = Math.min(H - 1, Math.floor((Math.max(ay, by, cy) - y0) / t));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * t;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * t;
        const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
        const w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) lleno[j * W + i] = 1;
      }
    }
  }

  // Bordes dirigidos de las celdas ocupadas, con la celda a la izquierda (exteriores antihorarios, huecos horarios).
  // Vértice de la grilla (i, j) → id j*(W+1)+i. Cada vértice tiene a lo sumo 2 bordes salientes (en un «punto de silla»).
  const V = W + 1;
  const sale = new Map<number, number[]>();
  const agregar = (a: number, b: number) => { const l = sale.get(a); if (l) l.push(b); else sale.set(a, [b]); };
  const ocupado = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && lleno[j * W + i] === 1;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!lleno[j * W + i]) continue;
      if (!ocupado(i, j - 1)) agregar(j * V + i, j * V + i + 1);
      if (!ocupado(i + 1, j)) agregar(j * V + i + 1, (j + 1) * V + i + 1);
      if (!ocupado(i, j + 1)) agregar((j + 1) * V + i + 1, (j + 1) * V + i);
      if (!ocupado(i - 1, j)) agregar((j + 1) * V + i, j * V + i);
    }
  }

  const anillos: number[][][] = [];
  const xy = (id: number) => [x0 + (id % V) * t, y0 + Math.floor(id / V) * t];
  for (const inicio of [...sale.keys()]) {
    while (sale.get(inicio)?.length) {
      const ids = [inicio];
      let prev = inicio, act = sale.get(inicio)!.pop()!;
      while (act !== inicio) {
        ids.push(act);
        const opciones = sale.get(act)!;
        let k = 0;
        if (opciones.length > 1) {
          // En un punto de silla se dobla a la izquierda: dos celdas que solo se tocan en una esquina quedan en anillos aparte.
          const [px, py] = xy(prev), [cx, cy] = xy(act);
          const izq = (o: number) => { const [ox, oy] = xy(o); return (cx - px) * (oy - cy) - (cy - py) * (ox - cx); };
          k = izq(opciones[0]) >= izq(opciones[1]) ? 0 : 1;
        }
        prev = act;
        act = opciones.splice(k, 1)[0];
      }
      ids.push(inicio);
      anillos.push(ids.map(xy));
    }
  }

  // Escalones de la grilla → rectas; la tolerancia es una celda, el error del calco.
  const exteriores: { r: number[][]; huecos: number[][][]; a: number }[] = [];
  const huecos: number[][][] = [];
  for (const r of anillos) {
    const s = simplificarAnillo(r, t);
    const a = areaAnillo(s);
    if (Math.abs(a) < 2 * t * t) continue; // migas del calco
    if (a > 0) exteriores.push({ r: s, huecos: [], a }); else huecos.push(s);
  }
  exteriores.sort((p, q) => p.a - q.a);
  for (const h of huecos) {
    // El hueco va al exterior más chico que lo contiene (sus anillos del calco no se cruzan).
    const m = [(h[0][0] + h[1][0]) / 2, (h[0][1] + h[1][1]) / 2];
    exteriores.find((e) => dentro(m, e.r) || dentro(h[0], e.r))?.huecos.push(h);
  }
  const redondear = (r: number[][]) => r.map(([x, y]) => [cm(x), cm(y)] as Pair);
  return exteriores.map((e) => [redondear(e.r), ...e.huecos.map(redondear)]);
}

/**
 * Huella en planta de un elemento: polígonos [anillo exterior, ...huecos] en metros relativos a (oe, on).
 * `v` son vértices E, N, Z consecutivos y `f` los índices de sus triángulos.
 */
export function siluetaElemento(v: Float64Array, f: Uint32Array, oe: number, on: number): Polygon[] {
  const nv = v.length / 3;
  const paso = Math.max(1, Math.floor(nv / 600));
  const xy: number[][] = [];
  for (let k = 0; k < v.length; k += 3 * paso) xy.push([v[k], v[k + 1]]);
  const h = envolvente(xy).map(([x, y]) => [cm(x - oe), cm(y - on)] as Pair);
  const convexa: Polygon[] = h.length >= 3 ? [[[...h, h[0]]]] : [];
  if (!f.length || !convexa.length) return convexa;

  const real = siluetaGrilla(v, f, oe, on);
  const area = real.reduce((t, pol) => t + pol.reduce((u, r) => u + areaAnillo(r), 0), 0);
  // Elemento compacto: la envolvente es más limpia (y es lo que se dibujaba antes).
  if (!real.length || Math.abs(areaAnillo(convexa[0][0])) <= HOLGURA * area) return convexa;
  return real;
}
