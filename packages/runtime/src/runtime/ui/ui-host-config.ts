import { UI_UTILITIES_CSS } from './utilities.ts';
import { IDENT } from './auto-globals.ts';

export interface UiHostConfig {
  rootId?: string;
  blankSelector?: string;
  styleId?: string;
  spriteId?: string;
  globals?: readonly string[] | 'auto';
  styles?: readonly string[];
  gameCss?: boolean;
  readyWhen?: UiReadyWhen;
  utilities?: boolean;
}

/** see UiHostConfig.readyWhen; a string that is not one of the keywords is a CSS selector */
export type UiReadyWhen = 'modal' | 'firstFrame' | 'firstUiRender' | (string & {});

export interface ResolvedUiHostConfig {
  readonly rootId: string;
  readonly blankSelector: string;
  readonly styleId: string;
  readonly spriteId: string;
  readonly globals: readonly string[] | 'auto';
  readonly styles: readonly string[];
  readonly gameCss: boolean;
  readonly readyWhen: UiReadyWhen;
  readonly utilities: boolean;
}

/** Neutral host defaults; authored markup and handlers are discovered per UI module. */
export const DEFAULT_UI_HOST_CONFIG: ResolvedUiHostConfig = Object.freeze({
  rootId: 'game',
  blankSelector: '[data-scene-cover]',
  styleId: 'ss-style',
  spriteId: 'ss-sprites',
  globals: 'auto',
  styles: Object.freeze([] as string[]),
  gameCss: false,
  readyWhen: 'firstUiRender',
  utilities: false,
});


const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

function id(name: string, v: string): string {
  if (!ID.test(v)) throw new Error(`UiHostConfig.${name} must be a plain element id, got ${JSON.stringify(v)}`);
  return v;
}

function ready(v: string): UiReadyWhen {
  if (v.trim() === '') throw new Error('UiHostConfig.readyWhen must be a keyword or a CSS selector, got an empty string');
  return v;
}

export function resolveUiHostConfig(c: UiHostConfig | undefined): ResolvedUiHostConfig {
  if (!c) return DEFAULT_UI_HOST_CONFIG;
  const d = DEFAULT_UI_HOST_CONFIG;
  const globals = c.globals ?? d.globals;
  if (globals !== 'auto') for (const g of globals) if (!IDENT.test(g)) throw new Error(`UiHostConfig.globals: ${JSON.stringify(g)} is not an identifier`);
  return Object.freeze({
    rootId: id('rootId', c.rootId ?? d.rootId),
    blankSelector: c.blankSelector ?? d.blankSelector,
    styleId: id('styleId', c.styleId ?? d.styleId),
    spriteId: id('spriteId', c.spriteId ?? d.spriteId),
    globals,
    styles: Object.freeze([...(c.utilities === true ? [UI_UTILITIES_CSS] : []), ...(c.styles ?? d.styles)]),
    gameCss: c.gameCss ?? d.gameCss,
    readyWhen: ready(c.readyWhen ?? d.readyWhen),
    utilities: c.utilities === true,
  });
}
