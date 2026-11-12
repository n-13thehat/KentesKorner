!include nsDialogs.nsh
!define KENTE_INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define KENTE_UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"

!ifndef BUILD_UNINSTALLER
Var MaintenanceInstallDir
Var MaintenanceUninstallArgs
Var MaintenanceUpdateRadio
Var MaintenanceRepairRadio
Var MaintenanceUninstallRadio
Var MaintenanceStatus

!macro customWelcomePage
  Page custom MaintenancePageCreate MaintenancePageLeave
!macroend

Function MaintenancePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "Updates and repairs reinstall the app in its existing folder and keep your ROMs, saves, and settings."
  Pop $1

  ${NSD_CreateRadioButton} 0 40u 100% 14u "Install or update Kente's Korner"
  Pop $MaintenanceUpdateRadio
  ${NSD_Check} $MaintenanceUpdateRadio

  ${NSD_CreateRadioButton} 0 62u 100% 14u "Repair the existing installation"
  Pop $MaintenanceRepairRadio

  ${NSD_CreateRadioButton} 0 84u 100% 14u "Uninstall the existing version"
  Pop $MaintenanceUninstallRadio

  ReadRegStr $MaintenanceInstallDir SHCTX "${KENTE_INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $MaintenanceInstallDir == ""
    ReadRegStr $MaintenanceInstallDir HKCU "${KENTE_INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $MaintenanceInstallDir == ""
    ReadRegStr $MaintenanceInstallDir HKLM "${KENTE_INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $MaintenanceInstallDir != ""
      StrCpy $MaintenanceUninstallArgs "/allusers"
    ${EndIf}
  ${EndIf}
  ${If} $MaintenanceInstallDir == ""
    EnableWindow $MaintenanceRepairRadio 0
    EnableWindow $MaintenanceUninstallRadio 0
  ${Else}
    StrCpy $INSTDIR $MaintenanceInstallDir
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function MaintenancePageLeave
  ${NSD_GetState} $MaintenanceUpdateRadio $0
  ${If} $0 == ${BST_CHECKED}
    Return
  ${EndIf}

  ${NSD_GetState} $MaintenanceRepairRadio $0
  ${If} $0 == ${BST_CHECKED}
    Return
  ${EndIf}

  ${NSD_GetState} $MaintenanceUninstallRadio $0
  ${If} $0 == ${BST_CHECKED}
    ${If} $MaintenanceInstallDir == ""
      Abort
    ${EndIf}
    IfFileExists "$MaintenanceInstallDir\${KENTE_UNINSTALL_FILENAME}" 0 maintenance_uninstall_missing
    ExecWait "$\"$MaintenanceInstallDir\${KENTE_UNINSTALL_FILENAME}$\" $MaintenanceUninstallArgs /S" $MaintenanceStatus
    ${If} $MaintenanceStatus == 0
      Quit
    ${EndIf}
    MessageBox MB_ICONSTOP "The existing installation could not be removed (code $MaintenanceStatus). Setup stopped."
    Abort
  ${EndIf}

maintenance_uninstall_missing:
  MessageBox MB_ICONSTOP "The existing installation's uninstaller is missing. Run Repair to replace the app files."
  Abort
FunctionEnd
!endif
