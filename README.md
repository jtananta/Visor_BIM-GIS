# Visor gerencial · Drenaje Pluvial Integral de Talara

Visor web para presentar a gerencia los modelos BIM federados sobre el plano del proyecto. Se abre con un link, sin instalar nada.
Al hacer clic en una estructura muestra solo información general: nombre, componente, sector y paquete, tipo y estado de coordinación.

- **Visor:** `https://<tu-proyecto>.vercel.app/`
- **Administración:** `https://<tu-proyecto>.vercel.app/#admin`

## Cómo se actualiza

Todo lo que ve el visor está en `public/data/`. Cada cambio que se guarda en el repositorio hace que Vercel vuelva a publicar el sitio solo, en uno o dos minutos.
Hay dos formas de cambiar esos datos: desde la página de administración (lo normal) o con los scripts de `pipeline/` (para cargas masivas).

## Dashboard

Tercera pestaña del visor, junto a Plano general y Vista 3D. Muestra cantidades (metrados) del proyecto:
- **Estructura**: sectores, paquetes, componentes y modelos BIM publicados.
- **Metrados modelados**: buzones y sumideros (und); tubería, box, canal y gaviones (ml).
- **Estado de cada paquete** (En diseño, Diseño aprobado, En ejecución, Construido): en los indicadores, en las barras por sector, en el mapa (botón «Estado») y en la tabla de paquetes. Se cambia con «Editar estados» en la tabla y «Publicar» con la clave de publicación; se guarda en `public/data/paquetes.json`.
- **Paquetes por sector** y **componentes por paquete** (con y sin modelo).
- **Mapa por tipo de estructura**.
- **Metrados por paquete** y **por componente**, con botones para abrir cada uno en la planta o en 3D.

Los metrados se miden al convertir el IFC: tubería = suma del largo de los segmentos rectos (sin codos ni accesorios); canal, box y gaviones = largo del tramo a lo largo de su eje. Box se reconoce por el nombre del elemento (Box, Cajón, Alcantarilla; ver `reglas.json`). Los modelos convertidos antes de esta versión se estiman con su trazado en planta hasta que se vuelva a subir su IFC.

Todo sale del Excel de control (`componentes.csv`) y de los modelos publicados (`manifest.json`), así que se actualiza solo al publicar.

## Configurar la publicación (una sola vez)

La publicación pasa por una función del propio sitio (`api/publicar.js`). El token de GitHub queda guardado en Vercel y nadie tiene que pegarlo en el navegador.
Para publicar basta con la **clave de publicación**, y quien no la tenga solo puede mirar.

1. **Token de GitHub.** Entra a **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   En *Repository access* elige *Only select repositories* y marca este repositorio. En *Permissions → Contents* elige **Read and write**. Genéralo y cópialo.
2. **Variables en Vercel.** Ve a **Project → Settings → Environment Variables** y agrega estas dos:
   - `GITHUB_TOKEN`: el token del paso 1.
   - `CLAVE_PUBLICAR`: la clave que usarán quienes publiquen. Elige una difícil de adivinar.
3. **Redeploy.** En **Deployments**, abre el último y pulsa **Redeploy** para que tome las variables.

Opcionales: `GITHUB_REPO` (por defecto, el repositorio conectado a Vercel) y `GITHUB_RAMA` (por defecto, `main`).
Para cambiar la clave, edita `CLAVE_PUBLICAR` y vuelve a desplegar.

## Subir IFC desde el visor

El botón **Subir IFC** de la barra superior convierte el IFC en el navegador y muestra el modelo al instante, solo para quien lo subió.
Con **Publicar para todos** queda en el link público. La primera vez pide la clave de publicación y la recuerda.
Desde el visor se publican archivos de hasta 3 MB por modelo liviano. Un IFC de 100 MB suele dar menos de 1 MB.
Para quitar modelos, cargar el catálogo o las capas GIS, usa la página de administración.

## Terreno y superficies en la vista 3D

- **Satélite / Relieve / Sin mapa**: el suelo plano con la imagen satelital, el mismo suelo con el relieve real del terreno (elevación pública SRTM de 30 m, teselas Terrarium de AWS) o sin suelo.
- **Opacidad del terreno**: bájala para ver las tuberías y estructuras enterradas.
- **Agregar superficie…**: carga una superficie topográfica propia en este navegador. Puede ser un GeoTIFF de elevaciones o un LandXML de Civil 3D (superficie TIN), en UTM WGS 84 zona 17S. Se dibuja coloreada por altura.
  Con **Publicar** (pide la clave de publicación) queda para todos. Las superficies también se pueden subir desde `#admin`, en *Capas GIS fijas*.

## Página de administración (`#admin`)

### 1. Entrar

Escribe la clave de publicación y pulsa **Entrar**.

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
- **Superficies topográficas** (GeoTIFF de elevaciones de una banda o LandXML de Civil 3D): se ven con relieve en la vista 3D.
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
