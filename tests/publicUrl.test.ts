import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicUrl, resolvePublicUrl } from '../src/utils/publicUrl';
import { registerServiceWorker, serviceWorkerLocation } from '../src/sw/serviceWorkerClient';

const globals = globalThis as { __webpack_public_path__?: string };

describe('resolvePublicUrl', () => {
  it('stays root-relative at the site root, as before', () => {
    expect(resolvePublicUrl('dsp-chain.wasm', '', 'https://h/')).toBe('/dsp-chain.wasm');
    expect(resolvePublicUrl('/icons/icon-192.png', 'https://h/', 'https://h/index.html')).toBe('/icons/icon-192.png');
  });

  it('follows the bundle directory when deployed under a path', () => {
    const page = 'https://h/flac-player/index.html?room=1';
    expect(resolvePublicUrl('service-worker.js', 'https://h/flac-player/', page)).toBe('/flac-player/service-worker.js');
    expect(resolvePublicUrl('/projectm/projectm-host.js', 'https://h/flac-player/', page)).toBe('/flac-player/projectm/projectm-host.js');
  });

  it('treats an empty public path as next to the page', () => {
    expect(resolvePublicUrl('dsp-chain.wasm', '', 'https://h/flac-player/')).toBe('/flac-player/dsp-chain.wasm');
    expect(resolvePublicUrl('dsp-chain.wasm', '', 'https://h/flac-player/index.html')).toBe('/flac-player/dsp-chain.wasm');
  });

  it('accepts a root-relative public path with or without the trailing slash', () => {
    expect(resolvePublicUrl('a.wasm', '/assets/', 'https://h/x/')).toBe('/assets/a.wasm');
    expect(resolvePublicUrl('a.wasm', '/assets', 'https://h/x/')).toBe('/assets/a.wasm');
  });

  it('keeps another origin absolute', () => {
    expect(resolvePublicUrl('a.wasm', 'https://cdn.example.com/app/', 'https://h/')).toBe('https://cdn.example.com/app/a.wasm');
  });
});

describe('service worker location', () => {
  afterEach(() => {
    delete globals.__webpack_public_path__;
    vi.unstubAllEnvs();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('is the site root when the bundle is served from it', () => {
    globals.__webpack_public_path__ = 'http://localhost:3000/';
    expect(publicUrl('service-worker.js')).toBe('/service-worker.js');
    expect(serviceWorkerLocation()).toEqual({ scriptUrl: '/service-worker.js', scope: '/' });
  });

  it('moves with the public path, scope included', () => {
    globals.__webpack_public_path__ = 'http://localhost:3000/flac-player/';
    expect(serviceWorkerLocation()).toEqual({
      scriptUrl: '/flac-player/service-worker.js',
      scope: '/flac-player/',
    });
  });

  it('registers the worker where the app is served, not at the origin root', async () => {
    globals.__webpack_public_path__ = 'http://localhost:3000/flac-player/';
    vi.stubEnv('NODE_ENV', 'production');
    const register = vi.fn(async () => ({ addEventListener: vi.fn(), installing: null }));
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, addEventListener: vi.fn(), controller: null },
    });

    await registerServiceWorker();

    expect(register).toHaveBeenCalledWith('/flac-player/service-worker.js', { scope: '/flac-player/' });
  });
});
