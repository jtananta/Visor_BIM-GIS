/**
 * Relieve para la vista 3D: el modelo de elevación público (teselas Terrarium de AWS, a partir de SRTM)
 * bajo la imagen satelital, y las superficies propias del proyecto (GeoTIFF o LandXML) como mallas coloreadas
 * por altura.
 */
import * as THREE from 'three';
import type { Grilla } from './datos';

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, mal) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => mal(new Error(url));
    img.src = url;
  });
}

const aTesela = (lon: number, lat: number, z: number) => {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n];
};

/**
 * Elevación (m sobre el nivel del mar) en cada punto lon/lat. El mar queda en 0: Terrarium trae batimetría
 * y no aporta nada en un proyecto en la costa.
 */
export async function alturasTerreno(puntos: [number, number][]): Promise<Float32Array> {
  let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
  for (const [lo, la] of puntos) { lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); la0 = Math.min(la0, la); la1 = Math.max(la1, la); }
  // El zoom más fino (15 ≈ 4 m/px; el dato SRTM es de 30 m) que cubra la zona con 6 × 6 teselas o menos.
  let z = 15, x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  for (; z >= 8; z--) {
    const [ax, ay] = aTesela(lo0, la1, z);
    const [bx, by] = aTesela(lo1, la0, z);
    x0 = Math.floor(ax); y0 = Math.floor(ay); x1 = Math.floor(bx); y1 = Math.floor(by);
    if (x1 - x0 < 6 && y1 - y0 < 6) break;
  }
  const w = (x1 - x0 + 1) * 256, h = (y1 - y0 + 1) * 256;
  const lienzo = document.createElement('canvas');
  lienzo.width = w; lienzo.height = h;
  const ctx = lienzo.getContext('2d', { willReadFrequently: true })!;
  const pedidos: Promise<void>[] = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      pedidos.push(cargarImagen(`${TERRARIUM}/${z}/${tx}/${ty}.png`).then((img) => ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256)));
    }
  }
  await Promise.all(pedidos);
  const px = ctx.getImageData(0, 0, w, h).data;
  const alt = (x: number, y: number) => {
    const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
    return px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
  };
  const out = new Float32Array(puntos.length);
  for (const [k, [lo, la]] of puntos.entries()) {
    const [tx, ty] = aTesela(lo, la, z);
    const fx = (tx - x0) * 256 - 0.5, fy = (ty - y0) * 256 - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
    const v = alt(ix, iy) * (1 - dx) * (1 - dy) + alt(ix + 1, iy) * dx * (1 - dy) + alt(ix, iy + 1) * (1 - dx) * dy + alt(ix + 1, iy + 1) * dx * dy;
    out[k] = Math.max(0, v);
  }
  return out;
}

/* Rampa hipsométrica: verde en lo bajo, ocre y marrón en lo alto. */
const RAMPA: [number, THREE.Color][] = [
  [0, new THREE.Color('#2f7d4f')],
  [0.3, new THREE.Color('#8fbf63')],
  [0.55, new THREE.Color('#e3cf7a')],
  [0.8, new THREE.Color('#b9844e')],
  [1, new THREE.Color('#f1ece4')],
];
function colorAltura(t: number, out: THREE.Color) {
  for (let i = 1; i < RAMPA.length; i++) {
    if (t <= RAMPA[i][0]) {
      const [t0, c0] = RAMPA[i - 1];
      const [t1, c1] = RAMPA[i];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(RAMPA[RAMPA.length - 1][1]);
}

/** Malla de una superficie propia: un vértice por celda, sin triángulos donde falta el dato. */
export function mallaSuperficie(z: Float32Array, g: Grilla, origen: { e: number; n: number; z: number }): THREE.Mesh {
  const { ancho, alto, paso } = g;
  const pos = new Float32Array(ancho * alto * 3);
  const col = new Float32Array(ancho * alto * 3);
  const c = new THREE.Color();
  const rango = Math.max(g.zmax - g.zmin, 1e-6);
  for (let j = 0; j < alto; j++) {
    for (let i = 0; i < ancho; i++) {
      const k = j * ancho + i;
      const v = z[k];
      pos[k * 3] = g.e0 + i * paso - origen.e;
      pos[k * 3 + 1] = Number.isFinite(v) ? v - origen.z : 0;
      pos[k * 3 + 2] = -(g.n0 - j * paso - origen.n);
      colorAltura(Number.isFinite(v) ? (v - g.zmin) / rango : 0, c);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  const ind: number[] = [];
  const ok = (k: number) => Number.isFinite(z[k]);
  for (let j = 0; j < alto - 1; j++) {
    for (let i = 0; i < ancho - 1; i++) {
      const a = j * ancho + i, b = a + 1, d = a + ancho, e = d + 1;
      if (ok(a) && ok(d) && ok(b)) ind.push(a, d, b);
      if (ok(b) && ok(d) && ok(e)) ind.push(b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(ind);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const malla = new THREE.Mesh(geo, mat);
  malla.name = 'superficie';
  return malla;
}

/** Opacidad compartida por el suelo y las superficies: bajarla deja ver las tuberías enterradas. */
export function aplicarOpacidad(mat: THREE.Material, opacidad: number) {
  const transparente = opacidad < 0.99;
  if (mat.transparent !== transparente) mat.needsUpdate = true;
  mat.transparent = transparente;
  mat.opacity = opacidad;
  mat.depthWrite = !transparente;
}
