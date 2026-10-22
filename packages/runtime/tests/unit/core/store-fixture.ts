// Shared fixture for the row-store tests (WP C1a): a store over null ports with recording physics / input / scene / camera /
// attachment ports, and a row builder that inserts records the way lifecycle.ts (WP C1b) will.
import { vi } from 'vitest';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import type { KernelPorts } from '../../../src/compat/core/ports.ts';
import { createRowRec, RowStoreImpl, type RowInit, type RowStoreOptions } from '../../../src/compat/core/store/rows.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';

export interface StoreFixture {
  store: RowStoreImpl;
  ports: KernelPorts;
  /** inserts a row: defaults vm platform, place gallow-farm, the next serial */
  add(init: Partial<RowInit> & { id: string }): RowRec;
  warnings: string[];
}

export function storeFixture(opts: Omit<RowStoreOptions, 'ports' | 'warn'> = {}): StoreFixture {
  const ports = createNullPorts();
  for (const k of ['setPosition', 'setRotation', 'setVelocity', 'setAngularVelocity', 'setForce', 'setSpectating', 'onPhysicsWrite'] as const) {
    vi.spyOn(ports.physics, k);
  }
  vi.spyOn(ports.input, 'setBlocked');
  const warnings: string[] = [];
  const store = new RowStoreImpl({ ...opts, ports, warn: (m) => warnings.push(m) });
  const add = (init: Partial<RowInit> & { id: string }): RowRec => {
    const rec = createRowRec({ serial: store.allocSerial(), vm: 'platform', place: 'gallow-farm', ...init });
    store.insert(rec);
    return rec;
  };
  return { store, ports, add, warnings };
}
