//! Escritura de anotaciones con PDFium.
//!
//! Se usan directamente las funciones FPDF_* que expone `pdfium-render`, porque su capa
//! de alto nivel no cubre trazos de tinta ni objetos dentro de sellos.

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
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

/// Guardado: `remove` son anotaciones originales del PDF ([página, índice], tal como las
/// devolvió `extract_annotations`) que se han borrado o modificado; `annots`, las que hay
/// que escribir (nuevas y versiones modificadas). Devuelve el PDF resultante.
pub fn apply_annotations(dll: &Path, pdf: &[u8], remove: &[[i32; 2]], annots: &[Annot]) -> Result<Vec<u8>, String> {
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
            let mut pages: Vec<i32> = annots.iter().map(|a| a.page).chain(remove.iter().map(|r| r[0])).collect();
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
                // Primero se quitan las originales (los índices se refieren al PDF tal cual).
                let targets: Vec<i32> = remove.iter().filter(|r| r[0] == index).map(|r| r[1]).collect();
                remove_with_popups(b, page, &targets);
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

/// Quita de la página las anotaciones de esos índices y sus ventanas emergentes (/Popup).
unsafe fn remove_with_popups(b: &Bindings, page: FPDF_PAGE, indices: &[i32]) {
    if indices.is_empty() {
        return;
    }
    let count = b.FPDFPage_GetAnnotCount(page);
    let mut all: Vec<i32> = Vec::new();
    for &i in indices.iter().filter(|&&i| i >= 0 && i < count) {
        all.push(i);
        let annot = b.FPDFPage_GetAnnot(page, i);
        if annot.is_null() {
            continue;
        }
        let popup = b.FPDFAnnot_GetLinkedAnnot(annot, "Popup");
        if !popup.is_null() {
            let pi = b.FPDFPage_GetAnnotIndex(page, popup);
            if pi >= 0 {
                all.push(pi);
            }
            b.FPDFPage_CloseAnnot(popup);
        }
        b.FPDFPage_CloseAnnot(annot);
    }
    // De mayor a menor para que los índices pendientes sigan siendo válidos.
    all.sort_unstable_by(|a, b| b.cmp(a));
    all.dedup();
    for i in all {
        b.FPDFPage_RemoveAnnot(page, i);
    }
}

/// Anotación ya guardada en el PDF que la app puede editar.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Existing {
    pub kind: &'static str,
    /// Página (desde 0) e índice dentro de la página: identifican la original al guardar.
    pub page: i32,
    pub index: i32,
    pub color: [u8; 3],
    pub rects: Vec<[f32; 4]>,
    pub point: Option<[f32; 2]>,
    pub rect: Option<[f32; 4]>,
    pub text: Option<String>,
    pub font_size: Option<f32>,
    pub width: Option<f32>,
    pub strokes: Vec<Vec<[f32; 2]>>,
    pub contents: String,
    pub author: String,
    pub date: String,
}

pub struct Extracted {
    pub annots: Vec<Existing>,
    /// Copia del PDF sin esas anotaciones (la app las dibuja en su capa editable);
    /// None si no había ninguna.
    pub display: Option<Vec<u8>>,
}

const ANNOT_FLAG_HIDDEN: c_int = 2;

/// Lee las notas, marcas, dibujos y textos de la app que ya contiene el PDF.
pub fn extract_annotations(dll: &Path, pdf: &[u8]) -> Result<Extracted, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe {
        let doc = b.FPDF_LoadMemDocument64(pdf, None);
        if doc.is_null() {
            return Err(format!("PDFium no pudo abrir el documento (error {})", b.FPDF_GetLastError()));
        }
        let result = (|| {
            let mut annots = Vec::new();
            for p in 0..b.FPDF_GetPageCount(doc) {
                let page = b.FPDF_LoadPage(doc, p);
                if page.is_null() {
                    continue;
                }
                let mut found = Vec::new();
                for i in 0..b.FPDFPage_GetAnnotCount(page) {
                    let annot = b.FPDFPage_GetAnnot(page, i);
                    if annot.is_null() {
                        continue;
                    }
                    if let Some(e) = read_existing(b, annot, p, i) {
                        found.push(i);
                        annots.push(e);
                    }
                    b.FPDFPage_CloseAnnot(annot);
                }
                remove_with_popups(b, page, &found);
                b.FPDF_ClosePage(page);
            }
            let display = if annots.is_empty() { None } else { Some(save(b, doc)?) };
            Ok(Extracted { annots, display })
        })();
        b.FPDF_CloseDocument(doc);
        result
    }
}

unsafe fn read_existing(b: &Bindings, annot: FPDF_ANNOTATION, page: i32, index: i32) -> Option<Existing> {
    if b.FPDFAnnot_GetFlags(annot) & ANNOT_FLAG_HIDDEN != 0 {
        return None;
    }
    // Las respuestas a otro comentario (/IRT) se dejan como están.
    let irt = b.FPDFAnnot_GetLinkedAnnot(annot, "IRT");
    if !irt.is_null() {
        b.FPDFPage_CloseAnnot(irt);
        return None;
    }
    let subtype = b.FPDFAnnot_GetSubtype(annot) as c_int;
    let nm = read_str(b, annot, "NM");
    let kind = match subtype {
        ANNOT_HIGHLIGHT => "highlight",
        ANNOT_UNDERLINE => "underline",
        ANNOT_STRIKEOUT => "strikeout",
        ANNOT_TEXT => "note",
        ANNOT_INK => "ink",
        ANNOT_STAMP if nm.starts_with(TEXT_STAMP_PREFIX) => "text",
        _ => return None,
    };
    let mut rc = FS_RECTF { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
    b.FPDFAnnot_GetRect(annot, &mut rc);
    let rect = [rc.left.min(rc.right), rc.bottom.min(rc.top), rc.left.max(rc.right), rc.bottom.max(rc.top)];

    let (mut r, mut g, mut bl, mut a) = (0u32, 0u32, 0u32, 0u32);
    let has_color = b.FPDFAnnot_GetColor(annot, COLORTYPE_COLOR as FPDFANNOT_COLORTYPE, &mut r, &mut g, &mut bl, &mut a) != 0;
    let default: [u8; 3] = match kind {
        "highlight" | "note" => [255, 212, 0],
        "underline" => [19, 163, 90],
        "text" => [17, 17, 17],
        _ => [226, 35, 26],
    };
    let color = if has_color { [r as u8, g as u8, bl as u8] } else { default };

    let mut e = Existing {
        kind,
        page,
        index,
        color,
        rects: Vec::new(),
        point: None,
        rect: None,
        text: None,
        font_size: None,
        width: None,
        strokes: Vec::new(),
        contents: read_str(b, annot, "Contents"),
        author: read_str(b, annot, "T"),
        date: {
            let m = read_str(b, annot, "M");
            if m.is_empty() { read_str(b, annot, "CreationDate") } else { m }
        },
    };
    match kind {
        "highlight" | "underline" | "strikeout" => {
            let n = b.FPDFAnnot_CountAttachmentPoints(annot);
            for q in 0..n {
                let mut quad = FS_QUADPOINTSF { x1: 0.0, y1: 0.0, x2: 0.0, y2: 0.0, x3: 0.0, y3: 0.0, x4: 0.0, y4: 0.0 };
                if b.FPDFAnnot_GetAttachmentPoints(annot, q, &mut quad) != 0 {
                    let xs = [quad.x1, quad.x2, quad.x3, quad.x4];
                    let ys = [quad.y1, quad.y2, quad.y3, quad.y4];
                    let min = |v: [f32; 4]| v.iter().cloned().fold(f32::MAX, f32::min);
                    let max = |v: [f32; 4]| v.iter().cloned().fold(f32::MIN, f32::max);
                    e.rects.push([min(xs), min(ys), max(xs), max(ys)]);
                }
            }
            if e.rects.is_empty() {
                e.rects.push(rect);
            }
        }
        "note" => e.point = Some([rect[0], rect[3]]),
        "ink" => {
            for s in 0..b.FPDFAnnot_GetInkListCount(annot) {
                let len = b.FPDFAnnot_GetInkListPath(annot, s, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }
                let mut pts = vec![FS_POINTF { x: 0.0, y: 0.0 }; len as usize];
                b.FPDFAnnot_GetInkListPath(annot, s, pts.as_mut_ptr(), len);
                e.strokes.push(pts.iter().map(|p| [p.x, p.y]).collect());
            }
            let (mut h, mut v, mut w) = (0.0f32, 0.0f32, 0.0f32);
            e.width = Some(if b.FPDFAnnot_GetBorder(annot, &mut h, &mut v, &mut w) != 0 && w > 0.0 { w } else { 1.0 });
            if e.strokes.is_empty() {
                return None;
            }
        }
        "text" => {
            // NM = "pdfiiuum-text;size=14;color=17,17,17"
            for part in nm.split(';') {
                if let Some(s) = part.strip_prefix("size=") {
                    e.font_size = s.parse().ok();
                } else if let Some(c) = part.strip_prefix("color=") {
                    let v: Vec<u8> = c.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                    if v.len() == 3 {
                        e.color = [v[0], v[1], v[2]];
                    }
                }
            }
            e.rect = Some(rect);
            e.text = Some(std::mem::take(&mut e.contents));
        }
        _ => {}
    }
    Some(e)
}

/// Lee un valor de texto (/Contents, /T, /M…) de la anotación.
unsafe fn read_str(b: &Bindings, annot: FPDF_ANNOTATION, key: &str) -> String {
    let bytes = b.FPDFAnnot_GetStringValue(annot, key, std::ptr::null_mut(), 0);
    if bytes <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (bytes as usize) / 2];
    b.FPDFAnnot_GetStringValue(annot, key, buf.as_mut_ptr() as *mut FPDF_WCHAR, bytes);
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf16_lossy(&buf)
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
        let out = apply_annotations(&dll, &pdf, &[], &annots).unwrap();
        std::fs::write(&output, &out).unwrap();

        // Las seis se vuelven a leer como editables y la copia de pantalla queda sin ellas.
        let ex = extract_annotations(&dll, &out).unwrap();
        let kinds: Vec<&str> = ex.annots.iter().map(|a| a.kind).collect();
        assert_eq!(kinds, ["highlight", "underline", "strikeout", "note", "text", "ink"]);
        assert_eq!(ex.annots[0].contents, "Comentario en resaltado");
        assert_eq!(ex.annots[4].text.as_deref(), Some("Texto insertado\nSegunda línea"));
        assert_eq!(ex.annots[4].font_size, Some(14.0));
        let display = ex.display.expect("copia sin anotaciones");
        assert!(extract_annotations(&dll, &display).unwrap().annots.is_empty());

        // Borrar el resaltado (página 0, índice 0) y guardar: quedan las otras cinco.
        let first = &ex.annots[0];
        let saved = apply_annotations(&dll, &out, &[[first.page, first.index]], &[]).unwrap();
        let again = extract_annotations(&dll, &saved).unwrap();
        assert_eq!(again.annots.len(), 5);
        assert!(again.annots.iter().all(|a| a.kind != "highlight"));
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
