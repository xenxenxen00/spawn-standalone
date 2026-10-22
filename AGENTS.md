# Public source maintenance

- The runtime is game-independent: inject world/content/configuration; never import game implementations or virtual modules in runtime source. Vite owns virtual adapters.
- Converted packages must retain the runtime MIT notice and adapted-source notices; license text is part of the archive checks.
- Keep only synthetic test data. Do not add game exports, asset catalogs, authored program snapshots, credentials or private checkout paths. Preserve third-party attribution.
- From the root, `npm ci` installs locked dependencies; `npm run check` builds package exports before typecheck/lint/tests. Rebuild after source edits because workspace imports resolve compiled entries.
- Notice inventory comparisons normalize Git checkout line endings; keep real content drift fatal.
- Source-audit history tests use synthetic commit objects; keep them independent of developer Git identity and configuration.
- Browser checks need Playwright Chromium. On Windows use writable local TEMP/TMP, the installed browser cache and VITEST_MAX_WORKERS=1.
- Canonicalize Vite worker paths with native real paths; Windows TEMP may contain 8.3 aliases. Retain the browser alias-path regressions.
- `npm run audit:source` checks current publishable files, staged blobs and all reachable history without printing matched file contents. Run it before committing and after history changes.
- Noise defaults have no authored terrain anchors. Keep host-owned calibration data outside this source tree; test conditioning with synthetic points.
- `npm run release:check -- --out ../release-candidates` verifies actual archives and a separate install; its offline install requires a warm npm cache. A source-tree test does not replace this gate.
- Keep rendering calibrations and explicit false options meaningful. Test behavior and negative controls with synthetic inputs.
- Preserve user changes, use isolated task branches, stage explicit paths and verify before committing. Uploads, registry publication and tags require explicit user authorization.
