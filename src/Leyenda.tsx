import { COLOR_ESTADO, COLOR_TIPO, colorSector, type Datos, type ModoColor } from './datos';

interface Props {
  modo: ModoColor;
  datos: Datos;
  sectores: string[];
  paquetes: string[];
}

export default function Leyenda({ modo, datos, sectores, paquetes }: Props) {
  const modelos = datos.manifest.modelos;
  let items: [string, string][];
  if (modo === 'sector') {
    // Solo lo que hay en pantalla: con 3 sectores y 14 paquetes la leyenda completa estorba.
    items = sectores.filter((s) => modelos.some((m) => m.sector === s)).map((s) => [s, colorSector(sectores, s)]);
  } else if (modo === 'paquete') {
    items = paquetes.filter((p) => modelos.some((m) => m.paquete === p)).map((p) => [p, colorSector(paquetes, p)]);
  } else if (modo === 'tipo') {
    const tipos = new Set(modelos.flatMap((m) => Object.keys(m.tipos)));
    items = Object.entries(COLOR_TIPO).filter(([t]) => tipos.has(t));
  } else {
    // Los estados del Excel de control, más cualquier otro que aparezca escrito en él.
    items = Object.entries(COLOR_ESTADO).filter(([e]) => e !== 'Sin asignar');
    new Set(datos.componentes.map((c) => c.estado)).forEach((u) => {
      if (u && !(u in COLOR_ESTADO)) items.push([u, COLOR_ESTADO['Sin asignar']]);
    });
  }
  const titulo = { sector: 'Sector', paquete: 'Paquete', tipo: 'Tipo de estructura', estado: 'Estado de coordinación' }[modo];
  return (
    <div className="leyenda" aria-label={`Leyenda: ${titulo}`}>
      <div className="leyenda-titulo">{titulo}</div>
      {items.map(([n, c]) => (
        <div key={n} className="leyenda-item">
          <span className="punto" style={{ background: c }} />
          {n}
        </div>
      ))}
    </div>
  );
}
