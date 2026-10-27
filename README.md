# Visor gerencial · Drenaje Pluvial Integral de Talara

Visor web para presentar a gerencia los modelos BIM federados sobre el plano del proyecto. Se abre con un link, sin instalar nada.
Al hacer clic en una estructura muestra solo información general: nombre, componente, sector y paquete, tipo y estado de coordinación.

- **Visor:** `https://<tu-proyecto>.vercel.app/`
- **Administración:** `https://<tu-proyecto>.vercel.app/#admin`

## Cómo se actualiza

Todo lo que ve el visor está en `public/data/`. Cada cambio que se guarda en el repositorio hace que Vercel vuelva a publicar el sitio solo, en uno o dos minutos.
Hay dos formas de cambiar esos datos: desde la página de administración (lo normal) o con los scripts de `pipeline/` (para cargas masivas).

## Subir IFC desde el visor

El botón **Subir IFC** de la barra superior convierte el IFC en el navegador y muestra el modelo al instante, solo para quien lo subió.
Con **Publicar para todos** queda en el link público. La primera vez pide el token de GitHub (ver abajo).
Para quitar modelos, cargar el catálogo o las capas GIS, usa la página de administración.

## Página de administración (`#admin`)

### 1. Crear el token de GitHub (una sola vez por computadora)

1. En GitHub ve a **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. En **Repository access** elige *Only select repositories* y marca solo este repositorio.
3. En **Permissions → Repository permissions → Contents**, elige **Read and write**.
4. Ponle una fecha de vencimiento, genéralo y cópialo.
5. En `#admin` pega el repositorio (`usuario/repositorio`), la rama (`main`) y el token, y pulsa **Conectar**. Si marcas *Recordar en este navegador*, el token queda guardado solo en ese navegador. No se sube a ningún lado.

Cada persona que vaya a administrar el visor necesita su propio token, con acceso de escritura al repositorio.

### 2. Modelos BIM

- **Agregar IFC…**: elige uno o varios IFC. Se convierten en tu navegador, el IFC no se sube. Un IFC de 100 MB tarda unos segundos.
- Revisa el **componente sugerido**. De él salen el sector, el paquete y el estado que verá gerencia.
- **Publicar modelos** guarda el modelo liviano (`.glb`), el trazado en planta y el catálogo.
- En los modelos ya publicados puedes cambiar el componente o **Quitar** el modelo.
- Si vuelves a subir un IFC con el mismo nombre, reemplaza al anterior.

### 3. Catálogo y estados

Sube el Excel «PAQUETES Y COMPONENTES» (hoja `CONTROL GENERAL`) y pulsa **Publicar catálogo**.
El estado de cada componente (Pendiente, En proceso, Completado, Observado) sale de la columna ESTADO.

### 4. Capas GIS fijas

- **Ortofoto o ráster** (GeoTIFF en UTM WGS 84 o EPSG:4326): se convierte a una imagen liviana.
- **Mapas GIS** (GeoJSON, KML o Shapefile comprimido en `.zip`).
- Marca **Suelo 3D** en una ortofoto para usarla como terreno de la vista 3D.

## Reglas de agrupación

`public/data/reglas.json` define qué elementos IFC se ignoran (armadura, encofrado, pintura…) y cómo se agrupan en estructuras:

| Tipo de estructura | Cómo se agrupa |
|---|---|
| Buzones y sumideros | Por piezas que se tocan |
| Tuberías | Por sistema de Revit |
| Canales y gaviones | Por tramos de 100 m |

La página de administración y los scripts de `pipeline/` leen el mismo archivo.

`public/data/proyecto.json` fija el origen de coordenadas del proyecto (EPSG:32717). No lo cambies: todos los modelos se ubican respecto a ese origen.

## Pipeline en Python (opcional, para cargas masivas)

```bash
pip install ifcopenshell numpy shapely pyproj openpyxl rasterio pyogrio
cd pipeline && npm ci
python catalogo.py PAQUETES.xlsx salida/              # componentes.csv
python convert.py carpeta_ifc/ salida/                # GLB + manifest + trazado + catalogo.csv
./optimizar.sh salida/ ../public/data/                # comprime y copia al sitio
python capas.py carpeta_capas/ ../public/data/        # ortofotos y mapas GIS (en public/data/capas/)
```

Luego haz commit y push. Vercel publica solo.

## Desarrollo local

```bash
npm ci
npm run dev      # http://localhost:5173  ·  administración en /#admin
npm run build    # sitio estático en dist/
```

Stack: React, Vite, three.js, Leaflet, web-ifc y gltf-transform.
