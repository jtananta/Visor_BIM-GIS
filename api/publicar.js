/**
 * Publicación desde el visor sin que nadie pegue un token: el token de GitHub vive en las variables de
 * entorno de Vercel y esta función hace los commits. Solo publica quien conoce la clave de publicación.
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   GITHUB_TOKEN     token fine-grained con Contents: Read and write sobre el repositorio del visor
 *   CLAVE_PUBLICAR   clave que se escribe en el visor para publicar
 *   GITHUB_REPO      opcional; por defecto, el repositorio conectado a Vercel
 *   GITHUB_RAMA      opcional; por defecto, main
 *
 * Acciones (POST JSON, cabecera x-clave):
 *   { accion: 'probar' }
 *   { accion: 'leer', ruta }                 → texto del archivo o 404
 *   { accion: 'blob', contenido }            → { sha }   (contenido en base64; uno por pedido por el límite de 4,5 MB)
 *   { accion: 'commit', mensaje, arbol }     → { sha }   (arbol: [{ path, sha | null }])
 */
import { timingSafeEqual } from 'node:crypto';

const RAIZ = 'public/data/';
const API = 'https://api.github.com';

function repo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  const { VERCEL_GIT_REPO_OWNER: o, VERCEL_GIT_REPO_SLUG: s } = process.env;
  return o && s ? `${o}/${s}` : 'jtananta/Visor_BIM-GIS';
}
const rama = () => process.env.GITHUB_RAMA || 'main';

function claveValida(dada) {
  const esperada = process.env.CLAVE_PUBLICAR || '';
  if (!esperada || typeof dada !== 'string') return false;
  const a = Buffer.from(dada);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

const rutaValida = (p) => typeof p === 'string' && p.startsWith(RAIZ) && !p.includes('..') && !p.includes('\\');

class Fallo extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(ruta, init = {}) {
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!r.ok) {
    let detalle = '';
    try { detalle = (await r.json()).message ?? ''; } catch { /* sin cuerpo */ }
    if (r.status === 401) throw new Fallo(502, 'GitHub rechazó el GITHUB_TOKEN configurado en Vercel: revisa que esté bien copiado y no haya vencido.');
    if (r.status === 403) throw new Fallo(502, `El GITHUB_TOKEN de Vercel no tiene permiso de escritura en ${repo()} (Contents: Read and write). ${detalle}`);
    if (r.status === 404) throw new Fallo(404, 'No encontrado');
    throw new Fallo(502, `GitHub respondió ${r.status}: ${detalle}`);
  }
  return r;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  if (!process.env.CLAVE_PUBLICAR || !process.env.GITHUB_TOKEN) {
    return res.status(503).json({ error: 'La publicación aún no está configurada: faltan GITHUB_TOKEN y CLAVE_PUBLICAR en las variables de entorno de Vercel.' });
  }
  if (!claveValida(req.headers['x-clave'])) return res.status(401).json({ error: 'La clave de publicación no es correcta.' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
  const R = repo();
  try {
    switch (b.accion) {
      case 'probar': {
        await gh(`/repos/${R}/branches/${encodeURIComponent(rama())}`);
        return res.json({ repo: R, rama: rama() });
      }
      case 'leer': {
        if (!rutaValida(b.ruta)) return res.status(400).json({ error: 'Ruta no permitida.' });
        try {
          const r = await gh(`/repos/${R}/contents/${encodeURI(b.ruta)}?ref=${encodeURIComponent(rama())}`, {
            headers: { Accept: 'application/vnd.github.raw+json' },
          });
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.send(await r.text());
        } catch (e) {
          if (e.status === 404) return res.status(404).json({ error: 'No existe.' });
          throw e;
        }
      }
      case 'blob': {
        if (typeof b.contenido !== 'string') return res.status(400).json({ error: 'Falta el contenido.' });
        const r = await gh(`/repos/${R}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b.contenido, encoding: 'base64' }) });
        return res.json({ sha: (await r.json()).sha });
      }
      case 'commit': {
        const arbol = Array.isArray(b.arbol) ? b.arbol : [];
        if (!arbol.length || !arbol.every((t) => rutaValida(t.path) && (t.sha === null || /^[0-9a-f]{40}$/.test(t.sha)))) {
          return res.status(400).json({ error: 'Solo se pueden cambiar archivos de public/data/.' });
        }
        const ref = await (await gh(`/repos/${R}/git/ref/heads/${encodeURIComponent(rama())}`)).json();
        const padre = await (await gh(`/repos/${R}/git/commits/${ref.object.sha}`)).json();
        const tree = await (await gh(`/repos/${R}/git/trees`, {
          method: 'POST',
          body: JSON.stringify({ base_tree: padre.tree.sha, tree: arbol.map((t) => ({ path: t.path, mode: '100644', type: 'blob', sha: t.sha })) }),
        })).json();
        const commit = await (await gh(`/repos/${R}/git/commits`, {
          method: 'POST',
          body: JSON.stringify({ message: String(b.mensaje || 'Visor: actualización').slice(0, 500), tree: tree.sha, parents: [ref.object.sha] }),
        })).json();
        await gh(`/repos/${R}/git/refs/heads/${encodeURIComponent(rama())}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
        return res.json({ sha: commit.sha });
      }
      default:
        return res.status(400).json({ error: 'Acción desconocida.' });
    }
  } catch (e) {
    return res.status(e.status ?? 500).json({ error: e.message });
  }
}
