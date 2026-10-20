# Genera las imágenes del README (docs/*.png) a partir de docs/manual/*.html con Edge sin ventana.
# Edge informa por la salida de error («N bytes written»): no se trata como fallo.
$root = Split-Path $PSScriptRoot -Parent
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "No se encuentra Microsoft Edge" }

$profile = Join-Path $env:TEMP "pdfiiuum-render-docs"
foreach ($page in "portada", "interfaz") {
  $src = Join-Path $root "docs\manual\$page.html"
  $out = Join-Path $root "docs\manual-$page.png"
  Remove-Item $out -ErrorAction SilentlyContinue
  $edgeArgs = @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--user-data-dir=$profile",
    "--force-device-scale-factor=2", "--window-size=630,893", "--screenshot=$out",
    ("file:///" + ($src -replace "\\", "/"))
  )
  Start-Process -FilePath $edge -ArgumentList $edgeArgs -Wait -WindowStyle Hidden
  if (-not (Test-Path $out)) { throw "No se generó $out" }
  Write-Host "docs\manual-$page.png"
}
