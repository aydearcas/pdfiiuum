# pdfiiuum

Lector de PDF de escritorio para Windows, ligero y con interfaz oscura. Permite abrir varios PDF en pestañas, resaltar, subrayar, tachar, comentar, insertar texto y dibujar, y guarda las anotaciones dentro del propio PDF como anotaciones estándar, legibles en Acrobat, Edge o Chrome.

## Funciones

- Pestañas: reordenar arrastrando, sacar una pestaña a una ventana nueva o moverla a otra ventana.
- Anotaciones: resaltado en 8 colores, subrayado, tachado, notas, texto insertado y dibujo a mano alzada, con deshacer y rehacer.
- Menú al seleccionar texto (comentar, resaltar, subrayar, tachar, copiar).
- Panel lateral con todos los comentarios y resaltados del documento, en orden de lectura. El autor es el usuario de Windows.
- Búsqueda, miniaturas, zoom y giro de la vista.
- Instalador para Windows que registra pdfiiuum en «Abrir con» y en Aplicaciones predeterminadas, y una sola instancia: los PDF abiertos desde el Explorador entran como pestañas.

## Tecnología

Tauri 2 (Rust) + React + TypeScript. [pdf.js](https://github.com/mozilla/pdf.js) muestra las páginas y [PDFium](https://pdfium.googlesource.com/pdfium/), mediante [`pdfium-render`](https://github.com/ajrcarey/pdfium-render), escribe las anotaciones al guardar.

## Requisitos para compilar (una vez)

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install --id Rustlang.Rustup
```

Cierra y vuelve a abrir la terminal después de instalar Rust. También hace falta Node.js 20 o posterior.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm install` | Instala dependencias |
| `npm run dev` | Solo la interfaz, en el navegador (http://localhost:1420). Sin guardado de anotaciones |
| `npm run tauri dev` | App de escritorio en modo desarrollo |
| `npm run tauri build` | Genera el instalador en `src-tauri/target/release/bundle/nsis/` |
| `npx tauri icon ruta/al/icono.png` | Regenera todos los iconos (PNG de 1024×1024) |

## Estructura

- `src/` — interfaz (React). `lib/platform.ts` separa lo de escritorio de lo de navegador.
- `src/components/DocTab.tsx` — una pestaña: visor, anotaciones, historial y guardado.
- `src/lib/annotations.ts` — modelo de anotaciones pendientes (coordenadas PDF).
- `src-tauri/src/pdf_engine.rs` — escritura de anotaciones con PDFium.
- `src-tauri/src/windows.rs` — varias ventanas, mover pestañas e instancia única.
- `src-tauri/windows/hooks.nsh` — registro del instalador como lector de PDF.

## Licencia

pdfiiuum se distribuye bajo la licencia [GPL-3.0](LICENSE).

Componentes de terceros incluidos:

- `src-tauri/lib/pdfium.dll` — compilación oficial de [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) (versión 158.0.8111), licencia BSD-3-Clause ([`src-tauri/lib/PDFIUM-LICENSE`](src-tauri/lib/PDFIUM-LICENSE)). Se incluye en el instalador.
- pdf.js (Apache-2.0), Tauri y `pdfium-render` (MIT/Apache-2.0), React (MIT) y Lucide (ISC) se obtienen como dependencias con sus propias licencias.
