// Formularios del PDF (AcroForm). pdf.js muestra los campos como controles y guarda lo escrito
// en su `annotationStorage`, indexado por el id del widget en el PDF que se ve. Ese PDF puede ser
// la copia sin anotaciones que hace PDFium (ver `openDocument`), así que para escribir los valores
// en el archivo real se emparejan los campos por nombre y posición, y pdf.js los guarda.
import { closePdf, loadPdf, type PDFDocument } from "./pdf";

/** id de cada widget → «nombre del campo + posición en su lista», igual en el original y en la copia. */
async function fieldKeys(pdf: PDFDocument): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  const fields = (await pdf.getFieldObjects()) as Map<string, { id?: string }[]> | null;
  for (const [name, list] of fields ?? []) {
    list.forEach((f, i) => f.id && keys.set(f.id, `${name}\u0000${i}`));
  }
  return keys;
}

/** El usuario ha escrito algo en los campos (desde que se abrió o se guardó). */
export function watchForm(pdf: PDFDocument, onChange: (modified: boolean) => void): () => void {
  // Los tipos de pdf.js declaran estos avisos como `null`, aunque son para asignarlos.
  const storage = pdf.annotationStorage as unknown as {
    onSetModified: (() => void) | null;
    onResetModified: (() => void) | null;
  };
  storage.onSetModified = () => onChange(true);
  storage.onResetModified = () => onChange(false);
  return () => {
    storage.onSetModified = null;
    storage.onResetModified = null;
  };
}

/** Lo escrito en los campos ya está en el archivo: deja de contar como cambio pendiente. */
export function markFormSaved(pdf: PDFDocument) {
  pdf.annotationStorage.resetModified();
}

/**
 * Escribe en `bytes` (el PDF real) los valores que hay en los campos de `shown` (el PDF que se ve).
 * Devuelve los mismos bytes si no hay nada que escribir. pdf.js añade los cambios al final del
 * archivo (guardado incremental): lo anterior, firmas incluidas, queda intacto.
 */
export async function bakeForm(shown: PDFDocument, bytes: Uint8Array): Promise<Uint8Array> {
  const { map } = shown.annotationStorage.serializable;
  if (!map?.size) return bytes;
  const from = await fieldKeys(shown);
  const target = await loadPdf(bytes);
  try {
    const to = new Map([...(await fieldKeys(target))].map(([id, key]) => [key, id]));
    let filled = 0;
    for (const [id, value] of map) {
      const key = from.get(id);
      const targetId = key && to.get(key);
      if (!targetId) continue;
      target.annotationStorage.setValue(targetId, structuredClone(value));
      filled++;
    }
    return filled ? await target.saveDocument() : bytes;
  } finally {
    closePdf(target);
  }
}
