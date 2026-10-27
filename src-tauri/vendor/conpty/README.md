# Bundled ConPTY

The workbench hosts CLIs in a Windows pseudo console. `portable-pty` loads a
`conpty.dll` that sits next to `cliora.exe` before it falls back to the copy in
`kernel32.dll`. This directory ships that sideloaded ConPTY together with the
`OpenConsole.exe` host it starts.

Why: the inbox ConPTY re-renders the console instead of passing VT through. It drops
the mouse-tracking (`CSI ? 1000/1003/1006 h`) and autowrap (`CSI ? 7 l`) switches that
full-screen CLIs such as Pi send, so the wheel never reaches them and their alternate
screen repaints drift. The bundled ConPTY forwards those modes, which is what Windows
Terminal and VS Code ship for the same reason.

| File | SHA-256 |
| --- | --- |
| `x64/conpty.dll` | `5afea6c9480e2c7dfd195376dd10996b0ae25cdc6f014e6247fd8aedc8c34852` |
| `x64/OpenConsole.exe` | `6f8e68dec4e8e5e15a54ecc8afa127b0e62139edc004ffbb4892125ff01d5737` |

Source: NuGet `Microsoft.Windows.Console.ConPTY` 1.24.261001001
(`runtimes/win-x64/native/conpty.dll` and `build/native/runtimes/x64/OpenConsole.exe`;
package SHA-256 `4d6aaddc1d2385c9f5897df28f33879f699f8f2783315d5204cf3d8c3616ac5f`),
built from microsoft/terminal under the MIT license in `LICENSE`.

- Installers: `tauri.windows.conf.json` maps both files into the install directory.
- Development: `build.rs` copies them next to the debug or release executable.
- Other architectures fall back to the inbox ConPTY until a matching build is added here.

To update, download the package, replace both files, and update the hashes above.
