/**
 * Catálogo de paquetes y componentes: lectura del Excel de control (como pipeline/catalogo.py) y
 * sugerencia del componente de un modelo nuevo (como catalogo_por_defecto en convert.py).
 */
import type { Componente } from '../datos';
import type { Ubicacion } from './convertir';

const COLUMNAS: Record<string, keyof Componente> = {
  'SECTOR': 'sector', 'N° PAQUETE': 'paquete', 'COMPONENTE': 'componente', 'DESCRIPCIÓN': 'descripcion',
  'ESTADO': 'estado', '% AVANCE': 'avance', 'RESPONSABLE': 'responsable',
  'FECHA ACTUALIZACIÓN': 'fecha', 'OBSERVACIONES': 'observaciones',
};

export const CAMPOS_COMPONENTE: (keyof Componente)[] = ['sector', 'paquete', 'componente', 'descripcion', 'estado', 'avance', 'responsable', 'fecha', 'observaciones'];

/** 'PAQUETE 9', 'Paquete 9 ', 'COMPONENTE4' → 'Paquete 9', 'Componente 4'. */
export function normalizar(tipo: 'PAQUETE' | 'COMPONENTE', v: unknown): string {
  const m = String(v ?? '').match(new RegExp(`^\\s*${tipo}\\s*([\\d.]+)`, 'i'));
  return m ? `${tipo[0]}${tipo.slice(1).toLowerCase()} ${m[1]}` : String(v ?? '').trim();
}

function titulo(t: string): string {
  return t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** Lee la hoja "CONTROL GENERAL" del Excel de paquetes y componentes. */
export async function leerExcel(buf: ArrayBuffer): Promise<Componente[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const hoja = wb.Sheets['CONTROL GENERAL'] ?? wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: null });
  const iCab = filas.findIndex((f) => Array.isArray(f) && f.some((c) => String(c ?? '').trim() === 'COMPONENTE'));
  if (iCab < 0) throw new Error('No encontré la fila de títulos (SECTOR, N° PAQUETE, COMPONENTE…) en la hoja "CONTROL GENERAL".');
  const idx: Partial<Record<keyof Componente, number>> = {};
  (filas[iCab] as unknown[]).forEach((c, i) => {
    const k = COLUMNAS[String(c ?? '').trim()];
    if (k && idx[k] === undefined) idx[k] = i;
  });
  const out: Componente[] = [];
  let sector = '', paquete = '';
  for (const f of filas.slice(iCab + 1) as unknown[][]) {
    const get = (k: keyof Componente) => (idx[k] !== undefined ? f[idx[k]!] : null);
    if (!get('componente')) continue;
    if (get('sector')) sector = titulo(String(get('sector')).trim());
    if (get('paquete')) paquete = normalizar('PAQUETE', get('paquete'));
    const fecha = get('fecha');
    out.push({
      sector, paquete,
      componente: normalizar('COMPONENTE', get('componente')),
      descripcion: String(get('descripcion') ?? '').trim(),
      estado: String(get('estado') ?? 'Pendiente').trim() || 'Pendiente',
      avance: get('avance') == null ? '' : String(get('avance')),
      responsable: String(get('responsable') ?? '').trim(),
      fecha: fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha ?? ''),
      observaciones: String(get('observaciones') ?? '').trim(),
    });
  }
  if (!out.length) throw new Error('La hoja no tiene componentes debajo de los títulos.');
  return out;
}

export function aCsv(filas: Record<string, unknown>[], campos: string[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [campos.join(','), ...filas.map((f) => campos.map((c) => esc(f[c])).join(','))].join('\n') + '\n';
}

function palabras(t: string): Set<string> {
  const w = new Set((t.toLowerCase().match(/[a-záéíóúñ]{4,}/g) ?? []));
  // Buzones, sumideros y tuberías son obras de "drenaje urbano" en el catálogo.
  if (['buzon', 'buzones', 'sumidero', 'sumideros', 'tuberia', 'tuberias', 'tubería', 'tuberías'].some((x) => w.has(x))) {
    w.add('drenaje'); w.add('urbano');
  }
  return w;
}

/** Componente con más palabras en común con la descripción del modelo y el IfcBuilding. */
export function sugerirComponente(componentes: Componente[], descripcion: string, edificio: string): Componente | null {
  const m = edificio.match(/PAQUETE\s*0*(\d+)/i);
  const enPaquete = m ? componentes.filter((c) => c.paquete === `Paquete ${m[1]}`) : [];
  const candidatos = enPaquete.length ? enPaquete : componentes;
  const clave = new Set([...palabras(descripcion), ...palabras(edificio)]);
  let mejor: Componente | null = null;
  let puntos = -1;
  for (const c of candidatos) {
    const p = [...palabras(c.descripcion)].filter((w) => clave.has(w)).length;
    if (p > puntos || (p === puntos && mejor && c.descripcion.length < mejor.descripcion.length)) { mejor = c; puntos = p; }
  }
  return mejor;
}

export function ubicacionDe(c: Componente | null | undefined, componente = ''): Ubicacion {
  return c
    ? { sector: c.sector, paquete: c.paquete, componente: c.componente, componente_desc: c.descripcion }
    : { sector: 'Sin sector', paquete: 'Sin paquete', componente: componente || 'Sin componente', componente_desc: '' };
}
