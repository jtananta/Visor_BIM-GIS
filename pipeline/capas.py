"""Prepara las capas GIS fijas del proyecto (ortofotos, rasters y capas vectoriales) para el visor.

Uso:
    python capas.py <carpeta_capas> <carpeta_salida>

Toma todo lo que haya en <carpeta_capas>:
    .tif .tiff              ortofoto o ráster georreferenciado → WebP en Web Mercator + límites
    .geojson .json .kml .kmz .gpkg .shp (con .dbf/.prj al lado) .zip (con un shapefile dentro)
                            capa vectorial → GeoJSON en WGS 84

y deja en <carpeta_salida>/capas/ los archivos y un capas.json que el visor lee al abrir.
El nombre de la capa en el visor es el nombre del archivo; para cambiarlo, edita capas.json.
La primera ortofoto de la lista se usa también como suelo de la vista 3D ("suelo": true).
"""

import json
import warnings
import re
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pyogrio.raw
import rasterio
from PIL import Image
from pyproj import CRS, Transformer
from rasterio.warp import Resampling, calculate_default_transform, reproject
from shapely import from_wkb
from shapely.geometry import mapping
from shapely.ops import transform as shp_transform

warnings.filterwarnings("ignore", category=DeprecationWarning)  # shapely.ops.transform

MAX_PX = 4096  # lado máximo de la imagen: los Artifacts admiten hasta 15 MB por archivo
VECTOR = {".geojson", ".json", ".kml", ".kmz", ".gpkg", ".shp"}
COLORES = ["#E8590C", "#7048E8", "#0CA678", "#D6336C", "#1C7ED6", "#F59F00"]


def slug(texto):
    return re.sub(r"[^a-z0-9]+", "-", texto.lower()).strip("-")[:60] or "capa"


def raster(ruta, destino):
    with rasterio.open(ruta) as src:
        if src.crs is None:
            raise ValueError("no tiene sistema de coordenadas (no es un GeoTIFF georreferenciado)")
        dst_crs = "EPSG:3857"
        transform, w, h = calculate_default_transform(src.crs, dst_crs, src.width, src.height, *src.bounds)
        escala = max(w, h) / MAX_PX
        if escala > 1:
            w, h = int(w / escala), int(h / escala)
            transform = transform * transform.scale(escala, escala)
        bandas = min(src.count, 3)
        out = np.zeros((bandas, h, w), dtype=np.float32)
        for b in range(bandas):
            reproject(rasterio.band(src, b + 1), out[b], src_transform=src.transform, src_crs=src.crs,
                      dst_transform=transform, dst_crs=dst_crs, resampling=Resampling.bilinear,
                      src_nodata=src.nodata, dst_nodata=np.nan)
        valido = ~np.isnan(out).any(axis=0)
        if src.nodata is None and bandas >= 3:
            valido &= ~(np.nan_to_num(out) == 0).all(axis=0)  # bordes negros de una ortofoto recortada
        datos = np.nan_to_num(out)
        if src.dtypes[0] != "uint8" or bandas == 1:
            # Ráster de valores (DEM, pendientes…): se estira a 0–255 con percentiles 2–98.
            v = datos[:, valido]
            lo, hi = (np.percentile(v, 2), np.percentile(v, 98)) if v.size else (0, 1)
            datos = np.clip((datos - lo) / max(hi - lo, 1e-9) * 255, 0, 255)
        rgb = np.repeat(datos, 3, axis=0) if bandas == 1 else datos[:3]
        rgba = np.dstack([*rgb.astype(np.uint8), (valido * 255).astype(np.uint8)])
        Image.fromarray(rgba, "RGBA").save(destino, "WEBP", quality=82, method=5)
        a_ll = Transformer.from_crs(dst_crs, 4326, always_xy=True)
        x0, y1 = transform * (0, 0)
        x1, y0 = transform * (w, h)
        lon0, lat0 = a_ll.transform(x0, y0)
        lon1, lat1 = a_ll.transform(x1, y1)
        return {"bounds": [[lat0, lon0], [lat1, lon1]], "px": [w, h]}


def abrir_vector(ruta, tmp):
    if ruta.suffix.lower() == ".zip":
        with zipfile.ZipFile(ruta) as z:
            z.extractall(tmp)
        shp = next(Path(tmp).rglob("*.shp"), None) or next(Path(tmp).rglob("*.geojson"), None) or next(Path(tmp).rglob("*.kml"), None)
        if not shp:
            raise ValueError("el .zip no contiene un shapefile (.shp con su .dbf y .prj)")
        return shp
    return ruta


def vector(ruta, destino):
    with tempfile.TemporaryDirectory() as tmp:
        fuente = abrir_vector(ruta, tmp)
        meta, _, geoms, campos = pyogrio.raw.read(fuente)
        crs = CRS.from_user_input(meta["crs"]) if meta.get("crs") else CRS.from_epsg(4326)
        a_ll = Transformer.from_crs(crs, 4326, always_xy=True)
        nombres = list(meta["fields"])
        feats = []
        for i, wkb in enumerate(geoms):
            if wkb is None:
                continue
            g = shp_transform(lambda x, y, z=None: a_ll.transform(x, y), from_wkb(wkb))
            props = {}
            for n, col in zip(nombres, campos):
                v = col[i]
                props[n] = v.item() if hasattr(v, "item") else (None if v is None else str(v))
            feats.append({"type": "Feature", "properties": props, "geometry": mapping(g)})
    destino.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False), encoding="utf-8")
    return {"elementos": len(feats)}


def main():
    entrada, salida = Path(sys.argv[1]), Path(sys.argv[2])
    dir_capas = salida / "capas"
    dir_capas.mkdir(parents=True, exist_ok=True)
    previas = {c["origen"]: c for c in json.loads((dir_capas / "capas.json").read_text(encoding="utf-8"))} \
        if (dir_capas / "capas.json").exists() else {}
    capas, colores = [], iter(COLORES * 10)
    suelo_asignado = any(c.get("suelo") for c in previas.values())
    for ruta in sorted(entrada.iterdir()):
        ext = ruta.suffix.lower()
        if ext not in VECTOR | {".tif", ".tiff", ".zip"}:
            continue
        previa = previas.get(ruta.name, {})
        nombre = previa.get("nombre") or ruta.stem.replace("_", " ")
        try:
            if ext in (".tif", ".tiff"):
                archivo = f"{slug(ruta.stem)}.webp"
                info = raster(ruta, dir_capas / archivo)
                capa = {"tipo": "raster", **info}
                if not suelo_asignado:
                    capa["suelo"] = suelo_asignado = True
            else:
                archivo = f"{slug(ruta.stem)}.geojson"
                info = vector(ruta, dir_capas / archivo)
                capa = {"tipo": "vector", "color": previa.get("color") or next(colores), **info}
            capas.append({**previa, **capa, "nombre": nombre, "archivo": f"capas/{archivo}", "origen": ruta.name,
                          "visible": previa.get("visible", True)})
            print(f"✓ {ruta.name} → capas/{archivo}")
        except Exception as e:  # una capa mala no detiene las demás
            print(f"✗ {ruta.name}: {e}")
    (dir_capas / "capas.json").write_text(json.dumps(capas, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
