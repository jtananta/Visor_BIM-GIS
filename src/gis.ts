import { crearProyeccion } from './datos';

/** GeoJSON, KML o Shapefile comprimido en .zip (con .shp, .dbf y .prj) → FeatureCollection en WGS 84. */
export async function leerVector(nombre: string, buf: ArrayBuffer): Promise<GeoJSON.FeatureCollection> {
  let gj: any;
  const ext = nombre.toLowerCase().split('.').pop();
  if (ext === 'zip') {
    const shp = (await import('shpjs')).default as any;
    gj = await shp(buf);
    // Un .zip con varios shapefiles devuelve una lista: se juntan en una capa.
    if (Array.isArray(gj)) gj = { type: 'FeatureCollection', features: gj.flatMap((x: any) => x.features) };
  } else if (ext === 'kml') {
    const { kml } = await import('@tmcw/togeojson');
    gj = kml(new DOMParser().parseFromString(new TextDecoder().decode(buf), 'text/xml'));
  } else {
    gj = JSON.parse(new TextDecoder().decode(buf));
    // GeoJSON en UTM (p. ej. exportado de QGIS con el CRS del proyecto): se pasa a WGS 84.
    const n = JSON.stringify(gj.crs ?? '').match(/EPSG:*:?(\d{4,5})/i)?.[1];
    if (n && (n.startsWith('326') || n.startsWith('327'))) {
      const p = crearProyeccion(Number(n));
      const conv = (c: any): any => (typeof c[0] === 'number' ? [...p.aLonLat(c[0], c[1])] : c.map(conv));
      for (const f of gj.features ?? []) if (f.geometry?.coordinates) f.geometry.coordinates = conv(f.geometry.coordinates);
      delete gj.crs;
    }
  }
  if (!gj?.features?.length) throw new Error(`«${nombre}» no tiene elementos para dibujar.`);
  return gj;
}
