# Deployment Guide

This guide explains how to deploy the FLAC Player application to various static hosting platforms.

## Prerequisites

1. Build the application:
   ```bash
   npm install
   npm run build
   ```

2. The build output will be in the `dist/` directory.

## Deployment Options

### 1. Apache/Nginx Server

Copy the contents of the `dist/` directory to your web server's document root.

**Apache .htaccess example:**
```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>

# Enable CORS if serving audio files
<IfModule mod_headers.c>
  Header set Access-Control-Allow-Origin "*"
</IfModule>
```

**Nginx configuration example:**
```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Enable CORS if serving audio files
    location ~* \.(flac|wav)$ {
        add_header Access-Control-Allow-Origin *;
    }
}
```

### 2. GitHub Pages

1. Install the gh-pages package:
   ```bash
   npm install --save-dev gh-pages
   ```

2. Add deployment scripts to `package.json`:
   ```json
   "scripts": {
     "predeploy": "npm run build",
     "deploy": "gh-pages -d dist"
   }
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

### 3. Netlify

**Option A: Drag and Drop**
1. Build the project locally
2. Go to https://app.netlify.com/drop
3. Drag the `dist/` folder to the upload area

**Option B: Continuous Deployment**
1. Create a `netlify.toml` file:
   ```toml
   [build]
     command = "npm run build"
     publish = "dist"
   ```

2. Connect your GitHub repository to Netlify
3. Netlify will automatically build and deploy

### 4. Vercel

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

1. Build the project
2. Create an S3 bucket for static website hosting
3. Upload the `dist/` contents to the bucket
4. Configure bucket for static website hosting
5. (Optional) Set up CloudFront for CDN

**S3 CORS Configuration:**
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

## Testing Deployment

After deployment, test with these sample URLs (replace with your actual audio files):
- Google Cloud Storage: `https://storage.googleapis.com/bucket-name/file.flac`
- Your server: `https://your-domain.com/audio/file.flac`

## Troubleshooting

### CORS Errors
- Ensure the audio source server has CORS headers configured
- Check browser console for specific CORS error messages

### WebGPU Not Working
- WebGPU requires a modern browser (Chrome 113+, Edge 113+)
- Must be served over HTTPS (except localhost)
- The app will fallback gracefully if WebGPU is not supported

### Audio Not Playing
- Verify the audio file URL is accessible
- Check file format is FLAC or WAV
- Ensure audio file is not corrupted
- Check browser console for decoding errors
