/// <reference lib="webworker" />
// La conversión corre en un worker para que la página no se congele con IFC de 100 MB o más.
import type { Componente } from '../datos';
import { sugerirComponente, ubicacionDe } from './catalogo';
import { convertirIfc, type Proyecto, type Reglas } from './convertir';

export interface Pedido {
  datos: ArrayBuffer;
  archivo: string;
  reglas: Reglas;
  proyecto: Proyecto;
  componentes: Componente[];
  /** Componente elegido a mano; vacío = sugerir. */
  componente: string;
  wasmDir: string;
}

self.onmessage = async (ev: MessageEvent<Pedido>) => {
  const p = ev.data;
  try {
    const r = await convertirIfc(
      new Uint8Array(p.datos), p.archivo, p.reglas, p.proyecto,
      (desc, edif) => {
        const c = p.componente ? p.componentes.find((x) => x.componente === p.componente) : sugerirComponente(p.componentes, desc, edif);
        return ubicacionDe(c, p.componente);
      },
      p.wasmDir,
      (texto, fraccion) => self.postMessage({ tipo: 'avance', texto, fraccion }),
    );
    self.postMessage({ tipo: 'listo', resultado: r }, [r.glb.buffer]);
  } catch (e) {
    self.postMessage({ tipo: 'error', mensaje: e instanceof Error ? e.message : String(e) });
  }
};
