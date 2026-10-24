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
use serde::Serialize;

use crate::pdf_engine::{engine, save, wide, Bindings};

const PAGEOBJ_TEXT: c_int = 1;
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

/// Tramos de texto editables de una página.
pub fn text_runs(dll: &Path, pdf: &[u8], page: i32) -> Result<Vec<TextRun>, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe { with_page(b, pdf, page, |_, page, tp| Ok(group(b, &pieces(b, page, tp)))) }
}

/// Sustituye el texto del tramo formado por `objects` por `text` (vacío = borrarlo).
pub fn edit_text(dll: &Path, pdf: &[u8], page: i32, objects: &[i32], text: &str) -> Result<Edited, String> {
    let guard = engine(dll)?.lock().map_err(|_| "PDFium está bloqueado".to_string())?;
    let b = &*guard;
    unsafe {
        with_page(b, pdf, page, |doc, page, tp| {
            let all = pieces(b, page, tp);
            let targets: Vec<&Piece> = objects.iter().filter_map(|i| all.iter().find(|p| p.index == *i)).collect();
            if targets.len() != objects.len() || targets.is_empty() {
                return Err("El texto ha cambiado mientras se editaba; vuelve a intentarlo".into());
            }
            let notice = if text.trim().is_empty() { None } else { write_run(b, doc, page, &targets, text)? };
            for t in &targets {
                if b.FPDFPage_RemoveObject(page, t.obj) != 0 {
                    b.FPDFPageObj_Destroy(t.obj);
                }
            }
            if b.FPDFPage_GenerateContent(page) == 0 {
                return Err("PDFium no pudo regenerar la página".into());
            }
            Ok(Edited { pdf: save(b, doc)?, notice })
        })
    }
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

/// Escribe `text` en lugar del tramo. Devuelve un aviso si ha hecho falta otra tipografía.
unsafe fn write_run(
    b: &Bindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    targets: &[&Piece],
    text: &str,
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
    let has = |c: char| !wanted.contains(&c) || present.contains(&c);
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
            let (name, file) = style.system();
            let dir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
            let data = std::fs::read(Path::new(&dir).join("Fonts").join(format!("{file}.ttf")))
                .map_err(|e| format!("No se pudo leer la tipografía {name}: {e}"))?;
            (b.FPDFText_LoadFont(doc, data.as_ptr(), data.len() as c_uint, FONT_TRUETYPE, 1), name.to_string())
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
    let mut at = first.index as usize;
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
            if b.FPDFPage_InsertObjectAtIndex(page, obj, at) == 0 {
                b.FPDFPageObj_Destroy(obj);
                return Err("No se pudo colocar el texto en la página".into());
            }
            at += 1;
        }
        x += w * squeeze;
    }
    Ok(notice)
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
        let runs = text_runs(&dll(), &pdf, 0).unwrap();
        assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["Hola mundo", "Segunda linea"]);
        assert!((runs[0].size - 12.0).abs() < 0.01, "{:?}", runs[0]);
        assert!(!runs[0].serif && !runs[0].bold);

        let edited = edit_text(&dll(), &pdf, 0, &runs[0].objects, "Adiós, mundo").unwrap();
        assert!(edited.notice.is_none(), "{:?}", edited.notice);
        let after = text_runs(&dll(), &edited.pdf, 0).unwrap();
        let texts: Vec<&str> = after.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["Adiós, mundo", "Segunda linea"]);
        assert!((after[0].baseline - runs[0].baseline).abs() < 0.01);
        // Mismo origen; la caja cambia un poco con el margen de cada letra (H frente a A).
        assert!((after[0].rect[0] - runs[0].rect[0]).abs() < 1.5);

        // Borrar un tramo.
        let removed = edit_text(&dll(), &edited.pdf, 0, &after[1].objects, "  ").unwrap();
        let left = text_runs(&dll(), &removed.pdf, 0).unwrap();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn letters_outside_winansi_use_a_system_font() {
        let pdf = sample();
        let runs = text_runs(&dll(), &pdf, 0).unwrap();
        let edited = edit_text(&dll(), &pdf, 0, &runs[1].objects, "Línea αβγ").unwrap();
        assert!(edited.notice.as_deref().unwrap_or("").contains("Arial"), "{:?}", edited.notice);
        let after = text_runs(&dll(), &edited.pdf, 0).unwrap();
        let joined: String = after.iter().skip(1).map(|r| r.text.clone()).collect::<Vec<_>>().join(" ");
        assert!(joined.contains("Línea") && joined.contains("αβγ"), "{joined}");
    }

    #[test]
    fn rejects_stale_objects() {
        let pdf = sample();
        assert!(edit_text(&dll(), &pdf, 0, &[99], "x").is_err());
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
        let runs = text_runs(&dll, &pdf, 0).unwrap();
        for r in &runs {
            eprintln!("{:?} {:.1}pt {} b={} i={} s={} «{}»", r.objects, r.size, r.family, r.bold, r.italic, r.serif, r.text);
        }
        let first = &runs[0];
        let edited = edit_text(&dll, &pdf, 0, &first.objects, &format!("{} (ñ)", first.text)).unwrap();
        eprintln!("aviso: {:?}", edited.notice);
        std::fs::write(output, &edited.pdf).unwrap();
    }
}
