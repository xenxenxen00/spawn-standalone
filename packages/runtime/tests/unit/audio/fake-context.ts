// A recording fake of the Web Audio surface the engine uses (io §2.15 `fake-context.ts`): nodes, params with their
// automation calls, start/stop times, connections, decodes. No dependency, no audio device. `currentTime` is set by the test.
import type {
  AudioBufferLike,
  AudioCtxLike,
  AudioListenerLike,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceNodeLike,
  CompressorNodeLike,
  GainNodeLike,
  PannerNodeLike,
} from '../../../src/runtime/audio/types.ts';

export type ParamEvent =
  | { type: 'set'; value: number; time: number }
  | { type: 'target'; value: number; time: number; tc: number }
  | { type: 'ramp'; value: number; time: number }
  | { type: 'cancel'; time: number };

export class FakeParam implements AudioParamLike {
  events: ParamEvent[] = [];
  value: number;
  constructor(v: number) {
    this.value = v;
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'set', value, time });
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number, time: number, tc: number): this {
    this.events.push({ type: 'target', value, time, tc });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'ramp', value, time });
    this.value = value;
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', time });
    return this;
  }
  /** the last automation call */
  last(): ParamEvent | undefined {
    return this.events[this.events.length - 1];
  }
}

export type NodeKind = 'gain' | 'source' | 'panner' | 'compressor' | 'destination';

export class FakeNode implements AudioNodeLike {
  readonly kind: NodeKind;
  outputs: FakeNode[] = [];
  disconnected = false;
  constructor(kind: NodeKind) {
    this.kind = kind;
  }
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.outputs.push(destination as FakeNode);
    return destination;
  }
  disconnect(): void {
    this.outputs = [];
    this.disconnected = true;
  }
  /** the chain of node kinds from here to the destination, following the first output */
  path(): FakeNode[] {
    const out: FakeNode[] = [];
    let n: FakeNode | undefined = this;
    while (n) {
      out.push(n);
      n = n.outputs[0];
    }
    return out;
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam(1);
  label = '';
  constructor() {
    super('gain');
  }
}

export class FakeBuffer implements AudioBufferLike {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  constructor(channels: number, length: number, sampleRate: number) {
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
    this.sampleRate = sampleRate;
  }
  get numberOfChannels(): number {
    return this.channels.length;
  }
  get length(): number {
    return this.channels[0]?.length ?? 0;
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(channel: number): Float32Array {
    const c = this.channels[channel];
    if (!c) throw new RangeError(`channel ${channel} of ${this.channels.length}`);
    return c;
  }
}

export class FakeSource extends FakeNode implements BufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  readonly playbackRate = new FakeParam(1);
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: ((ev: Event) => void) | null = null;
  started: { when: number; offset: number } | null = null;
  stopped: number | null = null;
  constructor() {
    super('source');
  }
  start(when = 0, offset = 0): void {
    if (this.started) throw new Error('InvalidStateError: start called twice');
    this.started = { when, offset };
  }
  stop(when = 0): void {
    if (!this.started) throw new Error('InvalidStateError: stop before start');
    this.stopped = when;
  }
  /** test helper: the source finished (naturally or at its stop time) */
  end(): void {
    this.onended?.(new Event('ended'));
  }
}

export class FakePanner extends FakeNode implements PannerNodeLike {
  panningModel: 'HRTF' | 'equalpower' = 'equalpower';
  distanceModel: 'linear' | 'inverse' | 'exponential' = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);
  constructor() {
    super('panner');
  }
}

export class FakeCompressor extends FakeNode implements CompressorNodeLike {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
  constructor() {
    super('compressor');
  }
}

export class FakeListener implements AudioListenerLike {
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);
  readonly forwardX = new FakeParam(0);
  readonly forwardY = new FakeParam(0);
  readonly forwardZ = new FakeParam(-1);
  readonly upX = new FakeParam(0);
  readonly upY = new FakeParam(1);
  readonly upZ = new FakeParam(0);
}

/** what a fake decode yields for given bytes; default: `fakeClipBytes` */
export type FakeDecoder = (data: ArrayBuffer, ctx: FakeAudioContext) => FakeBuffer;

/**
 * Bytes a fake fetch can serve: byte 0 = channel count, byte 1 = length in tenths of a second. The default decoder turns them
 * into a buffer at the context rate whose channel c holds the constant `CHANNEL_LEVEL[c]`.
 */
export function fakeClipBytes(channels: 1 | 2, tenths = 5): ArrayBuffer {
  return new Uint8Array([channels, tenths]).buffer;
}
export const CHANNEL_LEVEL = [0.5, -0.25] as const;

export const defaultDecoder: FakeDecoder = (data, ctx) => {
  const b = new Uint8Array(data);
  const channels = b[0] ?? 2;
  const length = Math.round(((b[1] ?? 5) / 10) * ctx.sampleRate);
  const buf = new FakeBuffer(channels, length, ctx.sampleRate);
  buf.channels.forEach((c, i) => c.fill(CHANNEL_LEVEL[i] ?? 0));
  return buf;
};

export interface FakeContextOptions {
  /** default 'running' (a context created inside a gesture) */
  state?: 'running' | 'suspended';
  sampleRate?: number;
  decoder?: FakeDecoder;
}

export class FakeAudioContext extends EventTarget implements AudioCtxLike {
  currentTime = 0;
  readonly sampleRate: number;
  state: string;
  readonly destination = new FakeNode('destination');
  readonly listener = new FakeListener();
  readonly nodes: FakeNode[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly decodes: ArrayBuffer[] = [];
  readonly calls: string[] = [];
  /** decodes resolve only when the test calls `flushDecodes()` when false */
  autoDecode = true;
  #held: Array<() => void> = [];
  readonly #decoder: FakeDecoder;

  constructor(opts: FakeContextOptions = {}) {
    super();
    this.state = opts.state ?? 'running';
    this.sampleRate = opts.sampleRate ?? 48000;
    this.#decoder = opts.decoder ?? defaultDecoder;
  }

  #add<N extends FakeNode>(n: N): N {
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeGain {
    return this.#add(new FakeGain());
  }
  createBufferSource(): FakeSource {
    return this.#add(new FakeSource());
  }
  createPanner(): FakePanner {
    return this.#add(new FakePanner());
  }
  createDynamicsCompressor(): FakeCompressor {
    return this.#add(new FakeCompressor());
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    const b = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decodes.push(data);
    const run = (): FakeBuffer => this.#decoder(data, this);
    if (this.autoDecode) return Promise.resolve().then(run);
    return new Promise((resolve) => this.#held.push(() => resolve(run())));
  }
  /** resolves the decodes held while `autoDecode` is false */
  flushDecodes(): void {
    const h = this.#held;
    this.#held = [];
    for (const f of h) f();
  }
  #setState(s: string): void {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new Event('statechange'));
  }
  resume(): Promise<void> {
    this.calls.push('resume');
    this.#setState('running');
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.calls.push('suspend');
    this.#setState('suspended');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.calls.push('close');
    this.#setState('closed');
    return Promise.resolve();
  }
  /** test helper: the browser suspends or interrupts the context on its own (iOS call, Safari backgrounding) */
  externalState(s: 'suspended' | 'interrupted'): void {
    this.#setState(s);
  }

  sources(): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
  }
  /** the sources of voices: every source but the 1-frame silent buffer the unlock plays */
  voiceSources(): FakeSource[] {
    return this.sources().filter((s) => s.buffer?.length !== 1);
  }
  panners(): FakePanner[] {
    return this.nodes.filter((n): n is FakePanner => n instanceof FakePanner);
  }
  compressors(): FakeCompressor[] {
    return this.nodes.filter((n): n is FakeCompressor => n instanceof FakeCompressor);
  }
}

/** a fetch over a table of URL → bytes; unknown URLs answer 404. Records every URL asked. */
export function fakeFetch(files: Record<string, ArrayBuffer>): {
  fetch: (url: string) => Promise<Response>;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch = (url: string): Promise<Response> => {
    urls.push(url);
    const b = files[url];
    return Promise.resolve(b ? new Response(b.slice(0), { status: 200 }) : new Response(null, { status: 404 }));
  };
  return { fetch, urls };
}

/** lets every pending promise callback (fetch → arrayBuffer → decode → start) run */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
