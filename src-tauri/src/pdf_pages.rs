//! Modo edición, páginas: girar, borrar, reordenar, insertar (en blanco o de otro PDF) y extraer.
//! Los índices de página empiezan en 0.

use std::os::raw::{c_int, c_ulong};
use std::path::Path;

use pdfium_render::prelude::*;
use serde::Deserialize;

use crate::pdf_engine::{engine, save, Bindings};

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PagesEdit {
    /// Gira las páginas `quarters` cuartos de vuelta en el sentido de las agujas del reloj
    /// (negativo: al contrario).
    Rotate { pages: Vec<i32>, quarters: i32 },
    Delete { pages: Vec<i32> },
    /// Mueve las páginas (en su orden) para que la primera quede en la posición `to` del
    /// documento resultante.
    Move { pages: Vec<i32>, to: i32 },
    /// Página en blanco del tamaño de la página `like`, en la posición `at`.
    InsertBlank { at: i32, like: i32 },
    /// Todas las páginas de otro PDF (por ruta o en base64), a partir de la posición `at`.
    InsertFile { at: i32, path: Option<String>, data: Option<String> },
}

/// Abre el PDF, ejecuta `f` y devuelve el PDF guardado.
unsafe fn with_doc(b: &Bindings, pdf: &[u8], f: impl FnOnce(FPDF_DOCUMENT, i32) -> Result<(), String>) -> Result<Vec<u8>, String> {
    let doc = b.FPDF_LoadMemDocument64(pdf, None);
    if doc.is_null() {
        return Err(format!("PDFium no pudo abrir el documento (error {})", b.FPDF_GetLastError()));
    }
    let count = b.FPDF_GetPageCount(doc);
    let result = f(doc, count).and_then(|_| save(b, doc));
    b.FPDF_CloseDocument(doc);
    result
}

fn check(pages: &[i32], count: i32) -> Result<(), String> {
    if pages.is_empty() {
        return Err("No hay páginas seleccionadas".into());
    }
    match pages.iter().find(|&&p| p < 0 || p >= count) {
        Some(p) => Err(format!("La página {} no existe", p + 1)),
        None => Ok(()),
    }
}

pub fn edit_pages(dll: &Path, pdf: &[u8], edit: &PagesEdit) -> Result<Vec<u8>, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe {
        with_doc(b, pdf, |doc, count| {
            match edit {
                PagesEdit::Rotate { pages, quarters } => {
                    check(pages, count)?;
                    for &index in pages {
                        let page = b.FPDF_LoadPage(doc, index);
                        if page.is_null() {
                            return Err(format!("No se pudo cargar la página {}", index + 1));
                        }
                        let rotation = (b.FPDFPage_GetRotation(page) + quarters).rem_euclid(4);
                        b.FPDFPage_SetRotation(page, rotation);
                        b.FPDF_ClosePage(page);
                    }
                }
                PagesEdit::Delete { pages } => {
                    check(pages, count)?;
                    let mut sorted = pages.clone();
                    sorted.sort_unstable();
                    sorted.dedup();
                    if sorted.len() as i32 >= count {
                        return Err("Un PDF tiene que tener al menos una página".into());
                    }
                    // De la última a la primera, para que los índices sigan valiendo.
                    for &index in sorted.iter().rev() {
                        b.FPDFPage_Delete(doc, index);
                    }
                }
                PagesEdit::Move { pages, to } => {
                    check(pages, count)?;
                    let n = pages.len() as i32;
                    if *to < 0 || to + n > count {
                        return Err("Posición de destino no válida".into());
                    }
                    let indices: Vec<c_int> = pages.clone();
                    if b.FPDF_MovePages(doc, indices.as_ptr(), indices.len() as c_ulong, *to) == 0 {
                        return Err("PDFium no pudo mover las páginas".into());
                    }
                }
                PagesEdit::InsertBlank { at, like } => {
                    check(&[*like], count)?;
                    let mut size = FS_SIZEF { width: 595.0, height: 842.0 };
                    b.FPDF_GetPageSizeByIndexF(doc, *like, &mut size);
                    let page = b.FPDFPage_New(doc, (*at).clamp(0, count), size.width as f64, size.height as f64);
                    if page.is_null() {
                        return Err("No se pudo crear la página".into());
                    }
                    b.FPDF_ClosePage(page);
                }
                PagesEdit::InsertFile { at, path, data } => {
                    let data = crate::pdf_edit::read_source(path, data, "el PDF")?;
                    let src = b.FPDF_LoadMemDocument64(&data, None);
                    if src.is_null() {
                        return Err("No se pudo abrir el PDF (¿está protegido con contraseña?)".into());
                    }
                    let ok = b.FPDF_ImportPagesByIndex(doc, src, std::ptr::null(), 0, (*at).clamp(0, count));
                    b.FPDF_CloseDocument(src);
                    if ok == 0 {
                        return Err("PDFium no pudo insertar las páginas".into());
                    }
                }
            }
            Ok(())
        })
    }
}

/// PDF nuevo con solo esas páginas, en ese orden.
pub fn extract_pages(dll: &Path, pdf: &[u8], pages: &[i32]) -> Result<Vec<u8>, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe {
        let src = b.FPDF_LoadMemDocument64(pdf, None);
        if src.is_null() {
            return Err(format!("PDFium no pudo abrir el documento (error {})", b.FPDF_GetLastError()));
        }
        let result = (|| {
            check(pages, b.FPDF_GetPageCount(src))?;
            let out = b.FPDF_CreateNewDocument();
            if out.is_null() {
                return Err("No se pudo crear el PDF".into());
            }
            let ok = b.FPDF_ImportPagesByIndex(out, src, pages.as_ptr(), pages.len() as c_ulong, 0);
            let r = if ok == 0 { Err("PDFium no pudo copiar las páginas".into()) } else { save(b, out) };
            b.FPDF_CloseDocument(out);
            r
        })();
        b.FPDF_CloseDocument(src);
        result
    }
}

/// PDF de una página con el texto «Hola» (para pruebas de otros módulos).
#[cfg(test)]
pub(crate) fn tests_sample() -> Vec<u8> {
    use crate::pdf_engine::wide;
    let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll");
    let guard = engine(&dll).unwrap().lock().unwrap();
    let b = &*guard;
    unsafe {
        let doc = b.FPDF_CreateNewDocument();
        let page = b.FPDFPage_New(doc, 0, 595.0, 842.0);
        let obj = b.FPDFPageObj_NewTextObj(doc, "Helvetica", 12.0);
        let w = wide(b, "Hola");
        b.FPDFText_SetText(obj, w.as_ptr() as FPDF_WIDESTRING);
        b.FPDFPageObj_Transform(obj, 1.0, 0.0, 0.0, 1.0, 72.0, 700.0);
        b.FPDFPage_InsertObject(page, obj);
        b.FPDFPage_GenerateContent(page);
        b.FPDF_ClosePage(page);
        let out = save(b, doc).unwrap();
        b.FPDF_CloseDocument(doc);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_engine::wide;

    fn dll() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll")
    }

    /// PDF de `n` páginas; la página i (desde 0) mide 500+i de ancho y lleva el texto «Página i».
    fn sample(n: i32) -> Vec<u8> {
        let guard = engine(&dll()).unwrap().lock().unwrap();
        let b = &*guard;
        unsafe {
            let doc = b.FPDF_CreateNewDocument();
            for i in 0..n {
                let page = b.FPDFPage_New(doc, i, 500.0 + i as f64, 800.0);
                let obj = b.FPDFPageObj_NewTextObj(doc, "Helvetica", 12.0);
                let w = wide(b, &format!("Página {i}"));
                b.FPDFText_SetText(obj, w.as_ptr() as FPDF_WIDESTRING);
                b.FPDFPage_InsertObject(page, obj);
                b.FPDFPage_GenerateContent(page);
                b.FPDF_ClosePage(page);
            }
            let out = save(b, doc).unwrap();
            b.FPDF_CloseDocument(doc);
            out
        }
    }

    /// Ancho de cada página (identifica el orden) y su giro.
    fn layout(pdf: &[u8]) -> Vec<(i32, i32)> {
        let guard = engine(&dll()).unwrap().lock().unwrap();
        let b = &*guard;
        unsafe {
            let doc = b.FPDF_LoadMemDocument64(pdf, None);
            let out = (0..b.FPDF_GetPageCount(doc))
                .map(|i| {
                    let page = b.FPDF_LoadPage(doc, i);
                    // El ancho sin girar: con /Rotate 90 o 270, FPDF_GetPageWidth da el alto.
                    let rot = b.FPDFPage_GetRotation(page);
                    let w = if rot % 2 == 1 { b.FPDF_GetPageHeightF(page) } else { b.FPDF_GetPageWidthF(page) };
                    b.FPDF_ClosePage(page);
                    (w.round() as i32 - 500, rot)
                })
                .collect();
            b.FPDF_CloseDocument(doc);
            out
        }
    }

    #[test]
    fn page_operations() {
        let pdf = sample(4);
        let ids = |pdf: &[u8]| layout(pdf).into_iter().map(|(w, _)| w).collect::<Vec<_>>();

        let rotated = edit_pages(&dll(), &pdf, &PagesEdit::Rotate { pages: vec![1, 2], quarters: -1 }).unwrap();
        assert_eq!(layout(&rotated), [(0, 0), (1, 3), (2, 3), (3, 0)]);

        let deleted = edit_pages(&dll(), &pdf, &PagesEdit::Delete { pages: vec![2, 0] }).unwrap();
        assert_eq!(ids(&deleted), [1, 3]);
        assert!(edit_pages(&dll(), &pdf, &PagesEdit::Delete { pages: vec![0, 1, 2, 3] }).is_err());

        let moved = edit_pages(&dll(), &pdf, &PagesEdit::Move { pages: vec![3], to: 0 }).unwrap();
        assert_eq!(ids(&moved), [3, 0, 1, 2]);
        let moved = edit_pages(&dll(), &pdf, &PagesEdit::Move { pages: vec![0, 1], to: 2 }).unwrap();
        assert_eq!(ids(&moved), [2, 3, 0, 1]);

        let blank = edit_pages(&dll(), &pdf, &PagesEdit::InsertBlank { at: 1, like: 3 }).unwrap();
        assert_eq!(ids(&blank), [0, 3, 1, 2, 3]);

        let other = std::env::temp_dir().join("pdfiiuum-insert.pdf");
        std::fs::write(&other, sample(2)).unwrap();
        let merged =
            edit_pages(&dll(), &pdf, &PagesEdit::InsertFile { at: 4, path: Some(other.to_string_lossy().into()), data: None }).unwrap();
        assert_eq!(ids(&merged), [0, 1, 2, 3, 0, 1]);

        let extracted = extract_pages(&dll(), &pdf, &[2, 0]).unwrap();
        assert_eq!(ids(&extracted), [2, 0]);
    }
}
