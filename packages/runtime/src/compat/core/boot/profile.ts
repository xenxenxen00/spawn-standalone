import type { HostPlatform } from '../ports.ts';
import type { DurableSettings } from '../save/durable.ts';

export const DEFAULT_DISPLAY_NAME = 'Player';

export interface LocalProfile {
  /** the body's `player.userId` */
  userId: string;
  displayName: string;
  /** the id came from the platform account, not from this device */
  authorised: boolean;
}

export interface ProfileOptions {
  /** the id minted on a first run (default: crypto.randomUUID) */
  uuid?: () => string;
  log?: { warn(message: string, detail?: unknown): void };
  /** prefix of an authorised platform id (default empty); a device id (a UUID) never gets one */
  idPrefix?: string;
  /** the name of a player the platform names nothing for (default `Player`) */
  defaultName?: string;
}

/** a version-4 UUID: crypto.randomUUID where the page has it (secure contexts), else from random bytes */
export function mintUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** core §13.4: who the human body is. `settings` must be loaded (DurableState.load()). Never rejects. */
export async function resolveProfile(platform: Pick<HostPlatform, 'getUser'>, settings: DurableSettings, opts: ProfileOptions = {}): Promise<LocalProfile> {
  let user: Awaited<ReturnType<HostPlatform['getUser']>> = null;
  try {
    user = await platform.getUser();
  } catch (err) {
    (opts.log ?? console).warn(`[profile] platform.getUser() failed (${err instanceof Error ? err.message : String(err)}); using the device id`, err);
  }
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  const displayName = name !== '' ? name : (opts.defaultName ?? DEFAULT_DISPLAY_NAME);
  if (user !== null && user.loggedIn === true && typeof user.id === 'string' && user.id !== '') {
    return { userId: `${opts.idPrefix ?? ''}${user.id}`, displayName, authorised: true };
  }
  let deviceId = settings.get<unknown>('deviceId');
  if (typeof deviceId !== 'string' || deviceId === '') {
    deviceId = (opts.uuid ?? mintUuid)();
    settings.set('deviceId', deviceId);
  }
  return { userId: deviceId as string, displayName, authorised: false };
}
