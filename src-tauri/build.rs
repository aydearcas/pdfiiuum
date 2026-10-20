fn main() {
    // tauri-build no vuelve a incrustar el icono del .exe si solo cambia el archivo de icono.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
