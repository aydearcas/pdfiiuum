//! Corrige texto de una página tocando solo sus operadores en el flujo de contenido.
//!
//! `FPDFPage_GenerateContent` reescribe entero cada flujo del que se ha quitado algún objeto
//! y lo hace con pérdidas: se olvida del espaciado entre letras y palabras (Tc, Tw) y de los
//! colores que no son RGB, así que al corregir una línea se movía y cambiaba de color todo lo
//! que compartía flujo con ella. Aquí se borran del flujo original solo los operadores que
//! dibujan el texto corregido y en su sitio se pone el texto nuevo; el resto queda byte a byte
//! igual y se guarda como actualización incremental.

use lopdf::{IncrementalDocument, Object};

/// Como mucho se descomprimen estos bytes de contenido por página.
const MAX_CONTENT: usize = 256 << 20;

/// Objeto de texto de la página según PDFium, en el orden en que aparece en el contenido.
pub struct TextPos {
    /// Origen horizontal (coordenadas de página).
    pub x: f32,
    /// Lo que avanza en la página una unidad de ajuste de TJ (tamaño Tf × escala / 1000).
    pub unit: f32,
}

#[derive(Debug)]
enum Operand {
    Num(f64),
    /// Cadena: ¿está vacía?
    Str(bool),
    Array(Vec<Operand>),
    Other,
}

struct Op<'a> {
    name: &'a [u8],
    /// Operandos con su posición [inicio, fin) en el contenido.
    operands: Vec<(Operand, usize, usize)>,
    start: usize,
    end: usize,
}

fn is_space(c: u8) -> bool {
    matches!(c, 0 | b'\t' | b'\n' | 0x0c | b'\r' | b' ')
}

fn is_delimiter(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
}

enum Token<'a> {
    Operand(Operand),
    Keyword(&'a [u8]),
    /// `]` o `>>`.
    Close,
}

impl<'a> Lexer<'a> {
    fn skip_space(&mut self) {
        while let Some(&c) = self.data.get(self.pos) {
            if is_space(c) {
                self.pos += 1;
            } else if c == b'%' {
                while self.data.get(self.pos).is_some_and(|&c| c != b'\n' && c != b'\r') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn word(&mut self) -> &'a [u8] {
        let start = self.pos;
        while self.data.get(self.pos).is_some_and(|&c| !is_space(c) && !is_delimiter(c)) {
            self.pos += 1;
        }
        &self.data[start..self.pos]
    }

    fn next(&mut self) -> Option<Token<'a>> {
        self.skip_space();
        let c = *self.data.get(self.pos)?;
        Some(match c {
            b'(' => {
                self.pos += 1;
                let (start, mut depth) = (self.pos, 1);
                while let Some(&c) = self.data.get(self.pos) {
                    self.pos += 1;
                    match c {
                        b'\\' => self.pos += 1,
                        b'(' => depth += 1,
                        b')' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                Token::Operand(Operand::Str(self.pos.min(self.data.len()) - start <= 1))
            }
            b'<' if self.data.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                while let Some(t) = self.next() {
                    if matches!(t, Token::Close) {
                        break;
                    }
                }
                Token::Operand(Operand::Other)
            }
            b'<' => {
                self.pos += 1;
                let mut empty = true;
                while let Some(&c) = self.data.get(self.pos) {
                    self.pos += 1;
                    if c == b'>' {
                        break;
                    }
                    empty &= !c.is_ascii_hexdigit();
                }
                Token::Operand(Operand::Str(empty))
            }
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                while let Some(t) = self.next() {
                    match t {
                        Token::Operand(o) => items.push(o),
                        Token::Keyword(_) => items.push(Operand::Other),
                        Token::Close => break,
                    }
                }
                Token::Operand(Operand::Array(items))
            }
            b']' => {
                self.pos += 1;
                Token::Close
            }
            b'>' => {
                self.pos += if self.data.get(self.pos + 1) == Some(&b'>') { 2 } else { 1 };
                Token::Close
            }
            b'/' => {
                self.pos += 1;
                self.word();
                Token::Operand(Operand::Other)
            }
            b')' | b'{' | b'}' => {
                self.pos += 1;
                Token::Operand(Operand::Other)
            }
            b'+' | b'-' | b'.' | b'0'..=b'9' => {
                let w = self.word();
                Token::Operand(Operand::Num(std::str::from_utf8(w).ok().and_then(|s| s.parse().ok()).unwrap_or(0.0)))
            }
            _ => match self.word() {
                b"true" | b"false" | b"null" => Token::Operand(Operand::Other),
                w => Token::Keyword(w),
            },
        })
    }

    /// Salta los datos de una imagen en línea (tras `ID`) hasta su `EI`.
    fn skip_inline_image(&mut self) {
        self.pos += 1;
        while self.pos + 1 < self.data.len() {
            let d = self.data;
            if d[self.pos] == b'E'
                && d[self.pos + 1] == b'I'
                && is_space(d[self.pos - 1])
                && d.get(self.pos + 2).is_none_or(|&c| is_space(c) || is_delimiter(c))
            {
                self.pos += 2;
                return;
            }
            self.pos += 1;
        }
        self.pos = self.data.len();
    }
}

fn operators(data: &[u8]) -> Vec<Op<'_>> {
    let mut lexer = Lexer { data, pos: 0 };
    let mut ops = Vec::new();
    let mut operands = Vec::new();
    loop {
        lexer.skip_space();
        let at = lexer.pos;
        let Some(token) = lexer.next() else { break };
        match token {
            Token::Operand(o) => operands.push((o, at, lexer.pos)),
            Token::Close => {}
            Token::Keyword(name) => {
                if name == b"ID" {
                    lexer.skip_inline_image();
                }
                let start = operands.first().map_or(at, |o| o.1);
                ops.push(Op { name, operands: std::mem::take(&mut operands), start, end: lexer.pos });
            }
        }
    }
    ops
}

/// ¿Dibuja algo el operador? (PDFium no crea objeto para el texto vacío.)
fn shows_text(op: &Op) -> bool {
    match (op.name, op.operands.last()) {
        (b"Tj" | b"'", Some((Operand::Str(empty), ..))) => !empty,
        (b"\"", Some((Operand::Str(empty), ..))) => op.operands.len() == 3 && !empty,
        (b"TJ", Some((Operand::Array(items), ..))) => items.iter().any(|i| matches!(i, Operand::Str(false))),
        _ => false,
    }
}

/// Ajuste de TJ antes de la primera cadena con letras (PDFium lo aplica antes del objeto).
fn initial_kerning(op: &Op) -> f64 {
    match (op.name, op.operands.last()) {
        (b"TJ", Some((Operand::Array(items), ..))) => items
            .iter()
            .take_while(|i| !matches!(i, Operand::Str(false)))
            .map(|i| if let Operand::Num(n) = i { *n } else { 0.0 })
            .sum(),
        _ => 0.0,
    }
}

/// ¿Mueve la posición del texto sin dibujar nada? (TJ solo con números.)
fn only_moves(op: &Op) -> bool {
    match (op.name, op.operands.last()) {
        (b"TJ", Some((Operand::Array(items), ..))) => {
            items.iter().any(|i| matches!(i, Operand::Num(n) if *n != 0.0)) && !shows_text(op)
        }
        _ => false,
    }
}

/// Los `N` últimos operandos, si son números.
fn numbers<const N: usize>(op: &Op) -> Option<[f64; N]> {
    let from = op.operands.len().checked_sub(N)?;
    let mut out = [0.0; N];
    for (k, (o, ..)) in op.operands[from..].iter().enumerate() {
        out[k] = if let Operand::Num(n) = o { *n } else { return None };
    }
    Some(out)
}

/// Matriz [a b c d e f] de PDF.
type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// Primero `m` y luego `n` (lo que hace `m cm` cuando la transformación es `n`).
fn mul(m: Matrix, n: Matrix) -> Matrix {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

fn invert([a, b, c, d, e, f]: Matrix) -> Option<Matrix> {
    let det = a * d - b * c;
    (det.abs() > 1e-12).then(|| [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det])
}

/// `n` con `decimals` decimales como mucho.
fn number(n: f64, decimals: usize) -> String {
    let s = format!("{n:.decimals$}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

fn write_matrix(m: Matrix) -> String {
    m.iter().map(|&n| number(n, 6)).collect::<Vec<_>>().join(" ")
}

/// Cómo queda el contenido tras un operador: transformación, línea de texto y si se está
/// dentro de BT … ET.
#[derive(Clone, Copy)]
struct Place {
    ctm: Matrix,
    /// Último Tm (y dónde están sus operandos) o, sin él, la identidad de BT.
    tm: Matrix,
    tm_src: Option<(usize, usize)>,
    /// Desplazamiento de la línea desde ese Tm, sumado en f32 como hace PDFium.
    line: [f32; 2],
    in_text: bool,
    /// ¿El texto recorta (modo 4 a 7)? Ese recorte se aplica en ET.
    clip: bool,
}

impl Place {
    /// Matriz de la línea de texto.
    fn line_matrix(&self) -> Matrix {
        mul([1.0, 0.0, 0.0, 1.0, self.line[0] as f64, self.line[1] as f64], self.tm)
    }
}

/// Recorre el contenido como PDFium: dónde queda cada operador y cuáles dibujan los objetos
/// de texto (en orden).
fn walk(ops: &[Op]) -> (Vec<Place>, Vec<usize>) {
    // Lo que guardan q y Q: transformación, si hay tipografía, interlineado y modo de texto.
    let mut stack = vec![(IDENTITY, false, 0.0f32, 0.0)];
    let mut text = Place { ctm: IDENTITY, tm: IDENTITY, tm_src: None, line: [0.0; 2], in_text: false, clip: false };
    let mut places = Vec::with_capacity(ops.len());
    let mut shown = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        let state = stack.last_mut().unwrap();
        match op.name {
            b"q" => {
                let copy = *state;
                stack.push(copy);
            }
            b"Q" => {
                if stack.len() > 1 {
                    stack.pop();
                }
            }
            b"cm" => {
                if let Some(m) = numbers::<6>(op) {
                    state.0 = mul(m, state.0);
                }
            }
            b"Tf" => state.1 = true,
            b"Tr" => {
                if let Some([mode]) = numbers::<1>(op) {
                    state.3 = mode;
                }
            }
            b"TL" => {
                if let Some([l]) = numbers::<1>(op) {
                    state.2 = l as f32;
                }
            }
            b"BT" => (text.tm, text.tm_src, text.line, text.in_text) = (IDENTITY, None, [0.0; 2], true),
            b"ET" => text.in_text = false,
            b"Tm" => {
                if let Some(m) = numbers::<6>(op) {
                    let n = op.operands.len();
                    (text.tm, text.tm_src, text.line) = (m, Some((op.operands[n - 6].1, op.operands[n - 1].2)), [0.0; 2]);
                }
            }
            b"Td" | b"TD" => {
                if let Some([x, y]) = numbers::<2>(op) {
                    text.line = [text.line[0] + x as f32, text.line[1] + y as f32];
                    if op.name == b"TD" {
                        state.2 = -(y as f32);
                    }
                }
            }
            b"T*" | b"'" => text.line[1] -= state.2,
            b"\"" if op.operands.len() == 3 => text.line[1] -= state.2,
            _ => {}
        }
        let state = *stack.last().unwrap();
        if state.1 && shows_text(op) {
            shown.push(i);
        }
        places.push(Place { ctm: state.0, clip: state.3 >= 4.0, ..text });
    }
    (places, shown)
}

/// Texto nuevo que va en el sitio del que se quita: lo que PDFium escribió al final de la
/// página.
struct Snippet<'a> {
    bytes: &'a [u8],
    /// Transformación que PDFium supuso al principio de su flujo (la del final del contenido).
    ctm: Matrix,
}

impl<'a> Snippet<'a> {
    fn new(bytes: &'a [u8]) -> Option<Snippet<'a>> {
        // PDFium deshace con «cm» la transformación que deja el contenido antes de su texto.
        let ops = operators(bytes);
        let undo = ops.iter().take_while(|o| o.name != b"BT").find(|o| o.name == b"cm").map(numbers::<6>);
        let ctm = match undo {
            Some(m) => invert(m?)?,
            None => IDENTITY,
        };
        Some(Snippet { bytes, ctm })
    }
}

/// Lo que sustituye al operador `ops[i]`, que dibuja el texto número `ordinal`: nada, salvo
/// el salto de línea de `'` y `"`; el texto nuevo, si se pasa `snippet`; y, si el texto que le
/// sigue en la misma línea depende de dónde acababa este, un `TJ` sin letras que avanza lo mismo.
fn replacement(
    data: &[u8],
    ops: &[Op],
    places: &[Place],
    i: usize,
    ordinal: usize,
    texts: &[TextPos],
    snippet: Option<&Snippet>,
) -> Result<String, String> {
    let op = &ops[i];
    let mut out = match op.name {
        b"'" => " T* ".to_string(),
        b"\"" => {
            let src = |k: usize| String::from_utf8_lossy(&data[op.operands[k].1..op.operands[k].2]).into_owned();
            format!(" {} Tw {} Tc T* ", src(0), src(1))
        }
        _ => " ".to_string(),
    };
    let this = texts.get(ordinal).ok_or("falta un texto")?;
    let place = places[i];
    // Dónde está la posición del texto al seguir (x en la página).
    let mut start = this.x as f64 + initial_kerning(op) * this.unit as f64;
    if let Some(snippet) = snippet {
        // Fuera del objeto de texto, con la transformación que esperaba PDFium y sin el
        // espaciado que tuviera el PDF; luego se vuelve a la línea en la que se estaba.
        let to = mul(snippet.ctm, invert(place.ctm).ok_or("transformación sin inversa")?);
        if place.in_text {
            // Partir el objeto de texto adelantaría el recorte del texto que recorta.
            let begin = ops[..i].iter().rposition(|o| o.name == b"BT").unwrap_or(0);
            let end = ops[i..].iter().position(|o| o.name == b"ET").map_or(ops.len(), |e| i + e);
            if (begin..end).any(|j| places[j].clip && shows_text(&ops[j])) {
                return Err("texto que recorta".into());
            }
            out.push_str("ET ");
        }
        out.push_str(&format!("q {} cm 0 Tc 0 Tw 100 Tz 0 Ts\n", write_matrix(to)));
        out.push_str(&String::from_utf8_lossy(snippet.bytes));
        out.push_str("\nQ ");
        if place.in_text {
            // Igual que estaba: el mismo Tm y lo que se había movido la línea desde él.
            out.push_str("BT ");
            if let Some((from, to)) = place.tm_src {
                out.push_str(&format!("{} Tm ", String::from_utf8_lossy(&data[from..to])));
            }
            if place.line != [0.0; 2] {
                out.push_str(&format!("{} {} Td ", place.line[0], place.line[1]));
            }
            start = mul(place.line_matrix(), place.ctm)[4];
        }
    }
    for later in &ops[i + 1..] {
        match later.name {
            b"BT" | b"ET" | b"Tm" | b"Td" | b"TD" | b"T*" | b"'" | b"\"" => return Ok(out),
            _ if shows_text(later) => {
                let after = texts.get(ordinal + 1).ok_or("falta un texto")?;
                if this.unit.abs() < 1e-6 {
                    return Err("texto sin tamaño".into());
                }
                let advance = after.x as f64 + initial_kerning(later) * after.unit as f64 - start;
                out.push_str(&format!("[{}] TJ ", number(-advance / this.unit as f64, 3)));
                return Ok(out);
            }
            _ if only_moves(later) => return Err("ajuste de TJ sin texto".into()),
            _ => {}
        }
    }
    Ok(out)
}

/// Quita de la página `page` (desde 0) los textos `remove` (su posición entre los objetos de
/// texto de la página, en el orden del contenido); `texts` son todos esos objetos. Si
/// `appended`, el último flujo de la página es el que acaba de escribir PDFium con el texto
/// nuevo, que pasa al sitio del primero que se quita. Devuelve el PDF con una actualización
/// incremental al final.
pub fn replace_text(pdf: &[u8], page: usize, remove: &[usize], texts: &[TextPos], appended: bool) -> Result<Vec<u8>, String> {
    let err = |e: lopdf::Error| e.to_string();
    let mut inc = IncrementalDocument::load_from(pdf).map_err(err)?;
    let prev = inc.get_prev_documents();
    if prev.is_encrypted() || prev.trailer.get(b"Encrypt").is_ok() {
        return Err("documento cifrado".into());
    }
    let page_id = *prev.get_pages().get(&(page as u32 + 1)).ok_or("página no encontrada")?;
    let ids = prev.get_page_contents(page_id);

    // El contenido de la página es la unión de sus flujos (PDFium los lee seguidos).
    let mut data = Vec::new();
    let mut spans = Vec::new();
    for id in &ids {
        let stream = prev.get_object(*id).and_then(Object::as_stream).map_err(err)?;
        let start = data.len();
        data.extend(stream.decompressed_content_with_limit(MAX_CONTENT.saturating_sub(start)).map_err(err)?);
        spans.push(start..data.len());
        data.push(b'\n');
    }
    let ops = operators(&data);
    let (places, shown) = walk(&ops);
    if shown.len() != texts.len() {
        return Err(format!("{} textos en el contenido y {} en PDFium", shown.len(), texts.len()));
    }
    let snippet = match spans.last() {
        Some(last) if appended => Some(Snippet::new(&data[last.clone()]).ok_or("texto nuevo ilegible")?),
        _ => None,
    };

    let mut targets: Vec<(usize, usize)> =
        remove.iter().map(|&o| shown.get(o).map(|&i| (i, o))).collect::<Option<_>>().ok_or("texto fuera de rango")?;
    targets.sort_unstable();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (k, &(i, ordinal)) in targets.iter().enumerate() {
        let snippet = if k == 0 { snippet.as_ref() } else { None };
        edits.push((ops[i].start, ops[i].end, replacement(&data, &ops, &places, i, ordinal, texts, snippet)?));
    }

    // Cada cambio, en el flujo o los flujos que toca (un operador puede quedar a caballo).
    let mut changed: Vec<Option<Vec<u8>>> = vec![None; ids.len()];
    for (start, end, text) in edits.iter().rev() {
        let mut text = Some(text.as_str());
        for (s, span) in spans.iter().enumerate().rev() {
            let (from, to) = ((*start).max(span.start), (*end).min(span.end));
            if from >= to && !span.contains(start) {
                continue;
            }
            let bytes = changed[s].get_or_insert_with(|| data[span.clone()].to_vec());
            let insert = if span.contains(start) { text.take().unwrap_or("") } else { "" };
            bytes.splice(from - span.start..to.max(from) - span.start, insert.bytes());
        }
        if text.is_some() {
            return Err("cambio fuera del contenido".into());
        }
    }

    // Flujos nuevos (el original puede compartirse con otras páginas) y la página apuntando a ellos.
    let mut contents: Vec<Object> = Vec::new();
    for (s, &id) in ids.iter().enumerate() {
        if snippet.is_some() && s == ids.len() - 1 {
            continue;
        }
        let Some(bytes) = changed[s].take() else {
            contents.push(Object::Reference(id));
            continue;
        };
        let old = inc.get_prev_documents().get_object(id).and_then(Object::as_stream).map_err(err)?;
        let mut dict = old.dict.clone();
        for key in [&b"Filter"[..], b"DecodeParms", b"Length"] {
            dict.remove(key);
        }
        let mut stream = lopdf::Stream::new(dict, bytes);
        stream.compress().map_err(err)?;
        contents.push(Object::Reference(inc.new_document.add_object(stream)));
    }
    inc.opt_clone_object_to_new_document(page_id).map_err(err)?;
    inc.new_document
        .get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .map_err(err)?
        .set("Contents", Object::Array(contents));

    let mut out = Vec::with_capacity(pdf.len() + data.len() / 2);
    inc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_text_operators() {
        let data = b"BT /F1 12 Tf 72 700 Td (Hola) Tj [(mu) -20 (ndo)] TJ () Tj [<>] TJ 0 -14 TD 1 2 (x) \" ET \
                     BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\x01 EI Q";
        let ops = operators(data);
        let names: Vec<&[u8]> = ops.iter().map(|o| o.name).collect();
        assert_eq!(
            names,
            [&b"BT"[..], b"Tf", b"Td", b"Tj", b"TJ", b"Tj", b"TJ", b"TD", b"\"", b"ET", b"BI", b"ID", b"Q"]
        );
        let (places, shown) = walk(&ops);
        assert_eq!(shown, [3, 4, 8]);
        assert_eq!(&data[ops[3].start..ops[3].end], b"(Hola) Tj");
        // Tras «0 -14 TD» y el salto de línea de «"» (interlineado 14).
        assert_eq!(places[8].line_matrix(), [1.0, 0.0, 0.0, 1.0, 72.0, 672.0]);
    }

    #[test]
    fn keeps_the_advance_of_text_in_the_middle_of_a_line() {
        let data = b"BT /F1 10 Tf 0 0 Td [-50 (ab)] TJ /F2 10 Tf (cd) Tj ET";
        let ops = operators(data);
        let (places, _) = walk(&ops);
        // «ab» empieza en 1 (0 + 50 × 0,02) y «cd» en 21: avanzaba 21.
        let texts = [TextPos { x: 1.0, unit: 0.02 }, TextPos { x: 21.0, unit: 0.02 }];
        assert_eq!(replacement(data, &ops, &places, 3, 0, &texts, None).unwrap(), " [-1050] TJ ");
        // Al final de la línea no hace falta nada.
        assert_eq!(replacement(data, &ops, &places, 5, 1, &texts, None).unwrap(), " ");
        // Con el texto nuevo en medio, se vuelve al principio de la línea y se avanza hasta «cd».
        let snippet = Snippet::new(b"q BT (x) Tj ET Q").unwrap();
        assert_eq!(
            replacement(data, &ops, &places, 3, 0, &texts, Some(&snippet)).unwrap(),
            " ET q 1 0 0 1 0 0 cm 0 Tc 0 Tw 100 Tz 0 Ts\nq BT (x) Tj ET Q\nQ BT [-1050] TJ "
        );
    }
}
