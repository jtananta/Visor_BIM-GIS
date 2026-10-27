import { useMemo, type Dispatch, type SetStateAction } from 'react';
import type { Foco } from './App';
import { COLOR_ESTADO, colorSector, compararNatural, type Componente, type Datos, type Modelo } from './datos';

interface Props {
  abierto: boolean;
  cerrar: () => void;
  datos: Datos;
  sectores: string[];
  paquetes: string[];
  ocultos: Set<string>;
  foco: Foco | null;
  setOcultos: Dispatch<SetStateAction<Set<string>>>;
  enfocar: (f: Foco) => void;
  quitarFoco: () => void;
}

interface Fila {
  comp: Componente;
  modelos: Modelo[];
}

function Ojo({ visible }: { visible: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" opacity={visible ? 1 : 0.35} />
      {visible ? <circle cx="12" cy="12" r="3" /> : <line x1="3" y1="21" x2="21" y2="3" />}
    </svg>
  );
}

export default function Panel(p: Props) {
  const modelos = p.datos.manifest.modelos;

  // Árbol sector → paquete → componente con el catálogo completo; un modelo sin componente en el
  // catálogo aparece igual, con su propia fila.
  const arbol = useMemo(() => {
    const comps = [...p.datos.componentes];
    for (const m of modelos) {
      if (!comps.some((c) => c.componente === m.componente)) {
        comps.push({ sector: m.sector, paquete: m.paquete, componente: m.componente, descripcion: m.componente_desc || m.modelo,
          estado: 'Sin asignar', avance: '', responsable: '', fecha: '', observaciones: '' });
      }
    }
    const t = new Map<string, Map<string, Fila[]>>();
    for (const c of comps) {
      if (!t.has(c.sector)) t.set(c.sector, new Map());
      const ps = t.get(c.sector)!;
      if (!ps.has(c.paquete)) ps.set(c.paquete, []);
      ps.get(c.paquete)!.push({ comp: c, modelos: modelos.filter((m) => m.componente === c.componente) });
    }
    t.forEach((ps) => ps.forEach((fs) => fs.sort((a, b) => compararNatural(a.comp.componente, b.comp.componente))));
    return t;
  }, [p.datos, modelos]);

  const conModelo = new Set(modelos.map((m) => m.componente)).size;
  const totalComp = [...arbol.values()].reduce((n, ps) => n + [...ps.values()].reduce((k, fs) => k + fs.length, 0), 0);

  const alternar = (codigos: string[], mostrar: boolean) =>
    p.setOcultos((prev) => {
      const next = new Set(prev);
      codigos.forEach((c) => (mostrar ? next.delete(c) : next.add(c)));
      return next;
    });

  const ojoGrupo = (mods: Modelo[], etiqueta: string) => {
    if (!mods.length) return <span className="btn-ojo vacio" aria-hidden="true" />;
    const visible = mods.some((m) => !p.ocultos.has(m.codigo));
    return (
      <button className="btn-ojo" onClick={() => alternar(mods.map((m) => m.codigo), !visible)} aria-label={`${visible ? 'Ocultar' : 'Mostrar'} ${etiqueta}`}>
        <Ojo visible={visible} />
      </button>
    );
  };

  return (
    <aside className={`panel ${p.abierto ? 'abierto' : ''}`} aria-label="Paquetes del proyecto">
      <div className="panel-cab">
        <div>
          <h2>Paquetes y componentes</h2>
          <p className="sutil">{conModelo} de {totalComp} componentes con modelo BIM</p>
        </div>
        <button className="btn-icono solo-movil" onClick={p.cerrar} aria-label="Cerrar panel">✕</button>
      </div>

      {p.foco && (
        <div className="foco-aviso">
          Enfocado en <strong>{p.foco.valor}</strong>
          <button className="enlace" onClick={p.quitarFoco}>Quitar foco</button>
        </div>
      )}

      <div className="panel-lista">
        {[...arbol.keys()].sort(compararNatural).map((s) => {
          const ps = arbol.get(s)!;
          const modsSector = modelos.filter((m) => m.sector === s);
          return (
            <details key={s} className="sector" open={modsSector.length > 0}>
              <summary className="sector-cab">
                {ojoGrupo(modsSector, s)}
                <span className="punto" style={{ background: colorSector(p.sectores, s) }} />
                <button className="sector-nombre" disabled={!modsSector.length}
                  onClick={(e) => { e.preventDefault(); p.enfocar({ campo: 'sector', valor: s }); }}
                  title={modsSector.length ? 'Enfocar este sector' : 'Sin modelos todavía'}>{s}</button>
                <span className="sutil">{[...ps.values()].reduce((n, fs) => n + fs.length, 0)} comp.</span>
              </summary>
              {[...ps.keys()].sort(compararNatural).map((paq) => {
                const filas = ps.get(paq)!;
                const modsPaq = modelos.filter((m) => m.paquete === paq);
                const atenuado = p.foco !== null && p.foco.campo !== 'componente' && !(p.foco.campo === 'sector' ? s === p.foco.valor : paq === p.foco.valor);
                return (
                  <details key={paq} className={`paquete ${atenuado ? 'atenuado' : ''} ${modsPaq.length ? '' : 'sin-modelo'}`} open={modsPaq.length > 0}>
                    <summary className="paquete-cab">
                      {ojoGrupo(modsPaq, paq)}
                      <button className="paquete-nombre" disabled={!modsPaq.length}
                        onClick={(e) => { e.preventDefault(); p.enfocar({ campo: 'paquete', valor: paq }); }}>{paq}</button>
                      <span className="sutil">{filas.filter((f) => f.modelos.length).length}/{filas.length}</span>
                    </summary>
                    <ul>
                      {filas.map(({ comp, modelos: mods }) => {
                        const tiene = mods.length > 0;
                        const visible = mods.some((m) => !p.ocultos.has(m.codigo));
                        const estructuras = mods.reduce((n, m) => n + m.estructuras, 0);
                        return (
                          <li key={comp.componente} className={`${tiene ? '' : 'sin-modelo'} ${tiene && !visible ? 'oculto' : ''}`}>
                            {ojoGrupo(mods, comp.descripcion)}
                            <button className="modelo" disabled={!tiene}
                              onClick={() => p.enfocar({ campo: 'componente', valor: comp.componente })}
                              title={tiene ? 'Enfocar este componente' : 'Este componente aún no tiene modelo BIM cargado'}>
                              <span className="modelo-nombre">{comp.descripcion}</span>
                              <span className="sutil">
                                {comp.componente}
                                {tiene ? ` · ${mods.map((m) => m.modelo).join(', ')} · ${estructuras} estructuras` : ' · sin modelo'}
                              </span>
                            </button>
                            <span className="estado-punto" title={comp.estado} style={{ background: COLOR_ESTADO[comp.estado] ?? COLOR_ESTADO['Sin asignar'] }} />
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                );
              })}
            </details>
          );
        })}
      </div>
    </aside>
  );
}
