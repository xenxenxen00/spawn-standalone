// Matching usages to the manifest and building the coverage report.
import type { CapabilityKind, CapabilityManifest, CapabilityStatus } from '@spawn-standalone/runtime/capabilities';
import { ManifestIndex } from './match.ts';
import type { TreeScan, Usage } from './scan-tree.ts';

export interface Sample {
  file: string;
  line: number;
}

export interface Surface {
  id: string;
  kind: CapabilityKind;
  uses: number;
  samples: Sample[];
}

export interface MatchedSurface extends Surface {
  status: CapabilityStatus;
  note?: string;
  plan?: string;
}

export type Bucket = CapabilityStatus | 'unknown';

export interface Report {
  source: string;
  manifest: { runtime: string; entries: number };
  scanned: { jsFiles: number; yamlFiles: number };
  summary: Record<Bucket, { surfaces: number; uses: number }>;
  groups: Record<CapabilityStatus, MatchedSurface[]>;
  /** surfaces with no manifest entry */
  unknown: Surface[];
  /** emit topics that are not engine acts: game events, not coverage gaps */
  customEvents: Surface[];
  warnings: string[];
}

export const STATUS_ORDER: readonly CapabilityStatus[] = ['absent', 'loud', 'partial', 'implemented'];
const MAX_SAMPLES = 3;

const SELF_THREE: ReadonlySet<string> = new Set(['anim', 'ik', 'mixer', 'target', 'view', 'primitive', 'light', 'audio', 'effectiveScale', 'touching']);

/** Cuts an unmatched ctx chain to the member the engine would provide; what follows is game data. */
export function normalizeUnknown(id: string): string {
  if (!id.startsWith('ctx.')) return id;
  const s = id.split('.');
  const keep = (n: number): string => s.slice(0, n).join('.');
  switch (s[1]) {
    case 'self':
      return s[2] !== undefined && SELF_THREE.has(s[2]) ? keep(4) : keep(3);
    case 'world':
      return s[2] === 'places' || s[2] === 'assets' ? keep(4) : keep(3);
    case 'place':
    case 'player':
    case 'files':
    case 'view':
      return keep(3);
    default:
      return keep(2);
  }
}

function addSample(s: Surface, u: Usage): void {
  s.uses++;
  if (s.samples.length < MAX_SAMPLES && !s.samples.some((x) => x.file === u.file && x.line === u.line)) s.samples.push({ file: u.file, line: u.line });
}

class Tally {
  private readonly map = new Map<string, Surface>();
  add(id: string, kind: CapabilityKind, u: Usage): void {
    let s = this.map.get(id);
    if (!s) {
      s = { id, kind, uses: 0, samples: [] };
      this.map.set(id, s);
    }
    addSample(s, u);
  }
  list(): Surface[] {
    return [...this.map.values()].sort((a, b) => b.uses - a.uses || (a.id < b.id ? -1 : 1));
  }
}

/** how an unmatched usage is named in the Unknown table */
function unknownName(u: Usage): string {
  if (u.kind !== 'ctx') return u.id;
  const name = normalizeUnknown(u.id);
  // a handle chain keeps the `ctx.getObject().` spelling
  return u.label !== undefined ? name.replace(/^ctx\.self/, 'ctx.getObject()') : name;
}

export function buildReport(source: string, scan: TreeScan, manifest: CapabilityManifest): Report {
  const index = new ManifestIndex(manifest);
  const matched = new Map<string, MatchedSurface>();
  const unknown = new Tally();
  const custom = new Tally();

  for (const u of scan.usages) {
    const entry = index.match(u.id, u.value);
    if (entry) {
      let m = matched.get(entry.id);
      if (!m) {
        m = { id: entry.id, kind: entry.kind, status: entry.status, uses: 0, samples: [] };
        if (entry.note !== undefined) m.note = entry.note;
        if (entry.plan !== undefined) m.plan = entry.plan;
        matched.set(entry.id, m);
      }
      addSample(m, u);
    } else if (u.kind === 'act') {
      custom.add(u.id, 'act', u);
    } else if (u.kind === 'hook') {
      // an export that is not an engine hook is a helper; only `onXxx` names look like hooks the engine does not know
      if (/^hook:on[A-Z]/.test(u.id)) unknown.add(u.id, 'hook', u);
    } else if (!index.isContainer(u.id)) {
      unknown.add(unknownName(u), u.kind, u);
    }
  }

  const groups: Report['groups'] = { implemented: [], partial: [], absent: [], loud: [] };
  const summary = {} as Report['summary'];
  for (const b of [...STATUS_ORDER, 'unknown'] as Bucket[]) summary[b] = { surfaces: 0, uses: 0 };
  for (const m of [...matched.values()].sort((a, b) => b.uses - a.uses || (a.id < b.id ? -1 : 1))) {
    groups[m.status].push(m);
    summary[m.status].surfaces++;
    summary[m.status].uses += m.uses;
  }
  const unknownList = unknown.list();
  for (const s of unknownList) {
    summary.unknown.surfaces++;
    summary.unknown.uses += s.uses;
  }
  return {
    source,
    manifest: { runtime: manifest.runtime, entries: manifest.entries.length },
    scanned: { jsFiles: scan.jsFiles, yamlFiles: scan.yamlFiles },
    summary,
    groups,
    unknown: unknownList,
    customEvents: custom.list(),
    warnings: scan.warnings,
  };
}

export function summaryLine(r: Report): string {
  const buckets: Bucket[] = ['implemented', 'partial', 'absent', 'loud', 'unknown'];
  const uses = buckets.reduce((n, b) => n + r.summary[b].uses, 0);
  return `${buckets.map((b) => `${r.summary[b].surfaces} ${b}`).join(', ')} (${uses} uses)`;
}

const sampleText = (samples: readonly Sample[]): string => samples.map((s) => `${s.file}:${s.line}`).join(', ');
const cell = (text: string): string => text.replace(/\|/g, '\\|');

function table(rows: readonly MatchedSurface[]): string[] {
  const out = ['| surface | uses | plan | note | samples |', '|---|---:|---|---|---|'];
  for (const m of rows) out.push(`| \`${cell(m.id)}\` | ${m.uses} | ${m.plan ?? ''} | ${cell(m.note ?? '')} | ${cell(sampleText(m.samples))} |`);
  return out;
}

export function renderMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# Coverage: ${r.source}`, '');
  lines.push(`Summary: ${summaryLine(r)}`, '');
  lines.push(
    `Scanned ${r.scanned.jsFiles} JS files and ${r.scanned.yamlFiles} config files against ${r.manifest.entries} manifest entries (${r.manifest.runtime}). Counts are distinct surfaces; the bracketed total is use sites.`,
    '',
  );
  if (r.warnings.length > 0) lines.push('Warnings:', ...r.warnings.map((w) => `- ${w}`), '');
  const titles: Record<CapabilityStatus, string> = {
    absent: 'Absent (undefined or inert: the game gets nothing)',
    loud: 'Loud (throws when used)',
    partial: 'Partial',
    implemented: 'Implemented',
  };
  for (const status of STATUS_ORDER) {
    const rows = r.groups[status];
    lines.push(`## ${titles[status]} (${rows.length})`, '');
    if (rows.length === 0) lines.push('None.', '');
    else lines.push(...table(rows), '');
  }
  lines.push(`## Unknown (${r.unknown.length})`, '', 'Used by the game, named in no manifest entry. Either a gap in the manifest or a game-local object called `ctx`.', '');
  if (r.unknown.length === 0) lines.push('None.', '');
  else {
    lines.push('| surface | uses | samples |', '|---|---:|---|');
    for (const s of r.unknown) lines.push(`| \`${cell(s.id)}\` | ${s.uses} | ${cell(sampleText(s.samples))} |`);
    lines.push('');
  }
  lines.push(`## Custom events (${r.customEvents.length})`, '', 'Topics passed to `ctx.emit` that are not engine acts. They are game events and are not counted above.', '');
  if (r.customEvents.length === 0) lines.push('None.', '');
  else {
    lines.push('| topic | emits | samples |', '|---|---:|---|');
    for (const s of r.customEvents) lines.push(`| \`${cell(s.id.replace(/^act:/, ''))}\` | ${s.uses} | ${cell(sampleText(s.samples))} |`);
  }
  return lines.join('\n') + '\n';
}
