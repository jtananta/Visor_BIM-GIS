import { useMemo } from 'react';
import { compararNatural, type Componente } from './datos';

interface Props {
  componentes: Componente[];
  valor: string;
  cambiar: (componente: string) => void;
  desactivado?: boolean;
}

/** Lista de componentes agrupados por sector y paquete, para ubicar un IFC. */
export default function ElegirComponente({ componentes, valor, cambiar, desactivado }: Props) {
  const ordenados = useMemo(() => [...componentes].sort((a, b) =>
    compararNatural(a.sector, b.sector) || compararNatural(a.paquete, b.paquete) || compararNatural(a.componente, b.componente)), [componentes]);
  return (
    <select value={valor} onChange={(e) => cambiar(e.target.value)} disabled={desactivado}>
      {!ordenados.some((c) => c.componente === valor) && <option value={valor}>{valor || 'Elegir componente…'}</option>}
      {[...new Set(ordenados.map((c) => `${c.sector} · ${c.paquete}`))].map((g) => (
        <optgroup key={g} label={g}>
          {ordenados.filter((c) => `${c.sector} · ${c.paquete}` === g).map((c) => (
            <option key={c.componente} value={c.componente}>{c.componente} · {c.descripcion}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
