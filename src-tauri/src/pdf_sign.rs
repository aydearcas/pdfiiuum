//! Firma digital con certificado (PAdES B-B, ETSI.CAdES.detached).
//!
//! La firma se añade como una actualización incremental: lo que había en el PDF queda tal cual
//! y detrás van el campo de firma, su apariencia (si es visible) y el diccionario /Sig con el
//! CMS. El certificado y la clave los pone `Key` (el almacén de Windows en `cert_store`).

use lopdf::{Dictionary, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use sha2::{Digest, Sha256};

/// Clave privada con su certificado (la firma la hace Windows: tarjeta, DNIe o archivo).
pub trait Key {
    /// Certificado del firmante (DER).
    fn certificate(&self) -> &[u8];
    /// Resto de la cadena hasta la raíz (DER), para que quien verifique no tenga que buscarla.
    fn chain(&self) -> &[Vec<u8>];
    /// Firma un resumen SHA-256: RSA PKCS#1 v1.5, o ECDSA ya en DER.
    fn sign_digest(&self, digest: &[u8; 32]) -> Result<Vec<u8>, String>;
}

/// Sello visible en una página.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Seal {
    /// Página, desde 0.
    pub page: u32,
    /// Rectángulo en el espacio de usuario del PDF (y hacia arriba).
    pub rect: [f32; 4],
    /// Fecha y hora tal como se muestran en el sello.
    pub date_text: String,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct SignOptions {
    /// Fecha de la firma en formato PDF («D:20261109123456+01'00'»).
    pub date: String,
    /// Sin sello, la firma es invisible (solo aparece en el panel de firmas del lector).
    pub seal: Option<Seal>,
}

/// Petición de firma desde la interfaz: el certificado (huella SHA-1) y las opciones.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct SignRequest {
    pub cert: String,
    #[serde(flatten)]
    pub opts: SignOptions,
}

pub const ENCRYPTED_ERROR: &str = "No se pueden firmar con certificado los PDF protegidos con contraseña";

// ---------- DER ----------

fn der_len(n: usize, out: &mut Vec<u8>) {
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes = (n as u64).to_be_bytes();
        let skip = bytes.iter().position(|&b| b != 0).unwrap_or(7);
        out.push(0x80 | (8 - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 6);
    out.push(tag);
    der_len(content.len(), &mut out);
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

/// SET OF en DER: los elementos ordenados por su codificación.
fn set_of(mut parts: Vec<Vec<u8>>) -> Vec<u8> {
    parts.sort();
    tlv(0x31, &parts.concat())
}

fn oid(dotted: &str) -> Vec<u8> {
    let n: Vec<u64> = dotted.split('.').map(|p| p.parse().expect("OID")).collect();
    let mut body = vec![(n[0] * 40 + n[1]) as u8];
    for &v in &n[2..] {
        let mut chunk = vec![(v & 0x7f) as u8];
        let mut v = v >> 7;
        while v > 0 {
            chunk.push(0x80 | (v & 0x7f) as u8);
            v >>= 7;
        }
        chunk.reverse();
        body.extend(chunk);
    }
    tlv(0x06, &body)
}

/// INTEGER a partir de un número sin signo en big-endian.
fn unsigned_int(bytes: &[u8]) -> Vec<u8> {
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len().saturating_sub(1));
    let mut body = Vec::with_capacity(bytes.len() + 1);
    if bytes.get(start).is_some_and(|&b| b & 0x80 != 0) {
        body.push(0);
    }
    body.extend_from_slice(&bytes[start.min(bytes.len())..]);
    if body.is_empty() {
        body.push(0);
    }
    tlv(0x02, &body)
}

/// Lee un TLV: (etiqueta, contenido, TLV completo, resto).
fn read(data: &[u8]) -> Option<(u8, &[u8], &[u8], &[u8])> {
    let tag = *data.first()?;
    let first = *data.get(1)? as usize;
    let (len, head) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *data.get(2 + i)? as usize;
        }
        (len, 2 + n)
    };
    let end = head.checked_add(len)?;
    if end > data.len() {
        return None;
    }
    Some((tag, &data[head..end], &data[..end], &data[end..]))
}

/// Firma ECDSA de Windows (r‖s) a ECDSA-Sig-Value en DER.
pub fn ecdsa_der(raw: &[u8]) -> Vec<u8> {
    let (r, s) = raw.split_at(raw.len() / 2);
    seq(&[&unsigned_int(r), &unsigned_int(s)])
}

const OID_DATA: &str = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
const OID_SHA256: &str = "2.16.840.1.101.3.4.2.1";
const OID_RSA: &str = "1.2.840.113549.1.1.1";
const OID_SHA256_RSA: &str = "1.2.840.113549.1.1.11";
const OID_EC: &str = "1.2.840.10045.2.1";
const OID_ECDSA_SHA256: &str = "1.2.840.10045.4.3.2";
const OID_CONTENT_TYPE: &str = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
const OID_SIGNING_CERT_V2: &str = "1.2.840.113549.1.9.16.2.47";

/// Lo que hace falta del certificado: emisor y número de serie (TLV) y el tipo de clave.
pub struct CertParts<'a> {
    pub issuer: &'a [u8],
    pub serial: &'a [u8],
    pub key_oid: Vec<u8>,
}

pub fn cert_parts(der: &[u8]) -> Option<CertParts<'_>> {
    let (_, cert, _, _) = read(der)?;
    let (_, tbs, _, _) = read(cert)?;
    let mut r = tbs;
    let (tag, _, _, rest) = read(r)?;
    if tag == 0xA0 {
        r = rest; // versión
    }
    let (_, _, serial, rest) = read(r)?;
    let (_, _, _, rest) = read(rest)?; // algoritmo de la firma del certificado
    let (_, _, issuer, rest) = read(rest)?;
    let (_, _, _, rest) = read(rest)?; // validez
    let (_, _, _, rest) = read(rest)?; // sujeto
    let (_, spki, _, _) = read(rest)?;
    let (_, alg, _, _) = read(spki)?;
    let (_, _, key_oid, _) = read(alg)?;
    Some(CertParts { issuer, serial, key_oid: key_oid.to_vec() })
}

fn attribute(kind: &str, value: Vec<u8>) -> Vec<u8> {
    seq(&[&oid(kind), &set_of(vec![value])])
}

/// CMS SignedData separado (CAdES-BES, como pide PAdES B-B: sin signing-time, la hora va en /M).
pub fn cms(digest: &[u8; 32], key: &dyn Key) -> Result<Vec<u8>, String> {
    let cert = key.certificate();
    let parts = cert_parts(cert).ok_or("No se ha podido leer el certificado")?;
    let sig_alg = if parts.key_oid == oid(OID_RSA) {
        seq(&[&oid(OID_SHA256_RSA), &[0x05, 0x00]])
    } else if parts.key_oid == oid(OID_EC) {
        seq(&[&oid(OID_ECDSA_SHA256)])
    } else {
        return Err("El certificado usa un tipo de clave que pdfiiuum no sabe firmar (solo RSA y ECDSA)".into());
    };
    let sha256 = seq(&[&oid(OID_SHA256)]);
    let cert_hash: [u8; 32] = Sha256::digest(cert).into();
    // SigningCertificateV2 { [ ESSCertIDv2 { certHash, IssuerSerial { [4] emisor, serie } } ] }
    let issuer_serial = seq(&[&seq(&[&tlv(0xA4, parts.issuer)]), parts.serial]);
    let signing_cert = seq(&[&seq(&[&seq(&[&tlv(0x04, &cert_hash), &issuer_serial])])]);
    let attrs = set_of(vec![
        attribute(OID_CONTENT_TYPE, oid(OID_DATA)),
        attribute(OID_MESSAGE_DIGEST, tlv(0x04, digest)),
        attribute(OID_SIGNING_CERT_V2, signing_cert),
    ]);
    let to_sign: [u8; 32] = Sha256::digest(&attrs).into();
    let signature = key.sign_digest(&to_sign)?;
    // En SignerInfo los atributos van como [0] IMPLICIT; se firma su codificación como SET.
    let mut signed_attrs = attrs;
    signed_attrs[0] = 0xA0;
    let signer = seq(&[
        &unsigned_int(&[1]),
        &seq(&[parts.issuer, parts.serial]),
        &sha256,
        &signed_attrs,
        &sig_alg,
        &tlv(0x04, &signature),
    ]);
    let mut certs = cert.to_vec();
    for c in key.chain() {
        certs.extend_from_slice(c);
    }
    let signed_data = seq(&[
        &unsigned_int(&[1]),
        &set_of(vec![sha256.clone()]),
        &seq(&[&oid(OID_DATA)]),
        &tlv(0xA0, &certs),
        &set_of(vec![signer]),
    ]);
    Ok(seq(&[&oid(OID_SIGNED_DATA), &tlv(0xA0, &signed_data)]))
}

/// Nombre (CN) del titular, para el sello y /Name.
pub fn subject_name(der: &[u8]) -> Option<String> {
    let (_, cert, _, _) = read(der)?;
    let (_, tbs, _, _) = read(cert)?;
    let mut r = tbs;
    let (tag, _, _, rest) = read(r)?;
    if tag == 0xA0 {
        r = rest;
    }
    for _ in 0..4 {
        r = read(r)?.3; // serie, algoritmo, emisor, validez
    }
    let (_, mut rdns, _, _) = read(r)?;
    let cn = oid("2.5.4.3");
    let mut found = None;
    while let Some((_, rdn, _, rest)) = read(rdns) {
        rdns = rest;
        let mut atvs = rdn;
        while let Some((_, atv, _, more)) = read(atvs) {
            atvs = more;
            let (_, _, kind, value) = read(atv)?;
            if kind == cn.as_slice() {
                let (tag, text, _, _) = read(value)?;
                found = Some(match tag {
                    0x1E => {
                        let units: Vec<u16> = text.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                        String::from_utf16_lossy(&units)
                    }
                    _ => String::from_utf8_lossy(text).into_owned(),
                });
            }
        }
    }
    found
}

// ---------- PDF ----------

/// Cadena de texto PDF: ASCII tal cual; si no, UTF-16BE con BOM.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for u in s.encode_utf16() {
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

/// Anchos de Helvetica (milésimas) de « » a «~».
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584,
];

/// Texto en WinAnsi (lo que no está, «?») y su ancho en milésimas de Helvetica.
fn win_ansi(s: &str) -> (Vec<u8>, u32) {
    let mut bytes = Vec::with_capacity(s.len());
    let mut width = 0u32;
    for c in s.chars() {
        let b = match c as u32 {
            0x20..=0x7E | 0xA0..=0xFF => c as u32 as u8,
            0x20AC => 0x80,
            0x2013 => 0x96,
            0x2014 => 0x97,
            0x2019 => 0x92,
            _ => b'?',
        };
        width += match b {
            0x20..=0x7E => HELVETICA[(b - 0x20) as usize] as u32,
            0xC0..=0xDF => 722, // mayúsculas con tilde
            _ => 556,
        };
        bytes.push(b);
    }
    (bytes, width)
}

fn pdf_literal(bytes: &[u8]) -> String {
    let mut out = String::from("(");
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(b as char);
            }
            0x20..=0x7E => out.push(b as char),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push(')');
    out
}

/// Parte un nombre largo en dos líneas por el espacio más cercano a la mitad.
fn split_name(name: &str) -> Vec<String> {
    let mid = name.len() / 2;
    let best = name
        .char_indices()
        .filter(|&(_, c)| c == ' ')
        .min_by_key(|&(i, _)| i.abs_diff(mid))
        .map(|(i, _)| i);
    match best {
        Some(i) => vec![name[..i].trim().to_string(), name[i..].trim().to_string()],
        None => vec![name.to_string()],
    }
}

/// Contenido del sello, en un cuadro de `w`×`h` puntos derecho tal como se ve.
pub fn seal_content(name: &str, date_text: &str, w: f32, h: f32) -> Vec<u8> {
    let pad = (h * 0.1).clamp(2.0, 6.0);
    let fit = |lines: &[String]| {
        let widest = lines.iter().map(|l| win_ansi(l).1).max().unwrap_or(1).max(1) as f32 / 1000.0;
        ((w - 2.0 * pad - 3.0) / widest).min((h - 2.0 * pad) / (lines.len() as f32 * 1.2)).min(11.0)
    };
    let mut lines = vec!["Firmado digitalmente por".to_string(), name.to_string(), format!("Fecha: {date_text}")];
    let mut size = fit(&lines);
    if size < 7.0 {
        let mut split = vec![lines[0].clone()];
        split.extend(split_name(name));
        split.push(lines[2].clone());
        let s = fit(&split);
        if s > size {
            lines = split;
            size = s;
        }
    }
    let leading = size * 1.2;
    let top = h / 2.0 + leading * lines.len() as f32 / 2.0 - size;
    // Marco azul con una franja a la izquierda, y el texto.
    let mut out = format!(
        "q 0.12 0.25 0.6 RG 0.12 0.25 0.6 rg 0.8 w 0.4 0.4 {:.2} {:.2} re S 0.4 0.4 2.4 {:.2} re f Q\n",
        w - 0.8,
        h - 0.8,
        h - 0.8,
    );
    out.push_str(&format!("BT 0.1 0.1 0.1 rg /F1 {size:.2} Tf {leading:.2} TL {:.2} {top:.2} Td\n", pad + 3.0));
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push_str("T*\n");
        }
        out.push_str(&pdf_literal(&win_ansi(line).0));
        out.push_str(" Tj\n");
    }
    out.push_str("ET\n");
    out.into_bytes()
}

/// Giro de la página (0, 90, 180 o 270), heredado de sus padres.
fn page_rotation(doc: &lopdf::Document, page: ObjectId) -> i64 {
    let mut id = Some(page);
    for _ in 0..32 {
        let Some(dict) = id.and_then(|i| doc.get_dictionary(i).ok()) else { break };
        if let Ok(r) = dict.get(b"Rotate").and_then(Object::as_i64) {
            return r.rem_euclid(360) / 90 * 90;
        }
        id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }
    0
}

/// Añade `field` al final de un array que puede estar en el diccionario o en un objeto aparte.
fn push_to_array(inc: &mut IncrementalDocument, owner: ObjectId, key: &[u8], field: ObjectId) -> Result<(), String> {
    let err = |e: lopdf::Error| e.to_string();
    inc.opt_clone_object_to_new_document(owner).map_err(err)?;
    let current = inc.new_document.get_dictionary(owner).map_err(err)?.get(key).ok().cloned();
    match current {
        Some(Object::Reference(array_id)) if inc.get_prev_documents().get_object(array_id).and_then(Object::as_array).is_ok() => {
            inc.opt_clone_object_to_new_document(array_id).map_err(err)?;
            inc.new_document.get_object_mut(array_id).and_then(Object::as_array_mut).map_err(err)?.push(Object::Reference(field));
        }
        Some(Object::Array(mut items)) => {
            items.push(Object::Reference(field));
            inc.new_document.get_dictionary_mut(owner).map_err(err)?.set(key, Object::Array(items));
        }
        _ => {
            inc.new_document.get_dictionary_mut(owner).map_err(err)?.set(key, Object::Array(vec![Object::Reference(field)]));
        }
    }
    Ok(())
}

/// Nombres de los campos que ya hay en el formulario (primer nivel).
fn field_names(doc: &lopdf::Document, acroform: &Dictionary) -> Vec<Vec<u8>> {
    let fields = match acroform.get(b"Fields") {
        Ok(Object::Reference(id)) => doc.get_object(*id).and_then(Object::as_array).cloned().unwrap_or_default(),
        Ok(Object::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    fields
        .iter()
        .filter_map(|f| f.as_reference().ok().and_then(|id| doc.get_dictionary(id).ok()))
        .filter_map(|d| d.get(b"T").and_then(Object::as_str).ok().map(<[u8]>::to_vec))
        .collect()
}

/// Bytes reservados para el CMS: los certificados, la firma y margen.
fn reserve_for(key: &dyn Key) -> usize {
    let certs: usize = key.certificate().len() + key.chain().iter().map(Vec::len).sum::<usize>();
    (certs + 6000).div_ceil(1024) * 1024
}

/// Valor de relleno de /ByteRange: 10 cifras, se sustituye por los números reales.
const BYTE_RANGE_PLACEHOLDER: i64 = 9_999_999_999;

/// Firma el PDF: devuelve el original con la firma añadida detrás.
pub fn sign_pdf(pdf: &[u8], key: &dyn Key, opts: &SignOptions) -> Result<Vec<u8>, String> {
    let err = |e: lopdf::Error| e.to_string();
    if !opts.date.starts_with("D:") || opts.date.len() > 40 {
        return Err("Fecha de firma no válida".into());
    }
    let mut inc = IncrementalDocument::load_from(pdf).map_err(|e| format!("No se ha podido leer el PDF: {e}"))?;
    let prev = inc.get_prev_documents();
    if prev.is_encrypted() || prev.trailer.get(b"Encrypt").is_ok() {
        return Err(ENCRYPTED_ERROR.into());
    }
    let root = prev.trailer.get(b"Root").and_then(Object::as_reference).map_err(|_| "El PDF no tiene catálogo".to_string())?;
    let pages = prev.get_pages();
    let page_no = opts.seal.as_ref().map_or(0, |s| s.page);
    let page_id = *pages.get(&(page_no + 1)).ok_or("Página no encontrada")?;
    let rotation = page_rotation(prev, page_id);

    // Formulario: puede estar dentro del catálogo o en un objeto aparte.
    let catalog = prev.get_dictionary(root).map_err(err)?;
    let acroform_ref = catalog.get(b"AcroForm").and_then(Object::as_reference).ok();
    let acroform = match acroform_ref {
        Some(id) => prev.get_dictionary(id).ok().cloned(),
        None => catalog.get(b"AcroForm").and_then(Object::as_dict).ok().cloned(),
    };
    let names = acroform.as_ref().map(|af| field_names(prev, af)).unwrap_or_default();
    let field_name = (1..).map(|n| format!("Firma{n}")).find(|n| !names.iter().any(|t| t == n.as_bytes())).unwrap();

    let signer = subject_name(key.certificate()).unwrap_or_else(|| "Firmante".into());
    let reserve = reserve_for(key);

    // Diccionario de la firma: /ByteRange antes de /Contents (así se encuentran al rellenarlos).
    let mut sig = Dictionary::new();
    sig.set("Type", Object::Name(b"Sig".to_vec()));
    sig.set("Filter", Object::Name(b"Adobe.PPKLite".to_vec()));
    sig.set("SubFilter", Object::Name(b"ETSI.CAdES.detached".to_vec()));
    sig.set("M", Object::String(opts.date.as_bytes().to_vec(), StringFormat::Literal));
    sig.set("Name", text_string(&signer));
    sig.set("ByteRange", Object::Array(vec![Object::Integer(0), Object::Integer(BYTE_RANGE_PLACEHOLDER), Object::Integer(BYTE_RANGE_PLACEHOLDER), Object::Integer(BYTE_RANGE_PLACEHOLDER)]));
    sig.set("Contents", Object::String(vec![0; reserve], StringFormat::Hexadecimal));
    let sig_id = inc.new_document.add_object(sig);

    // Apariencia: vacía si la firma es invisible; si no, el sello derecho tal como se ve la página.
    let (rect, ap) = match &opts.seal {
        Some(seal) => {
            let [x1, y1, x2, y2] = seal.rect;
            let rect = [x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)];
            let (rw, rh) = (rect[2] - rect[0], rect[3] - rect[1]);
            if !(rw >= 10.0 && rh >= 5.0 && rw.is_finite() && rh.is_finite()) {
                return Err("El sello de la firma es demasiado pequeño".into());
            }
            let (w, h) = if rotation % 180 == 0 { (rw, rh) } else { (rh, rw) };
            // /Rotate gira la página en el sentido de las agujas del reloj: el sello, al revés.
            let matrix: [i64; 4] = match rotation {
                90 => [0, 1, -1, 0],
                180 => [-1, 0, 0, -1],
                270 => [0, -1, 1, 0],
                _ => [1, 0, 0, 1],
            };
            let mut font = Dictionary::new();
            font.set("Type", Object::Name(b"Font".to_vec()));
            font.set("Subtype", Object::Name(b"Type1".to_vec()));
            font.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
            font.set("Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
            let mut dict = Dictionary::new();
            dict.set("Type", Object::Name(b"XObject".to_vec()));
            dict.set("Subtype", Object::Name(b"Form".to_vec()));
            dict.set("BBox", Object::Array(vec![0.into(), 0.into(), Object::Real(w), Object::Real(h)]));
            dict.set("Matrix", Object::Array(matrix.iter().map(|&v| Object::Integer(v)).chain([0.into(), 0.into()]).collect()));
            dict.set("Resources", Object::Dictionary(Dictionary::from_iter([("Font", Object::Dictionary(Dictionary::from_iter([("F1", Object::Dictionary(font))])))])));
            let stream = Stream::new(dict, seal_content(&signer, &seal.date_text, w, h));
            (rect, inc.new_document.add_object(stream))
        }
        None => {
            let mut dict = Dictionary::new();
            dict.set("Type", Object::Name(b"XObject".to_vec()));
            dict.set("Subtype", Object::Name(b"Form".to_vec()));
            dict.set("BBox", Object::Array(vec![0.into(), 0.into(), 0.into(), 0.into()]));
            ([0.0; 4], inc.new_document.add_object(Stream::new(dict, Vec::new())))
        }
    };

    // Campo de firma y su widget en el mismo diccionario.
    let mut field = Dictionary::new();
    field.set("Type", Object::Name(b"Annot".to_vec()));
    field.set("Subtype", Object::Name(b"Widget".to_vec()));
    field.set("FT", Object::Name(b"Sig".to_vec()));
    field.set("T", Object::String(field_name.into_bytes(), StringFormat::Literal));
    field.set("V", Object::Reference(sig_id));
    field.set("F", Object::Integer(132)); // imprimir + bloqueada
    field.set("P", Object::Reference(page_id));
    field.set("Rect", Object::Array(rect.iter().map(|&v| Object::Real(v)).collect()));
    field.set("AP", Object::Dictionary(Dictionary::from_iter([("N", Object::Reference(ap))])));
    let field_id = inc.new_document.add_object(field);

    push_to_array(&mut inc, page_id, b"Annots", field_id)?;
    match acroform_ref {
        Some(af) if acroform.is_some() => {
            push_to_array(&mut inc, af, b"Fields", field_id)?;
            inc.new_document.get_dictionary_mut(af).map_err(err)?.set("SigFlags", Object::Integer(3));
        }
        _ => {
            let mut af = acroform.unwrap_or_default();
            let mut fields = match af.get(b"Fields") {
                Ok(Object::Array(a)) => a.clone(),
                Ok(Object::Reference(id)) => inc.get_prev_documents().get_object(*id).and_then(Object::as_array).cloned().unwrap_or_default(),
                _ => Vec::new(),
            };
            fields.push(Object::Reference(field_id));
            af.set("Fields", Object::Array(fields));
            af.set("SigFlags", Object::Integer(3));
            inc.opt_clone_object_to_new_document(root).map_err(err)?;
            inc.new_document.get_dictionary_mut(root).map_err(err)?.set("AcroForm", Object::Dictionary(af));
        }
    }

    let mut out = Vec::with_capacity(pdf.len() + reserve * 2 + 8192);
    inc.save_to(&mut out).map_err(|e| e.to_string())?;
    if !out.starts_with(pdf) {
        return Err("La firma no ha conservado el PDF original".into());
    }

    // Huecos de /Contents y /ByteRange en lo escrito.
    let mut hole = Vec::with_capacity(reserve * 2 + 2);
    hole.push(b'<');
    hole.resize(reserve * 2 + 1, b'0');
    hole.push(b'>');
    let start = find_last(&out[pdf.len()..], &hole).ok_or("No se ha encontrado el hueco de la firma")? + pdf.len();
    let end = start + hole.len();
    let br_key = find_last(&out[pdf.len()..start], b"/ByteRange").ok_or("No se ha encontrado /ByteRange")? + pdf.len();
    let open = br_key + out[br_key..start].iter().position(|&b| b == b'[').ok_or("/ByteRange ilegible")?;
    let close = open + out[open..start].iter().position(|&b| b == b']').ok_or("/ByteRange ilegible")?;
    let ranges = format!("0 {start} {end} {}", out.len() - end);
    let slot = close - open - 1;
    if ranges.len() > slot {
        return Err("/ByteRange no cabe".into());
    }
    out[open + 1..close].copy_from_slice(format!("{ranges:<slot$}").as_bytes());

    let mut hasher = Sha256::new();
    hasher.update(&out[..start]);
    hasher.update(&out[end..]);
    let digest: [u8; 32] = hasher.finalize().into();
    let cms = cms(&digest, key)?;
    if cms.len() > reserve {
        return Err("La firma no cabe en el espacio reservado".into());
    }
    let hex: String = cms.iter().map(|b| format!("{b:02X}")).collect();
    out[start + 1..start + 1 + hex.len()].copy_from_slice(hex.as_bytes());
    Ok(out)
}

fn find_last(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).rev().find(|&i| &hay[i..i + needle.len()] == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn der_basics() {
        assert_eq!(oid(OID_SHA256), [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
        assert_eq!(unsigned_int(&[0x00, 0x80]), [0x02, 0x02, 0x00, 0x80]);
        assert_eq!(unsigned_int(&[0x00, 0x00, 0x05]), [0x02, 0x01, 0x05]);
        assert_eq!(tlv(0x04, &[0; 200])[..3], [0x04, 0x81, 200]);
        let big = tlv(0x04, &[0; 300]);
        assert_eq!(big[..4], [0x04, 0x82, 0x01, 0x2C]);
        let (tag, content, whole, rest) = read(&[big.as_slice(), &[1, 2]].concat()).map(|(t, c, w, r)| (t, c.len(), w.len(), r.to_vec())).unwrap();
        assert_eq!((tag, content, whole, rest), (0x04, 300, 304, vec![1, 2]));
        assert_eq!(ecdsa_der(&[0x80, 0x01, 0x00, 0x02]), [0x30, 0x08, 0x02, 0x03, 0x00, 0x80, 0x01, 0x02, 0x01, 0x02]);
    }

    #[test]
    fn seal_text_fits_and_splits_long_names() {
        let short = String::from_utf8(seal_content("ANA PÉREZ", "09/11/2026 12:00", 200.0, 56.0)).unwrap();
        assert_eq!(short.matches(" Tj").count(), 3);
        assert!(short.contains("(ANA P\\311REZ) Tj"));
        let long = "APELLIDOMUYLARGO OTROAPELLIDOLARGO NOMBRECOMPUESTO MÁS - 12345678Z";
        let text = String::from_utf8(seal_content(long, "09/11/2026 12:00", 150.0, 50.0)).unwrap();
        assert_eq!(text.matches(" Tj").count(), 4);
    }
}
