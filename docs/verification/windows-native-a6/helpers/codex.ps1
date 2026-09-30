# harmless Cliora verification fixture, npm package evidence: node_modules/@openai/codex
if ($args.Count -eq 1 -and $args[0] -eq '--version') { Write-Output 'codex-cli 0.159.2'; exit 0 }
$env:CLIORA_VERIFICATION_SHELL_PID="$PID"
$env:CLIORA_VERIFICATION_MARKER='cliora-native-verification-20260930'
$Host.UI.RawUI.WindowTitle='Cliora native verification 20260930'
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\12976\AppData\Local\Temp\cliora-native-verification\fixtures\terminal-probe.mjs' @args
