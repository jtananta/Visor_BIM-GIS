import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fueraDeFoco, type EstadoVisor } from './App';
import { colorDe, crearProyeccion, unirCajas, type Caja, type Estructura } from './datos';
import { leerVector } from './gis';

type Base = 'sat' | 'osm' | 'none';

/** Capa del panel de capas: fija del proyecto (data/capas) o agregada en esta sesión. */
interface Capa {
  id: string;
  nombre: string;
  tipo: 'raster' | 'vector';
  visible: boolean;
  opacidad: number;
  fija: boolean;
  color?: string;
}

/* Límite de memoria del navegador para un GeoTIFF, igual que en el visor técnico. */
const MAX_RASTER_BYTES = 200 * 1024 * 1024;
const RASTER_EXT = /\.(tif|tiff|gtiff|geotiff)$/i;
const VECTOR_EXT = /\.(geojson|json|kml|zip)$/i;
const COLORES_SESION = ['#E8590C', '#7048E8', '#0CA678', '#D6336C', '#1C7ED6', '#F59F00'];

const ATENUADO = '#B8C0C8';

function escapar(t: unknown): string {
  return String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Ventana con los primeros atributos de un elemento de una capa GIS. */
function popupAtributos(props: Record<string, unknown> | null): string {
  const filas = Object.entries(props ?? {}).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').slice(0, 8);
  if (!filas.length) return '<em>Sin atributos</em>';
  return `<table class="atributos">${filas.map(([k, v]) => `<tr><th>${escapar(k)}</th><td>${escapar(v)}</td></tr>`).join('')}</table>`;
}

function estiloVector(color: string): L.PathOptions {
  return { color, weight: 2.5, fillColor: color, fillOpacity: 0.15, opacity: 0.95 };
}

export default function PlanoGeneral(s: EstadoVisor) {
  const host = useRef<HTMLDivElement | null>(null);
  const mapa = useRef<L.Map | null>(null);
  const base = useRef<L.TileLayer | null>(null);
  const capaTrazado = useRef<L.GeoJSON | null>(null);
  const capaEtiquetas = useRef<L.LayerGroup | null>(null);
  const capasLeaflet = useRef(new Map<string, any>());
  const seleccionar = useRef(s.seleccionar);
  seleccionar.current = s.seleccionar;

  const [tipoBase, setTipoBase] = useState<Base>('sat');
  const [capas, setCapas] = useState<Capa[]>([]);
  const [panelCapas, setPanelCapas] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const archivo = useRef<HTMLInputElement | null>(null);

  const proy = useMemo(() => crearProyeccion(s.datos.manifest.epsg), [s.datos.manifest.epsg]);
  const aBounds = useCallback((c: Caja) => {
    const [lo1, la1] = proy.aLonLat(c[0], c[1]);
    const [lo2, la2] = proy.aLonLat(c[2], c[3]);
    return L.latLngBounds([la1, lo1], [la2, lo2]);
  }, [proy]);

  /* Montaje ---------------------------------------------------------- */
  useEffect(() => {
    if (!host.current) return;
    const { lat, lon } = s.datos.manifest.origen;
    const m = L.map(host.current, { center: [lat, lon], zoom: 15, preferCanvas: true, zoomControl: true });
    // Panes como en el visor técnico: ráster sobre el mapa base, vectores GIS sobre el ráster,
    // y el trazado del proyecto (overlayPane, 400) siempre encima.
    m.createPane('raster').style.zIndex = '350';
    m.createPane('gis').style.zIndex = '380';
    capaEtiquetas.current = L.layerGroup().addTo(m);
    m.on('moveend', () => {
      const b = m.getBounds();
      const [e1, n1] = proy.aUtm(b.getWest(), b.getSouth());
      const [e2, n2] = proy.aUtm(b.getEast(), b.getNorth());
      s.reportarEncuadre([e1, n1, e2, n2]);
    });
    m.on('click', () => seleccionar.current(null));
    mapa.current = m;
    const obs = new ResizeObserver(() => m.invalidateSize());
    obs.observe(host.current);

    // Capas fijas del proyecto (pipeline/capas.py).
    const fijas: Capa[] = [];
    for (const [i, c] of s.datos.capas.entries()) {
      const id = `fija-${i}`;
      const url = `data/${c.archivo}`;
      if (c.tipo === 'raster' && c.bounds) {
        capasLeaflet.current.set(id, L.imageOverlay(url, c.bounds, { pane: 'raster', opacity: 0.95 }));
      } else if (c.tipo === 'vector') {
        const grupo = L.geoJSON(undefined, { pane: 'gis', style: () => estiloVector(c.color ?? '#E8590C'),
          pointToLayer: (_f, ll) => L.circleMarker(ll, { ...estiloVector(c.color ?? '#E8590C'), radius: 5, fillOpacity: 0.8, pane: 'gis' }),
          onEachFeature: (f, l) => l.bindPopup(popupAtributos(f.properties)) });
        fetch(url).then((r) => r.json()).then((gj) => grupo.addData(gj)).catch(() => setError(`No se pudo leer la capa «${c.nombre}».`));
        capasLeaflet.current.set(id, grupo);
      } else continue;
      fijas.push({ id, nombre: c.nombre, tipo: c.tipo, visible: c.visible !== false, opacidad: c.tipo === 'raster' ? 0.95 : 1, fija: true, color: c.color });
    }
    setCapas(fijas);

    return () => {
      obs.disconnect();
      m.remove();
      mapa.current = null;
      capasLeaflet.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Mapa base -------------------------------------------------------- */
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    base.current?.remove();
    base.current = null;
    if (tipoBase === 'sat') {
      base.current = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 20, maxNativeZoom: 19, attribution: 'Imágenes © Esri',
      }).addTo(m);
    } else if (tipoBase === 'osm') {
      base.current = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap',
      }).addTo(m);
    }
  }, [tipoBase]);

  /* Visibilidad y opacidad de las capas GIS --------------------------- */
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    for (const c of capas) {
      const l = capasLeaflet.current.get(c.id);
      if (!l) continue;
      if (c.tipo === 'raster') l.setOpacity?.(c.opacidad);
      if (c.visible && !m.hasLayer(l)) l.addTo(m);
      if (!c.visible && m.hasLayer(l)) m.removeLayer(l);
    }
  }, [capas]);

  /* Trazado de estructuras -------------------------------------------- */
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    capaTrazado.current?.remove();
    const visibles = {
      ...s.datos.trazado,
      features: s.datos.trazado.features.filter((f) => !s.ocultos.has(f.properties.modelo_codigo)),
    };
    const seleccionado = s.seleccion?.codigo;
    capaTrazado.current = L.geoJSON(visibles as any, {
      style: (f) => {
        const e = f!.properties as Estructura;
        const fuera = fueraDeFoco(s.foco, e);
        const color = fuera ? ATENUADO : colorDe(s.modoColor, s.datos, s.sectores, e, s.paquetes);
        const sel = e.codigo === seleccionado;
        return {
          color: sel ? '#FFFFFF' : color,
          weight: sel ? 4 : 2,
          fillColor: color,
          fillOpacity: fuera ? 0.25 : 0.75,
          opacity: fuera ? 0.5 : 1,
        };
      },
      onEachFeature: (f, layer) => {
        const e = f.properties as Estructura;
        layer.bindTooltip(e.nombre, { sticky: true, direction: 'top', className: 'tip' });
        layer.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          seleccionar.current(e);
        });
      },
    }).addTo(m);
  }, [s.datos, s.ocultos, s.foco, s.modoColor, s.sectores, s.paquetes, s.seleccion]);

  /* Etiqueta de cada paquete en el plano general --------------------------- */
  useEffect(() => {
    const g = capaEtiquetas.current;
    if (!g) return;
    g.clearLayers();
    for (const paq of s.paquetes) {
      const mods = s.datos.manifest.modelos.filter((x) => x.paquete === paq && !s.ocultos.has(x.codigo));
      const caja = unirCajas(mods.map((x) => x.bbox_utm));
      if (!caja) continue;
      const [lon, lat] = proy.aLonLat(caja[0], caja[3]);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: 'etiqueta-sector', html: `<span>${escapar(mods[0].sector)} · ${escapar(paq)}</span>`, iconSize: undefined }),
        interactive: false,
        keyboard: false,
      }).addTo(g);
    }
  }, [s.paquetes, s.datos, s.ocultos, proy]);

  /* Encuadre pedido por el panel, "Ver todo" o el cambio de vista ---------- */
  useEffect(() => {
    const m = mapa.current;
    if (!m || !s.encuadre) return;
    m.fitBounds(aBounds(s.encuadre.caja), { padding: [40, 40], maxZoom: 19, animate: s.encuadre.n > 0 });
  }, [s.encuadre?.n, aBounds]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Capas agregadas en la sesión ---------------------------------------- */
  const agregarCapa = (nombre: string, tipo: Capa['tipo'], capa: any, color?: string) => {
    const id = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    capasLeaflet.current.set(id, capa);
    capa.addTo(mapa.current!);
    setCapas((l) => [...l, { id, nombre, tipo, visible: true, opacidad: tipo === 'raster' ? 0.9 : 1, fija: false, color }]);
    try {
      const b = capa.getBounds?.();
      if (b?.isValid?.()) mapa.current!.fitBounds(b, { maxZoom: 19, padding: [30, 30] });
    } catch { /* el encuadre es una comodidad */ }
  };

  /** GeoTIFF / ortofotos: misma integración georaster que el visor técnico. */
  const cargarRaster = async (file: File) => {
    if (file.size > MAX_RASTER_BYTES) {
      setError(`«${file.name}» pesa ${(file.size / 1048576).toFixed(0)} MB y el límite es 200 MB por capa.`);
      return;
    }
    // @ts-ignore — georaster no publica tipos propios.
    const gr = await import('georaster');
    // @ts-ignore — georaster-layer-for-leaflet no publica tipos propios.
    const gl = await import('georaster-layer-for-leaflet');
    const parseGeoraster = (gr as any).default ?? gr;
    const GeoRasterLayer = (gl as any).default ?? gl;
    const georaster = await parseGeoraster(await file.arrayBuffer());
    if (![georaster?.xmin, georaster?.xmax, georaster?.ymin, georaster?.ymax].every((v) => Number.isFinite(Number(v)))) {
      throw new Error(`«${file.name}» no tiene georreferencia. Expórtalo como GeoTIFF georreferenciado.`);
    }
    agregarCapa(file.name, 'raster', new GeoRasterLayer({ georaster, opacity: 0.9, resolution: 256, pane: 'raster' }));
  };

  /** GeoJSON, KML o Shapefile comprimido en .zip (con .shp, .dbf y .prj). */
  const cargarVector = async (file: File) => {
    const gj = await leerVector(file.name, await file.arrayBuffer());
    const color = COLORES_SESION[capas.filter((c) => c.tipo === 'vector').length % COLORES_SESION.length];
    const capa = L.geoJSON(gj, {
      pane: 'gis',
      style: () => estiloVector(color),
      pointToLayer: (_f, ll) => L.circleMarker(ll, { ...estiloVector(color), radius: 5, fillOpacity: 0.8, pane: 'gis' }),
      onEachFeature: (f, l) => l.bindPopup(popupAtributos(f.properties)),
    });
    agregarCapa(file.name.replace(/\.(geojson|json|kml|zip)$/i, ''), 'vector', capa, color);
  };

  const cargarArchivo = async (file: File) => {
    setError(null);
    if (!RASTER_EXT.test(file.name) && !VECTOR_EXT.test(file.name)) {
      setError(`«${file.name}»: el visor acepta GeoTIFF (.tif), GeoJSON, KML o un Shapefile comprimido en .zip. Un .kmz se puede guardar como .kml desde Google Earth o QGIS.`);
      return;
    }
    setOcupado(`Leyendo «${file.name}»…`);
    try {
      await (RASTER_EXT.test(file.name) ? cargarRaster(file) : cargarVector(file));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setError(msg.startsWith('«') ? msg : `No se pudo cargar «${file.name}». Comprueba que sea un archivo GIS georreferenciado válido.`);
    } finally {
      setOcupado(null);
    }
  };

  const cambiarCapa = (id: string, patch: Partial<Capa>) => setCapas((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const quitarCapa = (id: string) => {
    const l = capasLeaflet.current.get(id);
    if (l) mapa.current?.removeLayer(l);
    capasLeaflet.current.delete(id);
    setCapas((x) => x.filter((c) => c.id !== id));
  };

  return (
    <div
      className={`vista ${arrastrando ? 'arrastrando' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
      onDragLeave={() => setArrastrando(false)}
      onDrop={(e) => {
        e.preventDefault();
        setArrastrando(false);
        Array.from(e.dataTransfer.files).forEach((f) => void cargarArchivo(f));
      }}
    >
      <div ref={host} className="mapa" />
      <div className="capas">
        <div className="segmentado chico" role="radiogroup" aria-label="Mapa base">
          <button aria-checked={tipoBase === 'sat'} role="radio" onClick={() => setTipoBase('sat')}>Satélite</button>
          <button aria-checked={tipoBase === 'osm'} role="radio" onClick={() => setTipoBase('osm')}>Calles</button>
          <button aria-checked={tipoBase === 'none'} role="radio" onClick={() => setTipoBase('none')}>Sin base</button>
        </div>
        <div className="caja-capas">
          <button className="caja-capas-cab" onClick={() => setPanelCapas((x) => !x)} aria-expanded={panelCapas}>
            <span>Capas GIS ({capas.length})</span><span aria-hidden="true">{panelCapas ? '▾' : '▸'}</span>
          </button>
          {panelCapas && (
            <>
              {capas.length === 0 && <p className="sutil capas-vacio">Sin capas todavía. Agrega una ortofoto o un mapa GIS.</p>}
              {capas.map((c) => (
                <div key={c.id} className="raster">
                  <label title={c.nombre}>
                    <input type="checkbox" checked={c.visible} onChange={(e) => cambiarCapa(c.id, { visible: e.target.checked })} />
                    {c.tipo === 'vector' ? <span className="punto" style={{ background: c.color }} /> : <span className="icono-raster" aria-hidden="true" />}
                    <span className="raster-nombre">{c.nombre}</span>
                  </label>
                  {c.tipo === 'raster' && (
                    <input type="range" min={0.1} max={1} step={0.05} value={c.opacidad} aria-label={`Opacidad de ${c.nombre}`}
                      onChange={(e) => cambiarCapa(c.id, { opacidad: Number(e.target.value) })} />
                  )}
                  {c.fija ? <span className="sutil etiqueta-fija" title="Capa del proyecto">fija</span>
                    : <button className="btn-icono chico" onClick={() => quitarCapa(c.id)} aria-label={`Quitar ${c.nombre}`}>✕</button>}
                </div>
              ))}
              <button className="btn chico ancho" onClick={() => archivo.current?.click()}>Agregar capa…</button>
              <p className="sutil capas-ayuda">GeoTIFF, GeoJSON, KML o Shapefile (.zip). También puedes soltarlos sobre el mapa. Solo se ven en este navegador.</p>
            </>
          )}
        </div>
        <input ref={archivo} type="file" accept=".tif,.tiff,.gtiff,.geotiff,.geojson,.json,.kml,.zip" multiple hidden
          onChange={(e) => { Array.from(e.target.files ?? []).forEach((f) => void cargarArchivo(f)); e.target.value = ''; }} />
        {ocupado && <div className="aviso">{ocupado}</div>}
        {error && <div className="aviso error" onClick={() => setError(null)}>{error}</div>}
      </div>
    </div>
  );
}
