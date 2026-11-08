import GUI from 'lil-gui';
import { TUNING } from '../data/tuning';

/** ?debug=1 panel. Workstreams add folders via `debugFolder(name)`. */
let gui: GUI | null = null;

export function initDebug(): GUI {
  if (gui) return gui;
  gui = new GUI({ title: 'INKWAKE debug' });
  const t = gui.addFolder('tuning').close();
  addObject(t, TUNING as unknown as Record<string, unknown>);
  return gui;
}

export function debugFolder(name: string): GUI | null {
  return gui ? gui.addFolder(name) : null;
}

function addObject(folder: GUI, obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') folder.add(obj, k);
    else if (typeof v === 'boolean') folder.add(obj, k);
    else if (v && typeof v === 'object' && !Array.isArray(v))
      addObject(folder.addFolder(k).close(), v as Record<string, unknown>);
  }
}
