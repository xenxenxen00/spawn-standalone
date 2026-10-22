# Source provenance and content boundary

The library was extracted from an application runtime and made game-independent. Historical engine comments and calibrated defaults describe compatibility evidence; they do not include the original game's implementation or assets. Project code is released under MIT by its owner. Adapted third-party code retains the complete notices recorded in THIRD_PARTY_NOTICES.md.

This public source was assembled as an independent repository with new history. It contains four packages, portable engine tests, synthetic fixture exports, public documentation and build/release tools. The original private repository is not an ancestor or dependency.

Omitted material includes game workspaces, copied game SQL/AI/achievement fixtures, game-specific save/UI/input policies, asset catalogs, scene snapshots, serialized authored FX programs, golden catalogs, private release evidence and upstream-sync tools. Original-corpus acceptance tests are not distributed as dormant or skipped suites.

Portable tests that previously depended on that material use small synthetic asset indexes, SQL schemas, jobs, achievements, geometry and input sequences. Generic renderer, worker, parser, persistence and physics assertions remain. This establishes library behavior on those inputs; it does not establish original-game acceptance or visual golden parity.

The source audit covers current tracked/unignored source, staged blobs and every blob reachable from local refs. It detects common credential formats, credential literals, private key blocks, private checkout paths, prohibited game-content paths, symlinks and non-text data (NUL bytes or invalid UTF-8). Findings report paths, lines and rule names without matched file contents. Pattern detection cannot prove the absence of every possible custom secret or identify all ownership issues; the file inventory and source review complement it.

Default noise retains scalar numerical calibration but has no map-specific conditioning anchors. Hosts can supply their own anchors through `createNoise`; the original game's terrain coordinates and sample heights are omitted.

Game exports supplied later to the converter remain the creator's responsibility and retain their own licenses. Hosted services, account access and live advertising are outside local package verification.
