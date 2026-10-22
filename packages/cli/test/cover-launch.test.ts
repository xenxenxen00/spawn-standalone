import { describe, expect, it } from 'vitest';
import { coverLaunchOptions } from '../src/package/covers.ts';

const AUDIO = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
const DEFAULT_ARGS = [
  '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--disable-vulkan', '--disable-gpu-compositing', '--disable-blink-features=WebGPU',
  ...AUDIO,
];

describe('cover browser launch options', () => {
  it('keeps the default headless software rendering and audio arguments', () => {
    expect(coverLaunchOptions({})).toEqual({ headless: true, args: DEFAULT_ARGS });
  });

  it.each(['chrome', 'msedge', 'chrome-beta', undefined])('allows only the requested Chrome or Edge channel: %s', channel => {
    const options = coverLaunchOptions({ SS_BROWSER_CHANNEL: channel });
    expect(options.channel).toBe(channel === 'chrome' || channel === 'msedge' ? channel : undefined);
    expect(options.args).toEqual(DEFAULT_ARGS);
  });

  it.each([undefined, '0', 'true', '1'])('uses native rendering only for the explicit flag value 1: %s', native => {
    const options = coverLaunchOptions({ SS_BROWSER_CHANNEL: 'chrome', SS_BROWSER_NATIVE: native });
    expect(options).toEqual({ headless: true, channel: 'chrome', args: native === '1' ? AUDIO : DEFAULT_ARGS });
  });
});
