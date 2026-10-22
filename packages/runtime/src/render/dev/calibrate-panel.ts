// The dev-only calibration panel (docs/design/rendering.md §17; WP R15).
//
// Mounted only when the page has `?calibrate=1` (src/render/index.ts loads this module on demand, code-split, so
// the shipped bundle and the ordinary runtime never touch it). It edits the existing runtime calibration copy —
// `calibration` from `../calibration.ts` — and can reset it to the shipped defaults via `resetCalibration()`.
// The defaults object itself is frozen and is never written.
//
// A change of a structural constant (marked ⚠: roughnessAA, envScale 0 ↔ non-zero, wetModifier, additiveFog,
// tonemapOrder, bloomKernel, fxaa) alters shader graphs: materials and the pipeline built before the change keep
// the old value until they are rebuilt. The panel reports such changes through `onStructuralChange`; wiring the
// actual rebuild is the app's job (one line where the post pipeline is installed).
//
// The one live exception is `grade.contrastPivot`: it drives the post pipeline's `calibrationPivot` uniform
// (postfx-tsl.ts), so its edit takes effect without a rebuild. The panel reports it through `onLiveChange`; the
// app syncs the uniform (src/render/index.ts wires it to `syncPanelLiveCalibration`).
//
// Engine-free except for the DOM: imports only `../calibration.ts` (X-26).

import { CALIBRATION_DEFAULTS, calibration, resetCalibration } from '../calibration.ts';

export interface CalibratePanelOptions {
  /** structural constant paths changed by the panel (they need material/pipeline rebuild to take effect) */
  onStructuralChange?: (paths: string[]) => void;
  /**
   * calibration paths changed by the panel that take effect through a live uniform, no rebuild (currently only
   * `grade.contrastPivot` → the post pipeline's `calibrationPivot` uniform); the app syncs them
   */
  onLiveChange?: (paths: string[]) => void;
  /** where to mount the panel; default document.body */
  mount?: HTMLElement;
}

export interface CalibratePanel {
  /** re-reads `calibration` into every control */
  refresh(): void;
  /** removes the panel from the DOM */
  dispose(): void;
}

type Field =
  | { kind: 'select'; path: string; label: string; options: readonly string[]; structural?: boolean; hint?: string }
  | { kind: 'number'; path: string; label: string; min: number; max: number; step: number; structural?: boolean; hint?: string }
  | { kind: 'check'; path: string; label: string; hint?: string }
  | { kind: 'text'; path: string; label: string; structural?: boolean; hint?: string }
  | { kind: 'static'; label: string; value: string; hint?: string };

interface Section {
  title: string;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    title: 'switches',
    fields: [
      { kind: 'select', path: 'emissiveDecode', label: 'emissiveDecode', options: ['srgb-eotf', 'hdr-linear'], hint: 'how ctx.emissive() display values become linear' },
      { kind: 'select', path: 'tonemapOrder', label: 'tonemapOrder', options: ['aces-look', 'look-aces'], structural: true, hint: 'where the tone map sits against the look' },
      { kind: 'select', path: 'bloomKernel', label: 'bloomKernel', options: ['r186', 'unreal-legacy'], structural: true, hint: 'r186: radii 6..22 σ=r/3; legacy: 3..11 σ=r' },
      { kind: 'select', path: 'additiveFog', label: 'additiveFog', options: ['three', 'fade'], structural: true, hint: 'scene fog on additive materials' },
      { kind: 'select', path: 'fxaa', label: 'fxaa', options: ['off', 'on'], structural: true },
      { kind: 'select', path: 'roughnessAA', label: 'roughnessAA', options: ['three', 'raw'], structural: true, hint: 'getRoughness before the lighting script' },
      { kind: 'select', path: 'viewmodelInterp', label: 'viewmodelInterp', options: ['alpha', 'step'], hint: 'flag port.viewmodelInterp' },
      { kind: 'select', path: 'wetModifier', label: 'wetModifier', options: ['off', 'surface'], structural: true, hint: "'surface' is an addition (live reads neither)" },
      { kind: 'static', label: 'grainMode', value: 'additive', hint: 'fixed form' },
    ],
  },
  {
    title: 'scales',
    fields: [
      { kind: 'number', path: 'envScale', label: 'envScale', min: 0, max: 2, step: 0.05, structural: true, hint: '0↔non-zero is structural (compiles a constant vec3(0))' },
      { kind: 'number', path: 'implicitRadiusK', label: 'implicitRadiusK', min: 0.001, max: 0.1, step: 0.001, hint: 'sqrt(I/k) cut-off' },
      { kind: 'number', path: 'skyK', label: 'skyK', min: 0.1, max: 2, step: 0.05, hint: 'sky gradient exponent' },
      { kind: 'number', path: 'decalDepth', label: 'decalDepth', min: 0.05, max: 1, step: 0.05, hint: 'projection half-depth, m' },
      { kind: 'number', path: 'decalRoughness', label: 'decalRoughness', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'grade (§10.5)',
    fields: [
      { kind: 'number', path: 'grade.contrastPivot', label: 'contrastPivot', min: 0.05, max: 0.5, step: 0.01 },
      { kind: 'static', label: 'exposureLaw', value: 'linear', hint: 'fixed form' },
      { kind: 'static', label: 'whiteBalance', value: 'rgb-gain', hint: 'fixed form' },
      { kind: 'static', label: 'liftGammaGain', value: 'asc-cdl', hint: 'fixed form' },
      { kind: 'static', label: 'saturationLuma', value: 'rec709', hint: 'fixed form' },
      { kind: 'static', label: 'hazeMode', value: 'fog-colour', hint: 'fixed form' },
      { kind: 'static', label: 'hazeCurve', value: 'exp2', hint: 'fixed form' },
    ],
  },
  {
    title: 'vignette',
    fields: [
      { kind: 'number', path: 'vignette.roundness', label: 'roundness', min: 1, max: 8, step: 0.1 },
      { kind: 'number', path: 'vignette.feather', label: 'feather', min: 0.05, max: 1, step: 0.05 },
      { kind: 'number', path: 'vignette.scale', label: 'scale', min: 0.3, max: 1.5, step: 0.01 },
    ],
  },
  {
    title: 'wet surface law',
    fields: [
      { kind: 'number', path: 'wet.roughnessScale', label: 'roughnessScale', min: 0, max: 1, step: 0.05 },
      { kind: 'number', path: 'wet.albedoScale', label: 'albedoScale', min: 0, max: 1, step: 0.05 },
      { kind: 'number', path: 'wet.normalYLow', label: 'normalYLow', min: 0, max: 1, step: 0.05 },
      { kind: 'number', path: 'wet.normalYHigh', label: 'normalYHigh', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'noise / decals / lod',
    fields: [
      { kind: 'static', label: 'noise.kind', value: 'simplex-fbm', hint: 'fixed form' },
      { kind: 'number', path: 'noise.lacunarity', label: 'lacunarity', min: 1, max: 4, step: 0.1 },
      { kind: 'number', path: 'noise.gain', label: 'gain', min: 0.1, max: 1, step: 0.05 },
      { kind: 'check', path: 'noise.normalised', label: 'normalised' },
      { kind: 'static', label: 'decalWindow.mode', value: 'live', hint: 'flag fidelity.DR-18' },
      { kind: 'number', path: 'decalWindow.max', label: 'decal max', min: 16, max: 1024, step: 16 },
      { kind: 'number', path: 'decalWindow.lifeS', label: 'decal lifeS', min: 60, max: 3600, step: 60 },
      { kind: 'number', path: 'lod.d13', label: 'lod.d13', min: 5, max: 200, step: 5, hint: 'metres' },
      { kind: 'number', path: 'lod.d35', label: 'lod.d35', min: 10, max: 400, step: 5, hint: 'metres' },
    ],
  },
  {
    title: 'camera / fx / colour',
    fields: [
      { kind: 'number', path: 'nearFar.near', label: 'near', min: 0.01, max: 10, step: 0.01, hint: 'metres' },
      { kind: 'number', path: 'nearFar.far', label: 'far', min: 100, max: 8000, step: 100, hint: 'metres' },
      { kind: 'text', path: 'fxGravity', label: 'fxGravity', hint: "'place' or m/s²" },
      { kind: 'number', path: 'fxMeshRoughness', label: 'fxMeshRoughness', min: 0, max: 1, step: 0.05 },
      { kind: 'number', path: 'waveforms.flick.bias', label: 'flick.bias', min: 0, max: 1, step: 0.05 },
      { kind: 'number', path: 'waveforms.flick.gain', label: 'flick.gain', min: 0, max: 1, step: 0.05 },
      { kind: 'number', path: 'waveforms.fire.base', label: 'fire.base', min: 0, max: 2, step: 0.02 },
      { kind: 'number', path: 'waveforms.fire.slowAmp', label: 'fire.slowAmp', min: 0, max: 1, step: 0.02 },
      { kind: 'number', path: 'waveforms.fire.slowHz', label: 'fire.slowHz', min: 0.1, max: 10, step: 0.1 },
      { kind: 'number', path: 'waveforms.fire.fastAmp', label: 'fire.fastAmp', min: 0, max: 1, step: 0.02 },
      { kind: 'number', path: 'waveforms.fire.fastHz', label: 'fire.fastHz', min: 0.5, max: 20, step: 0.5 },
      { kind: 'number', path: 'waveforms.smooth.tauS', label: 'smooth.tauS', min: 0.01, max: 2, step: 0.01, hint: 'seconds' },
      { kind: 'text', path: 'defaultFogColor', label: 'defaultFogColor', hint: "'night-sky-horizon' or r,g,b linear" },
    ],
  },
];

/**
 * Calibration paths whose panel edits sync a live uniform instead of needing a rebuild: `grade.contrastPivot`
 * drives the post pipeline's `calibrationPivot` uniform (postfx-tsl.ts `syncPanelLiveCalibration`). The panel reports
 * them through `onLiveChange`.
 */
const LIVE_PATHS: ReadonlySet<string> = new Set(['grade.contrastPivot']);

const getPath = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((acc, k) => (acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
const setPath = (o: unknown, path: string, v: unknown): void => {
  const parts = path.split('.');
  const last = parts.pop()!;
  const parent = parts.reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], o) as Record<string, unknown>;
  parent[last] = v;
};

const fmtDefault = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : Array.isArray(v) ? v.join(',') : String(v));
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** parses the free-text fields: 'night-sky-horizon' | 'r,g,b' and 'place' | number */
function parseText(path: string, raw: string): { ok: boolean; value?: unknown } {
  const t = raw.trim();
  if (path === 'defaultFogColor') {
    if (t === 'night-sky-horizon') return { ok: true, value: t };
    const parts = t.split(',').map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return { ok: true, value: parts as [number, number, number] };
    return { ok: false };
  }
  if (path === 'fxGravity') {
    if (t === 'place') return { ok: true, value: t };
    const n = Number(t);
    if (Number.isFinite(n) && n < 0) return { ok: true, value: n };
    return { ok: false };
  }
  return { ok: false };
}

const PANEL_STYLE = [
  'position:fixed', 'top:8px', 'right:8px', 'width:320px', 'max-height:calc(100vh - 16px)', 'overflow-y:auto',
  'background:rgba(10,12,16,.94)', 'color:#cfd6dd', 'border:1px solid #3a4550', 'border-radius:6px',
  'font:11px/1.5 ui-monospace,monospace', 'padding:8px 10px', 'z-index:99999',
].join(';');

/**
 * Mounts the dev calibration panel. Returns null outside a DOM (the module is only loaded for `?calibrate=1`,
 * so this is a backstop, not a path the app takes).
 */
export function installCalibratePanel(opts: CalibratePanelOptions = {}): CalibratePanel | null {
  if (typeof document === 'undefined') return null;
  const mount = opts.mount ?? document.body;

  const root = document.createElement('div');
  root.setAttribute('style', PANEL_STYLE);
  root.dataset['ssCalibrate'] = '1';

  const header = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'calibration (dev)';
  const reset = document.createElement('button');
  reset.textContent = 'reset all';
  reset.title = 'restore every constant to its shipped default';
  reset.setAttribute('style', 'float:right');
  header.append(title, reset);

  const note = document.createElement('div');
  note.textContent = 'Edits the runtime copy. ⚠ structural: needs material/pipeline rebuild.';
  note.setAttribute('style', 'color:#8a94a0;margin:2px 0 6px');

  const body = document.createElement('div');
  root.append(header, note, body);
  mount.appendChild(root);

  interface Row {
    field: Field;
    control: HTMLElement;
    label: HTMLElement;
    def: unknown;
    set: (v: unknown) => void;
  }
  const rows: Row[] = [];

  const mark = (row: Row): void => {
    const cur = row.field.kind === 'static' ? row.def : getPath(calibration, (row.field as { path: string }).path);
    const changed = !sameValue(cur, row.def);
    // 'check' and 'static' fields carry no structural flag: narrow by property presence first
    const structural = 'structural' in row.field && row.field.structural === true;
    row.label.style.color = changed ? '#ffd479' : '';
    row.label.textContent = (structural ? '⚠ ' : '') + row.field.label + (changed ? ' *' : '');
  };

  for (const sec of SECTIONS) {
    const h = document.createElement('div');
    h.textContent = sec.title;
    h.setAttribute('style', 'color:#7fd0ff;margin:8px 0 2px;text-transform:uppercase;letter-spacing:.08em;font-size:10px');
    body.appendChild(h);
    for (const field of sec.fields) {
      const line = document.createElement('div');
      line.setAttribute('style', 'display:flex;align-items:center;gap:6px;margin:2px 0');
      const label = document.createElement('span');
      label.setAttribute('style', 'flex:0 0 128px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      label.title = field.hint ?? '';
      line.appendChild(label);
      const row: Row = { field, control: document.createElement('span'), label, def: undefined, set: () => undefined };

      if (field.kind === 'static') {
        row.def = field.value;
        const s = document.createElement('span');
        s.textContent = field.value;
        s.setAttribute('style', 'color:#8a94a0');
        line.appendChild(s);
        row.set = () => undefined;
      } else {
        const def = getPath(CALIBRATION_DEFAULTS, field.path);
        row.def = def;
        label.title = `${field.hint ?? ''} (default: ${fmtDefault(def)})`.trim();
        if (field.kind === 'select') {
          const sel = document.createElement('select');
          for (const o of field.options) {
            const opt = document.createElement('option');
            opt.value = o;
            opt.textContent = o;
            sel.appendChild(opt);
          }
          sel.value = String(getPath(calibration, field.path));
          sel.addEventListener('change', () => {
            setPath(calibration, field.path, sel.value);
            mark(row);
            if (field.structural === true) opts.onStructuralChange?.([field.path]);
          });
          line.appendChild(sel);
          row.control = sel;
          row.set = (v: unknown) => {
            sel.value = String(v);
          };
        } else if (field.kind === 'number') {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = String(field.min);
          inp.max = String(field.max);
          inp.step = String(field.step);
          inp.value = String(getPath(calibration, field.path));
          inp.setAttribute('style', 'width:76px');
          inp.addEventListener('change', () => {
            const n = Number(inp.value);
            if (!Number.isFinite(n)) {
              inp.value = String(getPath(calibration, field.path));
              return;
            }
            setPath(calibration, field.path, Math.min(field.max, Math.max(field.min, n)));
            inp.value = String(getPath(calibration, field.path));
            mark(row);
            if (field.structural === true) opts.onStructuralChange?.([field.path]);
            else if (LIVE_PATHS.has(field.path)) opts.onLiveChange?.([field.path]);
          });
          line.appendChild(inp);
          row.control = inp;
          row.set = (v: unknown) => {
            inp.value = String(v);
          };
        } else if (field.kind === 'check') {
          const inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.checked = getPath(calibration, field.path) === true;
          inp.addEventListener('change', () => {
            setPath(calibration, field.path, inp.checked);
            mark(row);
          });
          line.appendChild(inp);
          row.control = inp;
          row.set = (v: unknown) => {
            inp.checked = v === true;
          };
        } else {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = fmtDefault(getPath(calibration, field.path));
          inp.setAttribute('style', 'width:110px');
          inp.addEventListener('change', () => {
            const parsed = parseText(field.path, inp.value);
            if (!parsed.ok) {
              inp.value = fmtDefault(getPath(calibration, field.path));
              return;
            }
            setPath(calibration, field.path, parsed.value);
            mark(row);
          });
          line.appendChild(inp);
          row.control = inp;
          row.set = (v: unknown) => {
            inp.value = fmtDefault(v);
          };
        }
      }
      body.appendChild(line);
      rows.push(row);
      mark(row);
    }
  }

  const refresh = (): void => {
    for (const row of rows) {
      if (row.field.kind === 'static') continue;
      row.set(getPath(calibration, (row.field as { path: string }).path));
      mark(row);
    }
  };

  reset.addEventListener('click', () => {
    resetCalibration();
    refresh();
    // reset writes the shipped pivot back: the live uniform must follow it (no rebuild)
    opts.onLiveChange?.(['grade.contrastPivot']);
  });

  return {
    refresh,
    dispose: () => {
      root.remove();
    },
  };
}
