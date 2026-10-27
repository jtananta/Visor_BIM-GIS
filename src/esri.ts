/**
 * Imágenes satelitales de Esri World Imagery. En Talara la imagen de detalle no llega a todos los zooms y,
 * más allá del último disponible, Esri devuelve teselas grises «Map data not yet available».
 * Se consulta una vez el zoom máximo real en el proyecto y el plano y la vista 3D se quedan en él (Leaflet amplía).
 */
export const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
// blankTile=false: una tesela sin imagen responde 404 en vez del aviso gris.
export const urlTeselaEsri = (z: number | string, y: number | string, x: number | string) => `${ESRI}/tile/${z}/${y}/${x}?blankTile=false`;

const ZOOM_SEGURO = 17;
let pendiente: Promise<number> | null = null;

export function teselaDe(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)];
}

/** Zoom más alto con imagen real en ese punto (19 a 13). */
export function zoomMaxEsri(lon: number, lat: number): Promise<number> {
  pendiente ??= (async () => {
    for (let z = 19; z >= 13; z--) {
      const [x, y] = teselaDe(lon, lat, z);
      try {
        const r = await fetch(`${ESRI}/tilemap/${z}/${y}/${x}/1/1`);
        const j = await r.json();
        if (!j.adjusted && j.data?.[0] === 1) return z;
      } catch {
        return ZOOM_SEGURO; // sin red hacia Esri: el valor que funciona en la zona
      }
    }
    return 13;
  })();
  return pendiente;
}
