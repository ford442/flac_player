/**
 * Embeddable mini player builds (docs/EMBED.md) — separate from the full app's
 * webpack.config.js, which is unchanged.
 *
 *   dist-embed/flac-mini-player.js   script-tag / iframe bundle (React included)
 *   dist-embed/embed.html            iframe page
 *   dist-embed/lib/index.js          ESM library; react / react-dom are peer imports
 *
 * Only src/embed/** (plus EQChain band layout and contextContract) is reachable: no
 * Dexie, projectM, ffmpeg, workbox, WebGPU or Tailwind.
 */
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const tsRule = {
  test: /\.tsx?$/,
  use: { loader: 'ts-loader', options: { compilerOptions: { noEmit: false } } },
  exclude: /node_modules/,
};

const shared = (argv) => ({
  mode: argv.mode || 'production',
  devtool: argv.mode === 'development' ? 'eval-source-map' : 'source-map',
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: { rules: [tsRule] },
  performance: { hints: false },
});

module.exports = (env = {}, argv = {}) => [
  {
    ...shared(argv),
    name: 'standalone',
    entry: { 'flac-mini-player': './src/embed/standalone.tsx' },
    output: {
      path: path.resolve(__dirname, 'dist-embed'),
      filename: '[name].js',
      publicPath: 'auto',
      clean: { keep: /^lib\// },
    },
    plugins: [
      new HtmlWebpackPlugin({ template: './public/embed.html', filename: 'embed.html', inject: 'body' }),
    ],
  },
  {
    ...shared(argv),
    name: 'lib',
    entry: { index: './src/embed/index.ts' },
    experiments: { outputModule: true },
    externalsType: 'module',
    externals: { react: 'react', 'react-dom/client': 'react-dom/client', 'react/jsx-runtime': 'react/jsx-runtime' },
    output: {
      path: path.resolve(__dirname, 'dist-embed/lib'),
      filename: '[name].js',
      library: { type: 'module' },
      clean: true,
    },
  },
];
