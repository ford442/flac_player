# projectM WASM (optional)

In-app Milkdrop visuals are loaded from this directory when built.

```bash
npm run build:projectm   # requires emsdk + cmake; ~5–15 min first run
```

Expected artifacts after build:

- `projectm-host.js`
- `projectm-host.wasm`
- `projectm-host.data` (bundled `.milk` presets)

Without these files the app falls back to ShaderGUI automatically.
