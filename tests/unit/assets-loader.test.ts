import { AnimationClip, Object3D, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AssetLoader, type LoaderDeps, type Manifest } from '../../src/world/assets';

const manifest: Manifest = {
  version: 1,
  assets: {
    wizard: { file: 'wizard.abc.glb', type: 'character', title: 'w', bytes: 100, license: 'CC0-1.0' },
    pack: { file: 'pack.def.glb', type: 'prop-pack', title: 'p', bytes: 50, license: 'CC0-1.0' },
    rock: {
      file: 'pack.def.glb',
      type: 'prop',
      title: 'r',
      bytes: 0,
      node: 'rock',
      pack: 'pack',
      license: 'CC0-1.0',
    },
    tree: {
      file: 'pack.def.glb',
      type: 'prop',
      title: 't',
      bytes: 0,
      node: 'tree',
      pack: 'pack',
      license: 'CC0-1.0',
    },
  },
};

function deps(failures: Record<string, number> = {}) {
  const calls: string[] = [];
  const d: LoaderDeps = {
    fetch: vi.fn(async (url: string) => {
      calls.push(url);
      const name = url.split('/').pop()!;
      if ((failures[name] ?? 0) > 0) {
        failures[name]!--;
        return new Response('nope', { status: 503 });
      }
      if (name === 'manifest.json') return new Response(JSON.stringify(manifest));
      return new Response(new Uint8Array(name.startsWith('wizard') ? 100 : 50));
    }),
    parseGltf: vi.fn(async (_buf: ArrayBuffer, url: string) => {
      const scene = new Object3D();
      if (url.includes('pack')) {
        for (const n of ['rock', 'tree']) {
          const o = new Object3D();
          o.name = n;
          o.position.set(5, 0, 0);
          scene.add(o);
        }
      }
      return { scene, animations: [new AnimationClip('wizard@idle', 1, [])] };
    }),
    clone: (o) => o.clone(),
    loadTexture: async () => new Texture(),
    sleep: async () => {},
  };
  return { d, calls };
}

describe('AssetLoader', () => {
  it('downloads each file once and reports byte progress to 100%', async () => {
    const { d, calls } = deps();
    const l = new AssetLoader('/assets/', d);
    const ratios: number[] = [];
    await l.preload(['wizard', 'rock', 'tree'], (p) => ratios.push(p.ratio));
    expect(calls.filter((c) => c.endsWith('.glb')).sort()).toEqual([
      '/assets/pack.def.glb',
      '/assets/wizard.abc.glb',
    ]);
    expect(ratios[0]).toBe(0);
    expect(ratios.at(-1)).toBe(1);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    await l.loadAsset('wizard');
    expect(calls.filter((c) => c.includes('wizard')).length).toBe(1);
  });

  it('retries transient failures', async () => {
    const { d, calls } = deps({ 'wizard.abc.glb': 2, 'manifest.json': 1 });
    const l = new AssetLoader('/assets/', d);
    const g = await l.loadAsset('wizard');
    expect(g.animations).toHaveLength(1);
    expect(calls.filter((c) => c.includes('wizard')).length).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    const { d } = deps({ 'wizard.abc.glb': 10 });
    const l = new AssetLoader('/assets/', d, 2);
    await expect(l.loadAsset('wizard')).rejects.toThrow(/failed to load "wizard"/);
  });

  it('clones a prop node out of its pack at the origin', async () => {
    const { d } = deps();
    const l = new AssetLoader('/assets/', d);
    const a = await l.loadAsset('rock');
    const b = await l.loadAsset('rock');
    expect(a.scene.name).toBe('rock');
    expect(a.scene).not.toBe(b.scene);
    expect(a.scene.position.x).toBe(0);
  });

  it('resolves clips by short or full name', async () => {
    const { d } = deps();
    const l = new AssetLoader('/assets/', d);
    expect(l.getClip('wizard', 'idle')).toBeNull(); // not loaded yet
    await l.preload(['wizard']);
    expect(l.getClip('wizard', 'idle')?.name).toBe('wizard@idle');
    expect(l.getClip('wizard', 'wizard@idle')).toBe(l.getClip('wizard', 'idle'));
    expect(l.getClip('wizard', 'nope')).toBeNull();
  });

  it('rejects unknown ids', async () => {
    const { d } = deps();
    const l = new AssetLoader('/assets/', d);
    await expect(l.loadAsset('dragon')).rejects.toThrow(/unknown asset/);
  });
});
