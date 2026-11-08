import type { AudioAPI } from '../core/types';

/** Used when Web Audio is unavailable; the game stays playable silently. */
export class NullAudio implements AudioAPI {
  async unlock(): Promise<void> {}
  play(): void {}
  loop(): () => void {
    return () => {};
  }
  setMusic(): void {}
  setIntensity(): void {}
  setListener(): void {}
  setVolumes(): void {}
  suspend(): void {}
  resume(): void {}
}
