import { describe, expect, it, vi } from 'vitest';
import { ProjectMEngine, projectMBufferSize, type ProjectMWasmModule } from '../src/projectm/ProjectMEngine';
import {
  PresetFetcher,
  PresetPlaylist,
  buildPresetShareUrl,
  isSafePresetPath,
  parsePresetManifest,
  presetDisplayName,
  presetUrl,
  readPresetFromSearch,
} from '../src/projectm/presetLibrary';

/** Fake host module: records calls, accepts presets unless their text says BROKEN. */
function fakeModule() {
  const memory = new WebAssembly.Memory({ initial: 4 });
  let next = 1024;
  const calls = {
    init: 0,
    paused: [] as number[],
    resized: [] as Array<[number, number]>,
    mallocs: 0,
    frees: 0,
    pcm: [] as number[][],
    locked: [] as number[],
    loaded: [] as string[],
  };
  const mod: ProjectMWasmModule = {
    _pm_init: () => { calls.init += 1; return 1; },
    _pm_resize: (w, h) => { calls.resized.push([w, h]); },
    _pm_add_pcm: (ptr, count) => { calls.pcm.push(Array.from(new Float32Array(memory.buffer, ptr, count))); },
    _pm_load_preset_data: (ptr, length) => {
      const text = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length));
      calls.loaded.push(text);
      return text.includes('BROKEN') ? 0 : 1;
    },
    _pm_set_preset_locked: (v) => { calls.locked.push(v); },
    _pm_set_beat_sensitivity: () => {},
    _pm_set_paused: (v) => { calls.paused.push(v); },
    _pm_destroy: () => {},
    _malloc: (size) => { calls.mallocs += 1; const p = next; next += size + 16; return p; },
    _free: () => { calls.frees += 1; },
    wasmMemory: memory,
  };
  return { mod, calls };
}

const PACK = { name: 'pack', bases: ['https://cdn.example/pack/'], presets: ['A/one.milk', 'B/two.milk', 'C/BROKEN.milk', 'D/four.milk'] };

function makeEngine(overrides: { initialPreset?: string | null; manifestFails?: boolean } = {}) {
  const { mod, calls } = fakeModule();
  const loadModule = vi.fn(async () => mod);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(`milk:${String(input)}`));
  const engine = new ProjectMEngine({
    loadModule,
    loadManifest: async () => {
      if (overrides.manifestFails) throw new Error('offline');
      return PACK;
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    random: () => 0,
    initialPreset: () => overrides.initialPreset ?? null,
  });
  return { engine, mod, calls, loadModule, fetchImpl };
}

/** Wait until the first pack preset is on screen. */
async function settle(engine: ProjectMEngine): Promise<void> {
  await vi.waitFor(() => expect(engine.getPresetState().current).not.toBeNull());
}

describe('ProjectMEngine lifecycle (#259 G3)', () => {
  it('instantiates once for concurrent and repeated loads', async () => {
    const { engine, loadModule, calls } = makeEngine();
    const results = await Promise.all([engine.load(), engine.load()]);
    expect(results).toEqual([true, true]);
    expect(await engine.load()).toBe(true);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(calls.init).toBe(1);
  });

  it('moves one canvas between hosts and pauses the loop with no host attached', async () => {
    const { engine, calls } = makeEngine();
    const projectmSlot = document.createElement('div');
    const splitSlot = document.createElement('div');
    const detachProjectm = engine.attach(projectmSlot);
    await engine.load();
    const canvas = engine.getCanvas();
    expect(canvas.parentNode).toBe(projectmSlot);

    // projectm → split: React mounts the new host, then cleans up the old one.
    const detachSplit = engine.attach(splitSlot);
    detachProjectm();
    expect(canvas.parentNode).toBe(splitSlot);
    expect(engine.getCanvas()).toBe(canvas);
    expect(calls.paused).toEqual([]);

    detachSplit();
    expect(canvas.parentNode).toBeNull();
    expect(calls.paused).toEqual([1]);

    const detachAgain = engine.attach(projectmSlot);
    expect(canvas.parentNode).toBe(projectmSlot);
    expect(calls.paused).toEqual([1, 0]);
    detachAgain();
    detachAgain(); // idempotent
    expect(calls.paused).toEqual([1, 0, 1]);
    expect(calls.init).toBe(1);
  });

  it('applies a pause requested before the module was ready', async () => {
    const { engine, calls } = makeEngine();
    const detach = engine.attach(document.createElement('div'));
    detach();
    await engine.load();
    expect(calls.paused).toEqual([1]);
  });

  it('sizes the drawing buffer from CSS px × DPR, capped at 2', async () => {
    expect(projectMBufferSize(400, 200, 1)).toEqual({ width: 400, height: 200 });
    expect(projectMBufferSize(400, 200, 1.5)).toEqual({ width: 600, height: 300 });
    expect(projectMBufferSize(400, 200, 3)).toEqual({ width: 800, height: 400 });
    const { engine, calls } = makeEngine();
    await engine.load();
    engine.resize(400, 225, 2);
    expect(engine.getCanvas().width).toBe(800);
    expect(engine.getCanvas().height).toBe(450);
    engine.resize(400, 225, 2);
    expect(calls.resized).toEqual([[800, 450]]);
  });

  it('feeds PCM through one persistent staging buffer', async () => {
    const { engine, calls } = makeEngine();
    await engine.load();
    const mallocsAfterLoad = calls.mallocs;
    for (let i = 0; i < 10; i++) engine.addPCM(new Float32Array([i, -i]), 2);
    expect(calls.mallocs - mallocsAfterLoad).toBe(1);
    expect(calls.frees).toBe(0);
    expect(calls.pcm[9]).toEqual([9, -9]);
    engine.addPCM(new Float32Array(8192), 2); // grows once
    expect(calls.mallocs - mallocsAfterLoad).toBe(2);
    expect(calls.frees).toBe(1);
  });
});

describe('ProjectMEngine presets (#259 G5)', () => {
  it('opens ?preset= first, otherwise a random pack preset', async () => {
    const linked = makeEngine({ initialPreset: 'B/two.milk' });
    await linked.engine.load();
    await settle(linked.engine);
    expect(linked.engine.getPresetState()).toMatchObject({ library: 'ready', current: 'B/two.milk', name: 'two', count: 4 });

    const plain = makeEngine();
    await plain.engine.load();
    await settle(plain.engine);
    expect(plain.engine.getPresetState().current).toBe('A/one.milk');
    expect(plain.fetchImpl).toHaveBeenCalledWith('https://cdn.example/pack/A/one.milk', expect.objectContaining({ mode: 'cors' }));
  });

  it('skips presets projectM rejects and walks next / back / random', async () => {
    const { engine } = makeEngine({ initialPreset: 'B/two.milk' });
    await engine.load();
    await settle(engine);
    expect(await engine.nextPreset()).toBe(true);
    expect(engine.getPresetState().current).toBe('D/four.milk'); // C rejected, skipped
    expect(await engine.prevPreset()).toBe(true);
    expect(engine.getPresetState().current).toBe('B/two.milk');
    expect(await engine.randomPreset()).toBe(true);
    expect(engine.getPresetState().current).toBe('A/one.milk');
  });

  it('lock stops auto-switching requested by projectM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { engine, mod, calls } = makeEngine({ initialPreset: 'A/one.milk' });
      await engine.load();
      await vi.waitFor(() => expect(engine.getPresetState().current).toBe('A/one.milk'));
      engine.setPresetLocked(true);
      expect(calls.locked).toEqual([1]);
      const loadedBefore = calls.loaded.length;
      mod.onPresetSwitchRequested?.(false);
      await vi.runAllTimersAsync();
      expect(calls.loaded.length).toBe(loadedBefore);

      engine.setPresetLocked(false);
      mod.onPresetSwitchRequested?.(false);
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(engine.getPresetState().current).not.toBe('A/one.milk'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pick made while the linked preset loads is not replaced by the fallback', async () => {
    const { engine } = makeEngine({ initialPreset: 'B/two.milk' });
    await engine.load();
    const pick = engine.showPreset('D/four.milk');
    expect(await pick).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.getPresetState().current).toBe('D/four.milk');
  });

  it('keeps working without the pack', async () => {
    const { engine } = makeEngine({ manifestFails: true });
    expect(await engine.load()).toBe(true);
    await vi.waitFor(() => expect(engine.getPresetState().library).toBe('unavailable'));
    expect(await engine.nextPreset()).toBe(false);
    expect(engine.loadLocalPreset('mine.milk', 'per_frame_1=x')).toBe(true);
    expect(engine.getPresetState()).toMatchObject({ current: null, name: 'mine' });
    expect(engine.loadLocalPreset('bad.milk', 'BROKEN')).toBe(false);
  });
});

describe('presetLibrary', () => {
  it('accepts only pack-relative .milk paths', () => {
    expect(isSafePresetPath('Dancer/Whirl/a b.milk')).toBe(true);
    for (const bad of ['../x.milk', 'a/../x.milk', '/abs.milk', 'https://evil/x.milk', 'a\\b.milk', 'x.txt', 'a//b.milk']) {
      expect(isSafePresetPath(bad), bad).toBe(false);
    }
  });

  it('parses the manifest, drops unsafe entries, and lets the env base win', () => {
    const json = { name: 'n', base: 'https://cdn/x', mirrors: ['https://raw/y'], presets: ['a.milk', '../b.milk', 3] };
    expect(parsePresetManifest(json, '')).toEqual({ name: 'n', bases: ['https://cdn/x/', 'https://raw/y/'], presets: ['a.milk'] });
    expect(parsePresetManifest(json, 'https://mirror/').bases).toEqual(['https://mirror/']);
    expect(() => parsePresetManifest({ presets: [] }, '')).toThrow();
  });

  it('builds encoded URLs, display names and share links', () => {
    expect(presetUrl('https://cdn/', 'Dancer/a b#1.milk')).toBe('https://cdn/Dancer/a%20b%231.milk');
    expect(presetDisplayName('Dancer/Whirl/Geiss - x.milk')).toBe('Geiss - x');
    const link = buildPresetShareUrl('Dancer/a b.milk', 'https://app.example/flac-player/?room=r1');
    const url = new URL(link);
    expect(url.searchParams.get('preset')).toBe('Dancer/a b.milk');
    expect(url.searchParams.get('room')).toBe('r1');
    expect(url.searchParams.get('aesthetic')).toBe('projectm');
    expect(new URL(buildPresetShareUrl('a.milk', 'https://x/?aesthetic=split')).searchParams.get('aesthetic')).toBe('split');
    expect(readPresetFromSearch(url.search)).toBe('Dancer/a b.milk');
    expect(readPresetFromSearch('?preset=../../etc.milk')).toBeNull();
  });

  it('playlist history goes back through what was shown', () => {
    const list = new PresetPlaylist(['a.milk', 'b.milk', 'c.milk'], () => 0.99);
    list.markShown('a.milk');
    list.markShown('c.milk');
    list.markShown('b.milk');
    expect(list.back()).toBe('c.milk');
    list.markShown('c.milk');
    expect(list.back()).toBe('a.milk');
    expect(list.randomPick()).not.toBe(list.getCurrent());
  });

  it('fetcher caches recent presets', async () => {
    const fetchImpl = vi.fn(async () => new Response('text'));
    const fetcher = new PresetFetcher(['https://cdn/'], fetchImpl as unknown as typeof fetch, 2);
    await fetcher.fetch('a.milk');
    await fetcher.fetch('a.milk');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(fetcher.fetch('missing.milk')).rejects.toThrow(/404/);
  });

  it('fetcher falls back to the mirrors on HTTP or network errors', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith('https://cdn/')) return new Response('', { status: 403 });
      if (url.startsWith('https://down/')) throw new TypeError('Failed to fetch');
      return new Response('from raw');
    });
    const fetcher = new PresetFetcher(['https://cdn/', 'https://down/', 'https://raw/'], fetchImpl as unknown as typeof fetch);
    expect(await fetcher.fetch('a.milk')).toBe('from raw');
    expect(seen).toEqual(['https://cdn/a.milk', 'https://down/a.milk', 'https://raw/a.milk']);
  });

  it('the committed manifest parses and every entry is a safe pack path', async () => {
    const fs = await import('fs');
    const raw = JSON.parse(fs.readFileSync('public/projectm/presets.json', 'utf8')) as { presets: string[] };
    const manifest = parsePresetManifest(raw, '');
    expect(manifest.presets.length).toBe(raw.presets.length);
    expect(manifest.presets.length).toBeGreaterThan(100);
    expect(manifest.bases[0]).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/.+@[0-9a-f]{40}\/$/);
    expect(manifest.bases[1]).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\/[0-9a-f]{40}\/$/);
  });
});
