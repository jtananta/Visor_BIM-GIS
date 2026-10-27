/**
 * Publicación al repositorio de GitHub del visor. Cada "Publicar" es un commit; Vercel lo detecta y
 * vuelve a desplegar el sitio en uno o dos minutos. El token vive solo en el navegador de quien administra.
 */

export interface Conexion {
  repo: string; // "usuario/repositorio"
  rama: string;
  token: string;
}

/** Carpeta del repositorio donde viven los datos que lee el visor. */
export const RAIZ_DATOS = 'public/data/';

const API = 'https://api.github.com';

async function gh<T>(c: Conexion, ruta: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${c.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!r.ok) {
    let detalle = '';
    try { detalle = (await r.json()).message ?? ''; } catch { /* sin cuerpo */ }
    if (r.status === 401) throw new Error('GitHub rechazó el token: revisa que esté bien copiado y no haya vencido.');
    if (r.status === 403) throw new Error(`El token no tiene permiso de escritura en ${c.repo} (Contents: Read and write). ${detalle}`);
    if (r.status === 404) throw new Error(`No encontré ${c.repo} o la rama ${c.rama}, o el token no tiene acceso a ese repositorio.`);
    throw new Error(`GitHub respondió ${r.status}: ${detalle}`);
  }
  return r.status === 204 ? (undefined as T) : r.json();
}

/** Lee un archivo de texto del repositorio; null si no existe. */
export async function leerTexto(c: Conexion, ruta: string): Promise<string | null> {
  const r = await fetch(`${API}/repos/${c.repo}/contents/${encodeURI(ruta)}?ref=${encodeURIComponent(c.rama)}`, {
    headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${c.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    cache: 'no-store',
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`No se pudo leer ${ruta} del repositorio (${r.status}).`);
  return r.text();
}

export async function probarConexion(c: Conexion): Promise<void> {
  await gh(c, `/repos/${c.repo}/branches/${encodeURIComponent(c.rama)}`);
}

function aBase64(datos: Uint8Array | string): string {
  const bytes = typeof datos === 'string' ? new TextEncoder().encode(datos) : datos;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Un archivo a escribir (contenido) o a borrar (null). */
export type Cambios = Record<string, Uint8Array | string | null>;

/** Escribe y borra varios archivos en un solo commit. */
export async function publicar(c: Conexion, cambios: Cambios, mensaje: string, avisar?: (t: string) => void): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(c, `/repos/${c.repo}/git/ref/heads/${encodeURIComponent(c.rama)}`);
  const padre = await gh<{ tree: { sha: string } }>(c, `/repos/${c.repo}/git/commits/${ref.object.sha}`);
  const arbol: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
  const rutas = Object.keys(cambios);
  for (const [i, ruta] of rutas.entries()) {
    const contenido = cambios[ruta];
    if (contenido === null) {
      arbol.push({ path: ruta, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    avisar?.(`Subiendo ${ruta.split('/').pop()} (${i + 1} de ${rutas.length})…`);
    const blob = await gh<{ sha: string }>(c, `/repos/${c.repo}/git/blobs`, {
      method: 'POST', body: JSON.stringify({ content: aBase64(contenido), encoding: 'base64' }),
    });
    arbol.push({ path: ruta, mode: '100644', type: 'blob', sha: blob.sha });
  }
  avisar?.('Guardando los cambios…');
  const tree = await gh<{ sha: string }>(c, `/repos/${c.repo}/git/trees`, {
    method: 'POST', body: JSON.stringify({ base_tree: padre.tree.sha, tree: arbol }),
  });
  const commit = await gh<{ sha: string }>(c, `/repos/${c.repo}/git/commits`, {
    method: 'POST', body: JSON.stringify({ message: mensaje, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await gh(c, `/repos/${c.repo}/git/refs/heads/${encodeURIComponent(c.rama)}`, {
    method: 'PATCH', body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
}
