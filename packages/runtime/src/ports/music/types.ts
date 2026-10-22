// MusicPort: the host behind the game-facing `ctx.music.*` (engine 6.0.0 api-reference.md "ctx.music.*"; the calls below are
// the ones the ported games use). Hosts opt into createAudioMusicPort to use the shared audio engine.
//
//   ctx.music.play(clip, { fade?, volume?, layer?, loop? })   one base layer crossfades to `clip` over `fade` seconds; a named
//                                                              `layer` plays as an overlay on top of the base layer
//   ctx.music.stop({ fade?, layer? })                          fades the named layer, or the base layer, out
//   ctx.music.duck(level, { duration? })                       lowers the base layer by the factor `level` (0..1) for
//                                                              `duration` seconds, then restores it
//
// Every method is fire-and-forget and must not throw; the kernel also guards the call.

export interface MusicPlayOptions {
  /** crossfade / fade-in seconds; default 0 */
  fade?: number;
  /** 0..1 on the music bus; default 1 */
  volume?: number;
  /** a named overlay layer; omitted = the base layer */
  layer?: string;
  /** default true for the base layer, false for a named layer (the game passes `loop: false` for stingers) */
  loop?: boolean;
}

export interface MusicStopOptions {
  fade?: number;
  layer?: string;
}

export interface MusicDuckOptions {
  /** seconds; default 1 */
  duration?: number;
}

export interface MusicPort {
  play(clip: string, options?: MusicPlayOptions): void;
  stop(options?: MusicStopOptions): void;
  duck(level: number, options?: MusicDuckOptions): void;
}

/** a port that does nothing */
export function createNullMusicPort(): MusicPort {
  return { play() {}, stop() {}, duck() {} };
}
