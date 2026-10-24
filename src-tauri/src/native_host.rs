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

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
use serde::Deserialize;
use serde_json::json;

/// Tamaño máximo admitido (la extensión también lo comprueba).
const MAX_PDF: usize = 1 << 30;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Begin { name: String, size: usize },
    Chunk { data: String },
    End,
    Path { path: String },
}

/// ¿Nos ha arrancado el navegador como puente de la extensión?
pub fn is_native_host() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://"))
}

pub fn run() {
    let mut stdin = io::stdin().lock();
    let reply = match receive(&mut stdin) {
        Ok(path) => match open_in_app(&path) {
            Ok(()) => json!({ "ok": true, "path": path }),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let _ = send(&mut io::stdout().lock(), &reply);
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
fn receive(input: &mut impl Read) -> Result<PathBuf, String> {
    let mut file: Option<(String, Vec<u8>)> = None;
    let b64 = base64::engine::general_purpose::STANDARD;
    loop {
        match read_message(input)? {
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
        let err = receive(&mut input.as_slice()).unwrap_err();
        assert!(err.contains("cerró"), "{err}");
    }

    #[test]
    fn rejects_non_pdf() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut input = Vec::new();
        input.extend(frame(json!({ "type": "begin", "name": "x.pdf", "size": 4 })));
        input.extend(frame(json!({ "type": "chunk", "data": b64.encode(b"<html>") })));
        input.extend(frame(json!({ "type": "end" })));
        assert_eq!(receive(&mut input.as_slice()).unwrap_err(), "Lo descargado no es un PDF");
    }
}
