# Verification

Run checks from a fresh clone with Node.js 24+, Git, installed dependencies and Playwright Chromium:

```sh
npm ci --no-audit --no-fund
npx --no-install playwright install chromium
npm run check
npm run audit:source
npm run release:check -- --out ../release-candidates
```

Use writable TEMP/TMP and `VITEST_MAX_WORKERS=1` for a single browser lane on Windows. Browser skips must be reported separately from passing assertions.

The source audit has synthetic negative controls for credentials (including JSON/YAML/npm configuration), private paths, invalid UTF-8/NUL payloads, game export paths, staged-only secrets and secrets removed from earlier commits. It prints finding paths/rules/lines without matched file contents. It is separate from the package audit because excluded package files could still leak through a public source repository.

The release verifier audits actual npm archives, installs them outside the checkout, rejects workspace/ancestor dependency links, consumes public declarations with strict TypeScript, and exercises the installed executable. The generated sample remains unedited through init/import/check/coverage/assets/build/dev and Playgama packaging, including SQL, jobs, user input and local assets.

For hardware rendering, run `node tools/release/hardware-smoke.mjs <installed-sample-dist> --out hardware-report.json`. It rejects software GPUs and blank/gradient-only frames, hides DOM overlays and waits for real geometry. A known antivirus script injected into loopback HTML is locally neutralized and explicitly reported; other external requests fail the strict offline check.

Local Playgama fallback/packaging does not prove hosted Bridge initialization, live ads or platform acceptance. Physical mobile, hosted CI, other operating systems and original game acceptance/goldens require separate evidence. No publication or upload is performed by these checks.
