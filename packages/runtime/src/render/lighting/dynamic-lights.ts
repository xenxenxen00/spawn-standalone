// Dynamic light selection (docs/design/rendering.md §8.3; docs/architecture.md X-47, DR-26; WP R1b): which of the moving and
// transient lights go into the dynamic block of the light texture this frame.
//
// Moving and transient lights are muzzle flashes, explosions, telegraph swells, boss glows, the ammo box, the shadowCaster's
// throw light, the trader-gate lamps, door-bash sparks, bot beams and the team torches (six always-on spots, X-47). Each
// frame the light table offers every one that is lit; the top `DYN_CAP` (16 / 8 / 4 / 2 per tier, `TierConfig.dynamicLights`)
// are kept, best first, so a smaller cap drops the dimmest.
//
// The score is render §8.3's: `intensity × window(dCam) / max(dCam², 1)`, with three's cut-off window, for lights whose
// sphere reaches into the view frustum. Three things the design leaves open are decided here and covered by the tests:
//
//   - **Outside the sphere.** The formula is 0 for every light the camera stands outside the cut-off of, which would rank a
//     bot's muzzle flash 20 m away (lighting ground the camera sees) level with nothing. The window is therefore floored at
//     `FAR_WINDOW`: such lights still rank, by `intensity / dCam²`, below every light of similar strength the camera is
//     inside of. The score stays monotonic in the distance.
//   - **Ties.** Equal scores are broken by the light's creation order (the lower id wins), so the result does not depend on
//     the order the table iterates in.
//   - **Hysteresis.** A light chosen last frame keeps its slot until a challenger's score exceeds its own by
//     `DYNAMIC_HYSTERESIS`. Two torches of nearly equal score on either side of the cut line would otherwise swap every time
//     the camera sways a centimetre. A burst (a muzzle flash is 22-45 against a torch's 5) clears the margin at once.
//
// There is no exemption for any kind of light (DR-26: the torches stay on every tier "inside the tier's dynamic-light cap").
//
// Allocation-free per frame, engine-free: no import. The camera comes in as the element arrays of its matrices.

/** the largest `DYN_CAP` (tier `high`): the size of the dynamic block of the light texture */
export const DYNAMIC_LIGHTS_MAX = 16;

/** a challenger must beat an incumbent's score by this factor to take its slot */
export const DYNAMIC_HYSTERESIS = 1.15;

/** floor of the cut-off window in the score, for lights the camera stands outside the sphere of */
export const FAR_WINDOW = 1e-3;

/** three's cut-off window (`getDistanceAttenuation`): `saturate(1 − (d / cutoff)⁴)²`; 1 when there is no cut-off */
export function distanceWindow(distance: number, cutoff: number): number {
  if (!(cutoff > 0)) return 1;
  const q = distance / cutoff;
  const w = 1 - q * q * q * q;
  return w > 0 ? w * w : 0;
}

/** render §8.3: `intensity × window(dCam) / max(dCam², 1)`, the window floored at `FAR_WINDOW`; 0 for a dark light */
export function dynamicLightScore(intensity: number, cutoff: number, dCam: number): number {
  if (!(intensity > 0)) return 0;
  const w = distanceWindow(dCam, cutoff);
  return (intensity * (w > FAR_WINDOW ? w : FAR_WINDOW)) / Math.max(dCam * dCam, 1);
}

/**
 * True for an orthographic `projectionMatrix.elements` (K16): three's `makeOrthographic` leaves the last row at (0, 0, 0, 1),
 * a perspective matrix has a nonzero index 11 and a zero index 15.
 */
export function isOrthographic(projection: ArrayLike<number>): boolean {
  return projection.length >= 16 && projection[11] === 0 && projection[15] === 1;
}

/**
 * The half-angle tangents of a symmetric perspective projection, from `projectionMatrix.elements`. For an orthographic one
 * (K16) the sides do not open with depth: `tanHalfX` / `tanHalfY` are 0, `ortho` is true and `halfWidth` / `halfHeight` are
 * the half-extents in metres (for perspective they are `Infinity`).
 */
export function perspectiveFrom(projection: ArrayLike<number>): { tanHalfX: number; tanHalfY: number; ortho: boolean; halfWidth: number; halfHeight: number } {
  if (isOrthographic(projection)) return { tanHalfX: 0, tanHalfY: 0, ortho: true, halfWidth: 1 / projection[0]!, halfHeight: 1 / projection[5]! };
  return { tanHalfX: 1 / projection[0]!, tanHalfY: 1 / projection[5]!, ortho: false, halfWidth: Infinity, halfHeight: Infinity };
}

/**
 * Keeps the best `cap` of the lights offered between `begin` and `end`. One instance per light table: it remembers last
 * frame's choice for the hysteresis.
 */
export class DynamicLightSelector {
  /** the caller's reference (its slot) of each chosen light, best first; valid in `[0, count)` after `end()` */
  readonly refs: Int32Array;
  /** the stable id of each chosen light, same order */
  readonly ids: Float64Array;
  /** the score each was ranked by (an incumbent's includes its hysteresis) */
  readonly scores: Float64Array;
  /** lights chosen by the last `end()` */
  count = 0;

  readonly #max: number;
  readonly #previous: Float64Array;
  #previousCount = 0;
  #cap = 0;
  #n = 0;

  // the view: world → view rows, the side-plane slopes and their normal lengths, the depth range
  readonly #m = new Float64Array(12);
  #sx = 1;
  #sy = 1;
  #nx = Math.SQRT2;
  /** K16: an orthographic view: the side planes are `|x| = 1 / sx`, parallel to the axis */
  #ortho = false;
  #ny = Math.SQRT2;
  #near = 0.1;
  #far = 2000;

  constructor(max: number = DYNAMIC_LIGHTS_MAX) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`DynamicLightSelector: the size must be a positive integer, got ${String(max)}`);
    this.#max = max;
    this.refs = new Int32Array(max);
    this.ids = new Float64Array(max);
    this.scores = new Float64Array(max);
    this.#previous = new Float64Array(max);
    this.#m[0] = 1;
    this.#m[5] = 1;
    this.#m[10] = 1;
  }

  /**
   * The camera of this frame: `matrixWorldInverse.elements`, `projectionMatrix.elements` (a symmetric perspective: only its
   * two focal terms are read, so the depth convention of the backend does not matter; an orthographic one is told apart by its
   * last row and its two terms are 1 / half-extent), near and far.
   */
  setView(viewMatrix: ArrayLike<number>, projection: ArrayLike<number>, near: number, far: number): void {
    const m = this.#m;
    // rows of the upper 3 × 4 of a column-major matrix
    m[0] = viewMatrix[0]!;
    m[1] = viewMatrix[4]!;
    m[2] = viewMatrix[8]!;
    m[3] = viewMatrix[12]!;
    m[4] = viewMatrix[1]!;
    m[5] = viewMatrix[5]!;
    m[6] = viewMatrix[9]!;
    m[7] = viewMatrix[13]!;
    m[8] = viewMatrix[2]!;
    m[9] = viewMatrix[6]!;
    m[10] = viewMatrix[10]!;
    m[11] = viewMatrix[14]!;
    this.#sx = projection[0]!;
    this.#sy = projection[5]!;
    this.#ortho = isOrthographic(projection);
    this.#nx = Math.hypot(this.#sx, 1);
    this.#ny = Math.hypot(this.#sy, 1);
    this.#near = near;
    this.#far = far;
  }

  /** forgets last frame's choice (a place change) */
  reset(): void {
    this.#previousCount = 0;
    this.count = 0;
    this.#n = 0;
  }

  begin(cap: number): void {
    this.#cap = Math.max(0, Math.min(this.#max, Math.floor(cap)));
    this.#n = 0;
  }

  /**
   * Offers one light: `id` is stable for the light's life and ordered by creation (the tie-break), `ref` is whatever the
   * caller wants back (its slot). `x, y, z` is the world position, `cutoff` the radius (0 = none).
   */
  offer(id: number, ref: number, x: number, y: number, z: number, intensity: number, cutoff: number): void {
    const cap = this.#cap;
    if (cap === 0 || !(intensity > 0)) return;
    const m = this.#m;
    const vx = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
    const vy = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
    const vz = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
    if (cutoff > 0) {
      // the sphere against the frustum, in view space (the camera looks down −z)
      const depth = -vz;
      if (depth + cutoff < this.#near || depth - cutoff > this.#far) return;
      if (this.#ortho) {
        // the box |x| <= 1/sx, |y| <= 1/sy: the sphere is out when it clears a side by more than its radius
        if ((Math.abs(vx) * this.#sx - 1) / this.#sx > cutoff) return;
        if ((Math.abs(vy) * this.#sy - 1) / this.#sy > cutoff) return;
      } else {
        if ((Math.abs(vx) * this.#sx - depth) / this.#nx > cutoff) return;
        if ((Math.abs(vy) * this.#sy - depth) / this.#ny > cutoff) return;
      }
    }
    let score = dynamicLightScore(intensity, cutoff, Math.sqrt(vx * vx + vy * vy + vz * vz));
    if (!(score > 0)) return;
    const previous = this.#previous;
    for (let i = 0, n = this.#previousCount; i < n; i++) {
      if (previous[i] === id) {
        score *= DYNAMIC_HYSTERESIS;
        break;
      }
    }

    // insertion into the list, kept sorted by score (higher first) then id (lower first)
    const { ids, refs, scores } = this;
    let n = this.#n;
    if (n === cap) {
      const last = n - 1;
      if (!(score > scores[last]! || (score === scores[last]! && id < ids[last]!))) return;
      n = last; // the last one drops out
    }
    let at = n;
    while (at > 0 && (score > scores[at - 1]! || (score === scores[at - 1]! && id < ids[at - 1]!))) {
      scores[at] = scores[at - 1]!;
      ids[at] = ids[at - 1]!;
      refs[at] = refs[at - 1]!;
      at--;
    }
    scores[at] = score;
    ids[at] = id;
    refs[at] = ref;
    this.#n = n + 1;
  }

  /** Ends the frame: returns how many lights were chosen and remembers them for the next frame's hysteresis. */
  end(): number {
    const n = this.#n;
    for (let i = 0; i < n; i++) this.#previous[i] = this.ids[i]!;
    this.#previousCount = n;
    this.count = n;
    return n;
  }
}
