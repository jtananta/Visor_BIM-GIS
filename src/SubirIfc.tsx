import { useEffect, useMemo, useRef, useState } from 'react';
import { compararNatural, type Datos, type Modelo } from './datos';
import type { Resultado } from './admin/convertir';
import { guardarConexion, leerConexion, probarConexion, type Conexion } from './admin/github';
import { componentePorUbicacion, convertirEnWorker, leerContexto, publicarModelos, ubicarResultado, type Contexto } from './admin/modelos';

interface Item {
  archivo: string;
  estado: 'convirtiendo' | 'listo' | 'error' | 'publicado';
  avance: number;
  texto: string;
  resultado?: Resultado;
  componente: string;
}

export interface Previa {
  modelo: Modelo;
  features: GeoJSON.Feature[];
}

interface Props {
  datos: Datos;
  /** Muestra los modelos en el visor de este navegador mientras no se publican. */
  verAqui: (p: Previa[]) => void;
  cerrar: () => void;
}

/** Botón «Subir IFC» del visor: convierte en el navegador, muestra el modelo al instante y lo publica para todos. */
export default function SubirIfc({ datos, verAqui, cerrar }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [ctx, setCtx] = useState<Contexto | null>(null);
  const [con, setCon] = useState<Conexion>(leerConexion);
  const [recordar, setRecordar] = useState(true);
  const [pedirClave, setPedirClave] = useState(() => !leerConexion().clave);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const entrada = useRef<HTMLInputElement | null>(null);
  const cola = useRef<Promise<void>>(Promise.resolve());
  const urls = useRef<string[]>([]);

  useEffect(() => {
    leerContexto(datos.componentes).then(setCtx).catch(() => setAviso({ tipo: 'error', texto: 'No se pudieron leer las reglas de conversión del sitio.' }));
  }, [datos.componentes]);

  useEffect(() => {
    const cerrarConEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ocupado) cerrar(); };
    window.addEventListener('keydown', cerrarConEsc);
    return () => window.removeEventListener('keydown', cerrarConEsc);
  }, [cerrar, ocupado]);

  const componentes = useMemo(() => [...datos.componentes].sort((a, b) =>
    compararNatural(a.sector, b.sector) || compararNatural(a.paquete, b.paquete) || compararNatural(a.componente, b.componente)), [datos.componentes]);

  // Cada cambio de componente vuelve a mostrar los modelos con su nueva ubicación (y un GLB con URL nueva,
  // para que la vista 3D recargue la ficha de cada pieza).
  const mostrar = (lista: Item[]) => {
    const listos = lista.filter((i) => i.resultado && i.estado !== 'error');
    if (!listos.length) return;
    verAqui(listos.map((i) => {
      const u = ubicarResultado(i.resultado!, i.componente, datos.componentes);
      const url = URL.createObjectURL(new Blob([i.resultado!.glb as BlobPart], { type: 'model/gltf-binary' }));
      urls.current.push(url);
      return { modelo: { ...u.modelo, glb: url }, features: u.features };
    }));
  };

  const agregar = (files: File[]) => {
    const ifc = files.filter((f) => /\.ifc$/i.test(f.name));
    if (ifc.length < files.length) setAviso({ tipo: 'error', texto: 'Solo se aceptan archivos .ifc.' });
    if (!ifc.length || !ctx) return;
    setItems((l) => [...l.filter((x) => !ifc.some((f) => f.name === x.archivo)),
      ...ifc.map((f) => ({ archivo: f.name, estado: 'convirtiendo' as const, avance: 0, texto: 'En cola', componente: '' }))]);
    for (const f of ifc) {
      cola.current = cola.current.then(async () => {
        const cambiar = (patch: Partial<Item>) => setItems((l) => l.map((x) => (x.archivo === f.name ? { ...x, ...patch } : x)));
        try {
          const r = await convertirEnWorker(f, ctx, (texto, avance) => cambiar({ texto, avance }));
          const cerca = componentePorUbicacion(r.modelo.bbox_utm as number[], datos.manifest.modelos.filter((m) => m.codigo !== r.codigo));
          const porTexto = String(r.modelo.componente ?? '');
          const componente = cerca && datos.componentes.some((c) => c.componente === cerca) ? cerca : porTexto;
          const nota = componente !== porTexto ? ' · componente sugerido por ubicación (revísalo)' : '';
          const item: Item = { archivo: f.name, estado: 'listo', avance: 1, texto: `${r.reporte.estructuras} estructuras · ${r.reporte.kb} KB${nota}`, resultado: r, componente };
          cambiar(item);
          mostrar([item]);
        } catch (e) {
          cambiar({ estado: 'error', texto: `No se pudo convertir: ${e instanceof Error ? e.message : e}` });
        }
      });
    }
  };

  const cambiarComponente = (archivo: string, componente: string) => {
    const nueva = items.map((x) => (x.archivo === archivo ? { ...x, componente, estado: x.estado === 'publicado' ? 'listo' as const : x.estado } : x));
    setItems(nueva);
    mostrar(nueva.filter((x) => x.archivo === archivo));
  };

  const porPublicar = items.filter((i) => i.estado === 'listo' && i.resultado);
  const sinComponente = porPublicar.filter((i) => !datos.componentes.some((c) => c.componente === i.componente));

  const publicarTodo = async () => {
    setAviso(null);
    setOcupado('Conectando…');
    try {
      await probarConexion(con);
      guardarConexion(con, recordar);
      await publicarModelos(con, porPublicar.map((i) => ({ resultado: i.resultado!, componente: i.componente })), datos.componentes, setOcupado);
      const hechos = new Set(porPublicar.map((i) => i.archivo));
      setItems((l) => l.map((x) => (hechos.has(x.archivo) ? { ...x, estado: 'publicado' } : x)));
      setAviso({ tipo: 'ok', texto: 'Publicado. Todos lo verán en el link en uno o dos minutos.' });
    } catch (e) {
      const texto = e instanceof Error ? e.message : String(e);
      if (/clave/i.test(texto)) setPedirClave(true);
      setAviso({ tipo: 'error', texto });
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="modal-fondo" onClick={(e) => { if (e.target === e.currentTarget && !ocupado) cerrar(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="subir-titulo">
        <div className="ficha-cab">
          <h2 id="subir-titulo">Subir IFC</h2>
          <button className="btn-icono" onClick={cerrar} disabled={Boolean(ocupado)} aria-label="Cerrar">✕</button>
        </div>
        <p className="sutil">El IFC se convierte en tu navegador y el modelo aparece de inmediato en el plano y en la vista 3D.
          Para que lo vean todos los que abren el link, publícalo.</p>

        {items.length > 0 && (
          <ul className="lista-ifc">
            {items.map((i) => (
              <li key={i.archivo}>
                <div className="lista-ifc-cab">
                  <strong>{i.resultado?.descripcion ?? i.archivo}</strong>
                  <span className={`etiqueta ${i.estado}`}>{
                    { convirtiendo: 'Convirtiendo', listo: 'Visible solo aquí', error: 'Error', publicado: 'Publicado' }[i.estado]}</span>
                </div>
                <span className="sutil">{i.texto}</span>
                {i.estado === 'convirtiendo' && <div className="barra-progreso"><span style={{ width: `${Math.round(i.avance * 100)}%` }} /></div>}
                {i.resultado && (
                  <label className="campo">
                    <span>Componente</span>
                    <select value={i.componente} onChange={(e) => cambiarComponente(i.archivo, e.target.value)} disabled={Boolean(ocupado)}>
                      {!componentes.some((c) => c.componente === i.componente) && <option value={i.componente}>{i.componente || 'Elegir componente…'}</option>}
                      {[...new Set(componentes.map((c) => `${c.sector} · ${c.paquete}`))].map((g) => (
                        <optgroup key={g} label={g}>
                          {componentes.filter((c) => `${c.sector} · ${c.paquete}` === g).map((c) => (
                            <option key={c.componente} value={c.componente}>{c.componente} · {c.descripcion}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}

        <button className="btn ancho" onClick={() => entrada.current?.click()} disabled={!ctx || Boolean(ocupado)}>
          {items.length ? 'Agregar otro IFC…' : 'Elegir archivo IFC…'}
        </button>
        <input ref={entrada} type="file" accept=".ifc" multiple hidden onChange={(e) => { agregar(Array.from(e.target.files ?? [])); e.target.value = ''; }} />

        {porPublicar.length > 0 && (
          <div className="publicar-ifc">
            {pedirClave && (
              <>
                <label className="campo"><span>Clave de publicación</span>
                  <input type="password" value={con.clave} onChange={(e) => setCon({ clave: e.target.value })} autoComplete="off"
                    onKeyDown={(e) => { if (e.key === 'Enter' && con.clave) void publicarTodo(); }} /></label>
                <label className="check"><input type="checkbox" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} /> Recordar en este navegador</label>
              </>
            )}
            {sinComponente.length > 0 && <div className="aviso-admin error" role="status">Elige el componente de {sinComponente.length === 1 ? sinComponente[0].archivo : `${sinComponente.length} IFC`} antes de publicar: no pude reconocerlo por el nombre ni por la ubicación.</div>}
            <button className="btn btn-primario" onClick={publicarTodo} disabled={Boolean(ocupado) || !con.clave || sinComponente.length > 0}>
              Publicar para todos ({porPublicar.length})
            </button>
          </div>
        )}

        {ocupado && <div className="aviso-admin info" role="status">{ocupado}</div>}
        {aviso && <div className={`aviso-admin ${aviso.tipo}`} role="status">{aviso.texto}</div>}
        <a className="sutil enlace-admin" href="#admin">Más opciones: quitar modelos, catálogo y capas GIS</a>
      </section>
    </div>
  );
}
