// Unmounting ProjectMHost (aesthetic toggle, route change) must stop the host and drop its GL
// context; a remount, or React's StrictMode re-run, must end with exactly one live module.

import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectMEngine, type ProjectMWasmModule } from '../src/projectm/ProjectMEngine';
import { ProjectMHost } from '../src/components/ProjectMHost';

interface FakeGl {
  gl: WebGL2RenderingContext;
  lost: () => boolean;
}

function fakeGl(): FakeGl {
  let lost = false;
  const gl = {
    isContextLost: () => lost,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => { lost = true; } } : null),
  } as unknown as WebGL2RenderingContext;
  return { gl, lost: () => lost };
}

/** A canvas whose GL context is the fake one (what the module's SDL init would have created). */
function glCanvas(gl: FakeGl): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getContext = vi.fn((type: string) => (type === 'webgl2' ? gl.gl : null)) as never;
  return canvas;
}

interface FakeModuleBundle {
  module: ProjectMWasmModule;
  init: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeModule(initResult = 1): FakeModuleBundle {
  const init = vi.fn(() => initResult);
  const destroy = vi.fn();
  const module = {
    _pm_init: init,
    _pm_destroy: destroy,
    _pm_resize: vi.fn(),
    _pm_add_pcm: vi.fn(),
    _pm_next_preset: vi.fn(),
    _pm_prev_preset: vi.fn(),
    _pm_load_preset_data: vi.fn(),
    _pm_set_beat_sensitivity: vi.fn(),
    _malloc: vi.fn(),
    _free: vi.fn(),
  } as unknown as ProjectMWasmModule;
  return { module, init, destroy };
}

/** createProjectMModule that hands out `modules` in order, optionally held back by `gate`. */
function installFactory(modules: FakeModuleBundle[], gate?: Promise<void>) {
  const create = vi.fn(async () => {
    if (gate) await gate;
    return modules[create.mock.calls.length - 1].module;
  });
  (window as unknown as { createProjectMModule: unknown }).createProjectMModule = create;
  return create;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete (window as unknown as { createProjectMModule?: unknown }).createProjectMModule;
  vi.restoreAllMocks();
});

describe('ProjectMEngine lifecycle', () => {
  it('destroy() runs _pm_destroy and loses the GL context of a detached canvas', async () => {
    const gl = fakeGl();
    const canvas = glCanvas(gl);
    const bundle = fakeModule();
    installFactory([bundle]);
    const engine = new ProjectMEngine();

    expect(await engine.load(canvas)).toBe(true);
    expect(engine.getStatus()).toBe('ready');
    engine.destroy(canvas);

    expect(bundle.destroy).toHaveBeenCalledOnce();
    expect(gl.lost()).toBe(true);
    expect(engine.getStatus()).toBe('idle');
  });

  it('keeps the context of a canvas that is still attached (effect re-run on the same canvas)', async () => {
    const gl = fakeGl();
    const canvas = glCanvas(gl);
    document.body.appendChild(canvas);
    const bundle = fakeModule();
    installFactory([bundle]);
    const engine = new ProjectMEngine();

    await engine.load(canvas);
    engine.destroy(canvas);
    canvas.remove();

    expect(bundle.destroy).toHaveBeenCalledOnce();
    expect(gl.lost()).toBe(false);
  });

  it('reloads after destroy() instead of returning the stale module', async () => {
    const first = fakeModule();
    const second = fakeModule();
    const create = installFactory([first, second]);
    const engine = new ProjectMEngine();

    await engine.load(glCanvas(fakeGl()));
    engine.destroy();
    expect(await engine.load(glCanvas(fakeGl()))).toBe(true);

    expect(create).toHaveBeenCalledTimes(2);
    expect(second.init).toHaveBeenCalledOnce();
    expect(engine.getStatus()).toBe('ready');
  });

  it('replaces a module bound to another canvas', async () => {
    const gl = fakeGl();
    const first = fakeModule();
    const second = fakeModule();
    installFactory([first, second]);
    const engine = new ProjectMEngine();

    await engine.load(glCanvas(gl));
    await engine.load(glCanvas(fakeGl()));

    expect(first.destroy).toHaveBeenCalledOnce();
    expect(gl.lost()).toBe(true);
    expect(second.init).toHaveBeenCalledOnce();
  });

  it('leaves a newer owner alone when an older canvas destroys', async () => {
    const bundle = fakeModule();
    installFactory([bundle]);
    const engine = new ProjectMEngine();
    await engine.load(glCanvas(fakeGl()));

    engine.destroy(glCanvas(fakeGl()));

    expect(bundle.destroy).not.toHaveBeenCalled();
    expect(engine.getStatus()).toBe('ready');
  });

  it('does not leave a ready module behind when destroy() races a pending load', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bundle = fakeModule();
    installFactory([bundle], gate);
    const engine = new ProjectMEngine();
    const gl = fakeGl();
    const canvas = glCanvas(gl);

    const pending = engine.load(canvas);
    engine.destroy(canvas);
    release();

    expect(await pending).toBe(false);
    expect(bundle.init).not.toHaveBeenCalled();
    expect(engine.getStatus()).toBe('idle');
    // Never initialised, so no GL context was created just to be lost.
    expect(canvas.getContext).not.toHaveBeenCalled();
  });

  it('tears the module down when _pm_init fails', async () => {
    const gl = fakeGl();
    const bundle = fakeModule(0);
    installFactory([bundle]);
    const engine = new ProjectMEngine();

    expect(await engine.load(glCanvas(gl))).toBe(false);

    expect(engine.getStatus()).toBe('error');
    expect(bundle.destroy).toHaveBeenCalledOnce();
    expect(gl.lost()).toBe(true);
  });
});

describe('ProjectMHost', () => {
  let container: HTMLDivElement;
  let root: Root;
  let glByCanvas: Map<HTMLCanvasElement, FakeGl>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    glByCanvas = new Map();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      type: string,
    ) {
      if (type !== 'webgl2') return null;
      if (!glByCanvas.has(this)) glByCanvas.set(this, fakeGl());
      return glByCanvas.get(this)!.gl as never;
    } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = (engine: ProjectMEngine, extra: Record<string, unknown> = {}, strict = false) => {
    const host = createElement(ProjectMHost, { engine, ...extra });
    return act(async () => { root.render(strict ? createElement(StrictMode, null, host) : host); });
  };

  it('destroys the engine and loses the GL context on unmount', async () => {
    const bundle = fakeModule();
    installFactory([bundle]);
    const engine = new ProjectMEngine();

    await mount(engine);
    await flush();
    expect(engine.getStatus()).toBe('ready');
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(bundle.destroy).not.toHaveBeenCalled();

    act(() => root.unmount());

    expect(bundle.destroy).toHaveBeenCalledOnce();
    expect(glByCanvas.get(canvas)?.lost()).toBe(true);
    expect(engine.getStatus()).toBe('idle');
    root = createRoot(container);
  });

  it('loads a fresh module when the host mounts again', async () => {
    const first = fakeModule();
    const second = fakeModule();
    const create = installFactory([first, second]);
    const engine = new ProjectMEngine();

    await mount(engine);
    await flush();
    act(() => root.unmount());
    root = createRoot(container);
    await mount(engine);
    await flush();

    expect(create).toHaveBeenCalledTimes(2);
    expect(second.init).toHaveBeenCalledOnce();
    expect(engine.getStatus()).toBe('ready');
  });

  it('does not restart the engine when the parent passes new inline callbacks', async () => {
    const bundle = fakeModule();
    const create = installFactory([bundle]);
    const engine = new ProjectMEngine();
    const onReady = vi.fn();

    await mount(engine, { onFailed: () => {}, onReady });
    await flush();
    await mount(engine, { onFailed: () => {}, onReady });
    await flush();

    expect(create).toHaveBeenCalledOnce();
    expect(bundle.destroy).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('ends with exactly one live module under StrictMode', async () => {
    const modules = [fakeModule(), fakeModule(), fakeModule()];
    const create = installFactory(modules);
    const engine = new ProjectMEngine();
    const onReady = vi.fn();
    const onFailed = vi.fn();

    await mount(engine, { onReady, onFailed }, true);
    await flush();
    await flush();

    const initialised = modules.filter((m) => m.init.mock.calls.length > 0);
    expect(initialised).toHaveLength(1);
    expect(initialised[0].destroy).not.toHaveBeenCalled();
    expect(create.mock.calls.length).toBeLessThanOrEqual(2);
    expect(engine.getStatus()).toBe('ready');
    expect(onReady).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
