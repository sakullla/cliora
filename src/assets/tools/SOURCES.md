# Bundled tool icon sources

These assets render offline. Product symbols remain in their original colors; custom raster overrides are separate portable preference content.

- `codex.svg`: Official Codex product symbol extracted unchanged from the installed OpenAI.Codex 26.924.2738.0 package, app/resources/app.asar/webview/assets/codex-new-f14177b03534.svg. This is the Codex terminal mark, not the OpenAI/ChatGPT blossom. A quiet light tile preserves its original black paths in dark mode.
  SHA-256: `0b490f33f9c5b62c7db578f5101497efb87b774720f91b9e878243e761952c52`.
- `claude.svg`: Official Claude symbol: first symbol path extracted unchanged (orange #D97757) from https://code.claude.com/docs/logo/light.svg linked by https://code.claude.com/docs/en/overview. Original CDN source https://mintcdn.com/claude-code/c5r9_6tjPMzFdDDT/logo/light.svg . Only the symbol is separated from the wordmark; paths and color are retained.
  SHA-256: `19e1177ad4661cd6b4e20f45294ac5bcd795a897d7ed681671f7ba34e2ad42da`.
- `grok.svg`: Official https://grok.com/images/favicon.svg . Original white mark on black tile retained.
  SHA-256: `c3db0dfaf760b702b8490c6cbefe07fd8bfe00db43cae6a0acccf768f44d6179`.
- `pi.svg`: Official https://pi.dev/logo-auto.svg . Original three-color pixel P and paths retained; renderer scale compensates for the spacious original 800×800 viewBox.
  SHA-256: `abd66e7868b2d24f0f0895f9237ee8a6dcb22337583b0dc54aeb595acecb4d6b`.
- `opencode.svg`: Official https://opencode.ai/favicon-v3.svg, retained unchanged (612 bytes). The original white pixel mark on a dark tile replaces the former PNG and stays clear at small sizes in both themes. Its bytes match the upstream SVG at https://raw.githubusercontent.com/anomalyco/opencode/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/ui/src/assets/favicon/favicon-v3.svg . Brand resources: https://opencode.ai/brand .
  SHA-256: `e29bbe33380ad1c1ada9134b52f229d30e9776d60481512c9d81f2bb6f37def9`.
- `zcode.svg`: Official z.ai logo retained unchanged from https://z-cdn.chatglm.cn/z-ai/static/logo.svg (z.ai CDN). Original white Z on its own dark rounded tile with a hairline white stroke; the tile renders identically in both themes.
  SHA-256: `07a45e8e35b0b631ed2c68cd1cb041f9721b1ceeb0bd0e34f1459b0304a741c7`.
- `qoder.svg`: Official https://qoder.com/favIcon.svg retained unchanged. Original dark mark on its own light rounded tile; the tile renders identically in both themes.
  SHA-256: `5e1843cb50c4613855024453e76d5c06d2ca5562efebc12b4fcd80cf9ece1dd0`.
- `deepseek.svg`: Official https://api-docs.deepseek.com/img/favicon.svg retained unchanged. Original DeepSeek whale in brand blue #4D6BFE; the renderer's default tile supplies the background in both themes.
  SHA-256: `0bf5e13ce954f13423a692f083f5cb0f4bcfde35c8b812f64efe89dabfdaed20`.
- `codebuddy.svg`: Official CodeBuddy mark extracted unchanged from the installed @tencent-ai/codebuddy-code 2.161.1 npm package, dist/web-ui/pwa-icon.svg. Original white glyph on its own dark #1f1f1f tile.
  SHA-256: `012799424922a9b8dcfaa9e30a7596133bc8a99d10056d18fb8b16dbe0d199c3`.
- `kimi_code.svg`: Official Kimi symbol: the K path extracted unchanged (white) from https://platform.kimi.com/kimi.svg and placed on the black rounded tile of the official https://www.kimi.com/pwa-192.png app icon. Only the symbol is separated from the wordmark; path and color are retained. The raster mark's blue accent dot is not reproduced (no official vector source).
  SHA-256: `c366c98f46d7ccac6826bda7474817e14cb977ac10e7fa7286196705943ec581`.
- `mimo_code.png`: Official square lockup from https://platform.xiaomimimo.com/favicon.png (white Xiaomi MiMo wordmark on black). The public vector at https://mimo.xiaomi.com/coder/assets/logo.svg is a single-line wordmark with `preserveAspectRatio="none"` and does not read as an icon. Original PNG retained.
  SHA-256: `30f5305380e8a2f85c652b905ef5e155e0c00c7d56d7ab6bd8b1eb40dad61ba7`.
- `cline.svg`: Official dark-ink mark from https://cline.bot/assets/branding/logos/cline-icon-dark.svg, used on light surfaces. Paths and #1C1C24 fill retained.
  SHA-256: `3840c1a6f86cf98012af536e2f21157ab0b3ff541e0992ebf4d77307a9a809dc`.
- `cline_dark.svg`: Official light mark from https://cline.bot/assets/branding/logos/cline-icon.svg, used on dark surfaces. Paths and #F0F4FF fill retained.
  SHA-256: `aaeadd69d7a6140ead2ef4092e9b97eba80d6fe7548e31dd5d1c80529e127ab5`.
- `devin.svg`: Official https://devin.ai/favicon.svg retained unchanged. Original black geometric mark; a quiet light tile preserves it in dark mode.
  SHA-256: `fe0753d2e3823bc1eb8a37943234fac63733b8c9e8abff0ca0402a6c7ddcd682`.
- `command_code.svg`: Official mark extracted unchanged from the installed command-code 1.73.4 package, vsix/extension/icons/icon-light.svg. Original #424242 command symbol, used on light surfaces.
  SHA-256: `1e7fe66ca259c1c33040d5b0dba40dd0588dbf5a7edee175773a8044b5189379`.
- `command_code_dark.svg`: Official mark from the same package, vsix/extension/icons/icon-dark.svg. Original white command symbol, used on dark surfaces.
  SHA-256: `df9dce3a1f405eb3946c830a3b92609db4a0a1221af4dc3e0d9c2febb616bdd7`.
- `antigravity.svg`: Official https://antigravity.google/favicon.svg retained unchanged. Original multicolor mark on its circular tile.
  SHA-256: `de7911c3d206a3d2fe3d5b4e76e84b185c581d7a259406f64db247b5b824f02e`.
- `kiro.svg`: Official https://kiro.dev/icon.svg retained unchanged. Original white mark on its #9046FF rounded tile.
  SHA-256: `774cbc1c7ecec8c935a6091595583d7a92fc8289d6f1db3f071c0f50c61c369f`.

Declare future icons in the independent `src/adapters/<tool>/index.ts` module using `ToolUiAdapter.icon` (`light`, optional `dark`, `fit`, `tile`, `scale`, and `source`) and register the module in `adapters/index.ts`. All pages use `src/components/ToolIcon.tsx`; tools without icon metadata receive a neutral SVG symbol beside their text name. No network requests are needed for ordinary icon rendering.
