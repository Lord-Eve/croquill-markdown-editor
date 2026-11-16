; NSIS installer hooks for Croquill file association preservation.
; Pure ASCII only. Works with Tauri's generated installer.nsi template
; without modifying templates or Tauri-generated files.
;
; Goals for each HKCU\Software\Classes\.<ext> (.md, .markdown):
; 1. Install: if current (Default) != Croquill.Markdown, record it as original
;    and distinguish "value absent" (backup_exists="0") vs empty "" ("1").
;    If current (Default) == Croquill.Markdown (reinstall/overwrite), keep prior
;    recorded original instead of overwriting it with Croquill.Markdown.
; 2. Uninstall when current (Default) == Croquill.Markdown: restore original;
;    if originally absent, delete (Default) rather than writing "", and delete
;    the extension key if it has neither subkeys nor values left.
; 3. Uninstall when current (Default) != Croquill.Markdown: preserve current
;    state instead of restoring Croquill's backup.
; 4. Uninstall cleanup: remove Croquill.Markdown_backup and
;    Croquill.Markdown_backup_exists from both extension keys.
; 5. Safe under /UPDATE mode as well.

Var CroquillMdOrigExists
Var CroquillMdOrigVal
Var CroquillMdnOrigExists
Var CroquillMdnOrigVal

Var CroquillMdUninstCurrExists
Var CroquillMdUninstCurrVal
Var CroquillMdUninstOrigExists
Var CroquillMdUninstOrigVal

Var CroquillMdnUninstCurrExists
Var CroquillMdnUninstCurrVal
Var CroquillMdnUninstOrigExists
Var CroquillMdnUninstOrigVal

Var CroquillEnumTmp

!macro CROQUILL_CAPTURE_ORIG EXT OUT_EXISTS OUT_VAL
  ClearErrors
  ReadRegStr ${OUT_VAL} HKCU "Software\Classes\.${EXT}" ""
  ${If} ${Errors}
    StrCpy ${OUT_EXISTS} "0"
    StrCpy ${OUT_VAL} ""
  ${ElseIf} ${OUT_VAL} == "Croquill.Markdown"
    ClearErrors
    ReadRegStr ${OUT_EXISTS} HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup_exists"
    ${IfNot} ${Errors}
    ${AndIf} ${OUT_EXISTS} == "1"
      ClearErrors
      ReadRegStr ${OUT_VAL} HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup"
      ${If} ${Errors}
      ${OrIf} ${OUT_VAL} == "Croquill.Markdown"
        StrCpy ${OUT_EXISTS} "0"
        StrCpy ${OUT_VAL} ""
      ${EndIf}
    ${ElseIfNot} ${Errors}
    ${AndIf} ${OUT_EXISTS} == "0"
      StrCpy ${OUT_VAL} ""
    ${Else}
      ; Fallback if backup_exists is missing or invalid (e.g. from older build)
      ClearErrors
      ReadRegStr ${OUT_VAL} HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup"
      ${If} ${Errors}
      ${OrIf} ${OUT_VAL} == ""
      ${OrIf} ${OUT_VAL} == "Croquill.Markdown"
        StrCpy ${OUT_EXISTS} "0"
        StrCpy ${OUT_VAL} ""
      ${Else}
        StrCpy ${OUT_EXISTS} "1"
      ${EndIf}
    ${EndIf}
  ${Else}
    ; Non-Croquill value (including an existing explicit empty string "")
    StrCpy ${OUT_EXISTS} "1"
  ${EndIf}
  ClearErrors
!macroend

!macro CROQUILL_COMMIT_ORIG EXT IN_EXISTS IN_VAL
  WriteRegStr HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup" "${IN_VAL}"
  WriteRegStr HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup_exists" "${IN_EXISTS}"
  ClearErrors
!macroend

!macro CROQUILL_CAPTURE_UNINST EXT CURR_EXISTS CURR_VAL ORIG_EXISTS ORIG_VAL
  ClearErrors
  ReadRegStr ${CURR_VAL} HKCU "Software\Classes\.${EXT}" ""
  ${If} ${Errors}
    StrCpy ${CURR_EXISTS} "0"
    StrCpy ${CURR_VAL} ""
  ${Else}
    StrCpy ${CURR_EXISTS} "1"
  ${EndIf}

  ClearErrors
  ReadRegStr ${ORIG_EXISTS} HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup_exists"
  ${IfNot} ${Errors}
  ${AndIf} ${ORIG_EXISTS} == "1"
    ClearErrors
    ReadRegStr ${ORIG_VAL} HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup"
    ${If} ${Errors}
    ${OrIf} ${ORIG_VAL} == "Croquill.Markdown"
      StrCpy ${ORIG_EXISTS} "0"
      StrCpy ${ORIG_VAL} ""
    ${EndIf}
  ${ElseIfNot} ${Errors}
  ${AndIf} ${ORIG_EXISTS} == "0"
    StrCpy ${ORIG_VAL} ""
  ${Else}
    ClearErrors
    ReadRegStr ${ORIG_VAL} HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup"
    ${If} ${Errors}
    ${OrIf} ${ORIG_VAL} == ""
    ${OrIf} ${ORIG_VAL} == "Croquill.Markdown"
      StrCpy ${ORIG_EXISTS} "0"
      StrCpy ${ORIG_VAL} ""
    ${Else}
      StrCpy ${ORIG_EXISTS} "1"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro CROQUILL_RESTORE_UNINST EXT CURR_EXISTS CURR_VAL ORIG_EXISTS ORIG_VAL
  ${If} ${CURR_EXISTS} == "1"
  ${AndIf} ${CURR_VAL} == "Croquill.Markdown"
    ${If} ${ORIG_EXISTS} == "1"
      WriteRegStr HKCU "Software\Classes\.${EXT}" "" "${ORIG_VAL}"
    ${Else}
      DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
    ${EndIf}
  ${Else}
    ${If} ${CURR_EXISTS} == "1"
      WriteRegStr HKCU "Software\Classes\.${EXT}" "" "${CURR_VAL}"
    ${Else}
      DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
    ${EndIf}
  ${EndIf}

  DeleteRegValue HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup"
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "Croquill.Markdown_backup_exists"

  ; Delete key only when it contains neither subkeys nor any values
  ClearErrors
  EnumRegKey $CroquillEnumTmp HKCU "Software\Classes\.${EXT}" 0
  ${If} ${Errors}
    ClearErrors
    EnumRegValue $CroquillEnumTmp HKCU "Software\Classes\.${EXT}" 0
    ${If} ${Errors}
      DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CROQUILL_CAPTURE_ORIG "md" $CroquillMdOrigExists $CroquillMdOrigVal
  !insertmacro CROQUILL_CAPTURE_ORIG "markdown" $CroquillMdnOrigExists $CroquillMdnOrigVal
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro CROQUILL_COMMIT_ORIG "md" $CroquillMdOrigExists $CroquillMdOrigVal
  !insertmacro CROQUILL_COMMIT_ORIG "markdown" $CroquillMdnOrigExists $CroquillMdnOrigVal
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CROQUILL_CAPTURE_UNINST "md" $CroquillMdUninstCurrExists $CroquillMdUninstCurrVal $CroquillMdUninstOrigExists $CroquillMdUninstOrigVal
  !insertmacro CROQUILL_CAPTURE_UNINST "markdown" $CroquillMdnUninstCurrExists $CroquillMdnUninstCurrVal $CroquillMdnUninstOrigExists $CroquillMdnUninstOrigVal
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro CROQUILL_RESTORE_UNINST "md" $CroquillMdUninstCurrExists $CroquillMdUninstCurrVal $CroquillMdUninstOrigExists $CroquillMdUninstOrigVal
  !insertmacro CROQUILL_RESTORE_UNINST "markdown" $CroquillMdnUninstCurrExists $CroquillMdnUninstCurrVal $CroquillMdnUninstOrigExists $CroquillMdnUninstOrigVal
!macroend
