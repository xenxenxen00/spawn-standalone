import { TOUCH } from './config.ts';

export interface TouchControlDef {
  id: string;
  label: string;
  action?: string;
  hold?: boolean;
  x?: number;
  y?: number;
  size?: number;
}

export interface TouchStickDef {
  x: string;
  y: string;
  sprint?: string;
}

export interface TouchGestures {
  press?: string;
  tap?: string;
}

export interface TouchScheme {
  controls: readonly TouchControlDef[];
  stick: TouchStickDef | false;
  look: boolean;
  gestures: TouchGestures;
  /** @deprecated All public schemes use authored actions; retained for existing host objects. */
  plain: boolean;
}

/** Only authored controls, stick axes and gestures are enabled. */
export function touchScheme(s: Partial<TouchScheme>): TouchScheme {
  const ids = new Set<string>();
  for (const c of s.controls ?? []) {
    if (!c.id || ids.has(c.id)) throw new Error(`TouchScheme: control id ${JSON.stringify(c.id)} is empty or repeated`);
    ids.add(c.id);
  }
  return Object.freeze({
    controls: Object.freeze([...(s.controls ?? [])]),
    stick: s.stick ?? false,
    look: s.look ?? false,
    gestures: Object.freeze({ ...(s.gestures ?? {}) }),
    plain: s.plain ?? true,
  });
}

/** where a control stands (percent) and how big it is (px) */
export function controlLayout(c: TouchControlDef): { x: number; y: number; size: number } {
  return { x: c.x ?? 50, y: c.y ?? 50, size: c.size ?? TOUCH.buttonSize };
}
