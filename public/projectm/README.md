# projectM WASM (optional)

In-app Milkdrop visuals are loaded from this directory when built.

```bash
npm run build:projectm   # requires emsdk + cmake; ~5–15 min first run
```

Expected artifacts after build:

- `projectm-host.js`
- `projectm-host.wasm`

Presets are not bundled. `presets.json` lists a curated subset of projectM's
[Cream of the Crop](https://github.com/projectM-visualizer/presets-cream-of-the-crop)
pack at a pinned commit; `ProjectMEngine` fetches each `.milk` from the
manifest's `base` (jsDelivr) only when it is shown, and the service worker
caches it. Set `REACT_APP_PROJECTM_PRESET_BASE` at build time to use a mirror;
under COEP `require-corp` it must answer CORS. `?preset=<path in pack>` opens a
preset directly. The pack's `LICENSE.md` says the presets were released freely
without a specific license and treats them as public domain; we link to them
rather than redistribute them.

Without the WASM files the app falls back to ShaderGUI automatically; without
the preset pack (offline, CDN blocked) projectM shows its idle preset and local
`.milk` files can still be opened.
