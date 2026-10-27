#!/usr/bin/env bash
# Optimiza los GLB que deja convert.py: une vértices, simplifica y comprime con meshopt.
# Uso: ./optimizar.sh <carpeta_entrada> <carpeta_salida>
# No se usa "optimize" porque fusiona nodos y se perdería una estructura por nodo.
set -euo pipefail
IN="$1"; OUT="$2"; RATIO="${RATIO:-0.5}"; ERROR="${ERROR:-0.001}"
mkdir -p "$OUT/models"
cp "$IN"/manifest.json "$IN"/trazado.geojson "$IN"/componentes.csv "$IN"/catalogo.csv "$OUT"/
[ -d "$IN/capas" ] && cp -r "$IN/capas" "$OUT"/
T="$(mktemp -d)"
for f in "$IN"/models/*.glb; do
  n="$(basename "$f")"
  npx gltf-transform dedup "$f" "$T/a.glb" >/dev/null
  npx gltf-transform weld "$T/a.glb" "$T/b.glb" >/dev/null
  npx gltf-transform simplify "$T/b.glb" "$T/c.glb" --ratio "$RATIO" --error "$ERROR" >/dev/null
  npx gltf-transform meshopt "$T/c.glb" "$OUT/models/$n" --level medium >/dev/null
  printf '%-45s %8s → %8s\n' "$n" "$(du -h "$f" | cut -f1)" "$(du -h "$OUT/models/$n" | cut -f1)"
done
rm -rf "$T"
