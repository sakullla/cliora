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
- `opencode.png`: Official https://opencode.ai/favicon-96x96-v3.png linked from https://opencode.ai/brand . Original pixel mark retained.
  SHA-256: `aa34092540de60c889610edfa3c25316e215f12d88af29cfba530d09aee7265c`.

Declare future icons in the independent `src/features/tools/adapters/<tool>.ts` module using `ToolUiAdapter.icon` (`light`, optional `dark`, `fit`, `tile`, `scale`, and `source`) and register the module in `adapters/index.ts`. All pages use `src/components/ToolIcon.tsx`; tools without metadata, including a newly registered sixth adapter or future Kimi adapter, receive a neutral SVG symbol beside their text name. No network requests are needed for ordinary icon rendering.
