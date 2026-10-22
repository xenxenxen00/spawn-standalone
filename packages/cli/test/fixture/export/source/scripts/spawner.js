import { clamp } from 'builtin/math';
export function pick(ctx) {
  const kind = clamp(1, 0, 1) > 0 ? 'a' : 'b';
  return `templates/enemies/${kind}.js#enemy`;
}
