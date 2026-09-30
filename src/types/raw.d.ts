/** `?raw` imports: webpack `asset/source` (webpack.config.js) and Vite/Vitest built-in. */
declare module '*?raw' {
  const source: string;
  export default source;
}
