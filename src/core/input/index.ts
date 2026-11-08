export { GestureClassifier, type GestureConfig, type GestureKind } from './gesture';
export { Haptics, haptics } from './haptics';
export { Input, type InputOptions } from './Input';
export { Joystick } from './joystick';
export { TouchVisuals } from './touch-visual';

import type { GameContext } from '../types';
import { haptics } from './haptics';
import { Input, type InputOptions } from './Input';

/** Build the input service for main.ts: `ctx.input = installInput(ctx, { element: canvas })`. */
export function installInput(ctx: Pick<GameContext, 'settings' | 'events'>, opts: InputOptions): Input {
  haptics.settings = ctx.settings;
  const input = new Input({ leftHanded: ctx.settings.leftHanded, ...opts });
  ctx.events.on('settings:changed', ({ key }) => {
    if (key === 'leftHanded') input.setLeftHanded(ctx.settings.leftHanded);
  });
  ctx.events.on('game:pause', ({ paused }) => input.setEnabled(!paused));
  return input;
}
