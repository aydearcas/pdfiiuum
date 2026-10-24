; Registro de pdfiiuum como aplicación capaz de abrir PDF.
; SHCTX es HKLM al instalar para todos los usuarios (Program Files) y HKCU si fuera por usuario.
; No cambia el programa predeterminado: Windows obliga a que eso lo elija el usuario
; en Configuración > Aplicaciones predeterminadas.

!define PDFIIUUM_PROGID "pdfiiuum.pdf"
!define PDFIIUUM_CAPS "Software\pdfiiuum\Capabilities"
; Puente con la extensión del navegador (mensajería nativa de Edge, Chrome y Brave)
!define PDFIIUUM_HOST "com.pdfiiuum.open"

; El visor de la extensión cambia de nombres de archivo en cada versión: se quita el
; anterior para que no se acumulen archivos viejos al actualizar.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\extension\viewer"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ProgID con icono y comando de apertura
  WriteRegStr SHCTX "Software\Classes\${PDFIIUUM_PROGID}" "" "Documento PDF"
  WriteRegStr SHCTX "Software\Classes\${PDFIIUUM_PROGID}" "FriendlyTypeName" "Documento PDF"
  ; Icono de documento (hoja con «PDF») para los archivos; la app conserva el suyo
  WriteRegStr SHCTX "Software\Classes\${PDFIIUUM_PROGID}\DefaultIcon" "" "$INSTDIR\pdf-document.ico"
  WriteRegStr SHCTX "Software\Classes\${PDFIIUUM_PROGID}\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\${PDFIIUUM_PROGID}\shell\open" "" "Abrir con ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${PDFIIUUM_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Aparece en «Abrir con» para .pdf sin quitarle el sitio a la aplicación actual
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "${PDFIIUUM_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".pdf" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Capacidades: hace que salga en Configuración > Aplicaciones predeterminadas
  WriteRegStr SHCTX "${PDFIIUUM_CAPS}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${PDFIIUUM_CAPS}" "ApplicationDescription" "Lector de PDF ligero"
  WriteRegStr SHCTX "${PDFIIUUM_CAPS}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "${PDFIIUUM_CAPS}\FileAssociations" ".pdf" "${PDFIIUUM_PROGID}"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${PDFIIUUM_CAPS}"

  ; La extensión «Abrir en pdfiiuum» habla con pdfiiuum.exe a través de este manifiesto
  WriteRegStr SHCTX "Software\Microsoft\Edge\NativeMessagingHosts\${PDFIIUUM_HOST}" "" "$INSTDIR\native-messaging-host.json"
  WriteRegStr SHCTX "Software\Google\Chrome\NativeMessagingHosts\${PDFIIUUM_HOST}" "" "$INSTDIR\native-messaging-host.json"
  WriteRegStr SHCTX "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\${PDFIIUUM_HOST}" "" "$INSTDIR\native-messaging-host.json"

  ; Avisa al Explorador de que han cambiado las asociaciones
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\${PDFIIUUM_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "${PDFIIUUM_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey SHCTX "Software\pdfiiuum"
  DeleteRegKey SHCTX "Software\Microsoft\Edge\NativeMessagingHosts\${PDFIIUUM_HOST}"
  DeleteRegKey SHCTX "Software\Google\Chrome\NativeMessagingHosts\${PDFIIUUM_HOST}"
  DeleteRegKey SHCTX "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\${PDFIIUUM_HOST}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
