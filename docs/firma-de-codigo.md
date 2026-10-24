# Firma de código del instalador

El instalador de pdfiiuum no está firmado. Por eso Windows muestra «Windows protegió su PC» la primera vez que se abre, y quien lo descarga no puede comprobar con la firma que viene de este proyecto. Mientras tanto, cada versión publica el SHA-256 del instalador en sus notas.

Decisión (25-10-2026): si se firma, será con **SignPath Foundation**, que es gratuito para proyectos de código abierto. Por ahora se aplaza. Este documento recoge lo necesario para hacerlo cuando se retome.

## Requisitos de SignPath Foundation

Según sus [condiciones](https://signpath.org/terms) (la página está marcada como borrador y puede cambiar):

| Requisito | Situación en pdfiiuum |
|---|---|
| Licencia de código abierto aprobada por la OSI, sin componentes propietarios | Cumple (GPL-3.0; PDFium es BSD-3-Clause) |
| Proyecto mantenido, ya publicado y con sus funciones descritas en la página de descarga | Cumple (versiones en GitHub, README) |
| Solo se firman binarios compilados desde el propio código, de forma automática y verificable (verificación de origen) | **Falta**: hoy el instalador se compila en local con `npm run release` |
| Cada versión necesita aprobación manual de la firma | Hay que aprobarla en la web de SignPath |
| Roles del equipo: autores, revisores y aprobadores | El autor del repositorio ocupa los tres |
| Verificación en dos pasos en GitHub y en SignPath para todo el equipo | Comprobarla |
| Sección «Política de firma» en la portada y en las páginas de descarga | **Falta** (texto más abajo) |
| Nombre y versión del producto iguales en todos los binarios firmados | Tauri ya pone `pdfiiuum` y la versión en los metadatos |
| No cambiar la configuración del sistema sin avisar y ofrecer desinstalación | Cumple: el instalador solo se registra como opción para abrir PDF y tiene desinstalador |
| Política de privacidad si se envían datos a sistemas que el usuario no ha indicado | No aplica: la app no hace conexiones por su cuenta |

**Consecuencias:**
- El certificado se emite a nombre de SignPath Foundation, que aparece como editor del programa (no pdfiiuum ni su autor).
- SignPath no garantiza que SmartScreen deje de avisar desde el primer día: Windows también tiene en cuenta la reputación que el archivo va acumulando.
- `pdfium.dll` (de bblanchon/pdfium-binaries) no viene firmada. SignPath admite hoy bibliotecas de terceros sin firmar dentro de un instalador firmado, pero avisa de que en el futuro podría exigir que todo lo incluido vaya firmado.

## Qué habría que preparar en el repositorio

1. **Flujo de publicación en GitHub Actions** (`.github/workflows/release.yml`), lanzado al subir una etiqueta `vX.Y.Z`. Todo en máquinas de GitHub (`windows-latest`) y sin cachés de compilaciones anteriores, porque la verificación de origen lo exige.
   1. `npm ci` y `node scripts/build.mjs --no-bundle`: compila `pdfiiuum.exe` sin rutas del equipo.
   2. Subir `pdfiiuum.exe` con `actions/upload-artifact` (v4 o posterior) y pedir la firma con `signpath/github-action-submit-signing-request@v3`. La acción espera a que se apruebe y descarga el ejecutable firmado.
   3. `npx tauri bundle --bundles nsis`: genera el instalador con el ejecutable ya firmado.
   4. Subirlo y pedir su firma igual que en el paso 2 (segunda aprobación).
   5. Crear un borrador de la versión en GitHub con el instalador firmado y su SHA-256.

   Los pasos de firma pueden depender de que exista la variable del repositorio con el identificador de la organización de SignPath. Así el flujo genera el instalador sin firmar mientras tanto, y eso además demuestra en la solicitud que se compila en GitHub.
2. **Sección «Política de firma»** en el README y en las notas de cada versión:

   > Free code signing provided by SignPath.io, certificate by SignPath Foundation.
   >
   > - Autores y revisores: [@aydearcas](https://github.com/aydearcas)
   > - Aprobadores: [@aydearcas](https://github.com/aydearcas)
   >
   > Privacidad: este programa no transfiere información a otros sistemas en red salvo que lo pida expresamente quien lo usa o lo instala.

3. Quitar del README y de las notas de versión el paso de «Windows protegió su PC» cuando ya no haga falta.

## Qué tendría que hacer el autor

1. Activar la verificación en dos pasos en GitHub.
2. Enviar la solicitud en [signpath.org/apply](https://signpath.org/apply), con el repositorio, la licencia, la descripción y el enlace a la política de firma.
3. Cuando la aprueben, configurar en SignPath:
   - el proyecto enlazado al repositorio de GitHub como sistema de compilación de confianza;
   - dos configuraciones de artefacto: el ejecutable y el instalador, con el nombre del producto `pdfiiuum` y su versión como restricciones de metadatos;
   - una política de firma con «Verify origin», limitada a la rama `main` y con aprobación manual;
   - un usuario de CI con un token de API.
4. Añadir al repositorio el secreto `SIGNPATH_API_TOKEN` y las variables con el identificador de la organización y los nombres del proyecto y de la política.

## Referencias

- [Condiciones de SignPath Foundation](https://signpath.org/terms)
- [Integración con GitHub Actions](https://docs.signpath.io/trusted-build-systems/github)
- [Verificación de origen](https://docs.signpath.io/origin-verification)
