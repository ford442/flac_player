const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

// Load environment variables from .env file for frontend build
require('dotenv').config();

// Build env vars for DefinePlugin
const envVars = {};
['REACT_APP_API_URL', 'REACT_APP_GA_ID', 'REACT_APP_MIXPANEL_TOKEN'].forEach(key => {
  envVars[`process.env.${key}`] = JSON.stringify(process.env[key] || '');
});

module.exports = {
  entry: './src/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.[contenthash].js',
    clean: true
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx']
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        // Exclude node_modules and SDL generated build artifacts to avoid accidental inclusion
        exclude: /node_modules|src\/sdl\/build/
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/index.html',
      filename: 'index.html'
    }),
    // Inject environment variables into the bundle
    new webpack.DefinePlugin(envVars),
    // Ensure sdl-audio.* and script processor files from public/ are copied into dist/
    new CopyPlugin({
      patterns: [
        { from: 'public/sdl-audio.*', to: '[name][ext]' },
        { from: 'public/sdl2-audio.*', to: '[name][ext]' },
        { from: 'public/script-processor-*.js', to: '[name][ext]' }
      ]
    })
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'public')
    },
    compress: true,
    port: 3000,
    hot: true,
    // Proxy API requests to the backend server
    proxy: {
      '/api': {
        target: 'http://localhost:7860',
        changeOrigin: true,
        secure: false
      }
    },
    // Required for AudioWorklet and cross-origin isolation during development
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  }
};
