/**
 * El trazado en planta se guarda como un archivo por modelo (data/trazado/<codigo>.geojson), así ningún
 * archivo crece al agregar IFC y cada publicación sube solo el trazado de los modelos que cambian.
 * Las versiones anteriores guardaban todo en un único data/trazado.geojson: el visor lo sigue leyendo para
 * los modelos que aún no tienen su archivo, y la primera publicación lo divide y lo borra.
 */

/** Archivo único de las versiones anteriores. */
export const TRAZADO_ANTIGUO = 'trazado.geojson';

/** Archivo del trazado de un modelo, relativo a la carpeta de datos. */
export const rutaTrazado = (codigo: string) => `trazado/${codigo}.geojson`;

export function coleccion(features: GeoJSON.Feature[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/** Agrupa las features por el modelo al que pertenecen. */
export function porModelo(features: GeoJSON.Feature[]): Map<string, GeoJSON.Feature[]> {
  const grupos = new Map<string, GeoJSON.Feature[]>();
  for (const f of features) {
    const c = String(f.properties?.modelo_codigo ?? '');
    const g = grupos.get(c);
    if (g) g.push(f); else grupos.set(c, [f]);
  }
  return grupos;
}

async function leerJson(url: string): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return j && Array.isArray(j.features) ? j : null;
  } catch {
    return null;
  }
}

/** Trazado completo del visor: el archivo de cada modelo y, para los que no lo tienen, el archivo antiguo. */
export async function cargarTrazado(base: string, codigos: string[]): Promise<GeoJSON.Feature[]> {
  const partes = await Promise.all(codigos.map((c) => leerJson(`${base}${rutaTrazado(c)}`)));
  const faltan = new Set(codigos.filter((_, i) => !partes[i]));
  const features = partes.flatMap((p) => p?.features ?? []);
  if (faltan.size) {
    const antiguo = await leerJson(`${base}${TRAZADO_ANTIGUO}`);
    if (antiguo) features.push(...antiguo.features.filter((f) => faltan.has(String(f.properties?.modelo_codigo))));
  }
  return features;
}
