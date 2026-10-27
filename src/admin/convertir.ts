/**
 * Conversión IFC → GLB liviano en el navegador, con las mismas reglas que pipeline/convert.py
 * (reglas.json y proyecto.json se leen del sitio, así ambos caminos clasifican igual).
 *
 * Diferencias con el pipeline en Python: la geometría la calcula web-ifc (el mismo motor del visor
 * técnico); la huella 2D sigue siendo la unión de las siluetas de los elementos.
 */
import * as WebIFC from 'web-ifc';
import { Document, WebIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, meshopt, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import proj4 from 'proj4';
import poligonos, { type Geom, type MultiPolygon, type Pair } from 'polygon-clipping';

export interface Regla {
  tipo: string;
  patron: string;
  agrupar: 'contacto' | 'sistema' | 'tramo';
  tolerancia?: number;
  tramo?: number;
}

export interface Reglas {
  excluir: string;
  tipos: Regla[];
  por_modelo: Record<string, string>;
}

export interface Proyecto {
  nombre: string;
  epsg: number;
  origen: { e: number; n: number; z: number };
}

export interface Ubicacion {
  sector: string;
  paquete: string;
  componente: string;
  componente_desc: string;
}

export interface Resultado {
  codigo: string;
  descripcion: string;
  edificio: string;
  glb: Uint8Array;
  modelo: Record<string, unknown>;
  features: GeoJSON.Feature[];
  reporte: { elementos: number; excluidos: number; estructuras: number; triangulos: number; kb: number; tipos: Record<string, number> };
}

type Avisar = (texto: string, fraccion?: number) => void;

const ESPACIALES = new Set(['IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCPROJECT']);

const COLORES: Record<string, [number, number, number]> = {
  'Buzón': [0.2, 0.45, 0.75],
  Sumidero: [0.1, 0.6, 0.55],
  'Tubería': [0.85, 0.55, 0.15],
  Gaviones: [0.55, 0.5, 0.4],
  Canal: [0.62, 0.64, 0.66],
  Otros: [0.7, 0.7, 0.7],
};

interface Item {
  v: Float64Array; // E, N, Z en coordenadas del proyecto
  f: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
  centro: [number, number, number];
  sistema: string | null;
}

/* ------------------------------------------------------------------ */
/* Lectura del IFC                                                     */
/* ------------------------------------------------------------------ */

function valor(x: any): string {
  return x && typeof x === 'object' && 'value' in x ? String(x.value ?? '') : String(x ?? '');
}

/** Texto entre paréntesis del nombre original del IFC ("Sumideros", "Dique Mangle"…), como en convert.py. */
function descripcionModelo(api: WebIFC.IfcAPI, id: number, archivo: string): string {
  let nombre = archivo;
  try {
    const h = api.GetHeaderLine(id, WebIFC.FILE_NAME);
    const a = h?.arguments?.[0];
    nombre = valor(Array.isArray(a) ? a[0] : a) || archivo;
  } catch { /* algunos IFC no traen FILE_NAME legible */ }
  const m = nombre.match(/\(([^)]+)\)/) ?? archivo.match(/\(([^)]+)\)/);
  return m ? m[1].trim() : archivo.replace(/\.ifc$/i, '');
}

function idsDe(api: WebIFC.IfcAPI, id: number, tipo: number): number[] {
  const v = api.GetLineIDsWithType(id, tipo);
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
}

/* ------------------------------------------------------------------ */
/* Agrupación (mismo criterio que convert.py)                          */
/* ------------------------------------------------------------------ */

function agruparContacto(items: Item[], tol: number): Item[][] {
  const p = items.map((_, i) => i);
  const find = (a: number): number => { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; };
  const orden = items.map((_, i) => i).sort((a, b) => items[a].min[0] - items[b].min[0]);
  for (let ai = 0; ai < orden.length; ai++) {
    const a = items[orden[ai]];
    for (let bi = ai + 1; bi < orden.length; bi++) {
      const b = items[orden[bi]];
      if (b.min[0] - tol > a.max[0] + tol) break;
      let toca = true;
      for (let k = 0; k < 3; k++) {
        if (b.min[k] - tol > a.max[k] + tol || a.min[k] - tol > b.max[k] + tol) { toca = false; break; }
      }
      if (toca) p[find(orden[ai])] = find(orden[bi]);
    }
  }
  const g = new Map<number, Item[]>();
  items.forEach((it, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r)!.push(it); });
  return [...g.values()];
}

function agrupar(regla: Regla | undefined, items: Item[]): Item[][] {
  const r = regla ?? { agrupar: 'contacto', tolerancia: 0.5 } as Regla;
  if (r.agrupar === 'sistema') {
    const por = new Map<string, Item[]>();
    const sueltos: Item[] = [];
    for (const it of items) {
      if (it.sistema) { if (!por.has(it.sistema)) por.set(it.sistema, []); por.get(it.sistema)!.push(it); } else sueltos.push(it);
    }
    return [...por.values(), ...(sueltos.length ? agruparContacto(sueltos, r.tolerancia ?? 0.05) : [])];
  }
  if (r.agrupar === 'tramo') {
    const largo = r.tramo ?? 100;
    const celdas = new Map<string, Item[]>();
    for (const it of items) {
      const k = `${Math.floor(it.centro[0] / largo)}|${Math.floor(it.centro[1] / largo)}`;
      if (!celdas.has(k)) celdas.set(k, []);
      celdas.get(k)!.push(it);
    }
    return [...celdas.values()];
  }
  return agruparContacto(items, r.tolerancia ?? 0.5);
}

/** Envolvente convexa 2D (cadena monótona). */
function envolvente(xy: number[][]): number[][] {
  const pts = xy.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cruz = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [];
  for (const p of pts) { while (lo.length >= 2 && cruz(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const hi: number[][] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cruz(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/* ------------------------------------------------------------------ */
/* Conversión                                                          */
/* ------------------------------------------------------------------ */

export async function convertirIfc(
  datos: Uint8Array,
  archivo: string,
  reglas: Reglas,
  proyecto: Proyecto,
  ubicar: (descripcion: string, edificio: string) => Ubicacion,
  wasmDir: string,
  avisar: Avisar,
): Promise<Resultado> {
  const excluir = new RegExp(reglas.excluir, 'i');
  const tipos = reglas.tipos.map((r) => ({ ...r, rx: new RegExp(r.patron, 'i') }));
  const reglaDe = new Map(tipos.map((r) => [r.tipo, r]));

  avisar('Iniciando el motor IFC…', 0.02);
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir, true);
  await api.Init(undefined, true);
  api.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_OFF);

  avisar('Leyendo el IFC…', 0.05);
  const id = api.OpenModel(datos, { COORDINATE_TO_ORIGIN: false });
  try {
    const codigo = archivo.replace(/\.ifc$/i, '');
    const descripcion = descripcionModelo(api, id, archivo);
    const edificio = idsDe(api, id, WebIFC.IFCBUILDING).map((b) => valor(api.GetLine(id, b).Name))[0] ?? '';
    const ub = ubicar(descripcion, edificio);

    // Tipo de cada elemento (IfcRelDefinesByType) y sistema de Revit (IfcRelAssignsToGroup → IfcSystem).
    const tipoDe = new Map<number, string>();
    for (const r of idsDe(api, id, WebIFC.IFCRELDEFINESBYTYPE)) {
      const rel = api.GetLine(id, r);
      const nombre = valor(api.GetLine(id, rel.RelatingType.value)?.Name);
      for (const o of rel.RelatedObjects ?? []) tipoDe.set(o.value, nombre);
    }
    const sistemaDe = new Map<number, string>();
    for (const r of idsDe(api, id, WebIFC.IFCRELASSIGNSTOGROUP)) {
      const rel = api.GetLine(id, r);
      const g = api.GetLine(id, rel.RelatingGroup.value);
      if (api.GetNameFromTypeCode(api.GetLineType(id, g.expressID)).toUpperCase() !== 'IFCSYSTEM') continue;
      for (const o of rel.RelatedObjects ?? []) sistemaDe.set(o.value, valor(g.Name));
    }

    let defecto = 'Otros';
    for (const [clave, t] of Object.entries(reglas.por_modelo)) {
      if (!clave.startsWith('_') && descripcion.toLowerCase().includes(clave.toLowerCase())) { defecto = t; break; }
    }

    avisar('Calculando la geometría…', 0.1);
    const porTipo = new Map<string, Item[]>();
    const clasif = new Map<number, string | null>();
    let excluidos = 0;
    let triangulos = 0;
    const clasificar = (eid: number): string | null => {
      if (clasif.has(eid)) return clasif.get(eid)!;
      const linea = api.GetLine(id, eid);
      const clase = api.GetNameFromTypeCode(api.GetLineType(id, eid));
      const texto = `${clase}|${tipoDe.get(eid) ?? ''}|${valor(linea?.Name)}`;
      let t: string | null = defecto;
      // El terreno de Revit viaja como geometría del IfcSite; convert.py tampoco lo incluye.
      if (ESPACIALES.has(clase.toUpperCase()) || excluir.test(texto)) t = null;
      else for (const r of tipos) if (r.rx.test(texto)) { t = r.tipo; break; }
      clasif.set(eid, t);
      if (t === null) excluidos++;
      return t;
    };

    api.StreamAllMeshes(id, (mesh, i, total) => {
      if (i % 50 === 0) avisar(`Calculando la geometría… ${i} de ${total}`, 0.1 + 0.6 * (i / Math.max(total, 1)));
      const tipo = clasificar(mesh.expressID);
      if (!tipo) return;
      const vs: number[] = [];
      const fs: number[] = [];
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const pg = mesh.geometries.get(g);
        const geom = api.GetGeometry(id, pg.geometryExpressID);
        const vert = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const T = pg.flatTransformation;
        const base = vs.length / 3;
        for (let k = 0; k < vert.length; k += 6) {
          const x = vert[k], y = vert[k + 1], z = vert[k + 2];
          // web-ifc entrega Y arriba: (E, Z, -N). Se pasa a (E, N, Z) en doble precisión.
          const wx = T[0] * x + T[4] * y + T[8] * z + T[12];
          const wy = T[1] * x + T[5] * y + T[9] * z + T[13];
          const wz = T[2] * x + T[6] * y + T[10] * z + T[14];
          vs.push(wx, -wz, wy);
        }
        for (let k = 0; k < idx.length; k++) fs.push(idx[k] + base);
        geom.delete();
      }
      if (!fs.length) return;
      triangulos += fs.length / 3;
      const v = Float64Array.from(vs);
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      const centro: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < v.length; k += 3) {
        for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], v[k + c]); max[c] = Math.max(max[c], v[k + c]); centro[c] += v[k + c]; }
      }
      const n = v.length / 3;
      centro[0] /= n; centro[1] /= n; centro[2] /= n;
      if (!porTipo.has(tipo)) porTipo.set(tipo, []);
      porTipo.get(tipo)!.push({ v, f: Uint32Array.from(fs), min, max, centro, sistema: sistemaDe.get(mesh.expressID) ?? null });
    });

    avisar('Agrupando estructuras…', 0.72);
    const aLonLat = proj4(`+proj=utm +zone=${proyecto.epsg % 100} ${Math.floor(proyecto.epsg / 100) === 327 ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`, 'EPSG:4326');
    const o = proyecto.origen;
    const doc = new Document();
    const buffer = doc.createBuffer();
    const escena = doc.createScene();
    const materiales = new Map<string, ReturnType<Document['createMaterial']>>();
    const features: GeoJSON.Feature[] = [];
    const cuenta: Record<string, number> = {};
    let elementos = 0;
    const bmin = [Infinity, Infinity], bmax = [-Infinity, -Infinity];

    for (const tipo of [...porTipo.keys()].sort()) {
      const items = porTipo.get(tipo)!;
      elementos += items.length;
      const regla = reglaDe.get(tipo);
      const grupos = agrupar(regla, items);
      const media = (g: Item[], c: number) => g.reduce((s, it) => s + it.centro[c], 0) / g.length;
      grupos.sort((a, b) => -media(a, 1) + media(b, 1) || media(a, 0) - media(b, 0));
      cuenta[tipo] = grupos.length;
      if (!materiales.has(tipo)) {
        materiales.set(tipo, doc.createMaterial(tipo).setBaseColorFactor([...(COLORES[tipo] ?? COLORES.Otros), 1]).setMetallicFactor(0).setRoughnessFactor(0.9));
      }
      grupos.forEach((g, gi) => {
        const n = gi + 1;
        const nv = g.reduce((s, it) => s + it.v.length / 3, 0);
        const pos = new Float32Array(nv * 3);
        const ind = new Uint32Array(g.reduce((s, it) => s + it.f.length, 0));
        let pv = 0, pi = 0;
        const partes: Pair[][][] = [];
        for (const it of g) {
          const base = pv / 3;
          for (let k = 0; k < it.v.length; k += 3) {
            const e = it.v[k], nn = it.v[k + 1], z = it.v[k + 2];
            // Ejes glTF del visor: x=Este, y=Elevación, z=-Norte, relativos al origen del proyecto.
            pos[pv++] = e - o.e; pos[pv++] = z - o.z; pos[pv++] = -(nn - o.n);
            bmin[0] = Math.min(bmin[0], e); bmin[1] = Math.min(bmin[1], nn);
            bmax[0] = Math.max(bmax[0], e); bmax[1] = Math.max(bmax[1], nn);
          }
          for (let k = 0; k < it.f.length; k++) ind[pi++] = it.f[k] + base;
          // Silueta del elemento, con a lo sumo 600 puntos.
          const paso = Math.max(1, Math.floor(it.v.length / 3 / 600));
          const xy: number[][] = [];
          for (let k = 0; k < it.v.length; k += 3 * paso) xy.push([it.v[k], it.v[k + 1]]);
          // Relativa al origen y al centímetro: polygon-clipping pierde precisión con coordenadas UTM completas.
          const h = envolvente(xy).map(([x, y]) => [Math.round((x - o.e) * 100) / 100, Math.round((y - o.n) * 100) / 100] as Pair);
          if (h.length >= 3) partes.push([[...h, h[0]]]);
        }
        const tramo = regla?.agrupar === 'tramo';
        const meta = {
          codigo: `${codigo}#${tipo.slice(0, 3).toUpperCase()}${String(n).padStart(3, '0')}`,
          nombre: tramo ? `${tipo} · tramo ${String(n).padStart(2, '0')}` : `${tipo} ${String(n).padStart(2, '0')}`,
          paquete: ub.paquete,
          componente: ub.componente,
          componente_desc: ub.componente_desc,
          modelo: descripcion,
          modelo_codigo: codigo,
          tipo_estructura: tipo,
          sector: ub.sector,
        };
        const prim = doc.createPrimitive()
          .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
          .setIndices(doc.createAccessor().setType('SCALAR').setArray(ind).setBuffer(buffer))
          .setMaterial(materiales.get(tipo)!);
        const nodo = doc.createNode(meta.codigo).setMesh(doc.createMesh(meta.nombre).addPrimitive(prim)).setExtras(meta);
        escena.addChild(nodo);
        if (partes.length) {
          // Unión de las siluetas, igual que shapely en convert.py: una tubería en L no se dibuja como triángulo
          // y el trazado no pesa más de lo necesario.
          let unidas: MultiPolygon;
          try {
            unidas = (poligonos.union as (...g: Geom[]) => MultiPolygon)(...(partes as Geom[]));
          } catch {
            unidas = partes; // si la unión falla, las siluetas sueltas dibujan lo mismo
          }
          const huella = unidas.map((pol) => pol.map((anillo) => anillo.map(([x, y]) =>
            aLonLat.forward([x + o.e, y + o.n]).map((c: number) => Math.round(c * 1e7) / 1e7))));
          features.push({ type: 'Feature', properties: meta, geometry: { type: 'MultiPolygon', coordinates: huella } });
        }
      });
    }

    avisar('Optimizando la malla…', 0.8);
    await MeshoptEncoder.ready;
    await MeshoptSimplifier.ready;
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    doc.createExtension(KHRMeshQuantization).setRequired(true);
    await doc.transform(dedup(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.001 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    avisar('Escribiendo el GLB…', 0.95);
    const io = new WebIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    const glb = await io.writeBinary(doc);

    const estructuras = Object.values(cuenta).reduce((a, b) => a + b, 0);
    const modelo = {
      codigo, modelo: descripcion, ...ub,
      glb: `models/${codigo}.glb`,
      estructuras,
      tipos: cuenta,
      bbox_utm: [bmin[0], bmin[1], bmax[0], bmax[1]],
    };
    avisar('Listo', 1);
    return {
      codigo, descripcion, edificio, glb, modelo, features,
      reporte: { elementos, excluidos, estructuras, triangulos, kb: Math.round(glb.byteLength / 1024), tipos: cuenta },
    };
  } finally {
    api.CloseModel(id);
  }
}
