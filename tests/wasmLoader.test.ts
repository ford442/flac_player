import { describe, expect, it } from 'vitest';
import { loadWasmScript } from '../src/audio/wasmLoader';

describe('loadWasmScript (#259 G3)', () => {
  it('shares one in-flight load and resolves only on the load event', async () => {
    const url = '/fake/glue-a.js';
    const first = loadWasmScript(url);
    const second = loadWasmScript(url);
    expect(second).toBe(first);
    const scripts = document.querySelectorAll(`script[src="${url}"]`);
    expect(scripts).toHaveLength(1);

    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // the tag exists, but it has not loaded
    scripts[0]!.dispatchEvent(new Event('load'));
    await first;
    expect(settled).toBe(true);
    await expect(loadWasmScript(url)).resolves.toBeUndefined();
  });

  it('forgets a failed load so the next call retries', async () => {
    const url = '/fake/glue-b.js';
    const first = loadWasmScript(url);
    document.querySelector(`script[src="${url}"]`)!.dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow(/Failed to load/);
    expect(document.querySelector(`script[src="${url}"]`)).toBeNull();
    const retry = loadWasmScript(url);
    expect(retry).not.toBe(first);
    document.querySelector(`script[src="${url}"]`)!.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBeUndefined();
  });
});
