// Continuous character-vs-character containment (port-spec R-5; opt-in, off by default so the base runtime's character movement is untouched).
//
// A fast character (Crown Riot's dash: 21 m/s, 0.7 m a frame at the 30 Hz client step) pressed into another one is held by the
// controller and by kcc.ts's contact model for a few ticks, then the pair interpenetrates: the push-out of a touching pair
// lets the overlap grow past defaults.KCC_OVERLAP_IGNORE_DEPTH, a character that deep is never blocking, and the mover walks
// through it. (Walls are not affected: the controller sweeps its capsule along the whole move, so a thin wall or a zero
// thickness mesh stops 21 m/s at any step; tests/unit/physics/ccd-character.node.test.ts holds both.)
//
// This pass runs AFTER moveCharacter and is the last word on the horizontal part of the move: the discs of the two capsules
// (radius sum) are swept, the move stops where the path first reaches another character's disc, and what is left of it slides
// along that disc. A pair that already overlaps may separate or slide but not close further. Others are read where
// they will be: a character that moved earlier this tick at its target, one that moves later at its place of the last step,
// so the pair cannot end the tick inside each other whichever moves first. Only characters side by side (their straight
// parts share a height) and whose groups interact count; a body landing on another's head is the controller's.
import { groupsInteract } from '../defaults.ts';
import type { CharacterBody, KccResult } from './kcc.ts';

/** how far outside the disc a stopped character is left (m): a rounding margin, not a gap anyone can see */
export const CCD_MARGIN = 1e-3;
/** slide passes: a second obstacle met while sliding off the first */
const PASSES = 3;

const sideBySide = (a: CharacterBody, b: CharacterBody): boolean => {
  const aLo = a.feet.y + Math.min(a.radius, a.height / 2), aHi = a.feet.y + Math.max(a.height - a.radius, a.height / 2);
  const bLo = b.feet.y + Math.min(b.radius, b.height / 2), bHi = b.feet.y + Math.max(b.height - b.radius, b.height / 2);
  return !(aLo > bHi || bLo > aHi);
};

/**
 * Contains `out.translation` (horizontal part) of character `chars[index]` against the other characters of `chars`. Lower
 * indices already moved this tick (their `target` is final), higher ones did not (their `feet` is). Returns true when the
 * move was changed.
 */
export function containCharacter(chars: readonly CharacterBody[], index: number, out: KccResult): boolean {
  const c = chars[index]!;
  const t = out.translation;
  let changed = false;
  for (let pass = 0; pass < PASSES; pass++) {
    let hit = false;
    for (let j = 0; j < chars.length; j++) {
      if (j === index) continue;
      const o = chars[j]!;
      if (!o.enabled || !groupsInteract(c.groups, o.groups) || !sideBySide(c, o)) continue;
      const px = j < index ? o.target.x : o.feet.x, pz = j < index ? o.target.z : o.feet.z;
      const reach = c.radius + o.radius;
      const ax = c.feet.x - px, az = c.feet.z - pz;
      const d2 = ax * ax + az * az;
      const tx = t.x, tz = t.z;
      const ex = ax + tx, ez = az + tz;
      if (d2 < reach * reach) {
        // inside already (spawned there, pushed there): moving apart is free, closing is not
        const d = Math.sqrt(d2);
        if (!(d > 1e-9)) continue;
        const nx = ax / d, nz = az / d;
        const closing = -(tx * nx + tz * nz);
        if (closing > 0 && ex * ex + ez * ez < d2) {
          t.x = tx + nx * closing; t.z = tz + nz * closing;
          changed = hit = true;
        }
        continue;
      }
      // the segment a + s*t against the circle |p| = reach, first entry
      const qa = tx * tx + tz * tz;
      if (!(qa > 1e-12)) continue;
      if (ex * ex + ez * ez >= reach * reach && tx * ax + tz * az >= 0) continue; // ends outside and is not approaching
      const qb = 2 * (ax * tx + az * tz);
      const disc = qb * qb - 4 * qa * (d2 - reach * reach);
      if (disc < 0) continue;
      const s = (-qb - Math.sqrt(disc)) / (2 * qa);
      if (s > 1 || s < 0) continue;
      // stop at the contact (a margin short of it), slide the rest along the disc
      const reachM = reach + CCD_MARGIN;
      const discM = qb * qb - 4 * qa * (d2 - reachM * reachM);
      const k = Math.max(0, Math.min(1, (-qb - Math.sqrt(Math.max(0, discM))) / (2 * qa)));
      const hx = ax + tx * k, hz = az + tz * k;
      const hd = Math.hypot(hx, hz) || 1;
      const nx = hx / hd, nz = hz / hd;
      let rx = tx * (1 - k), rz = tz * (1 - k);
      const into = rx * nx + rz * nz;
      if (into < 0) { rx -= into * nx; rz -= into * nz; }
      t.x = tx * k + rx; t.z = tz * k + rz;
      // the slide is a chord: bring its end back onto the margin circle if it cut inside
      const fx = ax + t.x, fz = az + t.z, fd = Math.hypot(fx, fz);
      if (fd < reachM && fd > 1e-9) { t.x += (fx / fd) * reachM - fx; t.z += (fz / fd) * reachM - fz; }
      changed = hit = true;
    }
    if (!hit) break;
  }
  return changed;
}
