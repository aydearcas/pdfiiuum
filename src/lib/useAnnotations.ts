import { useCallback, useRef, useState } from "react";
import type { Annot } from "./annotations";

interface History {
  past: Annot[][];
  present: Annot[];
  future: Annot[][];
}

const EMPTY: History = { past: [], present: [], future: [] };
const LIMIT = 200;

/**
 * Lista de anotaciones con deshacer/rehacer.
 * `begin()` marca el inicio de un cambio continuo (arrastrar, escribir un comentario):
 * la instantánea solo entra en el historial si después llega algún `change()`.
 */
export function useAnnotations(initial?: Annot[]) {
  const [h, setH] = useState<History>(() => (initial?.length ? { ...EMPTY, present: initial } : EMPTY));
  const pending = useRef<Annot[] | null>(null);

  const push = (s: History, next: Annot[]): History => ({
    past: [...s.past, s.present].slice(-LIMIT),
    present: next,
    future: [],
  });

  const add = useCallback((a: Annot | Annot[]) => {
    pending.current = null;
    setH((s) => push(s, [...s.present, ...(Array.isArray(a) ? a : [a])]));
  }, []);

  const remove = useCallback((id: string) => {
    pending.current = null;
    setH((s) => push(s, s.present.filter((a) => a.id !== id)));
  }, []);

  const begin = useCallback(() => {
    setH((s) => {
      pending.current = s.present;
      return s;
    });
  }, []);

  const change = useCallback((id: string, patch: Partial<Annot>) => {
    setH((s) => {
      const next = s.present.map((a) => (a.id === id ? ({ ...a, ...patch } as Annot) : a));
      const snap = pending.current;
      if (snap) {
        pending.current = null;
        return { past: [...s.past, snap].slice(-LIMIT), present: next, future: [] };
      }
      return { ...s, present: next };
    });
  }, []);

  const undo = useCallback(() => {
    pending.current = null;
    setH((s) =>
      s.past.length
        ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] }
        : s,
    );
  }, []);

  const redo = useCallback(() => {
    pending.current = null;
    setH((s) =>
      s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s,
    );
  }, []);

  const reset = useCallback(() => {
    pending.current = null;
    setH(EMPTY);
  }, []);

  return {
    annots: h.present,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    add,
    remove,
    begin,
    change,
    undo,
    redo,
    reset,
  };
}
