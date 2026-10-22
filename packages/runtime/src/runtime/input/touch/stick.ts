import { TOUCH } from './config.ts';

export interface StickAxes { moveX: number; moveZ: number; magnitude: number }

/** Radial dead zone and clamp; screen-up is forward (`moveZ` +1). */
export function stickAxes(dx: number, dy: number, radius: number = TOUCH.stickRadius): StickAxes {
  const distance = Math.hypot(dx, dy);
  const magnitude = Math.min(1, distance / Math.max(1, radius));
  if (magnitude <= TOUCH.stickDeadZone) return { moveX: 0, moveZ: 0, magnitude };
  const scaled = (magnitude - TOUCH.stickDeadZone) / (1 - TOUCH.stickDeadZone);
  return {
    moveX: distance === 0 ? 0 : (dx / distance) * scaled,
    moveZ: distance === 0 ? 0 : (-dy / distance) * scaled,
    magnitude,
  };
}

/** Applies the sprint-on hold and lower release threshold to the stick's raw normalized magnitude. */
export function sprintHeld(magnitude: number, heldForMs: number, wasHeld: boolean): boolean {
  return wasHeld ? magnitude >= TOUCH.sprintRelease : magnitude >= TOUCH.sprintThreshold && heldForMs >= TOUCH.sprintDelayMs;
}
