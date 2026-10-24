// Mantiene al día src-tauri/lib/pdfium.dll con las compilaciones de bblanchon/pdfium-binaries.
// PDFium procesa PDF que pueden venir de cualquiera: cada versión de Chrome corrige fallos de
// seguridad suyos, así que conviene comprobarlo antes de publicar cada versión de pdfiiuum.
//
//   node scripts/update-pdfium.mjs                comprueba si hay una más nueva (no cambia nada)
//   node scripts/update-pdfium.mjs 8200           instala chromium/8200
//   node scripts/update-pdfium.mjs latest         instala la última
//   node scripts/update-pdfium.mjs 8200 <sha256>  con el SHA-256 que se espera del .tgz
//
// La descarga se comprueba con el SHA-256 que GitHub publica para el archivo (o el que se pase):
// si no coincide, no se toca nada.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const REPO = "bblanchon/pdfium-binaries";
const ASSET = "pdfium-win-x64.tgz";
const root = resolve(import.meta.dirname, "..");
const lib = join(root, "src-tauri", "lib");
const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
const installed = readme.match(/pdfium-binaries\]\([^)]*\) \(versión (\d+\.\d+\.\d+)\)/)?.[1];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function release(which) {
  const path = which === "latest" ? "latest" : `tags/chromium/${which}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub respondió ${res.status} al pedir la versión «${which}»`);
  return res.json();
}

/** Archivos normales de un .tar sin comprimir: nombre → contenido. */
function untar(buf) {
  const files = new Map();
  for (let at = 0; at + 512 <= buf.length; ) {
    const header = buf.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString("latin1").replace(/\0.*$/s, "").trim();
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : "") + field(0, 100);
    const size = parseInt(field(124, 12) || "0", 8);
    const type = field(156, 1);
    at += 512;
    if (type === "0" || type === "") files.set(name.replace(/^\.\//, ""), buf.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }
  return files;
}

const [which, expectedArg] = process.argv.slice(2);
const rel = await release(which ?? "latest");
const build = rel.tag_name.split("/").pop();

if (!which) {
  console.log(`PDFium incluida: ${installed ?? "desconocida"} · última publicada: ${rel.tag_name} (${rel.published_at.slice(0, 10)})`);
  console.log(
    installed?.endsWith(`.${build}`)
      ? "Está al día."
      : `Hay una versión nueva. Para instalarla: node scripts/update-pdfium.mjs ${build}`,
  );
  process.exit(0);
}

const asset = rel.assets.find((a) => a.name === ASSET);
if (!asset) throw new Error(`${rel.tag_name} no incluye ${ASSET}`);
const expected = (expectedArg ?? asset.digest?.replace(/^sha256:/, ""))?.toLowerCase();
if (!expected) throw new Error(`GitHub no publica el SHA-256 de ${ASSET}: pásalo como segundo argumento`);

const res = await fetch(asset.browser_download_url);
if (!res.ok) throw new Error(`La descarga respondió ${res.status}`);
const data = Buffer.from(await res.arrayBuffer());
const actual = sha256(data);
if (actual !== expected) {
  console.error(`El SHA-256 de ${ASSET} no coincide (esperado ${expected}, descargado ${actual}). No se ha cambiado nada.`);
  process.exit(1);
}

const files = untar(gunzipSync(data));
const dll = files.get("bin/pdfium.dll");
const license = files.get("LICENSE");
const versionFile = files.get("VERSION");
if (!dll || !license || !versionFile) throw new Error(`${ASSET} no contiene bin/pdfium.dll, LICENSE y VERSION`);
const v = Object.fromEntries(
  versionFile.toString().split(/\r?\n/).filter(Boolean).map((line) => line.split("=").map((s) => s.trim())),
);
const version = `${v.MAJOR}.${v.MINOR}.${v.BUILD}`;

writeFileSync(join(lib, "pdfium.dll"), dll);
writeFileSync(join(lib, "PDFIUM-LICENSE"), license);
writeFileSync(readmePath, readme.replace(`(versión ${installed})`, `(versión ${version})`));
console.log(`PDFium ${installed ?? "?"} → ${version} (${rel.tag_name}). SHA-256 de pdfium.dll: ${sha256(dll)}`);
console.log("Antes de publicar: cargo test --manifest-path src-tauri/Cargo.toml");
