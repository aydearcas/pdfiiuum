// Compila el instalador sin dejar rutas del equipo dentro del ejecutable.
// Rust guarda la ruta de cada archivo fuente (para los mensajes de error internos);
// --remap-path-prefix las sustituye por nombres genéricos.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = homedir();
const root = resolve(import.meta.dirname, "..");
const cargoHome = process.env.CARGO_HOME ?? join(home, ".cargo");
const rustupHome = process.env.RUSTUP_HOME ?? join(home, ".rustup");

// Con varias coincidencias gana la última: de la más general a la más concreta.
const remaps = [
  [home, "~"],
  [rustupHome, "rustup"],
  [cargoHome, "cargo"],
  [root, "pdfiiuum"],
];
const flags = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

// CARGO_ENCODED_RUSTFLAGS separa con 0x1F y admite rutas con espacios.
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
delete env.RUSTFLAGS;

const result = spawnSync("npx", ["tauri", "build", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
