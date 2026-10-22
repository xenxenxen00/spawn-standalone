import type { Vec3 } from '../../../compat/core/types.ts';
import { TOUCH } from './config.ts';

export type AimTargetQuery = (place: string, eye: Vec3, dir: Vec3, maxDist: number, radius: number) => readonly unknown[];

export function crosshairDirection(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

export function aimGain(args: {
  enabled: boolean; place?: string; eye?: Vec3; yaw?: number; pitch?: number; query?: AimTargetQuery;
}): number {
  if (!args.enabled || !args.place || !args.eye || !args.query) return 1;
  return args.query(args.place, args.eye, crosshairDirection(args.yaw ?? 0, args.pitch ?? 0), TOUCH.aimRange, TOUCH.aimRadius).length > 0
    ? TOUCH.aimGain
    : 1;
}
