# Deployment Guide

This guide explains how to deploy the FLAC Player application to various static hosting platforms.

## Prerequisites

1. Build the application:
   ```bash
   npm install
   npm run build
   ```

2. The build output will be in the `dist/` directory.

## Cross-origin isolation (required headers)

Every page response must carry these two headers, or the page is not
cross-origin isolated (`window.crossOriginIsolated === false`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The shipped configs also send `Cross-Origin-Resource-Policy: same-origin` on the
app's own files. COEP doesn't need it for same-origin loads; it stops other
sites from embedding the bundle.

**What breaks without isolation.** `SharedArrayBuffer` is unavailable, so:

| Feature | Without isolation |
|---|---|
| Worklet backend play ring / projectM tap | Falls back to `chunk` / `postMessage` transport (works, more main-thread copies) |
| Analysis ring (`?gpu_fft=1` live spectrum, WASM FFT golden) | Off; the visualizer reads the `AnalyserNode` |
| SDL3 backend (`-pthread` build) | Fails to initialize |
| Streaming (default), EQ, ShaderGUI, projectM | Unaffected (projectM is built without `-pthread`) |

The 🎛 debug panel in ShaderGUI shows `crossOriginIsolated: yes/no`.

**Service worker.** `<base>/service-worker.js` (`/service-worker.js` for a root
deploy, `/flac-player/service-worker.js` under `PUBLIC_PATH=/flac-player/`) must
be served as JavaScript with `Cache-Control: no-cache`, never as the SPA
`index.html` fallback. Header rules for it must use the base path.

**Cross-origin resources under COEP `require-corp`.** Each one has to opt in, or
the browser blocks it:

- **Audio** (`<audio crossorigin="anonymous">`, `fetch`): CORS-mode, so the audio
  host must send `Access-Control-Allow-Origin` (see
  [CORS Configuration for Audio Sources](#cors-configuration-for-audio-sources)).
  storage.noahcohn.com does.
- **Cover art** (`TopScreen`): requested CORS-mode first, then no-cors. Each
  artwork host must send either `Access-Control-Allow-Origin` or
  `Cross-Origin-Resource-Policy: cross-origin`. If it sends neither, the art is
  hidden and the title, album and spec overlay stays. Embedded art (`blob:` URLs)
  always works. Test load-from-URL tracks from a non-noahcohn host (#255) when
  you change art or headers.

**Verify a deploy:**
```bash
curl -sI https://<host>/<base>/ | grep -i cross-origin
curl -sI https://<host>/<base>/some/deep/link | grep -i cross-origin   # SPA fallback too
curl -sI https://<host>/<base>/service-worker.js | grep -i -E 'content-type|cache-control'
```
Locally: `npm run build && npm run test:e2e:prod`. It serves `dist/` with the
`vercel.json` header rules (`scripts/serve-dist.mjs`) and asserts
`crossOriginIsolated === true`. Set `PUBLIC_PATH` to the value the build used to
test a subpath deploy. CI runs the same check.

## Deployment Options

### 1. Apache/Nginx Server

Copy the contents of the `dist/` directory to your web server's document root.

**Apache .htaccess example** (requires `mod_headers` and `mod_rewrite`):
```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>

AddType text/javascript .js
AddType application/wasm .wasm

<IfModule mod_headers.c>
  # Cross-origin isolation; "always" also covers error / fallback responses.
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Embedder-Policy "require-corp"
  Header always set Cross-Origin-Resource-Policy "same-origin"

  <Files "service-worker.js">
    Header set Cache-Control "no-cache"
  </Files>

  # Only if this server also hosts audio for other origins.
  <FilesMatch "\.(flac|wav|mp3)$">
    Header set Access-Control-Allow-Origin "*"
    Header set Cross-Origin-Resource-Policy "cross-origin"
  </FilesMatch>
</IfModule>
```

**Subpath deploy (e.g. `https://go.1ink.us/flac-player/`):** build with
`PUBLIC_PATH=/flac-player/ npm run build`, upload `dist/` so `index.html` lands at
`<docroot>/flac-player/index.html`, and put this `.htaccess` next to it. Point
`ErrorDocument` at a file that exists under the same docroot (a missing target is what
produces the "misconfigured ErrorDocument" 404 page), and make sure
`/flac-player/service-worker.js` is served as JavaScript, not the SPA fallback.
`<Files>` matches by file name, so in this directory it applies to
`/flac-player/service-worker.js`.
```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /flac-player/
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /flac-player/index.html [L]
</IfModule>
ErrorDocument 404 /flac-player/index.html

AddType text/javascript .js
AddType application/wasm .wasm

<IfModule mod_headers.c>
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Embedder-Policy "require-corp"
  Header always set Cross-Origin-Resource-Policy "same-origin"

  <Files "service-worker.js">
    Header set Cache-Control "no-cache"
  </Files>
</IfModule>
```
`scripts/deploy.py` uploads `dist/` to the storage manager folder `flac-player`
(requires `DEPLOY_TOKEN`); confirm that folder is the one served at `/flac-player/`
and that its server honours `.htaccess` headers (`AllowOverride FileInfo`, or put
the same `Header` lines in the vhost).

**Nginx configuration example:**
```nginx
# /etc/nginx/snippets/flac-player-coi.conf
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
```
```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/dist;
    index index.html;

    include snippets/flac-player-coi.conf;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # A location with its own add_header drops the server-level ones: re-include.
    location = /service-worker.js {
        include snippets/flac-player-coi.conf;
        add_header Cache-Control "no-cache" always;
    }

    # Only if this server also hosts audio for other origins.
    # (Subresources don't need COOP/COEP, so no re-include here.)
    location ~* \.(flac|wav|mp3)$ {
        add_header Access-Control-Allow-Origin * always;
        add_header Cross-Origin-Resource-Policy "cross-origin" always;
    }
}
```
For a subpath, use `location /flac-player/ { try_files $uri $uri/ /flac-player/index.html; }`
and `location = /flac-player/service-worker.js { … }`. Check that `mime.types`
maps `.wasm` to `application/wasm`.

### 2. GitHub Pages

GitHub Pages **cannot set response headers**, so a Pages deploy is never
cross-origin isolated. Playback, EQ, ShaderGUI and projectM work. The
`SharedArrayBuffer` features listed in
[Cross-origin isolation](#cross-origin-isolation-required-headers) degrade or
are unavailable (SDL3 doesn't start). The app's own service worker doesn't
inject COOP/COEP into navigation responses. A coi-serviceworker-style shim would
need that, and it would only take effect after a reload. It isn't implemented,
so use a host that sets headers if you need the full feature set.

Pages is a project subpath (`https://<user>.github.io/<repo>/`): build with
`PUBLIC_PATH=/<repo>/`.

1. Install the gh-pages package:
   ```bash
   npm install --save-dev gh-pages
   ```

2. Add deployment scripts to `package.json`:
   ```json
   "scripts": {
     "predeploy": "PUBLIC_PATH=/<repo>/ npm run build",
     "deploy": "gh-pages -d dist"
   }
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

### 3. Netlify

The repo's `netlify.toml` already sets the headers:
```toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
    Cross-Origin-Resource-Policy = "same-origin"

[[headers]]
  for = "/service-worker.js"   # "/<base>/service-worker.js" when built with PUBLIC_PATH
  [headers.values]
    Cache-Control = "no-cache"
    Cross-Origin-Resource-Policy = "same-origin"
```

**Option A: Drag and Drop**
1. Build the project locally
2. Go to https://app.netlify.com/drop
3. Drag the `dist/` folder to the upload area. The headers in `netlify.toml` do
   **not** apply to a drag-and-drop deploy; add a `dist/_headers` file with the
   same rules, or use Option B.

**Option B: Continuous Deployment**
1. Keep the repo's `netlify.toml` (build command, publish dir, SPA redirect, headers).
2. Connect your GitHub repository to Netlify
3. Netlify will automatically build and deploy

### 4. Vercel

The repo's `vercel.json` sets the headers (the same file drives
`npm run test:e2e:prod`). Excerpt:
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" }
      ]
    },
    {
      "source": "/:base*/service-worker.js",
      "headers": [{ "key": "Cache-Control", "value": "no-cache" }]
    }
  ]
}
```
`/:base*/service-worker.js` matches both `/service-worker.js` and
`/<base>/service-worker.js`.

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Deploy:
   ```bash
   vercel --prod
   ```

Or connect your GitHub repository to Vercel for automatic deployments.

### 5. AWS S3 + CloudFront

S3 alone can't send COOP/COEP (object metadata only covers a fixed set of
headers), so an S3 website endpoint is not isolated. Put CloudFront in front and
attach a **response headers policy**.

1. Build the project
2. Create an S3 bucket and upload the `dist/` contents
3. Create a CloudFront distribution with the bucket as origin
4. Create and attach the response headers policy to the default cache behavior:
   ```bash
   aws cloudfront create-response-headers-policy --response-headers-policy-config '{
     "Name": "flac-player-coi",
     "CustomHeadersConfig": {
       "Quantity": 3,
       "Items": [
         { "Header": "Cross-Origin-Opener-Policy", "Value": "same-origin", "Override": true },
         { "Header": "Cross-Origin-Embedder-Policy", "Value": "require-corp", "Override": true },
         { "Header": "Cross-Origin-Resource-Policy", "Value": "same-origin", "Override": true }
       ]
     }
   }'
   ```
5. Add a cache behavior for `service-worker.js` (`<base>/service-worker.js` under
   `PUBLIC_PATH`) with the `CachingDisabled` cache policy and the same response
   headers policy.
6. SPA fallback: custom error responses 403 and 404 → `/index.html` (`/<base>/index.html`), status 200.
   Check with `curl -sI` on a deep link that the fallback carries the COOP/COEP headers.

**S3 CORS Configuration** (only if the bucket also serves audio to other origins):
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": []
  }
]
```

## CORS Configuration for Audio Sources

If you're serving FLAC/WAV files from your own server, ensure CORS is properly configured:

**For Google Cloud Storage:**
1. Create a CORS configuration file `cors.json`:
   ```json
   [
     {
       "origin": ["*"],
       "method": ["GET"],
       "responseHeader": ["Content-Type"],
       "maxAgeSeconds": 3600
     }
   ]
   ```

2. Apply the configuration:
   ```bash
   gsutil cors set cors.json gs://your-bucket-name
   ```

**For your own server:**
Add the following headers to your audio file responses:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
```
Artwork hosts need `Access-Control-Allow-Origin` or
`Cross-Origin-Resource-Policy: cross-origin`. See
[Cross-origin isolation](#cross-origin-isolation-required-headers).

## Testing Deployment

After deployment, test with these sample URLs (replace with your actual audio files):
- Google Cloud Storage: `https://storage.googleapis.com/bucket-name/file.flac`
- Your server: `https://your-domain.com/audio/file.flac`

Open the 🎛 debug panel and check `crossOriginIsolated: yes`.

## Troubleshooting

### CORS Errors
- Ensure the audio source server has CORS headers configured
- Check browser console for specific CORS error messages
- `net::ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep`:
  a cross-origin resource has neither CORS nor `Cross-Origin-Resource-Policy: cross-origin`

### SDL3 Backend Fails ("SDL Module failed to initialize")
- The page isn't cross-origin isolated; see the headers above and the 🎛 panel

### WebGPU Not Working
- WebGPU requires a modern browser (Chrome 113+, Edge 113+)
- Must be served over HTTPS (except localhost)
- ShaderGUI will show a fatal visualizer panel if WebGPU is not supported; audio playback remains available and no WebGL2/Canvas2D renderer is started

### Audio Not Playing
- Verify the audio file URL is accessible
- Check file format is FLAC or WAV
- Ensure audio file is not corrupted
- Check browser console for decoding errors
