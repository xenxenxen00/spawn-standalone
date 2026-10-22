// Animation constants of the motion domain (docs/design/motion-physics-nav.md §2, §3.3, §3.5, §3.7; calibration rows M5/M6
// of §9). One table so calibration changes one file. Engine-free; imported by the build cook and the runtime alike.

/** Mixer defaults when a channel write leaves a field out (motion §3.5.2 "Defaults when omitted"). */
export const MIXER_DEFAULTS = {
  /** [INF: three.js LoopRepeat] */
  loop: 'loop',
  speed: 1,
  weight: 1,
  /** [CAL M5]: every live writer passes blendIn explicitly */
  blendIn: 0,
  /** fade of a cleared channel (`anim.ch = null`) [INF, CAL M5] */
  blendOut: 0.1,
} as const;

/** Sim tick rate the channel clocks advance at (core: 30 Hz). */
export const SIM_HZ = 30;

/** Presentation LOD of the mixer (motion §3.5.7): rows beyond `near` m evaluate every `nearEvery`-th frame, beyond `far` m every
 * `farEvery`-th, off-screen rows every `offscreenEvery`-th. The low tier halves the distances; the governor may scale them by
 * `governorScale` as a CPU lever (render §15.2). The sim pose (bone probes) is unaffected. */
export const MIXER_LOD = {
  near: 35,
  nearEvery: 2,
  far: 60,
  farEvery: 4,
  offscreenEvery: 4,
  lowTierScale: 0.5,
  governorScale: 0.7,
} as const;

/** IK defaults (motion §3.7). */
export const IK_DEFAULTS = {
  /** fade of a cleared chain: the live write's blendIn (0.12 s) */
  blendOut: 0.12,
  /** the target distance is clamped to [|a−b| + clamp, a + b − clamp] */
  reachClamp: 0.001,
  /** feet IK (off unless `ik.feet === true`): the most the pelvis may drop */
  pelvisDropMax: 0.25,
} as const;

/** Frame rate of an authored clip or clip function that does not name one (engine cache: every cooked clip says 30). */
export const AUTHORED_DEFAULT_FPS = 30;

/** The engine cook inserts the Euler midpoint into a rotation segment whose two keys are more than this many degrees apart
 * (quaternion angle) unless the segment is a single-axis turn that slerp already follows; it repeats until every segment is
 * within the limit. Measured on the live cache (MA1): every multi-axis segment above 60° (62.2°-112.5°, 13 tracks) carries the
 * midpoint, every segment at or below 56.6° does not, and the two single-axis 76.8° segments (skitter lunge forearms) do not. */
export const SUBDIVIDE_ANGLE_DEG = 60;

/** A segment whose slerp midpoint is within this angle (radians) of its Euler midpoint is a single-axis turn (never subdivided). */
export const SUBDIVIDE_PATH_EPS_RAD = 1e-6;

/** Upper bound on midpoint recursion per segment (2^8 sub-segments): a guard, never reached by live content. */
export const SUBDIVIDE_MAX_DEPTH = 8;

/** Library clip address form (`cdn/clip-<name>.glb`, motion §3.3.2). */
export const LIBRARY_CLIP_RE = /^cdn\/clip-[^/]+\.glb$/;

/** Authored clip identity form (`anim/<file>.yml#<clip>`, motion §3.3.1, §3.5.5). */
export const AUTHORED_ID_RE = /^(anim\/[^#]+\.yml)#(.+)$/;
