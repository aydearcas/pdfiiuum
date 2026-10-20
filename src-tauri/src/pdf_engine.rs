//! Escritura de anotaciones con PDFium.
//!
//! Se usan directamente las funciones FPDF_* que expone `pdfium-render`, porque su capa
//! de alto nivel no cubre trazos de tinta ni objetos dentro de sellos.

use pdfium_render::prelude::*;
use serde::Deserialize;
use std::ffi::c_void;
use std::os::raw::{c_int, c_ulong};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

// Constantes de la API de PDFium (fpdf_annot.h / fpdfview.h / fpdf_save.h).
const ANNOT_TEXT: c_int = 1;
const ANNOT_HIGHLIGHT: c_int = 9;
const ANNOT_UNDERLINE: c_int = 10;
const ANNOT_STRIKEOUT: c_int = 12;
const ANNOT_STAMP: c_int = 13;
const ANNOT_INK: c_int = 15;
const COLORTYPE_COLOR: u32 = 0;
const ANNOT_FLAG_PRINT: c_int = 4;
const RENDER_ANNOT: c_int = 0x01;
const SAVE_NO_INCREMENTAL: u32 = 2;

/// Prefijo del campo NM con el que identificamos el texto insertado por la app.
pub const TEXT_STAMP_PREFIX: &str = "pdfiiuum-text";

type Bindings = Box<dyn PdfiumLibraryBindings>;

static ENGINE: OnceLock<Result<Mutex<Bindings>, String>> = OnceLock::new();

fn engine(dll: &Path) -> Result<&'static Mutex<Bindings>, String> {
    ENGINE
        .get_or_init(|| {
            let b = Pdfium::bind_to_library(dll)
                .map_err(|e| format!("No se pudo cargar PDFium ({}): {e}", dll.display()))?;
            unsafe { b.FPDF_InitLibrary() };
            Ok(Mutex::new(b))
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annot {
    pub kind: String,
    /// Índice de página empezando en 0.
    pub page: i32,
    pub color: [u8; 3],
    /// highlight / underline / strikeout: un rectángulo [x1, y1, x2, y2] por línea.
    #[serde(default)]
    pub rects: Vec<[f32; 4]>,
    /// note: esquina superior izquierda del icono.
    pub point: Option<[f32; 2]>,
    /// text: caja [x1, y1, x2, y2].
    pub rect: Option<[f32; 4]>,
    pub text: Option<String>,
    pub font_size: Option<f32>,
    pub contents: Option<String>,
    pub width: Option<f32>,
    #[serde(default)]
    pub strokes: Vec<Vec<[f32; 2]>>,
    /// Fecha en formato PDF (D:AAAAMMDDHHmmSS+hh'mm').
    pub date: Option<String>,
    /// Autor (campo /T); por defecto, el usuario de Windows.
    pub author: Option<String>,
}

/// Nombre de usuario de Windows.
pub fn default_author() -> String {
    std::env::var("USERNAME").unwrap_or_default()
}

fn wide(b: &Bindings, s: &str) -> Vec<u8> {
    b.get_pdfium_utf16le_bytes_from_str(s)
}

/// Aplica las anotaciones a `pdf` y devuelve el PDF resultante.
pub fn apply_annotations(dll: &Path, pdf: &[u8], annots: &[Annot]) -> Result<Vec<u8>, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    let author = default_author();

    unsafe {
        let doc = b.FPDF_LoadMemDocument64(pdf, None);
        if doc.is_null() {
            return Err(format!("PDFium no pudo abrir el documento (error {})", b.FPDF_GetLastError()));
        }
        let result = (|| {
            let page_count = b.FPDF_GetPageCount(doc);
            let mut pages: Vec<i32> = annots.iter().map(|a| a.page).collect();
            pages.sort_unstable();
            pages.dedup();

            for index in pages {
                if index < 0 || index >= page_count {
                    return Err(format!("Página {} fuera de rango", index + 1));
                }
                let page = b.FPDF_LoadPage(doc, index);
                if page.is_null() {
                    return Err(format!("No se pudo cargar la página {}", index + 1));
                }
                for a in annots.iter().filter(|a| a.page == index) {
                    if let Err(e) = add_annotation(b, doc, page, a, &author) {
                        b.FPDF_ClosePage(page);
                        return Err(e);
                    }
                }
                generate_appearances(b, page);
                b.FPDF_ClosePage(page);
            }
            save(b, doc)
        })();
        b.FPDF_CloseDocument(doc);
        result
    }
}

unsafe fn add_annotation(
    b: &Bindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    a: &Annot,
    author: &str,
) -> Result<(), String> {
    let subtype = match a.kind.as_str() {
        "highlight" => ANNOT_HIGHLIGHT,
        "underline" => ANNOT_UNDERLINE,
        "strikeout" => ANNOT_STRIKEOUT,
        "note" => ANNOT_TEXT,
        "text" => ANNOT_STAMP,
        "ink" => ANNOT_INK,
        other => return Err(format!("Tipo de anotación desconocido: {other}")),
    };
    let annot = b.FPDFPage_CreateAnnot(page, subtype as FPDF_ANNOTATION_SUBTYPE);
    if annot.is_null() {
        return Err("PDFium no pudo crear la anotación".into());
    }
    let [r, g, bl] = a.color;
    let set_str = |key: &str, value: &str| {
        let w = wide(b, value);
        b.FPDFAnnot_SetStringValue(annot, key, w.as_ptr() as FPDF_WIDESTRING);
    };

    b.FPDFAnnot_SetFlags(annot, ANNOT_FLAG_PRINT);
    let author = a.author.as_deref().filter(|s| !s.is_empty()).unwrap_or(author);
    if !author.is_empty() {
        set_str("T", author);
    }
    if let Some(date) = &a.date {
        set_str("M", date);
        set_str("CreationDate", date);
    }
    if let Some(c) = a.contents.as_deref().filter(|c| !c.is_empty()) {
        set_str("Contents", c);
    }

    let ok = match subtype {
        ANNOT_HIGHLIGHT | ANNOT_UNDERLINE | ANNOT_STRIKEOUT => {
            b.FPDFAnnot_SetColor(annot, COLORTYPE_COLOR as FPDFANNOT_COLORTYPE, r as _, g as _, bl as _, 255);
            let mut bounds: Option<[f32; 4]> = None;
            for rc in &a.rects {
                let [x1, y1, x2, y2] = normalize(*rc);
                // Orden de QuadPoints que usa Acrobat: sup-izq, sup-der, inf-izq, inf-der.
                let quad = FS_QUADPOINTSF { x1, y1: y2, x2, y2, x3: x1, y3: y1, x4: x2, y4: y1 };
                b.FPDFAnnot_AppendAttachmentPoints(annot, &quad);
                bounds = Some(match bounds {
                    None => [x1, y1, x2, y2],
                    Some(u) => [u[0].min(x1), u[1].min(y1), u[2].max(x2), u[3].max(y2)],
                });
            }
            if let Some([x1, y1, x2, y2]) = bounds {
                set_rect(b, annot, [x1, y1, x2, y2]);
            }
            bounds.is_some()
        }
        ANNOT_TEXT => {
            let [x, y] = a.point.ok_or("Falta la posición de la nota")?;
            b.FPDFAnnot_SetColor(annot, COLORTYPE_COLOR as FPDFANNOT_COLORTYPE, r as _, g as _, bl as _, 255);
            set_rect(b, annot, [x, y - 20.0, x + 20.0, y]);
            true
        }
        ANNOT_INK => {
            b.FPDFAnnot_SetColor(annot, COLORTYPE_COLOR as FPDFANNOT_COLORTYPE, r as _, g as _, bl as _, 255);
            let w = a.width.unwrap_or(2.0);
            b.FPDFAnnot_SetBorder(annot, 0.0, 0.0, w);
            let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            for stroke in a.strokes.iter().filter(|s| !s.is_empty()) {
                let pts: Vec<FS_POINTF> = stroke.iter().map(|[x, y]| FS_POINTF { x: *x, y: *y }).collect();
                b.FPDFAnnot_AddInkStroke(annot, pts.as_ptr(), pts.len() as _);
                for p in &pts {
                    bounds = [bounds[0].min(p.x), bounds[1].min(p.y), bounds[2].max(p.x), bounds[3].max(p.y)];
                }
            }
            let pad = w;
            set_rect(b, annot, [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad]);
            bounds[0] <= bounds[2]
        }
        ANNOT_STAMP => add_text_stamp(b, doc, annot, a)?,
        _ => false,
    };

    b.FPDFPage_CloseAnnot(annot);
    if ok {
        Ok(())
    } else {
        Err(format!("Anotación «{}» sin geometría", a.kind))
    }
}

/// Texto insertado: sello cuyo aspecto se construye con objetos de texto reales
/// (PDFium solo admite objetos dentro de anotaciones de tinta y de sello).
unsafe fn add_text_stamp(b: &Bindings, doc: FPDF_DOCUMENT, annot: FPDF_ANNOTATION, a: &Annot) -> Result<bool, String> {
    let rect = normalize(a.rect.ok_or("Falta la caja del texto")?);
    let text = a.text.as_deref().unwrap_or("");
    let size = a.font_size.unwrap_or(12.0);
    let [r, g, bl] = a.color;
    set_rect(b, annot, rect);

    let wtext = wide(b, text);
    b.FPDFAnnot_SetStringValue(annot, "Contents", wtext.as_ptr() as FPDF_WIDESTRING);
    let meta = format!("{TEXT_STAMP_PREFIX};size={size};color={r},{g},{bl}");
    let wmeta = wide(b, &meta);
    b.FPDFAnnot_SetStringValue(annot, "NM", wmeta.as_ptr() as FPDF_WIDESTRING);

    let line_height = size * 1.2;
    let mut baseline = rect[3] - size * 0.95;
    for line in text.lines() {
        if !line.is_empty() {
            let obj = b.FPDFPageObj_NewTextObj(doc, "Helvetica", size);
            if obj.is_null() {
                return Err("No se pudo crear el texto".into());
            }
            let wl = wide(b, line);
            b.FPDFText_SetText(obj, wl.as_ptr() as FPDF_WIDESTRING);
            b.FPDFPageObj_SetFillColor(obj, r as _, g as _, bl as _, 255);
            b.FPDFPageObj_Transform(obj, 1.0, 0.0, 0.0, 1.0, (rect[0] + 2.0) as f64, baseline as f64);
            if b.FPDFAnnot_AppendObject(annot, obj) == 0 {
                b.FPDFPageObj_Destroy(obj);
                return Err("No se pudo añadir el texto a la anotación".into());
            }
        }
        baseline -= line_height;
    }
    Ok(true)
}

unsafe fn set_rect(b: &Bindings, annot: FPDF_ANNOTATION, [x1, y1, x2, y2]: [f32; 4]) {
    let rc = FS_RECTF { left: x1, bottom: y1, right: x2, top: y2 };
    b.FPDFAnnot_SetRect(annot, &rc);
}

fn normalize([x1, y1, x2, y2]: [f32; 4]) -> [f32; 4] {
    [x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)]
}

/// PDFium genera el aspecto (/AP) de resaltados, notas y tinta al cargar la lista de
/// anotaciones para pintar la página; ese /AP queda guardado en el documento.
unsafe fn generate_appearances(b: &Bindings, page: FPDF_PAGE) {
    let bitmap = b.FPDFBitmap_Create(4, 4, 0);
    if !bitmap.is_null() {
        b.FPDF_RenderPageBitmap(bitmap, page, 0, 0, 4, 4, 0, RENDER_ANNOT);
        b.FPDFBitmap_Destroy(bitmap);
    }
}

#[repr(C)]
struct Writer {
    base: FPDF_FILEWRITE,
    out: Vec<u8>,
}

unsafe extern "C" fn write_block(this: *mut FPDF_FILEWRITE, data: *const c_void, size: c_ulong) -> c_int {
    // `base` es el primer campo de `Writer` (repr(C)), así que el puntero es el mismo.
    let writer = &mut *(this as *mut Writer);
    writer.out.extend_from_slice(std::slice::from_raw_parts(data as *const u8, size as usize));
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PDFIIUUM_TEST_IN=entrada.pdf PDFIIUUM_TEST_OUT=salida.pdf cargo test -- --nocapture
    #[test]
    fn writes_every_kind() {
        let (Ok(input), Ok(output)) = (std::env::var("PDFIIUUM_TEST_IN"), std::env::var("PDFIIUUM_TEST_OUT")) else {
            eprintln!("PDFIIUUM_TEST_IN/OUT no definidos; se omite");
            return;
        };
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll");
        let json = r#"[
          {"kind":"highlight","page":0,"color":[255,212,0],"rects":[[60,700,300,715]],"contents":"Comentario en resaltado","date":"D:20261020120000+02'00'"},
          {"kind":"underline","page":0,"color":[19,163,90],"rects":[[60,680,300,695]]},
          {"kind":"strikeout","page":0,"color":[226,35,26],"rects":[[60,660,300,675]]},
          {"kind":"note","page":0,"color":[255,212,0],"point":[400,760],"contents":"Nota de prueba con acentos: áéíóú ñ"},
          {"kind":"text","page":1,"color":[0,0,0],"rect":[60,500,300,540],"text":"Texto insertado\nSegunda línea","fontSize":14},
          {"kind":"ink","page":1,"color":[226,35,26],"width":3,"strokes":[[[100,300],[150,350],[200,300],[250,350]]]}
        ]"#;
        let annots: Vec<Annot> = serde_json::from_str(json).unwrap();
        let pdf = std::fs::read(input).unwrap();
        let out = apply_annotations(&dll, &pdf, &annots).unwrap();
        std::fs::write(output, out).unwrap();
    }
}

unsafe fn save(b: &Bindings, doc: FPDF_DOCUMENT) -> Result<Vec<u8>, String> {
    let mut writer = Writer {
        base: FPDF_FILEWRITE { version: 1, WriteBlock: Some(write_block) },
        out: Vec::new(),
    };
    let ok = b.FPDF_SaveAsCopy(doc, &mut writer as *mut Writer as *mut FPDF_FILEWRITE, SAVE_NO_INCREMENTAL as FPDF_DWORD);
    if ok == 0 {
        return Err("PDFium no pudo guardar el documento".into());
    }
    Ok(writer.out)
}
