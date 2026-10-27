import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fueraDeFoco, type EstadoVisor } from './App';
import { urlTeselaEsri, zoomMaxEsri } from './esri';
import { colorDe, crearProyeccion, ubicacionModelo, unirCajas, type CapaFija, type Caja, type Estructura } from './datos';

interface Pieza {
  mesh: THREE.Mesh;
  meta: Estructura;
}

const ATENUADO = '#C3CAD1';
const FONDO = '#E9EEF2';

/* Materiales compartidos por color: con 33 modelos no conviene uno por estructura. */
const materiales = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string, atenuado: boolean, resaltado: boolean): THREE.MeshStandardMaterial {
  const clave = `${color}|${atenuado}|${resaltado}`;
  let m = materiales.get(clave);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.85,
      metalness: 0,
      // Los GLB no traen normales (pesan menos): el sombreado plano las deriva en la GPU.
      flatShading: true,
      transparent: atenuado,
      opacity: atenuado ? 0.25 : 1,
      depthWrite: !atenuado,
      emissive: new THREE.Color(resaltado ? '#FFB020' : '#000000'),
      emissiveIntensity: resaltado ? 0.55 : 0,
      side: THREE.DoubleSide,
    });
    materiales.set(clave, m);
  }
  return m;
}

export default function Vista3D(s: EstadoVisor) {
  const host = useRef<HTMLDivElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const motor = useRef<{
    renderer: THREE.WebGLRenderer;
    escena: THREE.Scene;
    camara: THREE.PerspectiveCamera;
    controles: OrbitControls;
    modelos: Map<string, THREE.Object3D>;
    piezas: Pieza[];
    suelo: THREE.Mesh | null;
    pedirRender: () => void;
    volarA: (c: Caja, animar: boolean) => void;
  } | null>(null);
  const hover = useRef<string | null>(null);
  const [progreso, setProgreso] = useState<{ hechos: number; total: number } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [listo, setListo] = useState(0);
  const sRef = useRef(s);
  sRef.current = s;

  const { origen, epsg } = s.datos.manifest;
  const proy = useMemo(() => crearProyeccion(epsg), [epsg]);
  const cajaTotal = useMemo(() => unirCajas(s.datos.manifest.modelos.map((m) => m.bbox_utm))!, [s.datos]);

  /* Montaje del motor ---------------------------------------------------- */
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const escena = new THREE.Scene();
    escena.background = new THREE.Color(FONDO);
    escena.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 1.6));
    const sol = new THREE.DirectionalLight(0xffffff, 1.6);
    sol.position.set(-300, 600, 400);
    escena.add(sol);

    const camara = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.5, 30000);
    const controles = new OrbitControls(camara, renderer.domElement);
    controles.enableDamping = true;
    controles.screenSpacePanning = false;
    controles.maxPolarAngle = Math.PI * 0.49;
    controles.zoomToCursor = true;

    let pendiente = false;
    const pedirRender = () => {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(() => {
        pendiente = false;
        if (controles.update()) pedirRender();
        renderer.render(escena, camara);
      });
    };
    controles.addEventListener('change', pedirRender);
    controles.addEventListener('end', () => {
      // Lo que se ve, como caja UTM, para conservar el encuadre al volver al plano.
      const t = controles.target;
      const r = camara.position.distanceTo(t) * 0.6;
      sRef.current.reportarEncuadre([t.x + origen.e - r, -t.z + origen.n - r, t.x + origen.e + r, -t.z + origen.n + r]);
    });

    let anim = 0;
    const volarA = (c: Caja, animar: boolean) => {
      const cx = (c[0] + c[2]) / 2 - origen.e;
      const cz = -((c[1] + c[3]) / 2 - origen.n);
      const tam = Math.max(c[2] - c[0], c[3] - c[1], 30);
      const y = controles.target.y || 5;
      const destinoT = new THREE.Vector3(cx, y, cz);
      const dist = tam * 0.8;
      const destinoC = new THREE.Vector3(cx, y + dist * 0.85, cz + dist * 0.55);
      cancelAnimationFrame(anim);
      if (!animar) {
        controles.target.copy(destinoT);
        camara.position.copy(destinoC);
        pedirRender();
        return;
      }
      const t0 = performance.now();
      const desdeT = controles.target.clone();
      const desdeC = camara.position.clone();
      const paso = (ahora: number) => {
        const k = Math.min(1, (ahora - t0) / 700);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        controles.target.lerpVectors(desdeT, destinoT, e);
        camara.position.lerpVectors(desdeC, destinoC, e);
        pedirRender();
        if (k < 1) anim = requestAnimationFrame(paso);
      };
      anim = requestAnimationFrame(paso);
    };

    motor.current = { renderer, escena, camara, controles, modelos: new Map(), piezas: [], suelo: null, pedirRender, volarA };

    const obs = new ResizeObserver(() => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camara.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camara.updateProjectionMatrix();
      pedirRender();
    });
    obs.observe(el);

    /* Hover y clic ------------------------------------------------------ */
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const tocar = (ev: PointerEvent): Pieza | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, camara);
      const visibles = motor.current!.piezas.filter((p) => p.mesh.visible && p.mesh.parent?.visible);
      const hit = ray.intersectObjects(visibles.map((p) => p.mesh), false)[0];
      return hit ? visibles.find((p) => p.mesh === hit.object) ?? null : null;
    };
    let ultimo = 0;
    const mover = (ev: PointerEvent) => {
      if (ev.buttons) return;
      const ahora = performance.now();
      if (ahora - ultimo < 50) return;
      ultimo = ahora;
      const p = tocar(ev);
      const cod = p?.meta.codigo ?? null;
      if (tip.current) {
        tip.current.style.display = p ? 'block' : 'none';
        if (p) {
          const r = el.getBoundingClientRect();
          tip.current.textContent = p.meta.nombre;
          tip.current.style.transform = `translate(${ev.clientX - r.left + 14}px, ${ev.clientY - r.top + 10}px)`;
        }
      }
      renderer.domElement.style.cursor = p ? 'pointer' : '';
      if (cod !== hover.current) {
        hover.current = cod;
        setListo((n) => n + 1);
      }
    };
    let abajo: { x: number; y: number } | null = null;
    const bajar = (ev: PointerEvent) => { abajo = { x: ev.clientX, y: ev.clientY }; };
    const subir = (ev: PointerEvent) => {
      if (!abajo || Math.hypot(ev.clientX - abajo.x, ev.clientY - abajo.y) > 5) return;
      sRef.current.seleccionar(tocar(ev)?.meta ?? null);
    };
    renderer.domElement.addEventListener('pointermove', mover);
    renderer.domElement.addEventListener('pointerdown', bajar);
    renderer.domElement.addEventListener('pointerup', subir);

    return () => {
      cancelAnimationFrame(anim);
      obs.disconnect();
      controles.dispose();
      renderer.domElement.removeEventListener('pointermove', mover);
      renderer.domElement.removeEventListener('pointerdown', bajar);
      renderer.domElement.removeEventListener('pointerup', subir);
      escena.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
      renderer.dispose();
      el.removeChild(renderer.domElement);
      motor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Carga de modelos visibles (bajo demanda, uno por uno) --------------------- */
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    // Un modelo subido en esta sesión reemplaza al publicado con el mismo código.
    for (const x of s.datos.manifest.modelos) {
      const previo = m.modelos.get(x.codigo);
      if (!previo || previo.userData.glb === x.glb) continue;
      m.escena.remove(previo);
      m.piezas = m.piezas.filter((p) => p.meta.modelo_codigo !== x.codigo);
      m.modelos.delete(x.codigo);
    }
    const faltan = s.datos.manifest.modelos.filter((x) => !s.ocultos.has(x.codigo) && !m.modelos.has(x.codigo));
    if (!faltan.length) return;
    let cancelado = false;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    (async () => {
      setProgreso({ hechos: 0, total: faltan.length });
      let hechos = 0;
      const errores: string[] = [];
      for (const mod of faltan) {
        if (cancelado) return;
        try {
          const gltf = await cargarGlb(loader, mod.glb.startsWith('blob:') ? mod.glb : `data/${mod.glb}`);
          if (cancelado || !motor.current) return;
          const raiz = gltf.scene;
          raiz.name = mod.codigo;
          raiz.userData.glb = mod.glb;
          raiz.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            // GLTFLoader deja los extras del nodo en userData del objeto (o de su padre si hay varias primitivas).
            const meta = (Object.keys(mesh.userData).length ? mesh.userData : mesh.parent?.userData) as Estructura;
            if (meta?.codigo) m.piezas.push({ mesh, meta: { ...meta, ...ubicacionModelo(s.datos.manifest, meta.modelo_codigo) } });
          });
          m.escena.add(raiz);
          m.modelos.set(mod.codigo, raiz);
        } catch {
          errores.push(mod.modelo);
        }
        hechos++;
        setProgreso({ hechos, total: faltan.length });
        setListo((n) => n + 1);
      }
      setProgreso(null);
      if (errores.length) setAviso(`No se pudieron cargar: ${errores.join(', ')}.`);
    })();
    return () => { cancelado = true; };
  }, [s.datos, s.ocultos]);

  /* Suelo: la ortofoto del proyecto si hay una marcada como suelo; si no, la imagen satelital. ---- */
  useEffect(() => {
    const m = motor.current;
    if (!m || m.suelo || !m.piezas.length || progreso) return;
    const caja = new THREE.Box3();
    m.piezas.forEach((p) => caja.expandByObject(p.mesh));
    const y = caja.min.y - 1;
    const orto = s.datos.capas.find((c) => c.tipo === 'raster' && c.suelo && c.bounds);
    let c: Caja;
    if (orto) {
      const [[la0, lo0], [la1, lo1]] = orto.bounds!;
      const [e0, n0] = proy.aUtm(lo0, la0);
      const [e1, n1] = proy.aUtm(lo1, la1);
      c = [Math.min(e0, e1), Math.min(n0, n1), Math.max(e0, e1), Math.max(n0, n1)];
    } else {
      const margen = 250;
      c = [cajaTotal[0] - margen, cajaTotal[1] - margen, cajaTotal[2] + margen, cajaTotal[3] + margen];
    }
    const suelo = crearSuelo(c, y, origen, proy, orto ?? null, m.pedirRender,
      () => setAviso(orto ? `No se pudo leer la ortofoto «${orto.nombre}»: el suelo se muestra liso.` : 'La imagen satelital no está disponible en esta red: el suelo se muestra liso.'));
    m.escena.add(suelo);
    m.suelo = suelo;
    if (m.controles.target.y === 0) m.controles.target.y = y;
    m.pedirRender();
  }, [listo, progreso, cajaTotal, origen, proy, s.datos.capas]);

  /* Visibilidad, colores, atenuado por sector y resaltado ------------------- */
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.modelos.forEach((obj, cod) => { obj.visible = !s.ocultos.has(cod); });
    for (const p of m.piezas) {
      const fuera = fueraDeFoco(s.foco, p.meta);
      const color = fuera ? ATENUADO : colorDe(s.modoColor, s.datos, s.sectores, p.meta, s.paquetes);
      const res = p.meta.codigo === s.seleccion?.codigo || p.meta.codigo === hover.current;
      p.mesh.material = material(color, fuera, res);
      p.mesh.renderOrder = fuera ? 1 : 0;
    }
    m.pedirRender();
  }, [s.ocultos, s.foco, s.modoColor, s.seleccion, s.datos, s.sectores, s.paquetes, listo]);

  /* Encuadre ------------------------------------------------------------- */
  useEffect(() => {
    const m = motor.current;
    if (!m || !s.encuadre) return;
    m.volarA(s.encuadre.caja, s.encuadre.n > 0 && m.camara.position.lengthSq() > 0);
  }, [s.encuadre?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="vista">
      <div ref={host} className="mapa tres" />
      <div ref={tip} className="tip tip-3d" style={{ display: 'none' }} />
      {progreso && (
        <div className="progreso" role="status">
          Cargando modelos {progreso.hechos} de {progreso.total}
          <div className="barra-progreso"><span style={{ width: `${(progreso.hechos / progreso.total) * 100}%` }} /></div>
        </div>
      )}
      {aviso && <div className="aviso flotante" onClick={() => setAviso(null)}>{aviso}</div>}
      <div className="ayuda-3d">Arrastrar: girar · Clic derecho: mover · Rueda: acercar</div>
    </div>
  );
}

/** GLB normal, o en base64 (.b64.txt) donde el hosting no sirve binarios .glb, como los Artifacts. */
async function cargarGlb(loader: GLTFLoader, url: string) {
  if (!url.endsWith('.b64.txt')) return loader.loadAsync(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(url);
  const bin = atob((await r.text()).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return loader.parseAsync(bytes.buffer, '');
}

/* ------------------------------------------------------------------ */
/* Suelo: teselas de Esri World Imagery reproyectadas sobre una malla UTM */
/* ------------------------------------------------------------------ */

function crearSuelo(
  c: Caja,
  y: number,
  origen: { e: number; n: number },
  proy: ReturnType<typeof crearProyeccion>,
  orto: CapaFija | null,
  pedirRender: () => void,
  sinImagen: () => void,
): THREE.Mesh {
  const ancho = c[2] - c[0];
  const alto = c[3] - c[1];
  const seg = 24;
  const geo = new THREE.PlaneGeometry(ancho, alto, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate((c[0] + c[2]) / 2 - origen.e, y, -((c[1] + c[3]) / 2 - origen.n));

  const mat = new THREE.MeshLambertMaterial({ color: '#D5DBD0' });
  const suelo = new THREE.Mesh(geo, mat);
  suelo.name = 'suelo';

  const merc = (lon: number, lat: number, z: number) => {
    const n = 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  };
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;

  if (orto?.bounds) {
    // La ortofoto viene en Web Mercator (capas.py): la UV es lineal en coordenadas Mercator.
    const [[laS, loO], [laN, loE]] = orto.bounds;
    const [mx0, my0] = merc(loO, laN, 0);
    const [mx1, my1] = merc(loE, laS, 0);
    for (let i = 0; i < pos.count; i++) {
      const [lon, lat] = proy.aLonLat(pos.getX(i) + origen.e, -pos.getZ(i) + origen.n);
      const [mx, my] = merc(lon, lat, 0);
      uv.setXY(i, (mx - mx0) / (mx1 - mx0), 1 - (my - my0) / (my1 - my0));
    }
    uv.needsUpdate = true;
    mat.transparent = true;
    mat.alphaTest = 0.5;
    new THREE.TextureLoader().load(`data/${orto.archivo}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      mat.map = tex;
      mat.color.set('#FFFFFF');
      mat.needsUpdate = true;
      pedirRender();
    }, undefined, sinImagen);
    return suelo;
  }

  // El zoom de las teselas no pasa del último con imagen real en la zona (ver esri.ts).
  const [loC, laC] = proy.aLonLat((c[0] + c[2]) / 2, (c[1] + c[3]) / 2);
  void zoomMaxEsri(loC, laC).then((zmax) => {
    // Rango de teselas que cubre la caja, a un zoom que quepa en un lienzo de 4096 px.
    const [lo1, la1] = proy.aLonLat(c[0], c[1]);
    const [lo2, la2] = proy.aLonLat(c[2], c[3]);
    let z = zmax;
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; z >= 12; z--) {
      const [ax, ay] = merc(Math.min(lo1, lo2), Math.max(la1, la2), z);
      const [bx, by] = merc(Math.max(lo1, lo2), Math.min(la1, la2), z);
      x0 = Math.floor(ax); y0 = Math.floor(ay); x1 = Math.floor(bx); y1 = Math.floor(by);
      if ((x1 - x0 + 1) * 256 <= 4096 && (y1 - y0 + 1) * 256 <= 4096) break;
    }
    const lienzo = document.createElement('canvas');
    lienzo.width = (x1 - x0 + 1) * 256;
    lienzo.height = (y1 - y0 + 1) * 256;
    const ctx = lienzo.getContext('2d')!;
    ctx.fillStyle = '#D5DBD0'; // donde falte una tesela queda el color del suelo liso
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);

    // UV de cada vértice: local → UTM → lon/lat → píxel Mercator del lienzo.
    for (let i = 0; i < pos.count; i++) {
      const [lon, lat] = proy.aLonLat(pos.getX(i) + origen.e, -pos.getZ(i) + origen.n);
      const [mx, my] = merc(lon, lat, z);
      uv.setXY(i, (mx - x0) / (x1 - x0 + 1), 1 - (my - y0) / (y1 - y0 + 1));
    }
    uv.needsUpdate = true;

    const total = (x1 - x0 + 1) * (y1 - y0 + 1);
    let hechas = 0;
    let fallas = 0;
    const textura = new THREE.CanvasTexture(lienzo);
    textura.colorSpace = THREE.SRGBColorSpace;
    textura.anisotropy = 8;
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
          terminar();
        };
        img.onerror = () => { fallas++; terminar(); };
        img.src = urlTeselaEsri(z, ty, tx);
      }
    }
    function terminar() {
      hechas++;
      if (hechas < total) return;
      if (fallas === total) { sinImagen(); return; }
      try {
        mat.map = textura;
        mat.color.set('#FFFFFF');
        mat.needsUpdate = true;
        textura.needsUpdate = true;
      } catch {
        sinImagen();
      }
      pedirRender();
    }
  });
  return suelo;
}
