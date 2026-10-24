//! Varias ventanas: mover pestañas entre ventanas (o a una nueva) y reenviar a la ventana
//! activa los PDF que se abren con doble clic mientras la app ya está en marcha.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Estado inicial (JSON de la pestaña) de cada ventana creada al sacar una pestaña.
#[derive(Default)]
pub struct WindowPayloads(Mutex<HashMap<String, String>>);

/// Última ventana que tuvo el foco: recibe los PDF abiertos desde el Explorador.
#[derive(Default)]
pub struct LastFocused(pub Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DropResult {
    /// La pestaña se ha añadido a otra ventana de pdfiiuum.
    Attached,
    /// Se ha creado una ventana nueva para la pestaña.
    Created,
    /// No se ha hecho nada (única pestaña soltada fuera de cualquier ventana).
    None,
}

/// Pestaña soltada fuera de su ventana: si el puntero está sobre otra ventana de
/// pdfiiuum se añade allí; si no, se abre en una ventana nueva (salvo que fuera la única).
/// Es async porque en Windows crear ventanas desde un comando síncrono puede bloquearse.
#[tauri::command]
pub async fn drop_tab(
    app: AppHandle,
    window: WebviewWindow,
    payloads: tauri::State<'_, WindowPayloads>,
    payload: String,
    width: f64,
    height: f64,
    sole: bool,
) -> Result<DropResult, String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;

    for (label, target) in app.webview_windows() {
        if label == window.label() || target.is_minimized().unwrap_or(false) || !target.is_visible().unwrap_or(true) {
            continue;
        }
        let (Ok(pos), Ok(size)) = (target.outer_position(), target.outer_size()) else { continue };
        let inside = cursor.x >= pos.x as f64
            && cursor.x < pos.x as f64 + size.width as f64
            && cursor.y >= pos.y as f64
            && cursor.y < pos.y as f64 + size.height as f64;
        if inside {
            app.emit_to(label.as_str(), "attach-tab", payload).map_err(|e| e.to_string())?;
            let _ = target.set_focus();
            return Ok(DropResult::Attached);
        }
    }
    if sole {
        return Ok(DropResult::None);
    }

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let label = format!("doc-{nanos}");
    payloads.0.lock().map_err(|e| e.to_string())?.insert(label.clone(), payload);
    let created = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("pdfiiuum")
        .inner_size(width.max(720.0), height.max(480.0))
        .min_inner_size(720.0, 480.0)
        .theme(Some(tauri::Theme::Dark))
        .focused(true)
        // Como la principal: sin ventanas nuevas abiertas desde la página (ver lib.rs).
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|e| e.to_string())?;
    // La pestaña queda bajo el puntero, como al arrastrarla.
    let scale = created.scale_factor().unwrap_or(1.0);
    let _ = created.set_position(PhysicalPosition::new(
        (cursor.x - 120.0 * scale).max(0.0),
        (cursor.y - 16.0 * scale).max(0.0),
    ));
    Ok(DropResult::Created)
}

/// Lo llama cada ventana al arrancar; solo las creadas con `tear_off` tienen estado.
#[tauri::command]
pub fn take_window_payload(window: WebviewWindow, payloads: tauri::State<'_, WindowPayloads>) -> Option<String> {
    payloads.0.lock().ok()?.remove(window.label())
}

/// PDFs de la línea de comandos, convertidos a rutas absolutas.
pub fn pdf_args(argv: &[String], cwd: &str) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| a.to_lowercase().ends_with(".pdf"))
        .map(|a| {
            let p = Path::new(a);
            if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) }
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

/// Segunda ejecución de la app: abre sus PDF como pestañas en la última ventana activa.
pub fn forward_to_window(app: &AppHandle, paths: Vec<String>) {
    let windows = app.webview_windows();
    let last = app.state::<LastFocused>().0.lock().ok().and_then(|l| l.clone());
    let target = last
        .and_then(|l| windows.get(&l).cloned())
        .or_else(|| windows.get("main").cloned())
        .or_else(|| windows.values().next().cloned());
    let Some(window) = target else { return };
    if !paths.is_empty() {
        let _ = app.emit_to(window.label(), "open-files", paths);
    }
    let _ = window.unminimize();
    let _ = window.set_focus();
}
