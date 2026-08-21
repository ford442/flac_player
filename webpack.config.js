const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const { InjectManifest } = require('workbox-webpack-plugin');
const webpack = require('webpack');
const fs = require('fs');

require('dotenv').config();

const envVars = {};
['REACT_APP_API_URL', 'REACT_APP_PLAYLIST_API_URL', 'REACT_APP_GA_ID', 'REACT_APP_MIXPANEL_TOKEN', 'REACT_APP_DEBUG'].forEach(key => {
  envVars[`process.env.${key}`] = JSON.stringify(process.env[key] || '');
});

const SDL_ARTIFACTS = [
  'sdl-audio.js',
  'sdl-audio.wasm',
  'sdl2-audio.js',
  'sdl2-audio.wasm',
];

function wasmArtifactsPresent(publicDir) {
  return SDL_ARTIFACTS.every(name => fs.existsSync(path.join(publicDir, name)));
}

module.exports = (env = {}, argv = {}) => {
  const skipWasm = env.skipWasm === true || env.skipWasm === 'true';
  const publicDir = path.resolve(__dirname, 'public');
  const hasWasm = wasmArtifactsPresent(publicDir);

  if (!skipWasm && !hasWasm) {
    console.warn(
      '[webpack] SDL WASM artifacts missing in public/. ' +
      'Run `npm run build:wasm` or build with `--env skipWasm=true` (CI uses pre-committed binaries).'
    );
  }

  const copyPatterns = [
    { from: 'public/script-processor-*.js', to: '[name][ext]' },
    { from: 'public/manifest.json', to: 'manifest.json' },
    { from: 'public/icons', to: 'icons' },
    // Small UMD wrapper + worker for client-side convert (core WASM loaded from CDN).
    { from: 'public/ffmpeg', to: 'ffmpeg' },
  ];

  if (hasWasm) {
    copyPatterns.push(
      { from: 'public/sdl-audio.*', to: '[name][ext]' },
      { from: 'public/sdl2-audio.*', to: '[name][ext]' },
    );
  } else if (!skipWasm) {
    throw new Error(
      'SDL WASM artifacts missing. Run `npm run build:wasm` or pass --env skipWasm=true.'
    );
  }

  const projectmDir = path.join(publicDir, 'projectm');
  if (fs.existsSync(path.join(projectmDir, 'projectm-host.js'))) {
    copyPatterns.push({ from: 'public/projectm', to: 'projectm' });
  }

  return {
    entry: './src/index.tsx',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'bundle.[contenthash].js',
      clean: true,
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.jsx'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules|src\/sdl\/build/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './public/index.html',
        filename: 'index.html',
      }),
      new webpack.DefinePlugin(envVars),
      new CopyPlugin({ patterns: copyPatterns }),
      ...(argv.mode === 'production'
        ? [
          new InjectManifest({
            swSrc: './src/sw/service-worker.ts',
            swDest: 'service-worker.js',
            maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
            additionalManifestEntries: [
              { url: '/manifest.json', revision: null },
              { url: '/icons/icon-192.png', revision: null },
              { url: '/icons/icon-512.png', revision: null },
            ],
          }),
        ]
        : []),
    ],
    // @ffmpeg/ffmpeg uses dynamic require paths; harmless under webpack 5.
    ignoreWarnings: [
      {
        module: /@ffmpeg\/ffmpeg/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ],
    devServer: {
      static: {
        directory: path.join(__dirname, 'public'),
      },
      compress: true,
      port: 3000,
      hot: true,
      client: {
        overlay: {
          errors: true,
          warnings: false,
          // Chrome delivers this as window.onerror when a ResizeObserver
          // callback mutates layout in the same frame. Harmless; the overlay
          // would otherwise intercept Playwright clicks in e2e.
          runtimeErrors: (error) =>
            !/ResizeObserver loop/.test(error?.message || String(error)),
        },
      },
      proxy: {
        '/api': {
          target: 'http://localhost:7860',
          changeOrigin: true,
          secure: false,
        },
      },
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    // SDL player modules are dynamically imported when the user selects SDL backends.
    optimization: {
      splitChunks: {
        cacheGroups: {
          sdl3: {
            test: /[\\/]Sdl3AudioPlayer\.ts$/,
            name: 'sdl3-player',
            chunks: 'async',
          },
          sdl2: {
            test: /[\\/]Sdl2AudioPlayer\.ts$/,
            name: 'sdl2-player',
            chunks: 'async',
          },
          projectm: {
            test: /[\\/]projectm[\\/]ProjectMEngine\.ts$/,
            name: 'projectm-engine',
            chunks: 'async',
          },
        },
      },
    },
  };
};
