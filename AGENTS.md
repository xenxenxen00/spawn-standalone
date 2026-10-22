# Public source maintenance

- The runtime is game-independent: inject world/content/configuration; never import game implementations or virtual modules in runtime source. Vite owns virtual adapters.
- Keep only synthetic test data. Do not add game exports, asset catalogs, authored program snapshots, credentials or private checkout paths. Preserve third-party attribution.
- From the root, `npm ci` installs locked dependencies; `npm run check` builds package exports before typecheck/lint/tests. Rebuild after source edits because workspace imports resolve compiled entries.
- Notice inventory comparisons normalize Git checkout line endings; keep real content drift fatal.
- Browser checks need Playwright Chromium. On Windows use writable local TEMP/TMP, the installed browser cache and VITEST_MAX_WORKERS=1.
- `npm run audit:source` checks current publishable files, staged blobs and all reachable history without printing matched file contents. Run it before committing and after history changes.
- Noise defaults have no authored terrain anchors. Keep host-owned calibration data outside this source tree; test conditioning with synthetic points.
- `npm run release:check -- --out ../release-candidates` verifies actual archives and a separate install; its offline install requires a warm npm cache. A source-tree test does not replace this gate.
- Keep rendering calibrations and explicit false options meaningful. Test behavior and negative controls with synthetic inputs.
- Preserve user changes, use isolated task branches, stage explicit paths and verify before committing. Uploads, registry publication and tags require explicit user authorization.
