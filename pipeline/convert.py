"""Convierte los IFC del proyecto en GLB livianos para el visor gerencial.

Uso:
    python convert.py <carpeta_ifc> <carpeta_salida>

Salida en <carpeta_salida>:
    models/<codigo>.glb    una malla por estructura, metadata mínima en extras
    manifest.json          lista de modelos, origen y CRS del proyecto
    trazado.geojson        huella 2D de cada estructura (EPSG:4326)
    catalogo.csv           componente al que pertenece cada modelo (editable; se respeta si ya existe)
Requiere componentes.csv en <carpeta_salida> (lo genera catalogo.py desde el Excel de paquetes):
de ahí salen sector, paquete y estado.
    reporte.csv            control de la corrida
"""

import csv
import json
import warnings
import math
import multiprocessing
import re
import struct
import sys
from collections import defaultdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import numpy as np
from pyproj import Transformer
from shapely.geometry import MultiPoint, mapping
from shapely.ops import transform as shp_transform, unary_union

warnings.filterwarnings("ignore", category=DeprecationWarning)  # shapely.ops.transform

AQUI = Path(__file__).parent
# Las mismas reglas que usa la página de administración del visor: un solo lugar para editarlas.
DATOS_SITIO = AQUI.parent / "public" / "data"
PROYECTO = json.loads((DATOS_SITIO / "proyecto.json").read_text(encoding="utf-8"))
REGLAS = json.loads((DATOS_SITIO / "reglas.json").read_text(encoding="utf-8"))

# Colores por tipo de estructura (sRGB 0-1). El visor puede recolorear por sector o estado.
COLORES = {
    "Buzón": (0.20, 0.45, 0.75),
    "Sumidero": (0.10, 0.60, 0.55),
    "Tubería": (0.85, 0.55, 0.15),
    "Gaviones": (0.55, 0.50, 0.40),
    "Canal": (0.62, 0.64, 0.66),
    "Otros": (0.70, 0.70, 0.70),
}


# ---------------------------------------------------------------------------
# Clasificación
# ---------------------------------------------------------------------------

EXCLUIR = re.compile(REGLAS["excluir"], re.I)
TIPOS = [dict(r, rx=re.compile(r["patron"], re.I)) for r in REGLAS["tipos"]]
REGLA_POR_TIPO = {r["tipo"]: r for r in TIPOS}


def descripcion_modelo(ifc, ruta):
    """Texto entre paréntesis del nombre original del IFC: 'Sumideros', 'Dique Mangle'…"""
    nombre = ifc.header.file_name.name or ruta.name
    m = re.search(r"\(([^)]+)\)", nombre)
    return m.group(1).strip() if m else ruta.stem


def tipo_por_modelo(descripcion):
    for clave, tipo in REGLAS["por_modelo"].items():
        if not clave.startswith("_") and clave.lower() in descripcion.lower():
            return tipo
    return "Otros"


def clasificar(el, defecto):
    t = ue.get_type(el)
    texto = f"{el.is_a()}|{t.Name if t else ''}|{el.Name or ''}"
    if EXCLUIR.search(texto):
        return None
    for r in TIPOS:
        if r["rx"].search(texto):
            return r["tipo"]
    return defecto


# ---------------------------------------------------------------------------
# Agrupación de elementos en estructuras
# ---------------------------------------------------------------------------

class UnionFind:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def agrupar_contacto(items, tol):
    """Une elementos cuyas cajas (ampliadas en tol) se tocan: un buzón = sus losas + muro."""
    n = len(items)
    uf = UnionFind(n)
    lo = np.array([it["min"] for it in items]) - tol
    hi = np.array([it["max"] for it in items]) + tol
    orden = np.argsort(lo[:, 0])
    for a_i, a in enumerate(orden):
        for b in orden[a_i + 1:]:
            if lo[b, 0] > hi[a, 0]:
                break
            if np.all(lo[b] <= hi[a]) and np.all(lo[a] <= hi[b]):
                uf.union(a, b)
    grupos = defaultdict(list)
    for i in range(n):
        grupos[uf.find(i)].append(items[i])
    return list(grupos.values())


def agrupar_sistema(items, tol):
    """Tuberías: una estructura por sistema de Revit; lo que no tiene sistema, por contacto."""
    por_sistema = defaultdict(list)
    sueltos = []
    for it in items:
        (por_sistema[it["sistema"]] if it["sistema"] else sueltos).append(it)
    grupos = list(por_sistema.values())
    if sueltos:
        grupos += agrupar_contacto(sueltos, tol)
    return grupos


def agrupar_tramo(items, largo):
    """Obras lineales (canal, gaviones): cortes en celdas de `largo` metros."""
    celdas = defaultdict(list)
    for it in items:
        c = it["centro"]
        celdas[(math.floor(c[0] / largo), math.floor(c[1] / largo))].append(it)
    return list(celdas.values())


def agrupar(tipo, items):
    r = REGLA_POR_TIPO.get(tipo, {"agrupar": "contacto", "tolerancia": 0.5})
    if r["agrupar"] == "sistema":
        return agrupar_sistema(items, r.get("tolerancia", 0.05))
    if r["agrupar"] == "tramo":
        return agrupar_tramo(items, r.get("tramo", 100))
    return agrupar_contacto(items, r.get("tolerancia", 0.5))


def sistemas_por_elemento(ifc):
    out = {}
    for rel in ifc.by_type("IfcRelAssignsToGroup"):
        g = rel.RelatingGroup
        if g.is_a("IfcSystem"):
            for o in rel.RelatedObjects:
                out[o.id()] = g.Name
    return out


# ---------------------------------------------------------------------------
# Geometría
# ---------------------------------------------------------------------------

def teselar(ifc, elementos):
    s = ifcopenshell.geom.settings()
    s.set("use-world-coords", True)
    s.set("weld-vertices", True)
    it = ifcopenshell.geom.iterator(s, ifc, multiprocessing.cpu_count(), include=elementos)
    out = {}
    if not it.initialize():
        return out
    while True:
        sh = it.get()
        v = np.array(sh.geometry.verts, dtype=np.float64).reshape(-1, 3)
        f = np.array(sh.geometry.faces, dtype=np.uint32).reshape(-1, 3)
        if len(v) and len(f):
            out[sh.id] = (v, f)
        if not it.next():
            break
    return out


def a_local(v):
    """UTM (E, N, Z) en doble precisión → ejes glTF (x=E, y=Z, z=-N) relativos al origen."""
    o = PROYECTO["origen"]
    return np.column_stack([v[:, 0] - o["e"], v[:, 2] - o["z"], -(v[:, 1] - o["n"])]).astype(np.float32)


# ---------------------------------------------------------------------------
# Escritura GLB (mínima: posiciones + índices; el visor usa sombreado plano)
# ---------------------------------------------------------------------------

def escribir_glb(ruta, estructuras, tipos_usados):
    bin_ = bytearray()
    views, accessors, meshes, nodes = [], [], [], []
    materiales = [
        {"name": t, "pbrMetallicRoughness": {"baseColorFactor": [*COLORES.get(t, COLORES["Otros"]), 1.0],
                                              "metallicFactor": 0.0, "roughnessFactor": 0.9}}
        for t in tipos_usados
    ]
    mat_idx = {t: i for i, t in enumerate(tipos_usados)}

    def add_view(data, target):
        while len(bin_) % 4:
            bin_.append(0)
        views.append({"buffer": 0, "byteOffset": len(bin_), "byteLength": len(data), "target": target})
        bin_.extend(data)
        return len(views) - 1

    for e in estructuras:
        pos, idx = e["pos"], e["idx"]
        vp = add_view(pos.tobytes(), 34962)
        accessors.append({"bufferView": vp, "componentType": 5126, "count": len(pos), "type": "VEC3",
                          "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
        a_pos = len(accessors) - 1
        vi = add_view(idx.astype(np.uint32).tobytes(), 34963)
        accessors.append({"bufferView": vi, "componentType": 5125, "count": int(idx.size), "type": "SCALAR"})
        a_idx = len(accessors) - 1
        meshes.append({"name": e["meta"]["nombre"],
                       "primitives": [{"attributes": {"POSITION": a_pos}, "indices": a_idx,
                                       "material": mat_idx[e["meta"]["tipo_estructura"]]}]})
        nodes.append({"name": e["meta"]["codigo"], "mesh": len(meshes) - 1, "extras": e["meta"]})

    while len(bin_) % 4:
        bin_.append(0)
    gltf = {
        "asset": {"version": "2.0", "generator": "visor-gerencial convert.py"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "materials": materiales,
        "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(bin_)}],
    }
    js = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(ruta, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A)); fh.write(js)
        fh.write(struct.pack("<II", len(bin_), 0x004E4942)); fh.write(bin_)


# ---------------------------------------------------------------------------
# Catálogo y estados (CSV editables)
# ---------------------------------------------------------------------------

def leer_csv(ruta, clave):
    if not ruta.exists():
        return {}
    with open(ruta, encoding="utf-8-sig", newline="") as fh:
        return {r[clave]: r for r in csv.DictReader(fh)}


def escribir_csv(ruta, filas, campos):
    with open(ruta, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=campos)
        w.writeheader()
        w.writerows(filas)


def _palabras(t):
    w = {w for w in re.findall(r"[a-záéíóúñ]{4,}", t.lower())}
    # Buzones, sumideros y tuberías son obras de "drenaje urbano" en el catálogo.
    if w & {"buzon", "buzones", "sumidero", "sumideros", "tuberia", "tuberias", "tubería", "tuberías"}:
        w |= {"drenaje", "urbano"}
    return w


def catalogo_por_defecto(ifc, codigo, descripcion, componentes):
    """Propone el componente del catálogo para un modelo nuevo; Jenri lo corrige en catalogo.csv.

    Se queda con el componente cuya descripción comparte más palabras con la descripción del modelo y
    el nombre del IfcBuilding, dentro del paquete que diga el IfcBuilding si lo dice.
    """
    edificio = (ifc.by_type("IfcBuilding") or [None])[0]
    nombre_ed = edificio.Name if edificio and edificio.Name else ""
    m = re.search(r"PAQUETE\s*0*(\d+)", nombre_ed, re.I)
    candidatos = [c for c in componentes.values() if not m or c["paquete"] == f"Paquete {m.group(1)}"] or list(componentes.values())
    clave = _palabras(descripcion) | _palabras(nombre_ed)
    mejor = max(candidatos, key=lambda c: (len(clave & _palabras(c["descripcion"])), -len(c["descripcion"])), default=None)
    return {"codigo": codigo, "modelo": descripcion, "componente": mejor["componente"] if mejor else "",
            "descripcion_ifc": nombre_ed, "revisado": "no"}


def ubicar(cat, componentes):
    """Sector, paquete y descripción salen del catálogo de componentes, no del IFC."""
    c = componentes.get(cat.get("componente", ""))
    if not c:
        return {"sector": "Sin sector", "paquete": "Sin paquete", "componente": cat.get("componente") or "Sin componente", "componente_desc": ""}
    return {"sector": c["sector"], "paquete": c["paquete"], "componente": c["componente"], "componente_desc": c["descripcion"]}


# ---------------------------------------------------------------------------
# Proceso principal
# ---------------------------------------------------------------------------

def largo_principal(v):
    """Largo de la nube de puntos a lo largo de su eje principal (sirve para tubos inclinados o en diagonal)."""
    if len(v) < 2:
        return 0.0
    c = v - v.mean(0)
    eje = np.linalg.svd(c[:: max(1, len(c) // 2000)], full_matrices=False)[2][0]
    t = c @ eje
    return float(t.max() - t.min())


def metros_lineales(tipo, g):
    """Suma de tramos rectos en tuberías (sin codos ni accesorios); largo del tramo en canales, box y gaviones."""
    regla = REGLA_POR_TIPO.get(tipo, {}).get("agrupar")
    if regla == "sistema":
        return sum(largo_principal(it["v"]) for it in g if it["segmento"])
    if regla == "tramo":
        return largo_principal(np.vstack([it["v"][:, :2] for it in g]))
    return None


def es_segmento(el):
    if el.is_a("IfcFlowFitting"):
        return False
    if el.is_a("IfcFlowSegment") or el.is_a() == "IfcPipeSegment":
        return True
    tipo = ue.get_type(el)
    texto = f"{tipo.Name if tipo else ''}|{el.Name or ''}"
    return bool(re.search(r"tuber[ií]a|REC_TUB", texto, re.I)) and not re.search(r"codo|accesorio|fitting", tipo.Name if tipo and tipo.Name else "", re.I)


def convertir(ruta, salida, catalogo, componentes, a_wgs84):
    ifc = ifcopenshell.open(str(ruta))
    codigo = ruta.stem
    descripcion = descripcion_modelo(ifc, ruta)
    if codigo not in catalogo or not catalogo[codigo].get("componente"):
        catalogo[codigo] = catalogo_por_defecto(ifc, codigo, descripcion, componentes)
    cat = {**catalogo[codigo], **ubicar(catalogo[codigo], componentes)}
    defecto = tipo_por_modelo(descripcion)
    sistemas = sistemas_por_elemento(ifc)

    candidatos, tipo_de = [], {}
    excluidos = 0
    for el in ifc.by_type("IfcProduct"):
        if not el.Representation or el.is_a("IfcSite") or el.is_a("IfcSpatialStructureElement"):
            continue
        t = clasificar(el, defecto)
        if t is None:
            excluidos += 1
            continue
        candidatos.append(el)
        tipo_de[el.id()] = t

    geo = teselar(ifc, candidatos)
    por_tipo = defaultdict(list)
    tris_in = 0
    for el in candidatos:
        if el.id() not in geo:
            continue
        v, f = geo[el.id()]
        tris_in += len(f)
        por_tipo[tipo_de[el.id()]].append({
            "v": v, "f": f, "min": v.min(0), "max": v.max(0), "centro": v.mean(0),
            "sistema": sistemas.get(el.id()),
            "segmento": es_segmento(el),
        })

    estructuras, features = [], []
    metrados = {}
    for tipo in sorted(por_tipo):
        grupos = agrupar(tipo, por_tipo[tipo])
        # Numeración estable: de norte a sur, luego de oeste a este.
        grupos.sort(key=lambda g: (-np.mean([i["centro"][1] for i in g]), np.mean([i["centro"][0] for i in g])))
        for n, g in enumerate(grupos, 1):
            vs, fs, off = [], [], 0
            for it in g:
                vs.append(it["v"]); fs.append(it["f"] + off); off += len(it["v"])
            v = np.vstack(vs); f = np.vstack(fs)
            nombre = f"{tipo} {n:02d}"
            sistema = g[0]["sistema"] if tipo == "Tubería" and g[0]["sistema"] else None
            if REGLA_POR_TIPO.get(tipo, {}).get("agrupar") == "tramo":
                nombre = f"{tipo} · tramo {n:02d}"
            meta = {
                "codigo": f"{codigo}#{tipo[:3].upper()}{n:03d}",
                "nombre": nombre,
                "paquete": cat["paquete"],
                "componente": cat["componente"],
                "componente_desc": cat["componente_desc"],
                "modelo": cat["modelo"],
                "modelo_codigo": codigo,
                "tipo_estructura": tipo,
                "sector": cat["sector"],
            }
            ml = metros_lineales(tipo, g)
            m = metrados.setdefault(tipo, {"n": 0})
            m["n"] += 1
            if ml is not None:
                meta["longitud_m"] = round(ml, 2)
                m["ml"] = round(m.get("ml", 0) + ml, 2)
            estructuras.append({"pos": a_local(v), "idx": f, "meta": meta})
            # Huella 2D para el plano general: unión de la silueta de cada elemento,
            # así un tramo de tubería en L no se dibuja como un triángulo.
            partes = []
            for it in g:
                xy = it["v"][:, :2]
                if len(xy) > 600:
                    xy = xy[np.random.default_rng(0).choice(len(xy), 600, replace=False)]
                partes.append(MultiPoint(xy).convex_hull.buffer(0.15))
            huella = unary_union(partes).simplify(0.1)
            huella = shp_transform(lambda x, y, z=None: tuple(np.round(a_wgs84.transform(x, y), 7)), huella)
            features.append({"type": "Feature", "properties": meta, "geometry": mapping(huella)})

    tipos_usados = sorted({e["meta"]["tipo_estructura"] for e in estructuras})
    (salida / "models").mkdir(parents=True, exist_ok=True)
    glb = salida / "models" / f"{codigo}.glb"
    escribir_glb(glb, estructuras, tipos_usados)

    allv = np.vstack([e["pos"] for e in estructuras]) if estructuras else np.zeros((1, 3), np.float32)
    o = PROYECTO["origen"]
    bmin, bmax = allv.min(0), allv.max(0)
    modelo = {
        "codigo": codigo, "modelo": cat["modelo"], "paquete": cat["paquete"], "sector": cat["sector"],
        "componente": cat["componente"], "componente_desc": cat["componente_desc"],
        "glb": f"models/{codigo}.glb",
        "estructuras": len(estructuras),
        "tipos": {t: sum(1 for e in estructuras if e["meta"]["tipo_estructura"] == t) for t in tipos_usados},
        "metrados": metrados,
        "bbox_utm": [float(bmin[0] + o["e"]), float(-bmax[2] + o["n"]), float(bmax[0] + o["e"]), float(-bmin[2] + o["n"])],
    }
    reporte = {
        "codigo": codigo, "modelo": cat["modelo"], "ifc_mb": round(ruta.stat().st_size / 1e6, 1),
        "elementos_excluidos": excluidos, "elementos_usados": sum(len(x) for x in por_tipo.values()),
        "estructuras": len(estructuras), "triangulos": tris_in,
        "glb_mb_sin_optimizar": round(glb.stat().st_size / 1e6, 2),
        "tipos": "; ".join(f"{t}={n}" for t, n in modelo["tipos"].items()),
    }
    return modelo, features, reporte


def main():
    entrada, salida = Path(sys.argv[1]), Path(sys.argv[2])
    salida.mkdir(parents=True, exist_ok=True)
    a_wgs84 = Transformer.from_crs(PROYECTO["epsg"], 4326, always_xy=True)
    catalogo = leer_csv(salida / "catalogo.csv", "codigo")
    componentes = leer_csv(salida / "componentes.csv", "componente")
    if not componentes:
        sys.exit("Falta componentes.csv: corre antes  python catalogo.py <Excel de paquetes> <carpeta_salida>")

    modelos, features, reportes = [], [], []
    for ruta in sorted(entrada.glob("*.ifc")):
        print(f"→ {ruta.name}", flush=True)
        m, fs, r = convertir(ruta, salida, catalogo, componentes, a_wgs84)
        modelos.append(m); features += fs; reportes.append(r)
        print(f"  {r['estructuras']} estructuras, {r['triangulos']:,} triángulos, {r['glb_mb_sin_optimizar']} MB", flush=True)

    lon0, lat0 = a_wgs84.transform(PROYECTO["origen"]["e"], PROYECTO["origen"]["n"])
    manifest = {
        "proyecto": PROYECTO["nombre"],
        "epsg": PROYECTO["epsg"],
        "origen": {**PROYECTO["origen"], "lon": lon0, "lat": lat0},
        "ejes": "glTF x=Este, y=Elevación, z=-Norte (metros, relativo al origen)",
        "modelos": modelos,
    }
    (salida / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (salida / "trazado.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")
    escribir_csv(salida / "catalogo.csv", list(catalogo.values()),
                 ["codigo", "modelo", "componente", "descripcion_ifc", "revisado"])
    escribir_csv(salida / "reporte.csv", reportes, list(reportes[0].keys()))


if __name__ == "__main__":
    main()
