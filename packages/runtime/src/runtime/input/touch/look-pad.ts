import type { RawInputEvent } from '../input-log.ts';
import { TOUCH } from './config.ts';

export interface LookInput { push(event: RawInputEvent): void }

export function pushTouchLook(input: LookInput, dx: number, dy: number, gain = 1): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  input.push({ type: 'look', dx, dy, source: 'touch', base: TOUCH.touchBase * gain });
}
