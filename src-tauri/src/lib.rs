mod extension_setup;
pub mod native_host;
mod pdf_edit;
mod pdf_pages;
mod pdf_engine;
mod windows;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

/// PDF recibido como argumento al arrancar (doble clic en un .pdf).
struct StartupFile(Mutex<Option<String>>);

/// Ruta de pdfium.dll.
struct PdfiumPath(PathBuf);

/// Lo único que pueden leer o escribir los comandos que reciben una ruta desde la ventana: así,
/// aunque alguien llegara a ejecutar código en ella, no le servirían para tocar otro tipo de
/// archivos (por ejemplo, dejar un .bat en la carpeta de Inicio).
pub(crate) const PDF: &[&str] = &["pdf"];
pub(crate) const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp"];

pub(crate) fn check_path(path: &Path, allowed: &[&str]) -> Result<(), String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    // Un «:» en el nombre sería un flujo alternativo de NTFS (otro.bat:x.pdf).
    let stream = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(':'));
    if !stream && allowed.iter().any(|a| ext.eq_ignore_ascii_case(a)) {
        return Ok(());
    }
    let list: Vec<String> = allowed.iter().map(|a| format!(".{a}")).collect();
    Err(format!("Solo se admiten archivos {}: {}", list.join(", "), path.display()))
}

/// Direcciones de la propia app: la ventana no puede salir de ellas, para que un enlace del PDF
/// no sustituya la interfaz por una web (y se pierda lo no guardado).
fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost") || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
        }
        _ => url.as_str() == "about:blank",
    }
}

/// Webs y correo: lo único que la app abre fuera (con el navegador o el programa de correo).
fn external_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| format!("Enlace no válido: {url}"))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => Ok(parsed),
        other => Err(format!("pdfiiuum no abre enlaces «{other}:»")),
    }
}

/// Abre un enlace del PDF que el usuario ha confirmado.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    shell_open(external_url(&url)?.as_str())
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, target) = (wide("open"), wide(target));
    let null = std::ptr::null();
    // ShellExecute devuelve un valor mayor que 32 si lo ha podido abrir.
    let code = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), null, null, SW_SHOWNORMAL) };
    if code > 32 { Ok(()) } else { Err(format!("No se pudo abrir el enlace (error {code})")) }
}

#[cfg(not(windows))]
fn shell_open(_: &str) -> Result<(), String> {
    Err("Abrir enlaces solo está disponible en Windows".into())
}

#[cfg(windows)]
const SW_SHOWNORMAL: i32 = 1;

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_cmd: i32,
    ) -> isize;
}

#[tauri::command]
fn startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// Devuelve el archivo como binario puro (sin pasar por JSON).
#[tauri::command]
fn read_pdf(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    check_path(&path, PDF)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| e.to_string())
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("Se esperaba un cuerpo binario".into()),
    }
}

fn target_path(request: &Request<'_>) -> Result<PathBuf, String> {
    let path = request
        .headers()
        .get("path")
        .ok_or("Falta la ruta de destino")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = PathBuf::from(urlencoding::decode(path).map_err(|e| e.to_string())?.as_ref());
    check_path(&path, PDF)?;
    Ok(path)
}

/// Escribe primero en un temporal y luego reemplaza: así un fallo
/// a mitad de escritura nunca deja el PDF original corrupto.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("pdf.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Recibe los bytes en el cuerpo de la petición y la ruta en la cabecera `path`.
#[tauri::command]
fn write_pdf(request: Request<'_>) -> Result<(), String> {
    write_atomic(&target_path(&request)?, raw_body(&request)?)
}

/// [longitud (u32 LE)][JSON][binario]: formato de los mensajes con datos y PDF a la vez.
fn split_framed(body: &[u8]) -> Result<(&[u8], &[u8]), String> {
    if body.len() < 4 {
        return Err("Cuerpo incompleto".into());
    }
    let json_len = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    let json = body.get(4..4 + json_len).ok_or("Cuerpo incompleto")?;
    Ok((json, &body[4 + json_len..]))
}

fn framed(json: &[u8], bin: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + json.len() + bin.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json);
    out.extend_from_slice(bin);
    out
}

#[derive(serde::Deserialize)]
struct SaveRequest {
    /// Originales del PDF borradas o modificadas: [página, índice].
    #[serde(default)]
    remove: Vec<[i32; 2]>,
    /// Anotaciones que hay que escribir (nuevas y versiones modificadas).
    add: Vec<pdf_engine::Annot>,
}

/// Cuerpo: [longitud del JSON (u32 LE)][JSON {remove, add}][PDF original].
/// Escribe el PDF con las anotaciones y lo devuelve para que la interfaz lo recargue.
#[tauri::command]
async fn save_annotated(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<Response, String> {
    let path = target_path(&request)?;
    let (json, pdf) = split_framed(raw_body(&request)?)?;
    let req: SaveRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let pdf = pdf.to_vec();
    let dll = pdfium.0.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let out = pdf_engine::apply_annotations(&dll, &pdf, &req.remove, &req.add)?;
        write_atomic(&path, &out)?;
        Ok(Response::new(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cuerpo: el PDF. Respuesta: [longitud (u32 LE)][JSON de anotaciones editables][PDF para
/// mostrar, sin esas anotaciones; vacío si no había ninguna].
#[tauri::command]
async fn extract_annotations(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<Response, String> {
    let pdf = raw_body(&request)?.to_vec();
    let dll = pdfium.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ex = pdf_engine::extract_annotations(&dll, &pdf)?;
        let json = serde_json::to_vec(&ex.annots).map_err(|e| e.to_string())?;
        Ok(Response::new(framed(&json, ex.display.as_deref().unwrap_or(&[]))))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn page_header(request: &Request<'_>) -> Result<i32, String> {
    request
        .headers()
        .get("page")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| "Falta la página".to_string())
}

/// Modo edición. Cuerpo: el PDF; cabecera `page` (desde 0). Respuesta: tramos de texto e imágenes.
#[tauri::command]
async fn page_content(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<pdf_edit::PageContent, String> {
    let page = page_header(&request)?;
    let pdf = raw_body(&request)?.to_vec();
    let dll = pdfium.0.clone();
    tauri::async_runtime::spawn_blocking(move || pdf_edit::page_content(&dll, &pdf, page))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Deserialize)]
struct EditPageRequest {
    page: i32,
    edit: pdf_edit::PageEdit,
}

/// Cuerpo: [JSON {page, edit}][PDF]. Respuesta: [JSON {notice}][PDF editado].
#[tauri::command]
async fn edit_page(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<Response, String> {
    let (json, pdf) = split_framed(raw_body(&request)?)?;
    let req: EditPageRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let pdf = pdf.to_vec();
    let dll = pdfium.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let out = pdf_edit::edit_page(&dll, &pdf, req.page, &req.edit)?;
        let json = serde_json::to_vec(&serde_json::json!({ "notice": out.notice })).map_err(|e| e.to_string())?;
        Ok(Response::new(framed(&json, &out.pdf)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cuerpo: [JSON PagesEdit][PDF]. Respuesta: el PDF con las páginas giradas, borradas, movidas o insertadas.
#[tauri::command]
async fn edit_pages(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<Response, String> {
    let (json, pdf) = split_framed(raw_body(&request)?)?;
    let edit: pdf_pages::PagesEdit = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let pdf = pdf.to_vec();
    let dll = pdfium.0.clone();
    tauri::async_runtime::spawn_blocking(move || pdf_pages::edit_pages(&dll, &pdf, &edit).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}

/// Cuerpo: [JSON [páginas desde 0]][PDF]. Respuesta: un PDF nuevo con solo esas páginas.
#[tauri::command]
async fn extract_pages(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<Response, String> {
    let (json, pdf) = split_framed(raw_body(&request)?)?;
    let pages: Vec<i32> = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let pdf = pdf.to_vec();
    let dll = pdfium.0.clone();
    tauri::async_runtime::spawn_blocking(move || pdf_pages::extract_pages(&dll, &pdf, &pages).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}

/// Como `save_annotated` pero sin escribir el archivo: escribe en el PDF las anotaciones
/// pendientes (antes de operaciones que cambian las páginas).
#[tauri::command]
async fn bake_annotations(request: Request<'_>, pdfium: tauri::State<'_, PdfiumPath>) -> Result<Response, String> {
    let (json, pdf) = split_framed(raw_body(&request)?)?;
    let req: SaveRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let pdf = pdf.to_vec();
    let dll = pdfium.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pdf_engine::apply_annotations(&dll, &pdf, &req.remove, &req.add).map(Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Nombre de usuario de Windows: autor de los comentarios.
#[tauri::command]
fn user_name() -> String {
    pdf_engine::default_author()
}

/// Busca pdfium.dll: junto a los recursos de la app, junto al ejecutable
/// o en src-tauri/lib durante el desarrollo.
fn find_pdfium(app: &tauri::App) -> PathBuf {
    let name = "pdfium.dll";
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    // Solo en desarrollo: en la versión final no queda grabada la ruta del proyecto.
    #[cfg(debug_assertions)]
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("lib").join(name));
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup = std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".pdf"));

    tauri::Builder::default()
        // Debe ir primero: si la app ya está abierta, esta ejecución le pasa sus PDF y termina.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            windows::forward_to_window(app, windows::pdf_args(&argv, &cwd));
        }))
        .plugin(tauri_plugin_dialog::init())
        // Ni un enlace ni un script pueden llevar una ventana fuera de la app (ver `is_app_url`).
        .plugin(tauri::plugin::Builder::<_, ()>::new("navegacion").on_navigation(|_, url| is_app_url(url)).build())
        .manage(StartupFile(Mutex::new(startup)))
        .manage(windows::WindowPayloads::default())
        .manage(windows::LastFocused::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                if let Ok(mut last) = window.state::<windows::LastFocused>().0.lock() {
                    *last = Some(window.label().to_string());
                }
            }
        })
        .setup(|app| {
            let dll = find_pdfium(app);
            app.manage(PdfiumPath(dll));
            // La ventana principal se crea aquí para que no pueda abrir ventanas nuevas por su
            // cuenta (window.open, enlaces con target="_blank"): los enlaces van por open_external.
            let main = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("Falta la ventana main")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main)?
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_file,
            read_pdf,
            write_pdf,
            save_annotated,
            extract_annotations,
            page_content,
            edit_page,
            edit_pages,
            extract_pages,
            bake_annotations,
            user_name,
            open_external,
            extension_setup::extension_info,
            extension_setup::open_extension_folder,
            extension_setup::open_browser_extensions,
            windows::drop_tab,
            windows::take_window_payload
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_documents_and_images() {
        let startup = r"C:\Users\x\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.bat";
        assert!(check_path(Path::new(startup), PDF).is_err());
        assert!(check_path(Path::new(r"C:\Docs\informe.PDF"), PDF).is_ok());
        assert!(check_path(Path::new(r"\\servidor\docs\acta de la reunión.pdf"), PDF).is_ok());
        assert!(check_path(Path::new(r"C:\Docs\sin-extension"), PDF).is_err());
        assert!(check_path(Path::new(r"C:\Docs\otro.bat:oculto.pdf"), PDF).is_err());
        assert!(check_path(Path::new(r"C:\Docs\foto.png"), PDF).is_err());
        assert!(check_path(Path::new(r"C:\Docs\foto.JPG"), IMAGES).is_ok());
        // Rechazada antes de leer: no llega a abrir el archivo.
        let ini = pdf_edit::read_source(&Some(r"C:\Windows\win.ini".into()), &None, "la imagen", IMAGES);
        assert!(ini.unwrap_err().starts_with("Solo se admiten"));
    }

    #[test]
    fn window_stays_in_the_app() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_app_url(&url("http://tauri.localhost/index.html")));
        assert!(is_app_url(&url("tauri://localhost/")));
        assert!(is_app_url(&url("about:blank")));
        assert!(!is_app_url(&url("https://example.com/")));
        assert!(!is_app_url(&url("http://tauri.localhost.example.com/")));
        assert!(!is_app_url(&url("file:///C:/Windows/win.ini")));
    }

    #[test]
    fn only_web_and_mail_links_open_outside() {
        assert!(external_url("https://example.com/a?b=1").is_ok());
        assert!(external_url("mailto:alguien@example.com").is_ok());
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "ms-msdt:/id PCWDiagnostic",
            "search-ms:query=x",
            r"\\servidor\recurso\x.exe",
            "C:\\Windows\\System32\\calc.exe",
        ] {
            assert!(external_url(bad).is_err(), "{bad}");
        }
    }
}
