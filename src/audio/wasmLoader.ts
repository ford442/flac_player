/** Lazy-load Emscripten glue scripts from public/ (not bundled into the main JS chunk). */

const loaded = new Set<string>();

export function loadWasmScript(url: string): Promise<void> {
  if (loaded.has(url)) return Promise.resolve();

  const existing = document.querySelector(`script[src="${url}"]`);
  if (existing) {
    loaded.add(url);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      loaded.add(url);
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(script);
  });
}

export const WASM_ASSETS = {
  sdl3: '/sdl-audio.js',
  sdl2: '/sdl2-audio.js',
  scriptProcessorShim: '/script-processor-shim.js',
  projectmHost: '/projectm/projectm-host.js',
} as const;
