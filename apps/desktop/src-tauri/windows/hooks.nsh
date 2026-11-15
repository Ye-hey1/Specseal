; NSIS installer hooks（desktop-app spec「安装 CLI 指令到 PATH」，design D5）：
; 安装完成后把安装目录写入用户 PATH（HKCU\Environment）——CLI sidecar 与
; desktop 同目录，写入后新终端可直接运行 specseal；升级重跑安装器即同版。
; 自含式实作：不依赖模板的 StrFunc／WinMessages include 状态。

; StrStr（回传自 needle 起的子字符串；空字符串＝未找到）。
Function SpecsealStrStr
  Exch $R1 ; needle
  Exch
  Exch $R2 ; haystack
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R4 0
  specseal_strstr_loop:
    StrCpy $R5 $R2 $R3 $R4
    StrCmp $R5 $R1 specseal_strstr_done
    StrCmp $R5 "" specseal_strstr_done
    IntOp $R4 $R4 + 1
    Goto specseal_strstr_loop
  specseal_strstr_done:
  StrCpy $R1 $R5
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R1
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  Push $0
  Push "$INSTDIR"
  Call SpecsealStrStr
  Pop $1
  ; 已在 PATH（含升级重跑）即不重复追加。
  StrCmp $1 "" specseal_add_path specseal_path_done
specseal_add_path:
  StrCmp $0 "" specseal_path_empty
  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
  Goto specseal_path_notify
specseal_path_empty:
  WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
specseal_path_notify:
  ; HWND_BROADCAST / WM_WININICHANGE 以数值自含（0xFFFF／0x1A）：通知既有进程
  ; 环境变量已变，新开终端即得新 PATH。
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
specseal_path_done:
!macroend
