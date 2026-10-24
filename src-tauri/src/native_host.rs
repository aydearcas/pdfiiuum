//! Puente con la extensión del navegador («Abrir en pdfiiuum»).
//!
//! Edge y Chrome arrancan `pdfiiuum.exe chrome-extension://<id>/` con la entrada y la salida
//! estándar conectadas a la extensión («native messaging»): cada mensaje es un JSON precedido
//! de su longitud (4 bytes, little-endian). La extensión descarga el PDF con la sesión del
//! navegador y lo manda por trozos; aquí se guarda en Descargas y se abre en la app.
//!
//! Mensajes de la extensión:
//! - `{"type":"begin","name":"x.pdf","size":123}`, luego `{"type":"chunk","data":"<base64>"}`
//!   las veces que haga falta y `{"type":"end"}`.
//! - `{"type":"path","path":"C:\\…\\x.pdf"}` para un PDF local (`file://`): se abre tal cual.
//!
//! Respuesta: `{"ok":true,"path":"…"}` o `{"ok":false,"error":"…"}`.
//!
//! El visor de pdfiiuum dentro del navegador abre además una **sesión**: manda el PDF con
//! `{"type":"put","size":N}` y `{"type":"part","data":"<base64>"}`, y pide operaciones con
//! `{"type":"call","id":1,"cmd":"edit_page","args":{…}}` sobre el último PDF recibido o
//! producido. La respuesta llega en `{"type":"part","id":1,"data":…}` (si devuelve un PDF; en
//! trozos, porque Chrome no admite mensajes de más de 1 MB hacia la extensión) y
//! `{"type":"result","id":1,"result":…,"size":N,"current":bool}`, o `{"type":"error",…}`.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{pdf_edit, pdf_engine, pdf_pages};

/// Tamaño máximo admitido (la extensión también lo comprueba).
const MAX_PDF: usize = 1 << 30;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Begin { name: String, size: usize },
    Chunk { data: String },
    End,
    Path { path: String },
    // Sesión del visor del navegador.
    Put { size: usize },
    Part { data: String },
    Call {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
}

/// Trozo de PDF por mensaje hacia la extensión: en base64 queda por debajo de 1 MB.
const PART: usize = 700_000;

/// ¿Nos ha arrancado el navegador como puente de la extensión?
pub fn is_native_host() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://"))
}

pub fn run() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let first = match read_message(&mut stdin) {
        Ok(Some(m)) => m,
        Ok(None) => return,
        Err(e) => {
            let _ = send(&mut stdout, &json!({ "ok": false, "error": e }));
            return;
        }
    };
    if matches!(first, Message::Put { .. } | Message::Call { .. }) {
        return session(first, &mut stdin, &mut stdout, &pdfium_dll());
    }
    let reply = match receive(first, &mut stdin) {
        Ok(path) => match open_in_app(&path) {
            Ok(()) => json!({ "ok": true, "path": path }),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let _ = send(&mut stdout, &reply);
}

/// pdfium.dll junto al ejecutable (instalado) o en src-tauri/lib (desarrollo).
fn pdfium_dll() -> PathBuf {
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("pdfium.dll")));
    #[cfg(debug_assertions)]
    if !beside.as_ref().is_some_and(|p| p.exists()) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("lib").join("pdfium.dll");
    }
    beside.unwrap_or_else(|| PathBuf::from("pdfium.dll"))
}

/// Sesión del visor del navegador: atiende operaciones hasta que la extensión cierra.
fn session(first: Message, input: &mut impl Read, output: &mut impl Write, dll: &Path) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut current: Vec<u8> = Vec::new();
    let mut incoming: Option<Vec<u8>> = None;
    let mut next = Some(first);
    loop {
        let message = match next.take() {
            Some(m) => m,
            None => match read_message(input) {
                Ok(Some(m)) => m,
                _ => return,
            },
        };
        let sent = match message {
            Message::Put { size } => {
                incoming = Some(Vec::with_capacity(size.min(MAX_PDF)));
                Ok(())
            }
            Message::Part { data } => match incoming.as_mut() {
                Some(buf) => b64.decode_vec(data.as_bytes(), buf).map(|_| ()).map_err(|e| e.to_string()),
                None => Err("Trozo sin cabecera".to_string()),
            }
            .or_else(|e| send(output, &json!({ "type": "error", "id": null, "error": e })).map_err(|e| e.to_string())),
            Message::Call { id, cmd, args } => {
                if let Some(buf) = incoming.take() {
                    current = buf;
                }
                let reply = match call(dll, &current, &cmd, args) {
                    Ok((result, bytes, replaces)) => {
                        let size = bytes.as_ref().map_or(0, |b| b.len());
                        let mut ok = Ok(());
                        for part in bytes.iter().flat_map(|b| b.chunks(PART)) {
                            ok = ok.and(send(output, &json!({ "type": "part", "id": id, "data": b64.encode(part) })));
                        }
                        if let (true, Some(b)) = (replaces, bytes) {
                            current = b;
                        }
                        ok.and(send(
                            output,
                            &json!({ "type": "result", "id": id, "result": result, "size": size, "current": replaces }),
                        ))
                    }
                    Err(e) => send(output, &json!({ "type": "error", "id": id, "error": e })),
                };
                reply.map_err(|e| e.to_string())
            }
            _ => send(output, &json!({ "type": "error", "id": null, "error": "Mensaje inesperado" })).map_err(|e| e.to_string()),
        };
        if sent.is_err() {
            return;
        }
    }
}

fn arg<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("Argumentos no válidos: {e}"))
}

/// Una operación sobre el PDF actual: (resultado JSON, PDF producido, ¿pasa a ser el actual?).
fn call(dll: &Path, current: &[u8], cmd: &str, args: Value) -> Result<(Value, Option<Vec<u8>>, bool), String> {
    #[derive(Deserialize)]
    struct Page {
        page: i32,
    }
    #[derive(Deserialize)]
    struct EditPage {
        page: i32,
        edit: pdf_edit::PageEdit,
    }
    #[derive(Deserialize)]
    struct Bake {
        remove: Vec<[i32; 2]>,
        add: Vec<pdf_engine::Annot>,
    }
    #[derive(Deserialize)]
    struct Name {
        name: String,
    }
    match cmd {
        "user_name" => Ok((json!(pdf_engine::default_author()), None, false)),
        "extract_annotations" => {
            let ex = pdf_engine::extract_annotations(dll, current)?;
            Ok((json!({ "annots": ex.annots, "signed": ex.signed }), ex.display, false))
        }
        "page_content" => {
            let Page { page } = arg(args)?;
            let content = pdf_edit::page_content(dll, current, page)?;
            Ok((serde_json::to_value(&content).map_err(|e| e.to_string())?, None, false))
        }
        "edit_page" => {
            let EditPage { page, edit } = arg(args)?;
            let out = pdf_edit::edit_page(dll, current, page, &edit)?;
            Ok((json!({ "notice": out.notice }), Some(out.pdf), true))
        }
        "edit_pages" => {
            let edit: pdf_pages::PagesEdit = arg(args)?;
            Ok((Value::Null, Some(pdf_pages::edit_pages(dll, current, &edit)?), true))
        }
        "extract_pages" => {
            let pages: Vec<i32> = arg(args)?;
            Ok((Value::Null, Some(pdf_pages::extract_pages(dll, current, &pages)?), false))
        }
        "bake_annotations" => {
            let Bake { remove, add } = arg(args)?;
            Ok((Value::Null, Some(pdf_engine::apply_annotations(dll, current, &remove, &add)?), true))
        }
        "open_in_app" => {
            let Name { name } = arg(args)?;
            let path = save_download(&name, current)?;
            open_in_app(&path)?;
            Ok((json!({ "path": path }), None, false))
        }
        _ => Err(format!("Operación desconocida: {cmd}")),
    }
}

fn read_message(input: &mut impl Read) -> Result<Option<Message>, String> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > 64 << 20 {
        return Err("Mensaje demasiado grande".into());
    }
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map(Some).map_err(|e| format!("Mensaje no válido: {e}"))
}

fn send(output: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let body = value.to_string();
    output.write_all(&(body.len() as u32).to_le_bytes())?;
    output.write_all(body.as_bytes())?;
    output.flush()
}

/// Lee los mensajes hasta tener el PDF completo y devuelve dónde ha quedado.
fn receive(first: Message, input: &mut impl Read) -> Result<PathBuf, String> {
    let mut file: Option<(String, Vec<u8>)> = None;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut next = Some(first);
    loop {
        let message = match next.take() {
            Some(m) => Some(m),
            None => read_message(input)?,
        };
        match message {
            None => return Err("La extensión cerró la conexión antes de terminar".into()),
            Some(Message::Path { path }) => {
                let p = PathBuf::from(path);
                return if p.is_file() { Ok(p) } else { Err(format!("No existe {}", p.display())) };
            }
            Some(Message::Begin { name, size }) => {
                if size > MAX_PDF {
                    return Err("El PDF es demasiado grande".into());
                }
                file = Some((name, Vec::with_capacity(size)));
            }
            Some(Message::Chunk { data }) => {
                let (_, bytes) = file.as_mut().ok_or("Trozo sin cabecera")?;
                b64.decode_vec(data.as_bytes(), bytes).map_err(|e| e.to_string())?;
                if bytes.len() > MAX_PDF {
                    return Err("El PDF es demasiado grande".into());
                }
            }
            Some(Message::End) => {
                let (name, bytes) = file.take().ok_or("Fin sin cabecera")?;
                // Como los lectores de PDF, se admite basura antes de la cabecera (primer KB).
                if !bytes[..bytes.len().min(1024)].windows(4).any(|w| w == b"%PDF") {
                    return Err("Lo descargado no es un PDF".into());
                }
                return save_download(&name, &bytes);
            }
            Some(_) => return Err("Mensaje inesperado".into()),
        }
    }
}

/// Nombre de archivo válido en Windows y terminado en .pdf.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    let stem = if trimmed.is_empty() { "documento" } else { trimmed };
    let stem: String = stem.chars().take(150).collect();
    if stem.to_lowercase().ends_with(".pdf") { stem } else { format!("{stem}.pdf") }
}

/// Guarda en Descargas como haría el navegador: si ya hay un archivo con ese nombre y el mismo
/// contenido se reutiliza; si es distinto, se añade « (2)», « (3)»…
fn save_download(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = safe_name(name);
    let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, "pdf"));
    for n in 1.. {
        let path = if n == 1 { dir.join(&name) } else { dir.join(format!("{stem} ({n}).{ext}")) };
        match std::fs::read(&path) {
            Ok(existing) if existing == bytes => return Ok(path),
            Ok(_) => continue,
            Err(_) => {
                std::fs::write(&path, bytes).map_err(|e| format!("No se pudo guardar en {}: {e}", dir.display()))?;
                return Ok(path);
            }
        }
    }
    unreachable!()
}

/// Abre el PDF con una nueva ejecución de pdfiiuum (si ya está abierta, la pasa a su ventana).
/// Se lanza fuera del grupo de procesos del navegador para que no se cierre con el puente.
fn open_in_app(path: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Si la app heredara las tuberías con el navegador, este no vería cerrarse el puente.
        unsafe {
            for std_handle in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
                SetHandleInformation(GetStdHandle(std_handle), HANDLE_FLAG_INHERIT, 0);
            }
        }
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        // Algunos navegadores no permiten salir de su grupo de procesos.
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("No se pudo abrir pdfiiuum: {e}"))
}

#[cfg(windows)]
const STD_INPUT_HANDLE: u32 = -10i32 as u32;
#[cfg(windows)]
const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
#[cfg(windows)]
const STD_ERROR_HANDLE: u32 = -12i32 as u32;
#[cfg(windows)]
const HANDLE_FLAG_INHERIT: u32 = 1;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(std_handle: u32) -> *mut std::ffi::c_void;
    fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(v: serde_json::Value) -> Vec<u8> {
        let mut out = Vec::new();
        send(&mut out, &v).unwrap();
        out
    }

    #[test]
    fn names() {
        assert_eq!(safe_name("informe.pdf"), "informe.pdf");
        assert_eq!(safe_name("a/b:c?"), "a_b_c_.pdf");
        assert_eq!(safe_name("  . "), "documento.pdf");
        assert_eq!(safe_name("Doc.PDF"), "Doc.PDF");
    }

    #[test]
    fn chunks_are_joined() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let pdf = b"%PDF-1.4 hola";
        let mut input = Vec::new();
        input.extend(frame(json!({ "type": "begin", "name": "x.pdf", "size": pdf.len() })));
        input.extend(frame(json!({ "type": "chunk", "data": b64.encode(&pdf[..5]) })));
        input.extend(frame(json!({ "type": "chunk", "data": b64.encode(&pdf[5..]) })));
        // Sin «end»: termina con error, pero tras leer bien los trozos.
        let mut reader = input.as_slice();
        let first = read_message(&mut reader).unwrap().unwrap();
        let err = receive(first, &mut reader).unwrap_err();
        assert!(err.contains("cerró"), "{err}");
    }

    /// Respuestas del puente, ya interpretadas.
    fn replies(out: &[u8]) -> Vec<Value> {
        let mut r = out;
        let mut v = Vec::new();
        while r.len() >= 4 {
            let n = u32::from_le_bytes([r[0], r[1], r[2], r[3]]) as usize;
            v.push(serde_json::from_slice(&r[4..4 + n]).unwrap());
            r = &r[4 + n..];
        }
        v
    }

    #[test]
    fn viewer_session() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll");
        // PDF de dos páginas creado con PDFium.
        let pdf = pdf_pages::edit_pages(
            &dll,
            &pdf_pages::tests_sample(),
            &pdf_pages::PagesEdit::InsertBlank { at: 1, like: 0 },
        )
        .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut input = Vec::new();
        input.extend(frame(json!({ "type": "put", "size": pdf.len() })));
        for part in pdf.chunks(1000) {
            input.extend(frame(json!({ "type": "part", "data": b64.encode(part) })));
        }
        input.extend(frame(json!({ "type": "call", "id": 1, "cmd": "page_content", "args": { "page": 0 } })));
        input.extend(frame(json!({ "type": "call", "id": 2, "cmd": "edit_pages", "args": { "op": "delete", "pages": [1] } })));
        input.extend(frame(json!({ "type": "call", "id": 3, "cmd": "extract_pages", "args": [0] })));
        input.extend(frame(json!({ "type": "call", "id": 4, "cmd": "nada" })));
        input.extend(frame(json!({ "type": "call", "id": 5, "cmd": "extract_annotations" })));
        let mut reader = input.as_slice();
        let first = read_message(&mut reader).unwrap().unwrap();
        let mut out = Vec::new();
        session(first, &mut reader, &mut out, &dll);
        let r = replies(&out);

        let result = |id: u64| r.iter().find(|m| m["id"] == id && m["type"] != "part").unwrap().clone();
        assert_eq!(result(1)["result"]["runs"][0]["text"], "Hola");
        // El PDF con una página borrada vuelve por trozos y pasa a ser el actual.
        let two = result(2);
        assert_eq!(two["current"], true);
        let rebuilt: Vec<u8> = r
            .iter()
            .filter(|m| m["id"] == 2 && m["type"] == "part")
            .flat_map(|m| b64.decode(m["data"].as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(rebuilt.len() as u64, two["size"].as_u64().unwrap());
        assert!(rebuilt.starts_with(b"%PDF"));
        assert_eq!(result(3)["current"], false);
        assert_eq!(result(4)["type"], "error");
        // El visor del navegador recibe las anotaciones y si el PDF está firmado.
        assert!(result(5)["result"]["annots"].is_array());
        assert_eq!(result(5)["result"]["signed"], false);
    }

    #[test]
    fn rejects_non_pdf() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut input = Vec::new();
        input.extend(frame(json!({ "type": "begin", "name": "x.pdf", "size": 4 })));
        input.extend(frame(json!({ "type": "chunk", "data": b64.encode(b"<html>") })));
        input.extend(frame(json!({ "type": "end" })));
        let mut reader = input.as_slice();
        let first = read_message(&mut reader).unwrap().unwrap();
        assert_eq!(receive(first, &mut reader).unwrap_err(), "Lo descargado no es un PDF");
    }
}
