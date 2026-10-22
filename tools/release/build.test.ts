import { describe, expect, it } from 'vitest';
import { rewriteModulePaths } from './build.ts';

describe('compiled module paths', () => {
  it('rewrites runtime imports and workers while preserving declaration-file imports', () => {
    const input = [
      "import type { GameUiModule } from './game-ui.d.ts';",
      "import './globals.d.ts';",
      "export { createHost } from '../host.ts';",
      "const worker = new Worker(new URL('./worker.ts', import.meta.url));",
      "import type { Mesh } from 'builtin/three';",
    ].join('\n');
    expect(rewriteModulePaths(input)).toBe([
      "import type { GameUiModule } from './game-ui.d.ts';",
      "import './globals.d.ts';",
      "export { createHost } from '../host.js';",
      "const worker = new Worker(new URL('./worker.js', import.meta.url));",
      "import type { Mesh } from '@spawn-standalone/runtime/builtin/three';",
    ].join('\n'));
  });
  it('omits CSS side effects only from declarations and retains runtime stylesheet imports', () => {
    const source = "import './touch.css';\nimport \"./theme.css?inline\";\nimport './runtime.js';\nexport {};\n";
    expect(rewriteModulePaths(source)).toBe(source);
    expect(rewriteModulePaths(source, true)).toBe("import './runtime.js';\nexport {};\n");
  });

});
