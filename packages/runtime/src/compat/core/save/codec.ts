import { cloneWire, isPlainObject } from '../wire.ts';

export const SAVE_KEY = 'ss_save_v1';
export const SAVE_BACKUP_KEY = SAVE_KEY + '_bad';
export interface SaveDocument { v: 1; settings: Record<string, unknown>; [key: string]: unknown }
export type SaveParseStatus = 'empty' | 'ok' | 'migrated' | 'repaired' | 'corrupt';
export interface SaveParseResult { save: SaveDocument; status: SaveParseStatus; issues: string[] }
export interface SaveCodec {
  read(raw: string | null): SaveParseResult;
  serialize(save: SaveDocument): string;
}
const empty = (): SaveDocument => ({ v: 1, settings: {} });
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).filter(k => k !== '__proto__').sort().map(k => [k, sorted(value[k])]));
};
export const jsonSaveCodec: SaveCodec = {
  read(raw) {
    if (raw === null || raw === '') return { save: empty(), status: 'empty', issues: [] };
    try {
      const value: unknown = JSON.parse(raw);
      if (!isPlainObject(value) || value['v'] !== 1) throw new TypeError('unsupported save document');
      const issues: string[] = [];
      const save = sorted(value) as SaveDocument;
      if (!isPlainObject(save.settings)) { save.settings = {}; issues.push('settings: expected an object'); }
      if (save['ps'] !== undefined && !isPlainObject(save['ps'])) { delete save['ps']; issues.push('ps: expected an object'); }
      return { save, status: issues.length ? 'repaired' : 'ok', issues };
    } catch (err) {
      return { save: empty(), status: 'corrupt', issues: [err instanceof Error ? err.message : String(err)] };
    }
  },
  serialize(save) { return JSON.stringify(sorted(cloneWire(save))); },
};
