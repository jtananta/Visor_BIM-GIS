/**
 * Publicación al repositorio de GitHub del visor a través de la función api/publicar de Vercel, que guarda
 * el token de GitHub. Quien publica solo escribe la clave de publicación. Cada «Publicar» es un commit;
 * Vercel lo detecta y vuelve a desplegar el sitio en uno o dos minutos.
 */

export interface Conexion {
  clave: string;
}

const CLAVE = 'visor-gerencial-clave';

/** Clave recordada en este navegador. */
export function leerConexion(): Conexion {
  try {
    return { clave: localStorage.getItem(CLAVE) ?? '' };
  } catch {
    return { clave: '' };
  }
}

export function guardarConexion(c: Conexion, recordar: boolean) {
  try {
    if (recordar) localStorage.setItem(CLAVE, c.clave);
    else localStorage.removeItem(CLAVE);
  } catch { /* almacenamiento bloqueado: solo dura esta sesión */ }
}

/** Carpeta del repositorio donde viven los datos que lee el visor. */
export const RAIZ_DATOS = 'public/data/';

/**
 * Tope por archivo: la función de Vercel acepta pedidos de hasta 4,5 MB. Los archivos viajan como bytes
 * crudos (sin base64, que agregaría un tercio), así que 4 MB caben con margen.
 */
const MAX_BYTES = 4 * 1024 * 1024;

async function api(c: Conexion, cuerpo: Record<string, unknown> | Uint8Array): Promise<Response> {
  const crudo = cuerpo instanceof Uint8Array;
  let r: Response;
  try {
    r = await fetch(crudo ? 'api/publicar?accion=blob' : 'api/publicar', {
      method: 'POST',
      headers: { 'Content-Type': crudo ? 'application/octet-stream' : 'application/json', 'x-clave': c.clave },
      body: crudo ? (cuerpo as BodyInit) : JSON.stringify(cuerpo),
    });
  } catch {
    throw new Error('No se pudo contactar al servidor del visor. Revisa tu conexión a internet.');
  }
  if (r.ok || r.status === 404) return r;
  let error = '';
  try { error = (await r.json()).error ?? ''; } catch { /* sin cuerpo */ }
  if (r.status === 413) error = 'El archivo es demasiado grande para publicarlo desde el visor.';
  throw new Error(error || `El servidor respondió ${r.status}.`);
}

/** Lee un archivo de texto del repositorio; null si no existe. */
export async function leerTexto(c: Conexion, ruta: string): Promise<string | null> {
  const r = await api(c, { accion: 'leer', ruta });
  return r.status === 404 ? null : r.text();
}

export async function probarConexion(c: Conexion): Promise<void> {
  const r = await api(c, { accion: 'probar' });
  if (r.status === 404) throw new Error('El servidor no encontró el repositorio o la rama configurados en Vercel.');
}

/** Un archivo a escribir (contenido) o a borrar (null). */
export type Cambios = Record<string, Uint8Array | string | null>;

/** Escribe y borra varios archivos en un solo commit. Cada archivo sube en su propio pedido. */
export async function publicar(c: Conexion, cambios: Cambios, mensaje: string, avisar?: (t: string) => void): Promise<string> {
  const arbol: { path: string; sha: string | null }[] = [];
  const rutas = Object.keys(cambios);
  for (const [i, ruta] of rutas.entries()) {
    const contenido = cambios[ruta];
    if (contenido === null) {
      arbol.push({ path: ruta, sha: null });
      continue;
    }
    const bytes = typeof contenido === 'string' ? new TextEncoder().encode(contenido) : contenido;
    if (bytes.length > MAX_BYTES) {
      throw new Error(`${ruta.split('/').pop()} pesa ${(bytes.length / 1048576).toFixed(1)} MB; desde el visor se publican archivos de hasta 4 MB. Divide el IFC o usa el pipeline en Python.`);
    }
    avisar?.(`Subiendo ${ruta.split('/').pop()} (${i + 1} de ${rutas.length})…`);
    const r = await api(c, bytes);
    arbol.push({ path: ruta, sha: (await r.json()).sha });
  }
  avisar?.('Guardando los cambios…');
  const r = await api(c, { accion: 'commit', mensaje, arbol });
  return (await r.json()).sha;
}
