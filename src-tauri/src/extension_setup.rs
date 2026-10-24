//! Ayuda para instalar la extensión «Abrir en pdfiiuum»: dónde está su carpeta y abrir la
//! página de extensiones de cada navegador instalado. Chrome y Edge solo permiten instalar
//! extensiones fuera de su tienda a mano («Cargar descomprimida»), así que la app guía los pasos.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize, Debug, PartialEq)]
pub struct Browser {
    pub id: &'static str,
    pub name: &'static str,
}

#[derive(Serialize)]
pub struct ExtensionInfo {
    /// Carpeta que hay que elegir en «Cargar descomprimida».
    pub folder: String,
    /// Navegadores compatibles instalados en el equipo.
    pub browsers: Vec<Browser>,
}

/// (id, nombre, ruta del ejecutable dentro de Program Files o AppData\Local, página de extensiones)
const BROWSERS: [(&str, &str, &str, &str); 3] = [
    ("chrome", "Chrome", r"Google\Chrome\Application\chrome.exe", "chrome://extensions/"),
    ("edge", "Edge", r"Microsoft\Edge\Application\msedge.exe", "edge://extensions/"),
    ("brave", "Brave", r"BraveSoftware\Brave-Browser\Application\brave.exe", "brave://extensions/"),
];

fn find_exe(relative: &str) -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(|dir| Path::new(&dir).join(relative))
        .find(|p| p.is_file())
}

fn installed_browsers() -> Vec<Browser> {
    BROWSERS
        .iter()
        .filter(|(_, _, exe, _)| find_exe(exe).is_some())
        .map(|&(id, name, _, _)| Browser { id, name })
        .collect()
}

/// La carpeta instalada junto a la app; en desarrollo, la del proyecto.
fn extension_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("extension"));
    }
    #[cfg(debug_assertions)]
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("browser-extension"));
    candidates
        .into_iter()
        .find(|p| p.join("manifest.json").is_file())
        .map(|p| p.canonicalize().map(strip_verbatim).unwrap_or(p))
        .ok_or_else(|| "No se encuentra la carpeta de la extensión: reinstala pdfiiuum".into())
}

/// `canonicalize` en Windows devuelve rutas «\\?\C:\…», que el diálogo de carpetas no acepta.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

#[tauri::command]
pub fn extension_info(app: tauri::AppHandle) -> Result<ExtensionInfo, String> {
    Ok(ExtensionInfo {
        folder: extension_folder(&app)?.to_string_lossy().into_owned(),
        browsers: installed_browsers(),
    })
}

/// Abre la carpeta de la extensión en el Explorador.
#[tauri::command]
pub fn open_extension_folder(app: tauri::AppHandle) -> Result<(), String> {
    let folder = extension_folder(&app)?;
    Command::new("explorer.exe").arg(folder).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Abre la página de extensiones del navegador `id` (chrome, edge o brave).
#[tauri::command]
pub fn open_browser_extensions(id: String) -> Result<(), String> {
    let (_, name, exe, page) = BROWSERS.iter().find(|b| b.0 == id).ok_or("Navegador desconocido")?;
    let exe = find_exe(exe).ok_or_else(|| format!("No se encuentra {name} en este equipo"))?;
    Command::new(exe)
        .arg(page)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("No se pudo abrir {name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_paths_are_cleaned() {
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\C:\Program Files\pdfiiuum\extension")), PathBuf::from(r"C:\Program Files\pdfiiuum\extension"));
        assert_eq!(strip_verbatim(PathBuf::from(r"C:\a")), PathBuf::from(r"C:\a"));
    }

    #[test]
    fn detects_browsers_without_failing() {
        // Depende del equipo: solo comprueba que los ids son los conocidos.
        for b in installed_browsers() {
            assert!(["chrome", "edge", "brave"].contains(&b.id));
        }
    }
}
