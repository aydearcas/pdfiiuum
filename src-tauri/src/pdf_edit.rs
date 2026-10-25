//! Modo edición: cambia el contenido de las páginas (no las anotaciones) con PDFium.
//!
//! El texto de una página se agrupa en «tramos»: objetos de texto seguidos en la misma línea
//! con la misma tipografía, tamaño y color. Corregir un tramo sustituye sus objetos por el
//! texto nuevo en la misma posición. Si la tipografía del PDF no tiene alguna letra (los PDF
//! suelen incluir solo las que usan), esas letras se escriben con una parecida.

use std::collections::HashSet;
use std::os::raw::{c_int, c_uint};
use std::path::Path;

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::page_stream;
use crate::pdf_engine::{engine, save, wide, Bindings};

const PAGEOBJ_TEXT: c_int = 1;
const PAGEOBJ_IMAGE: c_int = 3;
const FILLMODE_ALTERNATE: c_int = 1;
const BITMAP_BGRA: c_int = 4;
const TEXTRENDERMODE_FILL: i32 = 0;
const TEXTRENDERMODE_INVISIBLE: i32 = 3;
const FONT_TRUETYPE: c_int = 2;
const FLAG_FIXED_PITCH: c_int = 1;
const FLAG_SERIF: c_int = 2;
const FLAG_ITALIC: c_int = 64;
const FLAG_FORCE_BOLD: c_int = 1 << 18;
/// Como mucho se estrecha el texto hasta este factor para que quepa en su sitio.
const MIN_SQUEEZE: f32 = 0.85;

/// Tramo de texto editable de una página (coordenadas PDF).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    /// Índices de los objetos de la página que forman el tramo.
    pub objects: Vec<i32>,
    pub text: String,
    /// Caja [x1, y1, x2, y2].
    pub rect: [f32; 4],
    pub baseline: f32,
    /// Tamaño con el que se ve, en puntos.
    pub size: f32,
    pub family: String,
    pub bold: bool,
    pub italic: bool,
    pub serif: bool,
    pub mono: bool,
    pub color: [u8; 3],
}

/// Un objeto de texto de la página.
struct Piece {
    index: i32,
    obj: FPDF_PAGEOBJECT,
    text: String,
    m: FS_MATRIX,
    bounds: [f32; 4],
    /// Tamaño del operador Tf (sin la escala de la matriz).
    tf: f32,
    font: FPDF_FONT,
    color: [u8; 3],
    mode: i32,
}

impl Piece {
    fn size(&self) -> f32 {
        self.tf * self.m.d
    }
}

/// Imagen de una página.
#[derive(Serialize, Clone, Debug)]
pub struct ImageObject {
    pub index: i32,
    pub rect: [f32; 4],
}

/// Lo que se puede editar en una página.
#[derive(Serialize, Debug)]
pub struct PageContent {
    pub runs: Vec<TextRun>,
    pub images: Vec<ImageObject>,
}

/// Cambio en el contenido de una página (coordenadas PDF).
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PageEdit {
    /// Corregir un tramo de texto (vacío = borrarlo).
    Text { objects: Vec<i32>, text: String },
    /// Texto nuevo con la esquina superior izquierda en (x, y). `font`: sans, serif o mono.
    AddText { x: f32, y: f32, text: String, size: f32, color: [u8; 3], font: String },
    /// Mover o cambiar de tamaño un objeto para que ocupe `rect`.
    Move { index: i32, rect: [f32; 4] },
    Delete { indices: Vec<i32> },
    /// Imagen (de una ruta o, en el visor del navegador, en base64), centrada en `center` y
    /// reducida para caber en `max` (ancho, alto).
    AddImage { path: Option<String>, data: Option<String>, center: [f32; 2], max: [f32; 2] },
    /// Rectángulo blanco que tapa la zona; quita lo que quede entero debajo.
    Cover { rect: [f32; 4] },
}

pub struct Edited {
    pub pdf: Vec<u8>,
    /// Aviso para el usuario (p. ej., letras escritas con otra tipografía).
    pub notice: Option<String>,
}

/// Abre el PDF y la página `index` (desde 0), ejecuta `f` y lo cierra todo.
unsafe fn with_page<T>(
    b: &Bindings,
    pdf: &[u8],
    index: i32,
    f: impl FnOnce(FPDF_DOCUMENT, FPDF_PAGE, FPDF_TEXTPAGE) -> Result<T, String>,
) -> Result<T, String> {
    let doc = b.FPDF_LoadMemDocument64(pdf, None);
    if doc.is_null() {
        return Err(format!("PDFium no pudo abrir el documento (error {})", b.FPDF_GetLastError()));
    }
    let result = (|| {
        if index < 0 || index >= b.FPDF_GetPageCount(doc) {
            return Err(format!("Página {} fuera de rango", index + 1));
        }
        let page = b.FPDF_LoadPage(doc, index);
        if page.is_null() {
            return Err(format!("No se pudo cargar la página {}", index + 1));
        }
        let text_page = b.FPDFText_LoadPage(page);
        let r = f(doc, page, text_page);
        if !text_page.is_null() {
            b.FPDFText_ClosePage(text_page);
        }
        b.FPDF_ClosePage(page);
        r
    })();
    b.FPDF_CloseDocument(doc);
    result
}

/// Tramos de texto e imágenes de una página.
pub fn page_content(dll: &Path, pdf: &[u8], page: i32) -> Result<PageContent, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe {
        with_page(b, pdf, page, |_, page, tp| {
            Ok(PageContent { runs: group(b, &pieces(b, page, tp)), images: images(b, page) })
        })
    }
}

/// Aplica un cambio a la página y devuelve el PDF resultante.
pub fn edit_page(dll: &Path, pdf: &[u8], page: i32, edit: &PageEdit) -> Result<Edited, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe {
        if let PageEdit::Text { objects, text } = edit {
            match replace_run_in_place(b, pdf, page, objects, text)? {
                Ok(edited) => return Ok(edited),
                #[cfg(debug_assertions)]
                Err(why) => eprintln!("Corregir texto rehace la página: {why}"),
                #[cfg(not(debug_assertions))]
                Err(_) => {}
            }
        }
        with_page(b, pdf, page, |doc, page, tp| {
            let notice = match edit {
                PageEdit::Text { objects, text } => {
                    let notice = replace_run(b, doc, page, tp, objects, text)?;
                    Some(notice.map_or(REWRITTEN.to_string(), |n| format!("{n}. {REWRITTEN}")))
                }
                PageEdit::AddText { x, y, text, size, color, font } => {
                    add_text(b, doc, page, [*x, *y], text, *size, *color, font)?
                }
                PageEdit::Move { index, rect } => {
                    move_object(b, page, *index, *rect)?;
                    None
                }
                PageEdit::Delete { indices } => {
                    let objs: Vec<FPDF_PAGEOBJECT> = indices.iter().map(|&i| b.FPDFPage_GetObject(page, i)).collect();
                    if objs.iter().any(|o| o.is_null()) {
                        return Err(STALE.into());
                    }
                    for obj in objs {
                        remove(b, page, obj);
                    }
                    None
                }
                PageEdit::AddImage { path, data, center, max } => {
                    let bytes = read_source(path, data, "la imagen", crate::IMAGES)?;
                    add_image(b, doc, page, &bytes, *center, *max)?;
                    None
                }
                PageEdit::Cover { rect } => cover(b, page, *rect),
            };
            if b.FPDFPage_GenerateContent(page) == 0 {
                return Err("PDFium no pudo regenerar la página".into());
            }
            Ok(Edited { pdf: save(b, doc)?, notice })
        })
    }
}

/// Contenido de un archivo de entrada: por ruta (app de escritorio, solo con las extensiones
/// `allowed`) o en base64 (visor del navegador, que no puede pasar rutas).
pub(crate) fn read_source(path: &Option<String>, data: &Option<String>, what: &str, allowed: &[&str]) -> Result<Vec<u8>, String> {
    use base64::Engine;
    match (path, data) {
        (_, Some(d)) => base64::engine::general_purpose::STANDARD
            .decode(d)
            .map_err(|e| format!("No se pudo leer {what}: {e}")),
        (Some(p), None) => {
            crate::check_path(Path::new(p), allowed)?;
            std::fs::read(p).map_err(|e| format!("No se pudo leer {what}: {e}"))
        }
        (None, None) => Err(format!("Falta {what}")),
    }
}

const STALE: &str = "La página ha cambiado mientras se editaba; vuelve a intentarlo";
const REWRITTEN: &str = "No se ha podido corregir la línea sin rehacer la página: revisa que el resto siga igual";

unsafe fn remove(b: &Bindings, page: FPDF_PAGE, obj: FPDF_PAGEOBJECT) {
    if b.FPDFPage_RemoveObject(page, obj) != 0 {
        b.FPDFPageObj_Destroy(obj);
    }
}

unsafe fn bounds(b: &Bindings, obj: FPDF_PAGEOBJECT) -> Option<[f32; 4]> {
    let (mut l, mut bt, mut r, mut t) = (0.0, 0.0, 0.0, 0.0);
    (b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) != 0).then_some([l, bt, r, t])
}

fn normalize([x1, y1, x2, y2]: [f32; 4]) -> [f32; 4] {
    [x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)]
}

/// Sustituye el texto del tramo formado por `objects` por `text` (vacío = borrarlo).
unsafe fn replace_run(
    b: &Bindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    tp: FPDF_TEXTPAGE,
    objects: &[i32],
    text: &str,
) -> Result<Option<String>, String> {
    let all = pieces(b, page, tp);
    let targets = find_targets(&all, objects)?;
    let notice = if text.trim().is_empty() {
        None
    } else {
        write_run(b, doc, page, &targets, text, Some(targets[0].index as usize))?
    };
    for t in &targets {
        remove(b, page, t.obj);
    }
    Ok(notice)
}

fn find_targets<'a>(all: &'a [Piece], objects: &[i32]) -> Result<Vec<&'a Piece>, String> {
    let targets: Vec<&Piece> = objects.iter().filter_map(|i| all.iter().find(|p| p.index == *i)).collect();
    if targets.len() != objects.len() || targets.is_empty() {
        return Err(STALE.into());
    }
    Ok(targets)
}

/// Corrige el tramo sin regenerar el resto de la página. `FPDFPage_GenerateContent` reescribe
/// entero el flujo del que se quita un objeto y pierde cosas (ver `page_stream`); añadir al
/// final no toca los flujos que ya había. Así que PDFium escribe el texto nuevo al final y
/// luego, a mano, se quitan del contenido original los operadores del tramo y el texto nuevo
/// pasa a su sitio. Se comprueba con PDFium que los demás objetos siguen exactamente igual;
/// si no se puede, `Err` dice por qué y se hace como antes.
unsafe fn replace_run_in_place(
    b: &Bindings,
    pdf: &[u8],
    index: i32,
    objects: &[i32],
    text: &str,
) -> Result<Result<Edited, String>, String> {
    let (saved, kept, added, ordinals, texts, notice) = with_page(b, pdf, index, |doc, page, tp| {
        let all = pieces(b, page, tp);
        let targets = find_targets(&all, objects)?;
        let before = shapes(b, page, 0);

        // Objetos de texto en el orden del contenido (los nuevos, al final) y cuáles son los del tramo.
        let text_objects = |from: i32| {
            (from..b.FPDFPage_CountObjects(page))
                .map(|i| (i, b.FPDFPage_GetObject(page, i)))
                .filter(|&(_, obj)| !obj.is_null() && b.FPDFPageObj_GetType(obj) == PAGEOBJ_TEXT)
                .collect::<Vec<_>>()
        };
        let old = text_objects(0);
        let ordinals: Vec<usize> = (0..old.len()).filter(|&k| objects.contains(&old[k].0)).collect();

        let count = before.len() as i32;
        let notice = if text.trim().is_empty() { None } else { write_run(b, doc, page, &targets, text, None)? };
        let texts: Vec<page_stream::TextPos> = old
            .into_iter()
            .chain(text_objects(count))
            .map(|(_, obj)| {
                let mut m = FS_MATRIX { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 };
                let mut tf = 0.0;
                b.FPDFPageObj_GetMatrix(obj, &mut m);
                b.FPDFTextObj_GetFontSize(obj, &mut tf);
                page_stream::TextPos { x: m.e, unit: tf * m.a / 1000.0 }
            })
            .collect();
        let kept: Vec<Shape> =
            before.into_iter().enumerate().filter(|(i, _)| !objects.contains(&(*i as i32))).map(|(_, s)| s).collect();
        let added = shapes(b, page, count);
        if b.FPDFPage_GenerateContent(page) == 0 {
            return Err("PDFium no pudo regenerar la página".into());
        }
        Ok((save(b, doc)?, kept, added, ordinals, texts, notice))
    })?;

    let out = match page_stream::replace_text(&saved, index as usize, &ordinals, &texts, !added.is_empty()) {
        Ok(out) => out,
        Err(e) => return Ok(Err(e)),
    };
    let after = match with_page(b, &out, index, |_, page, _| Ok(shapes(b, page, 0))) {
        Ok(after) => after,
        Err(e) => return Ok(Err(e)),
    };
    Ok(if unchanged_but(&kept, &added, &after) {
        Ok(Edited { pdf: out, notice })
    } else {
        Err("los demás objetos de la página no han quedado igual".into())
    })
}

/// Tipo, caja, matriz y color de cada objeto de la página desde `from`. (El texto que
/// devuelve PDFium no sirve para comparar: depende de lo que tenga alrededor; p. ej., un
/// guion a final de línea sale vacío o no según la línea anterior.)
#[derive(Debug)]
struct Shape {
    kind: c_int,
    bounds: [f32; 4],
    matrix: [f32; 6],
    color: [c_uint; 4],
}

unsafe fn shapes(b: &Bindings, page: FPDF_PAGE, from: i32) -> Vec<Shape> {
    (from..b.FPDFPage_CountObjects(page))
        .map(|i| {
            let obj = b.FPDFPage_GetObject(page, i);
            let mut m = FS_MATRIX { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 };
            b.FPDFPageObj_GetMatrix(obj, &mut m);
            let mut color = [0; 4];
            let [r, g, bl, a] = &mut color;
            b.FPDFPageObj_GetFillColor(obj, r, g, bl, a);
            Shape {
                kind: b.FPDFPageObj_GetType(obj),
                bounds: bounds(b, obj).unwrap_or_default(),
                matrix: [m.a, m.b, m.c, m.d, m.e, m.f],
                color,
            }
        })
        .collect()
}

fn same_shape(x: &Shape, y: &Shape) -> bool {
    x.kind == y.kind
        && x.color == y.color
        && x.bounds.iter().zip(y.bounds).all(|(p, q)| (p - q).abs() < 0.02)
        && x.matrix.iter().zip(y.matrix).all(|(p, q)| (p - q).abs() < 0.02)
}

fn same_shapes(a: &[Shape], b: &[Shape]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_shape(x, y))
}

/// ¿Es `after` lo mismo que `kept`, en el mismo orden, con `added` seguido en algún sitio?
fn unchanged_but(kept: &[Shape], added: &[Shape], after: &[Shape]) -> bool {
    if after.len() != kept.len() + added.len() {
        return false;
    }
    let n = added.len();
    let prefix = kept.iter().zip(after).take_while(|(x, y)| same_shape(x, y)).count();
    let suffix = kept.iter().rev().zip(after.iter().rev()).take_while(|(x, y)| same_shape(x, y)).count();
    (kept.len().saturating_sub(suffix)..=prefix).any(|k| same_shapes(added, &after[k..k + n]))
}

unsafe fn images(b: &Bindings, page: FPDF_PAGE) -> Vec<ImageObject> {
    (0..b.FPDFPage_CountObjects(page))
        .filter_map(|index| {
            let obj = b.FPDFPage_GetObject(page, index);
            if obj.is_null() || b.FPDFPageObj_GetType(obj) != PAGEOBJ_IMAGE {
                return None;
            }
            Some(ImageObject { index, rect: bounds(b, obj)? })
        })
        .collect()
}

/// Escala y desplaza el objeto para que su caja pase a ser `rect`.
unsafe fn move_object(b: &Bindings, page: FPDF_PAGE, index: i32, rect: [f32; 4]) -> Result<(), String> {
    let obj = b.FPDFPage_GetObject(page, index);
    let old = if obj.is_null() { None } else { bounds(b, obj) }.ok_or(STALE)?;
    let new = normalize(rect);
    let (ow, oh) = (old[2] - old[0], old[3] - old[1]);
    if ow <= 0.0 || oh <= 0.0 || new[2] - new[0] < 1.0 || new[3] - new[1] < 1.0 {
        return Err("Tamaño no válido".into());
    }
    let sx = (new[2] - new[0]) / ow;
    let sy = (new[3] - new[1]) / oh;
    b.FPDFPageObj_Transform(
        obj,
        sx as f64,
        0.0,
        0.0,
        sy as f64,
        (new[0] - sx * old[0]) as f64,
        (new[1] - sy * old[1]) as f64,
    );
    Ok(())
}

/// Texto nuevo como contenido de la página, una línea por objeto.
#[allow(clippy::too_many_arguments)]
unsafe fn add_text(
    b: &Bindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    [x, top]: [f32; 2],
    text: &str,
    size: f32,
    [r, g, bl]: [u8; 3],
    font: &str,
) -> Result<Option<String>, String> {
    let style = FontStyle::generic(font == "serif", font == "mono");
    let handle = if text.chars().all(|c| win_ansi(c) || c == '\n') {
        b.FPDFText_LoadStandardFont(doc, style.standard())
    } else {
        load_system_font(b, doc, &style)?
    };
    if handle.is_null() {
        return Err("No se pudo cargar la tipografía".into());
    }
    // Como el editor: interlineado 1,2 y la primera línea base a 0,95 del tamaño.
    let mut baseline = top - size * 0.95;
    for line in text.lines() {
        if !line.trim().is_empty() {
            let obj = b.FPDFPageObj_CreateTextObj(doc, handle, size);
            if obj.is_null() {
                return Err("No se pudo crear el texto".into());
            }
            let w = wide(b, line);
            b.FPDFText_SetText(obj, w.as_ptr() as FPDF_WIDESTRING);
            b.FPDFPageObj_SetFillColor(obj, r as _, g as _, bl as _, 255);
            b.FPDFPageObj_SetMatrix(obj, &FS_MATRIX { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: x, f: baseline });
            b.FPDFPage_InsertObject(page, obj);
        }
        baseline -= size * 1.2;
    }
    Ok(None)
}

unsafe fn load_system_font(b: &Bindings, doc: FPDF_DOCUMENT, style: &FontStyle) -> Result<FPDF_FONT, String> {
    let (name, file) = style.system();
    let dir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
    let data = std::fs::read(Path::new(&dir).join("Fonts").join(format!("{file}.ttf")))
        .map_err(|e| format!("No se pudo leer la tipografía {name}: {e}"))?;
    Ok(b.FPDFText_LoadFont(doc, data.as_ptr(), data.len() as c_uint, FONT_TRUETYPE, 1))
}

/// Imagen PNG, JPEG, GIF, BMP o WebP. El JPEG se incrusta tal cual; el resto, como mapa de bits.
unsafe fn add_image(
    b: &Bindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    data: &[u8],
    [cx, cy]: [f32; 2],
    [max_w, max_h]: [f32; 2],
) -> Result<(), String> {
    let img = image::load_from_memory(&data).map_err(|e| format!("No es una imagen válida: {e}"))?;
    let (pw, ph) = (img.width() as f32, img.height() as f32);
    // A 96 ppp (como en pantalla), reducida si no cabe.
    let fit = (max_w / (pw * 0.75)).min(max_h / (ph * 0.75)).min(1.0);
    let (w, h) = (pw * 0.75 * fit, ph * 0.75 * fit);

    let obj = b.FPDFPageObj_NewImageObj(doc);
    if obj.is_null() {
        return Err("No se pudo crear la imagen".into());
    }
    let ok = if data.starts_with(&[0xFF, 0xD8]) {
        let mut reader = MemoryReader(data);
        let mut access = FPDF_FILEACCESS {
            m_FileLen: data.len() as _,
            m_GetBlock: Some(read_block),
            m_Param: &mut reader as *mut MemoryReader as *mut std::ffi::c_void,
        };
        b.FPDFImageObj_LoadJpegFileInline(std::ptr::null_mut(), 0, obj, &mut access) != 0
    } else {
        let rgba = img.to_rgba8();
        let mut bgra: Vec<u8> = rgba.pixels().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
        let bitmap = b.FPDFBitmap_CreateEx(
            rgba.width() as c_int,
            rgba.height() as c_int,
            BITMAP_BGRA,
            bgra.as_mut_ptr() as *mut std::ffi::c_void,
            (rgba.width() * 4) as c_int,
        );
        let ok = !bitmap.is_null() && b.FPDFImageObj_SetBitmap(std::ptr::null_mut(), 0, obj, bitmap) != 0;
        if !bitmap.is_null() {
            b.FPDFBitmap_Destroy(bitmap);
        }
        ok
    };
    if !ok {
        b.FPDFPageObj_Destroy(obj);
        return Err("PDFium no pudo cargar la imagen".into());
    }
    b.FPDFPageObj_SetMatrix(obj, &FS_MATRIX { a: w, b: 0.0, c: 0.0, d: h, e: cx - w / 2.0, f: cy - h / 2.0 });
    b.FPDFPage_InsertObject(page, obj);
    Ok(())
}

struct MemoryReader<'a>(&'a [u8]);

unsafe extern "C" fn read_block(
    param: *mut std::ffi::c_void,
    position: std::os::raw::c_ulong,
    buf: *mut std::os::raw::c_uchar,
    size: std::os::raw::c_ulong,
) -> c_int {
    let data = (*(param as *const MemoryReader)).0;
    let (start, len) = (position as usize, size as usize);
    match data.get(start..start + len) {
        Some(src) => {
            std::ptr::copy_nonoverlapping(src.as_ptr(), buf, len);
            1
        }
        None => 0,
    }
}

/// Tapa la zona con un rectángulo blanco y quita el texto y las imágenes que quedan enteros
/// debajo (lo que solo queda tapado en parte sigue en el PDF).
unsafe fn cover(b: &Bindings, page: FPDF_PAGE, rect: [f32; 4]) -> Option<String> {
    let [x1, y1, x2, y2] = normalize(rect);
    let inside: Vec<FPDF_PAGEOBJECT> = (0..b.FPDFPage_CountObjects(page))
        .map(|i| b.FPDFPage_GetObject(page, i))
        .filter(|&o| !o.is_null() && matches!(b.FPDFPageObj_GetType(o), PAGEOBJ_TEXT | PAGEOBJ_IMAGE))
        .filter(|&o| {
            bounds(b, o).is_some_and(|[l, bt, r, t]| l >= x1 - 0.5 && bt >= y1 - 0.5 && r <= x2 + 0.5 && t <= y2 + 0.5)
        })
        .collect();
    let removed = inside.len();
    for obj in inside {
        remove(b, page, obj);
    }
    let obj = b.FPDFPageObj_CreateNewRect(x1, y1, x2 - x1, y2 - y1);
    if !obj.is_null() {
        b.FPDFPageObj_SetFillColor(obj, 255, 255, 255, 255);
        b.FPDFPath_SetDrawMode(obj, FILLMODE_ALTERNATE, 0);
        b.FPDFPage_InsertObject(page, obj);
    }
    (removed > 0).then(|| {
        format!(
            "Zona tapada; se ha{} quitado {removed} elemento{} que quedaba{} debajo",
            if removed == 1 { "" } else { "n" },
            if removed == 1 { "" } else { "s" },
            if removed == 1 { "" } else { "n" },
        )
    })
}

unsafe fn pieces(b: &Bindings, page: FPDF_PAGE, tp: FPDF_TEXTPAGE) -> Vec<Piece> {
    let mut out = Vec::new();
    for index in 0..b.FPDFPage_CountObjects(page) {
        let obj = b.FPDFPage_GetObject(page, index);
        if obj.is_null() || b.FPDFPageObj_GetType(obj) != PAGEOBJ_TEXT {
            continue;
        }
        let mode = b.FPDFTextObj_GetTextRenderMode(obj) as i32;
        // El texto invisible (capa de OCR de un escaneado) no se ve: no tiene sentido editarlo.
        if mode == TEXTRENDERMODE_INVISIBLE {
            continue;
        }
        let mut m = FS_MATRIX { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 };
        if b.FPDFPageObj_GetMatrix(obj, &mut m) == 0 {
            continue;
        }
        // Solo texto horizontal y sin girar.
        let scale = m.a.abs().max(m.d.abs());
        if m.a <= 0.0 || m.d <= 0.0 || m.b.abs() > 0.01 * scale || m.c.abs() > 0.01 * scale {
            continue;
        }
        let mut tf = 0.0;
        b.FPDFTextObj_GetFontSize(obj, &mut tf);
        let (mut l, mut bt, mut r, mut t) = (0.0, 0.0, 0.0, 0.0);
        if tf <= 0.0 || b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) == 0 {
            continue;
        }
        let text = object_text(b, obj, tp);
        if text.is_empty() {
            continue;
        }
        let (mut cr, mut cg, mut cb, mut ca) = (0, 0, 0, 0);
        b.FPDFPageObj_GetFillColor(obj, &mut cr, &mut cg, &mut cb, &mut ca);
        out.push(Piece {
            index,
            obj,
            text,
            m,
            bounds: [l, bt, r, t],
            tf,
            font: b.FPDFTextObj_GetFont(obj),
            color: [cr as u8, cg as u8, cb as u8],
            mode,
        });
    }
    out
}

unsafe fn object_text(b: &Bindings, obj: FPDF_PAGEOBJECT, tp: FPDF_TEXTPAGE) -> String {
    let bytes = b.FPDFTextObj_GetText(obj, tp, std::ptr::null_mut(), 0) as usize;
    if bytes < 2 {
        return String::new();
    }
    let mut buf = vec![0u16; bytes / 2];
    b.FPDFTextObj_GetText(obj, tp, buf.as_mut_ptr(), (buf.len() * 2) as _);
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).replace(['\r', '\n', '\u{2}'], "")
}

/// Une los objetos seguidos de una misma línea con igual tipografía, tamaño y color.
unsafe fn group(b: &Bindings, pieces: &[Piece]) -> Vec<TextRun> {
    let mut runs: Vec<(TextRun, FPDF_FONT)> = Vec::new();
    for p in pieces {
        let size = p.size();
        if let Some((run, font)) = runs.last_mut() {
            let gap = p.bounds[0] - run.rect[2];
            let joins = *font == p.font
                && (size - run.size).abs() < 0.05 * run.size
                && run.color == p.color
                && (p.m.f - run.baseline).abs() < 0.15 * run.size
                && gap > -0.3 * run.size
                && gap < 1.2 * run.size;
            if joins {
                if gap > 0.15 * size && !run.text.ends_with(' ') && !p.text.starts_with(' ') {
                    run.text.push(' ');
                }
                run.text.push_str(&p.text);
                run.objects.push(p.index);
                run.rect = [
                    run.rect[0].min(p.bounds[0]),
                    run.rect[1].min(p.bounds[1]),
                    run.rect[2].max(p.bounds[2]),
                    run.rect[3].max(p.bounds[3]),
                ];
                continue;
            }
        }
        let style = FontStyle::of(b, p.font);
        runs.push((
            TextRun {
                objects: vec![p.index],
                text: p.text.clone(),
                rect: p.bounds,
                baseline: p.m.f,
                size,
                family: style.family,
                bold: style.bold,
                italic: style.italic,
                serif: style.serif,
                mono: style.mono,
                color: p.color,
            },
            p.font,
        ));
    }
    runs.into_iter()
        .map(|(mut r, _)| {
            r.text = r.text.trim_end().to_string();
            r
        })
        .filter(|r| !r.text.trim().is_empty())
        .collect()
}

struct FontStyle {
    /// Nombre PostScript tal cual (con el prefijo «ABCDEF+» de los subconjuntos).
    base: String,
    family: String,
    embedded: bool,
    bold: bool,
    italic: bool,
    serif: bool,
    mono: bool,
}

impl FontStyle {
    unsafe fn of(b: &Bindings, font: FPDF_FONT) -> FontStyle {
        let base = font_string(|buf, len| b.FPDFFont_GetBaseFontName(font, buf, len));
        let mut family = font_string(|buf, len| b.FPDFFont_GetFamilyName(font, buf, len));
        let plain = base.split_once('+').map_or(base.as_str(), |(_, n)| n);
        if family.is_empty() {
            family = plain.split(['-', ',']).next().unwrap_or("").to_string();
        }
        let flags = b.FPDFFont_GetFlags(font).max(0);
        let has = |words: &[&str]| words.iter().any(|w| plain.to_lowercase().contains(w));
        FontStyle {
            embedded: b.FPDFFont_GetIsEmbedded(font) != 0,
            bold: b.FPDFFont_GetWeight(font) >= 600
                || flags & FLAG_FORCE_BOLD != 0
                || has(&["bold", "black", "heavy", "semibold", "demi"]),
            italic: flags & FLAG_ITALIC != 0 || has(&["italic", "oblique"]),
            serif: flags & FLAG_SERIF != 0
                || has(&["times", "serif", "roman", "georgia", "garamond", "cambria", "book"]) && !has(&["sans"]),
            mono: flags & FLAG_FIXED_PITCH != 0 || has(&["courier", "mono", "consolas"]),
            base,
            family,
        }
    }

    /// Estilo normal de una familia genérica (para el texto nuevo).
    fn generic(serif: bool, mono: bool) -> FontStyle {
        FontStyle {
            base: String::new(),
            family: String::new(),
            embedded: false,
            bold: false,
            italic: false,
            serif,
            mono,
        }
    }

    /// Una de las 14 tipografías estándar de PDF (no hace falta incrustarlas).
    fn standard(&self) -> &'static str {
        match (self.mono, self.serif, self.bold, self.italic) {
            (true, _, false, false) => "Courier",
            (true, _, true, false) => "Courier-Bold",
            (true, _, false, true) => "Courier-Oblique",
            (true, _, true, true) => "Courier-BoldOblique",
            (_, true, false, false) => "Times-Roman",
            (_, true, true, false) => "Times-Bold",
            (_, true, false, true) => "Times-Italic",
            (_, true, true, true) => "Times-BoldItalic",
            (_, _, false, false) => "Helvetica",
            (_, _, true, false) => "Helvetica-Bold",
            (_, _, false, true) => "Helvetica-Oblique",
            (_, _, true, true) => "Helvetica-BoldOblique",
        }
    }

    /// Tipografía de Windows equivalente (para letras fuera de WinAnsi: griego, cirílico…).
    fn system(&self) -> (&'static str, &'static str) {
        let (name, files) = if self.mono {
            ("Courier New", ["cour", "courbd", "couri", "courbi"])
        } else if self.serif {
            ("Times New Roman", ["times", "timesbd", "timesi", "timesbi"])
        } else {
            ("Arial", ["arial", "arialbd", "ariali", "arialbi"])
        };
        (name, files[self.bold as usize + 2 * self.italic as usize])
    }
}

unsafe fn font_string(get: impl Fn(*mut std::os::raw::c_char, usize) -> usize) -> String {
    let len = get(std::ptr::null_mut(), 0);
    if len == 0 {
        return String::new();
    }
    let mut buf = vec![0u8; len];
    get(buf.as_mut_ptr() as _, len);
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// Letras que se pueden escribir con la codificación WinAnsi (la de las tipografías estándar).
fn win_ansi(c: char) -> bool {
    matches!(c, ' '..='~' | '\u{a0}'..='\u{ff}')
        || "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".contains(c)
}

/// Letras de `wanted` que aparecen en algún texto del documento con esa tipografía: esas
/// seguro que están en ella aunque sea un subconjunto.
unsafe fn chars_in_font(b: &Bindings, doc: FPDF_DOCUMENT, base: &str, wanted: &HashSet<char>) -> HashSet<char> {
    let mut found = HashSet::new();
    for index in 0..b.FPDF_GetPageCount(doc) {
        if found.len() == wanted.len() {
            break;
        }
        let page = b.FPDF_LoadPage(doc, index);
        if page.is_null() {
            continue;
        }
        let tp = b.FPDFText_LoadPage(page);
        for p in pieces(b, page, tp) {
            if FontStyle::of(b, p.font).base == base {
                found.extend(p.text.chars().filter(|c| wanted.contains(c)));
            }
        }
        if !tp.is_null() {
            b.FPDFText_ClosePage(tp);
        }
        b.FPDF_ClosePage(page);
    }
    found
}

#[derive(Clone, Copy, PartialEq)]
enum Glyphs {
    Original,
    Fallback,
    /// Espacio que la tipografía original no tiene (habitual en PDF de LaTeX): solo avanza.
    Gap,
}

/// Escribe `text` en lugar del tramo, con los objetos nuevos a partir de la posición `at` o,
/// sin ella, al final de la página. Devuelve un aviso si ha hecho falta otra tipografía.
unsafe fn write_run(
    b: &Bindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    targets: &[&Piece],
    text: &str,
    mut at: Option<usize>,
) -> Result<Option<String>, String> {
    let first = targets[0];
    let style = FontStyle::of(b, first.font);
    let old_text: String = targets.iter().map(|t| t.text.as_str()).collect();
    let old_width = targets.iter().map(|t| t.bounds[2]).fold(f32::MIN, f32::max)
        - targets.iter().map(|t| t.bounds[0]).fold(f32::MAX, f32::min);

    // ¿Qué letras tiene la tipografía original?
    let wanted: HashSet<char> = text.chars().filter(|c| !old_text.contains(*c)).collect();
    let present: HashSet<char> = if style.embedded {
        chars_in_font(b, doc, &style.base, &wanted)
    } else {
        // Sin incrustar, el lector pone una del sistema: vale lo que quepa en WinAnsi.
        wanted.iter().copied().filter(|&c| win_ansi(c)).collect()
    };
    // Los espacios del texto que da PDFium pueden ser huecos entre palabras (TJ) y no letras
    // de la tipografía: si el espacio no tiene anchura, se deja hueco.
    let mut space = 0.0;
    b.FPDFFont_GetGlyphWidth(first.font, ' ' as c_uint, first.tf, &mut space);
    let has = |c: char| (c != ' ' || space > 0.0) && (!wanted.contains(&c) || present.contains(&c));
    let missing: Vec<char> = text.chars().filter(|&c| c != ' ' && !has(c)).collect();

    let kind = |c: char| match (c == ' ', has(c)) {
        (_, true) => Glyphs::Original,
        (true, false) => Glyphs::Gap,
        (false, false) => Glyphs::Fallback,
    };

    // Tipografía de repuesto, solo si hace falta.
    let mut notice = None;
    let mut fallback: FPDF_FONT = std::ptr::null_mut();
    if !missing.is_empty() {
        let (font, name) = if missing.iter().all(|&c| win_ansi(c)) {
            let name = style.standard();
            (b.FPDFText_LoadStandardFont(doc, name), name.split('-').next().unwrap_or(name).to_string())
        } else {
            (load_system_font(b, doc, &style)?, style.system().0.to_string())
        };
        if font.is_null() {
            return Err("No se pudo cargar una tipografía de repuesto".into());
        }
        fallback = font;
        let mut letters: Vec<char> = missing.clone();
        letters.sort_unstable();
        letters.dedup();
        let letters: String = letters.into_iter().collect();
        notice = Some(format!(
            "La tipografía del PDF no tiene «{letters}»: se ha escrito con {name}"
        ));
    }

    // Trozos seguidos con la misma tipografía.
    let mut segments: Vec<(Glyphs, String)> = Vec::new();
    for c in text.chars() {
        let k = kind(c);
        match segments.last_mut() {
            Some((last, s)) if *last == k => s.push(c),
            _ => segments.push((k, c.to_string())),
        }
    }

    let width_of = |font: FPDF_FONT, s: &str| -> f32 {
        s.chars()
            .map(|c| {
                let mut w = 0.0;
                b.FPDFFont_GetGlyphWidth(font, c as c_uint, first.tf, &mut w);
                w
            })
            .sum::<f32>()
            * first.m.a
    };
    let gap = first.tf * 0.25 * first.m.a;
    let widths: Vec<f32> = segments
        .iter()
        .map(|(k, s)| match k {
            Glyphs::Original => width_of(first.font, s),
            Glyphs::Fallback => width_of(fallback, s),
            Glyphs::Gap => gap * s.chars().count() as f32,
        })
        .collect();
    let natural: f32 = widths.iter().sum();
    let squeeze = if old_width > 0.0 && natural > old_width * 1.02 { (old_width / natural).max(MIN_SQUEEZE) } else { 1.0 };

    let mut x = first.m.e;
    for ((k, s), w) in segments.iter().zip(&widths) {
        if *k != Glyphs::Gap {
            let font = if *k == Glyphs::Original { first.font } else { fallback };
            let obj = b.FPDFPageObj_CreateTextObj(doc, font, first.tf);
            if obj.is_null() {
                return Err("No se pudo crear el texto".into());
            }
            let ws = wide(b, s);
            b.FPDFText_SetText(obj, ws.as_ptr() as FPDF_WIDESTRING);
            let [r, g, bl] = first.color;
            b.FPDFPageObj_SetFillColor(obj, r as _, g as _, bl as _, 255);
            if first.mode != TEXTRENDERMODE_FILL {
                b.FPDFTextObj_SetTextRenderMode(obj, first.mode as FPDF_TEXT_RENDERMODE);
            }
            let m = FS_MATRIX { a: first.m.a * squeeze, e: x, ..first.m };
            b.FPDFPageObj_SetMatrix(obj, &m);
            let placed = match at.as_mut() {
                Some(i) => {
                    *i += 1;
                    b.FPDFPage_InsertObjectAtIndex(page, obj, *i - 1)
                }
                None => b.FPDFPage_InsertObject(page, obj),
            };
            if placed == 0 {
                b.FPDFPageObj_Destroy(obj);
                return Err("No se pudo colocar el texto en la página".into());
            }
        }
        x += w * squeeze;
    }
    Ok(notice)
}

#[cfg(test)]
fn runs_of(dll: &Path, pdf: &[u8], page: i32) -> Result<Vec<TextRun>, String> {
    page_content(dll, pdf, page).map(|c| c.runs)
}

#[cfg(test)]
fn edit_text_for_tests(dll: &Path, pdf: &[u8], page: i32, objects: &[i32], text: &str) -> Result<Edited, String> {
    edit_page(dll, pdf, page, &PageEdit::Text { objects: objects.to_vec(), text: text.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dll() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll")
    }

    /// PDF de una página con dos líneas en Helvetica (sin incrustar) creado con PDFium.
    fn sample() -> Vec<u8> {
        let guard = engine(&dll()).unwrap().lock().unwrap();
        let b = &*guard;
        unsafe {
            let doc = b.FPDF_CreateNewDocument();
            let page = b.FPDFPage_New(doc, 0, 595.0, 842.0);
            for (i, line) in ["Hola mundo", "Segunda linea"].iter().enumerate() {
                let obj = b.FPDFPageObj_NewTextObj(doc, "Helvetica", 12.0);
                let w = wide(b, line);
                b.FPDFText_SetText(obj, w.as_ptr() as FPDF_WIDESTRING);
                b.FPDFPageObj_Transform(obj, 1.0, 0.0, 0.0, 1.0, 72.0, 700.0 - 20.0 * i as f64);
                b.FPDFPage_InsertObject(page, obj);
            }
            b.FPDFPage_GenerateContent(page);
            b.FPDF_ClosePage(page);
            let out = save(b, doc).unwrap();
            b.FPDF_CloseDocument(doc);
            out
        }
    }

    #[test]
    fn edits_a_line() {
        let pdf = sample();
        let runs = runs_of(&dll(), &pdf, 0).unwrap();
        assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["Hola mundo", "Segunda linea"]);
        assert!((runs[0].size - 12.0).abs() < 0.01, "{:?}", runs[0]);
        assert!(!runs[0].serif && !runs[0].bold);

        let edited = edit_text_for_tests(&dll(), &pdf, 0, &runs[0].objects, "Adiós, mundo").unwrap();
        assert!(edited.notice.is_none(), "{:?}", edited.notice);
        let after = runs_of(&dll(), &edited.pdf, 0).unwrap();
        let texts: Vec<&str> = after.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["Adiós, mundo", "Segunda linea"]);
        assert!((after[0].baseline - runs[0].baseline).abs() < 0.01);
        // Mismo origen; la caja cambia un poco con el margen de cada letra (H frente a A).
        assert!((after[0].rect[0] - runs[0].rect[0]).abs() < 1.5);

        // Borrar un tramo.
        let removed = edit_text_for_tests(&dll(), &edited.pdf, 0, &after[1].objects, "  ").unwrap();
        let left = runs_of(&dll(), &removed.pdf, 0).unwrap();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn letters_outside_winansi_use_a_system_font() {
        let pdf = sample();
        let runs = runs_of(&dll(), &pdf, 0).unwrap();
        let edited = edit_text_for_tests(&dll(), &pdf, 0, &runs[1].objects, "Línea αβγ").unwrap();
        assert!(edited.notice.as_deref().unwrap_or("").contains("Arial"), "{:?}", edited.notice);
        let after = runs_of(&dll(), &edited.pdf, 0).unwrap();
        let joined: String = after.iter().skip(1).map(|r| r.text.clone()).collect::<Vec<_>>().join(" ");
        assert!(joined.contains("Línea") && joined.contains("αβγ"), "{joined}");
    }

    #[test]
    fn adds_text_images_and_covers() {
        let pdf = sample();
        let added = edit_page(
            &dll(),
            &pdf,
            0,
            &PageEdit::AddText {
                x: 72.0,
                y: 600.0,
                text: "Nuevo\nDos líneas".into(),
                size: 14.0,
                color: [200, 0, 0],
                font: "serif".into(),
            },
        )
        .unwrap();
        let texts: Vec<String> = runs_of(&dll(), &added.pdf, 0).unwrap().into_iter().map(|r| r.text).collect();
        assert!(texts.contains(&"Nuevo".to_string()) && texts.contains(&"Dos líneas".to_string()), "{texts:?}");

        // Imagen PNG de 40×20 px.
        let png = std::env::temp_dir().join("pdfiiuum-test.png");
        image::RgbaImage::from_pixel(40, 20, image::Rgba([0, 128, 255, 128])).save(&png).unwrap();
        let with_image = edit_page(
            &dll(),
            &added.pdf,
            0,
            &PageEdit::AddImage { path: Some(png.to_string_lossy().into()), data: None, center: [300.0, 400.0], max: [500.0, 500.0] },
        )
        .unwrap();
        let content = page_content(&dll(), &with_image.pdf, 0).unwrap();
        assert_eq!(content.images.len(), 1);
        let r = content.images[0].rect;
        assert!(((r[2] - r[0]) - 30.0).abs() < 0.5 && ((r[3] - r[1]) - 15.0).abs() < 0.5, "{r:?}");

        // Moverla y agrandarla.
        let moved = edit_page(
            &dll(),
            &with_image.pdf,
            0,
            &PageEdit::Move { index: content.images[0].index, rect: [100.0, 100.0, 160.0, 130.0] },
        )
        .unwrap();
        let r = page_content(&dll(), &moved.pdf, 0).unwrap().images[0].rect;
        assert!((r[0] - 100.0).abs() < 0.5 && (r[2] - 160.0).abs() < 0.5 && (r[3] - 130.0).abs() < 0.5, "{r:?}");

        // Tapar la primera línea: desaparece su texto.
        let first = runs_of(&dll(), &moved.pdf, 0).unwrap().into_iter().find(|r| r.text == "Hola mundo").unwrap();
        let [x1, y1, x2, y2] = first.rect;
        let covered =
            edit_page(&dll(), &moved.pdf, 0, &PageEdit::Cover { rect: [x1 - 2.0, y1 - 2.0, x2 + 2.0, y2 + 2.0] }).unwrap();
        assert!(covered.notice.is_some());
        assert!(!runs_of(&dll(), &covered.pdf, 0).unwrap().iter().any(|r| r.text == "Hola mundo"));

        // Borrar la imagen.
        let idx = page_content(&dll(), &covered.pdf, 0).unwrap().images[0].index;
        let deleted = edit_page(&dll(), &covered.pdf, 0, &PageEdit::Delete { indices: vec![idx] }).unwrap();
        assert!(page_content(&dll(), &deleted.pdf, 0).unwrap().images.is_empty());
    }

    #[test]
    fn jpeg_is_embedded_as_is() {
        let jpg = std::env::temp_dir().join("pdfiiuum-test.jpg");
        image::RgbImage::from_pixel(200, 100, image::Rgb([200, 30, 30])).save(&jpg).unwrap();
        let size = std::fs::metadata(&jpg).unwrap().len() as usize;
        let out = edit_page(
            &dll(),
            &sample(),
            0,
            &PageEdit::AddImage { path: Some(jpg.to_string_lossy().into()), data: None, center: [300.0, 400.0], max: [100.0, 100.0] },
        )
        .unwrap();
        let r = page_content(&dll(), &out.pdf, 0).unwrap().images[0].rect;
        // 200×100 px son 150×75 pt: se reduce a 100×50 para caber.
        assert!(((r[2] - r[0]) - 100.0).abs() < 0.5 && ((r[3] - r[1]) - 50.0).abs() < 0.5, "{r:?}");
        assert!(out.pdf.windows(9).any(|w| w == b"DCTDecode"), "el JPEG debería ir sin recomprimir");
        assert!(out.pdf.len() < 4000 + size, "{} bytes", out.pdf.len());
    }

    #[test]
    fn rejects_stale_objects() {
        let pdf = sample();
        assert!(edit_text_for_tests(&dll(), &pdf, 0, &[99], "x").is_err());
    }

    /// PDF de una página de 300 × 200 con `content` como contenido, Helvetica (F1) y Times (F2).
    fn pdf_with(content: &[u8]) -> Vec<u8> {
        let objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R               /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>"
                .to_vec(),
            [format!("<< /Length {} >>
stream
", content.len()).as_bytes(), content, b"
endstream"].concat(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>".to_vec(),
        ];
        let mut out = b"%PDF-1.4
".to_vec();
        let mut offsets = Vec::new();
        for (i, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj
", i + 1).as_bytes());
            out.extend(object);
            out.extend(b"
endobj
");
        }
        let xref = out.len();
        out.extend(format!("xref
0 {}
0000000000 65535 f 
", objects.len() + 1).as_bytes());
        for o in offsets {
            out.extend(format!("{o:010} 00000 n 
").as_bytes());
        }
        out.extend(format!("trailer
<< /Size {} /Root 1 0 R >>
startxref
{xref}
%%EOF
", objects.len() + 1).as_bytes());
        out
    }

    fn objects_of(pdf: &[u8]) -> Vec<Shape> {
        let guard = engine(&dll()).unwrap().lock().unwrap();
        unsafe { with_page(&guard, pdf, 0, |_, page, _| Ok(shapes(&guard, page, 0))).unwrap() }
    }

    /// La página pintada a 2 píxeles por punto (BGRA) y su ancho.
    fn render(pdf: &[u8]) -> (Vec<u8>, usize) {
        let guard = engine(&dll()).unwrap().lock().unwrap();
        let b = &*guard;
        unsafe {
            with_page(b, pdf, 0, |_, page, _| {
                let (w, h) = ((b.FPDF_GetPageWidthF(page) * 2.0) as i32, (b.FPDF_GetPageHeightF(page) * 2.0) as i32);
                let bitmap = b.FPDFBitmap_Create(w, h, 1);
                b.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xFFFFFFFF);
                b.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, 0);
                let stride = b.FPDFBitmap_GetStride(bitmap) as usize;
                let buffer = b.FPDFBitmap_GetBuffer(bitmap) as *const u8;
                let mut out = Vec::new();
                for y in 0..h as usize {
                    out.extend_from_slice(std::slice::from_raw_parts(buffer.add(y * stride), w as usize * 4));
                }
                b.FPDFBitmap_Destroy(bitmap);
                Ok((out, w as usize))
            })
            .unwrap()
        }
    }

    /// Corregir una línea no mueve ni cambia nada más de la página: ni el texto con espaciado
    /// entre letras (Tc) y palabras (Tw), ni lo que sigue en la misma línea con otra letra, ni
    /// los colores CMYK, ni las imágenes. (Antes PDFium reescribía el flujo entero y lo perdía.)
    #[test]
    fn editing_a_line_leaves_the_rest_of_the_page_alone() {
        let pdf = pdf_with(
            b"0.2 0 0 0.6 k 20 160 120 20 re f
              BT /F1 12 Tf -0.4 Tc 1.5 Tw 30 130 Td (Primera linea con espaciado) Tj
              0 -20 TD (Segunda linea) Tj /F2 12 Tf ( sigue en Times) Tj
              T* [(Ter) 120 (cera linea)] TJ ET
              q 20 0 0 20 240 20 cm BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\x80\xff\x40 EI Q",
        );
        let runs = runs_of(&dll(), &pdf, 0).unwrap();
        let texts: Vec<&str> = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["Primera linea con espaciado", "Segunda linea", " sigue en Times", "Tercera linea"]);
        let second = &runs[1];
        let before = objects_of(&pdf);

        let edited = edit_text_for_tests(&dll(), &pdf, 0, &second.objects, "Segunda lineas").unwrap();
        assert!(edited.notice.is_none(), "{:?}", edited.notice);
        let after_runs = runs_of(&dll(), &edited.pdf, 0).unwrap();
        let after_texts: Vec<&str> = after_runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(after_texts, ["Primera linea con espaciado", "Segunda lineas", " sigue en Times", "Tercera linea"]);

        // Los demás objetos, en el mismo orden, sitio, tamaño y color; el nuevo, donde estaba.
        let after = objects_of(&edited.pdf);
        assert_eq!(before.len(), after.len());
        let edited_index = second.objects[0] as usize;
        for (k, (old, new)) in before.iter().zip(&after).enumerate() {
            if k == edited_index {
                // Mismo origen (si no cabe se estrecha un poco: cambia la escala horizontal).
                assert_eq!(old.matrix[4..], new.matrix[4..]);
            } else {
                assert!(same_shape(old, new), "objeto {k}: {old:?} → {new:?}");
            }
        }

        // Y se ve igual salvo esa línea (con la letra añadida).
        let ((old, w), (new, _)) = (render(&pdf), render(&edited.pdf));
        let h = old.len() / 4 / w;
        let [x1, y1, x2, y2] = second.rect;
        for (i, (p, q)) in old.chunks(4).zip(new.chunks(4)).enumerate() {
            if p != q {
                let (x, y) = ((i % w) as f32 / 2.0, (h - i / w) as f32 / 2.0);
                assert!(
                    x >= x1 - 1.0 && x <= x2 + second.size && y >= y1 - 2.0 && y <= y2 + 2.0,
                    "ha cambiado ({x}, {y}), fuera de la línea {:?}",
                    second.rect
                );
            }
        }
    }
}

#[cfg(test)]
mod real {
    use super::*;

    /// PDFIIUUM_EDIT_IN=entrada.pdf PDFIIUUM_EDIT_OUT=salida.pdf cargo test real_pdf -- --nocapture
    /// Muestra los tramos de la primera página y corrige el primero.
    #[test]
    fn real_pdf() {
        let (Ok(input), Ok(output)) = (std::env::var("PDFIIUUM_EDIT_IN"), std::env::var("PDFIIUUM_EDIT_OUT")) else {
            eprintln!("PDFIIUUM_EDIT_IN/OUT no definidos; se omite");
            return;
        };
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll");
        let pdf = std::fs::read(input).unwrap();
        let runs = runs_of(&dll, &pdf, 0).unwrap();
        for r in &runs {
            eprintln!("{:?} {:.1}pt {} b={} i={} s={} «{}»", r.objects, r.size, r.family, r.bold, r.italic, r.serif, r.text);
        }
        let first = &runs[0];
        let edited = edit_text_for_tests(&dll, &pdf, 0, &first.objects, &format!("{} (ñ)", first.text)).unwrap();
        eprintln!("aviso: {:?}", edited.notice);
        std::fs::write(output, &edited.pdf).unwrap();
    }
}
