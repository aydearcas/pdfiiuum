// Evita que se abra una consola junto a la app en Windows (solo en release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Arrancada por Edge o Chrome para la extensión: solo hace de puente, sin ventana.
    if pdfiiuum_lib::native_host::is_native_host() {
        return pdfiiuum_lib::native_host::run();
    }
    pdfiiuum_lib::run()
}
