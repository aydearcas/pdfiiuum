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

#[tauri::command]
fn startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// Devuelve el archivo como binario puro (sin pasar por JSON).
#[tauri::command]
fn read_pdf(path: String) -> Result<Response, String> {
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
    Ok(PathBuf::from(urlencoding::decode(path).map_err(|e| e.to_string())?.as_ref()))
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
            extension_setup::extension_info,
            extension_setup::open_extension_folder,
            extension_setup::open_browser_extensions,
            windows::drop_tab,
            windows::take_window_payload
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}
