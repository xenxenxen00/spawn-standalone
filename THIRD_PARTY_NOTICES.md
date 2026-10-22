# Third-party notices

The four public spawn-standalone packages are MIT licensed. Their dependencies retain their own
licenses and copyright notices. This inventory records installed package metadata; it does not
relicense dependencies. The npm archives include adapted three.js postprocessing code credited
below. Other dependencies are installed as separate npm packages with their own
license files. Preserve those files when redistributing a complete installation.

Regenerate this inventory after a dependency change with `node tools/release/notices.ts`.

## Direct production dependencies and peers

| Package | Installed version | License metadata | Public packages |
| --- | --- | --- | --- |
| @dimforge/rapier3d-simd-compat | 0.21.0 | Apache-2.0 | runtime |
| @playgama/bridge | 2.3.1 | LGPL-3.0-or-later | cli, runtime |
| @playwright/test | 1.64.0 | Apache-2.0 | cli |
| @types/three | 0.186.0 | MIT | runtime (peer) |
| acorn | 8.19.0 | MIT | cli, vite |
| acorn-walk | 8.3.5 | MIT | cli, vite |
| fflate | 0.8.3 | MIT | cli, runtime |
| idiomorph | 0.8.0 | 0BSD | runtime |
| js-yaml | 5.4.3 | MIT | cli, vite |
| sharp | 0.35.5 | Apache-2.0 | cli |
| sql.js | 1.15.1 | MIT | cli, runtime |
| three | 0.186.1 | MIT | runtime, vite |
| vite | 8.3.3 | MIT | cli, vite (peer) |
| yaml | 2.9.1 | ISC | cli |

## Vendored three.js code

The runtime includes an adapted three.js bloom/postprocessing implementation. The following
copyright, permission notice and disclaimer apply to those vendored portions:

The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


## Adapted Tailwind CSS reset

The scoped UI reset derives from Tailwind CSS v3.4.14 preflight:
https://github.com/tailwindlabs/tailwindcss/tree/v3.4.14

MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


The optional `@types/three` peer supplies public TypeScript types. The testing package has no
production dependencies. The Playgama Bridge is LGPL-3.0-or-later; the project MIT license does
not replace its license. Sharp's installed native package also includes libvips components under
the licenses recorded below. Playwright downloads Chromium separately; the browser is a local
verification prerequisite and is excluded from the npm archives.

## Installed transitive production dependencies

This table follows required dependencies and installed optional dependencies from the direct
packages above. Uninstalled optional binaries for other operating systems/architectures are
excluded. Paths below are relative to each dependency package in `node_modules`.

| Package | Version | License metadata | Notice files in installed package |
| --- | --- | --- | --- |
| @dimforge/rapier3d-compat | 0.12.0 | Apache-2.0 | `LICENSE` |
| @dimforge/rapier3d-simd-compat | 0.21.0 | Apache-2.0 | `LICENSE` |
| @img/colour | 1.1.0 | MIT | `LICENSE.md` |
| @img/sharp-win32-x64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | `LICENSE` |
| @oxc-project/types | 0.153.0 | MIT | `LICENSE` |
| @playgama/bridge | 2.3.1 | LGPL-3.0-or-later | `LICENSE` |
| @playwright/test | 1.64.0 | Apache-2.0 | `LICENSE`, `NOTICE` |
| @rolldown/binding-win32-x64-msvc | 1.2.13 | MIT | See package source/README |
| @rolldown/pluginutils | 1.0.1 | MIT | `LICENSE` |
| @tweenjs/tween.js | 23.1.3 | MIT | `LICENSE` |
| @types/stats.js | 0.17.4 | MIT | `LICENSE` |
| @types/three | 0.186.0 | MIT | `LICENSE` |
| @types/webxr | 0.5.24 | MIT | `LICENSE` |
| acorn | 8.19.0 | MIT | `LICENSE` |
| acorn-walk | 8.3.5 | MIT | `LICENSE` |
| argparse | 2.0.1 | Python-2.0 | `LICENSE` |
| detect-libc | 2.1.2 | Apache-2.0 | `LICENSE` |
| fdir | 6.5.0 | MIT | `LICENSE` |
| fflate | 0.8.3 | MIT | `LICENSE` |
| idiomorph | 0.8.0 | 0BSD | `LICENSE` |
| js-yaml | 5.4.3 | MIT | `LICENSE` |
| lightningcss | 1.33.0 | MPL-2.0 | `LICENSE` |
| lightningcss-win32-x64-msvc | 1.33.0 | MPL-2.0 | `LICENSE` |
| meshoptimizer | 1.1.1 | MIT | `LICENSE.md` |
| nanoid | 3.3.20 | MIT | `LICENSE` |
| picocolors | 1.1.1 | ISC | `LICENSE` |
| picomatch | 4.0.7 | MIT | `LICENSE` |
| playwright | 1.64.0 | Apache-2.0 | `LICENSE`, `NOTICE` |
| playwright-core | 1.64.0 | Apache-2.0 | `LICENSE`, `NOTICE` |
| postcss | 8.5.29 | MIT | `LICENSE` |
| rolldown | 1.2.13 | MIT | `LICENSE` |
| semver | 7.8.5 | ISC | `LICENSE` |
| sharp | 0.35.5 | Apache-2.0 | `LICENSE` |
| source-map-js | 1.2.2 | BSD-3-Clause | `LICENSE` |
| sql.js | 1.15.1 | MIT | `LICENSE` |
| three | 0.186.1 | MIT | `LICENSE` |
| tinyglobby | 0.2.17 | MIT | `LICENSE` |
| vite | 8.3.3 | MIT | `LICENSE.md` |
| yaml | 2.9.1 | ISC | `LICENSE` |

## Assets emitted into converted game builds

- The Vite plugin copies the meshopt decoder and Basis Universal transcoders from the installed
  three.js package. Meshopt uses MIT; Basis Universal uses Apache-2.0. Their upstream notices
  remain in the distributed files. The three.js Basis directory has no separate license file.
- The SQL adapter emits sql.js's WebAssembly file when a generated game uses SQL.
- Playgama packaging emits the Bridge configuration and credits/license inventory as
  `THIRD_PARTY.txt`; games retain their own license and asset credits.
- Game exports and their assets are supplied separately and are excluded from these public npm
  archives. They are not covered by this project's MIT grant.

Upstream references: [Playgama Bridge](https://github.com/playgama/bridge),
[Sharp/libvips](https://sharp.pixelplumbing.com/install/#licensing),
[three.js](https://github.com/mrdoob/three.js),
[Basis Universal](https://github.com/BinomialLLC/basis_universal), and
[meshoptimizer](https://github.com/zeux/meshoptimizer).
