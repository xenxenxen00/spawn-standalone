# Runtime API (v1)

This is the host API exported by `@spawn-standalone/runtime`; carried Spawn game files continue to use `builtin/*` through the Vite plugin. It describes code present today, not a promise that every Spawn surface is implemented. Check the [capability manifest](../packages/runtime/capabilities/capabilities.json) and [source boundary](provenance.md).

TypeScript hosts need the Node, three.js and SQL.js declarations listed in the [README](../README.md). The external release gate checks those public declarations with strict checking enabled and without `skipLibCheck`.

## Composition

```ts
import { composeGame } from '@spawn-standalone/runtime/shell';
import { createWorld, preloadSets } from 'virtual:ss/world';

const app = await composeGame({ slug: 'my-game', canvas, world: createWorld(), boot: { preloadSets } });
// Later: app.dispose();
```

`slug`, `canvas` and an injected `world` are required for the default runtime (`canvas` may be `null`). The Vite adapter supplies compiled world inputs; direct Node hosts construct a `BootWorld` using `@spawn-standalone/runtime/registry`. Each world gets a fresh registry. Startup uses `world.defaultPlace`, the web platform saves under `<slug>:`, and keyboard/mouse input and the frame driver are installed. Rendering and physics are opt-in. UI is absent unless `uiContainer` and `gameUi` are supplied; defaults use root `game`, automatic exported handlers, no game stylesheet, and readiness on the first UI render.

`renderer: 'default'` installs the runtime renderer and requires a non-null canvas; provide `content` for carried scripts and `assetIndex` for indexed assets. Lighting resolves from world config, carried `scripts/lighting.js`, then a neutral Lambert fallback. `wiring: 'default'` opts into Rapier physics, nav and motion. Renderer and wiring share asset/geometry services when either is enabled. `headless: true` omits browser listeners and animation-frame scheduling; advance `app.driver.step(timeMs)` yourself. Dispose the returned app to release resources.

## `ComposeGameOptions`

| Option | Current default and behavior |
|---|---|
| `slug` | Required. Save prefix and log tag. |
| `canvas` | Required; `null` is valid for headless or a later renderer. |
| `uiContainer`, `gameUi` | No UI host unless both are provided. `ui` overrides `UiHostConfig`; shell adds `globals: 'auto'`. |
| `world` | Required injected `BootWorld`. Vite generates `createWorld()` and `preloadSets`; the Vite shell compatibility wrapper supplies these for earlier hosts. |
| `platform` | `'web'`; `'playgama'` selects the Playgama adapter, or pass a `Platform` object. |
| `durable` | Overrides the boot default durable state. The generic document is `{ v: 1, settings: {}, ps: {} }`, key `ss_save_v1`; all JSON-valued body keys are saved by default. Choose a per-game key, explicit keys and/or a codec when needed. |
| `profile` | Fallback name `Player`; preserves platform user IDs. Override `defaultName` or `idPrefix`; device ids remain unchanged. |
| `input` | Keyboard/mouse only. Optional `map`, `look` (sensitivity multiplier/range and pitch limit), `pointerLock`, `unlockedLook: 'rightDrag'`, touch layer and `pointerSpace`. `pointerLock: true` uses manager defaults; `touch: true` uses the runtime's default touch scheme. |
| `camera` | Row-authored orientation off. `orientationFromRow: true` reads the row's `rotation.lookAt` / `include`. |
| `ports` | No SQL, jobs or music adapter by default. Supply `sql`, `jobs`, `music`; optional companion values are `jobPause`, `sqlWorldId`, and `sqlStores`. Ports are bound into ctx extensions by the shell. |
| `extensions`, `ext` | No game overrides. Bags merge over shell defaults, with `ext` applied after `extensions`. Shell defaults enable engine cadence, change tracking, writable gravity, music support and capability-aware missing verbs. |
| `wiring` | Null ports. `'default'` creates Rapier physics, nav and motion; alternatively pass a wiring factory. `wiringOptions` configures default wiring. |
| `renderer` | None. `'default'` creates the default renderer; alternatively pass a renderer factory. `rendererOptions` configures it. |
| `assetIndex` | Empty v1 asset index. |
| `content` | Empty. Accepts a path loader or `virtual:ss/content` map. |
| `rigs` / `render.rigs` | Off. Either true enables procedural rig support in default wiring, geometry workers and renderer. |
| `render` | Explicit flags default absent, except FX mode defaults to Worker where supported and range rolls use corrected range evaluation. Flags: `vertexColors`, `scriptedPrimitives`, `fxBuiltinAtlas`, `fxAtlasUrl`, `fxLightsWithoutAtlas`, `fxAlignedCards`, `fxHeldFollow`, `fxRangeRolls`, `fxMode`, `primitiveAngles`, `dissolve`, `highlightOutline`, `highlightScriptedRows`, `scriptedPivot`, `flatPrimitivesCentred`, `warmK8Acts`, `worldTags`; plus `geometryWorker` and `albedoTints`. `fxRangeRolls: false` explicitly selects legacy behavior. |
| `boot`, `seed`, `start` | Seed unset; start `'defaultPlace'`. Nested values win. `preloadSets` defaults empty; provide the generated sets. Optional hooks: `homePlace`, `readHome`, `fallbackPlace`, `residentPlaces`, `preroll`, plus `worldId`, `ids`, `placeBake`; `actors` is a deprecated preload shortcut. |
| `adBreaks` | Off on web; on for `'playgama'`. `false` disables; `true` or options enable. The channel pauses the game clock and reports `ctx.session.adBreak`; the adapter owns ad availability and cooldowns. |
| `fakeAds` | Off. Web-only `'show'`, `'fail'` or `'query'` (`?fakeAds=1` / `?fakeAds=fail`); ignored for Playgama and disabled headless. |
| `viewport` | Off. When enabled, provides `session.viewport` and safe-area/aspect CSS values; unavailable headless. |
| `audioTier`, `audioOptions` | Tier `'high'`. Host options set `voicePoolSize`, `perClipCap`, independent one-shot/entity distance defaults, and `monoPositional`. Calibrated caps and distances remain the fallback. Invalid caps are rejected before initialization. |
| `geometry` | Supply `createWorker` or `loadGenerator` when a render service is needed. `render.geometryWorker` is a URL or Worker factory. The generated scaffold owns its worker entry; missing entry/loader fails immediately. |
| `headless` | False. When true, omits browser listeners and animation-frame scheduling. |
| `onProgress` | Unset boot-progress callback. |
| `parts` | Runtime implementations; partial replacements are mainly a test/host seam. |

`GameApp` exposes `kernel`, `boot`, `platform`, `audio`, `input`, `camera`, `scene`, `ui`, `extensions`, `driver`, `acts`, `wiring`, `renderEnv`, optional `adBreaks` and `viewport`, ordered `steps`, `renderer`, `attachRenderer(renderer)`, and `dispose()`.

FX runs in a module Worker by default where Workers are available, with an inline fallback if startup fails. Set `render.fxMode: 'inline'` or supply `rendererOptions.search: '?fx=inline'` to run FX on the main thread for diagnosis. The explicit option takes precedence over the query. Corrected range-roll behavior is the default; `render.fxRangeRolls: false` restores the earlier unit-roll behavior.

## UI host

Direct UI defaults are `rootId: 'game'`, `blankSelector: '[data-scene-cover]'`, `styleId: 'ss-style'`, `spriteId: 'ss-sprites'`, `globals: 'auto'`, `gameCss: false`, `readyWhen: 'firstUiRender'` and no utility CSS. Handler discovery excludes lifecycle and runtime names; an explicit list restricts it. `styles` and `utilities` opt into game/utility CSS. `ctx.port` is an empty host-owned bag unless supplied. Touch defaults add no controls; a `TouchScheme` supplies action names, labels, layout, stick axes and gestures. Pause panels/labels/hints and toast content are host-authored. Theme CSS variables include `--ss-font`, `--ss-accent` and `--ss-background`.

Look calibration defaults remain sensitivity multiplier 3, preference range 0.1–4, pitch limit 1.4 radians, engine base 0.0006 radians/pixel and 400-pixel mouse spike rejection. Override the multiplier/range/pitch limit through `input.look`; the engine base and spike filter remain calibrated mechanisms. Audio defaults remain 64/64/40 voices for high/medium/low, 16 instances per clip, one-shot reference/max distances 3/45 and entity distances 1/45. Host options override these values; per-play values override host distances.

`builtin/noise` defaults have no terrain conditioning anchors. `createNoise(calibration)` accepts host-owned anchor sets; ports relying on the original application's terrain pins must provide their own calibration explicitly.

## Ports and capability behavior

The root `@spawn-standalone/runtime` entry exports SQL, jobs, music, achievements and leaderboard host ports. `@spawn-standalone/runtime/shell` exports composition and shell helpers. `@spawn-standalone/runtime/capabilities` exports manifest types/loaders; the JSON manifest is available at `@spawn-standalone/runtime/capabilities.json`.

The shell does not create a database, worker host, achievements store or leaderboard store automatically. Supply ports where required. SQL helpers and storage adapters exist, but each game supplies its schema and opts in. Jobs require a `JobPort`/host. `composeGame` installs a no-op `ctx.music` by default; a supplied `MusicPort` replaces it. Achievements and leaderboard ports are not automatically composed by `composeGame`.

The manifest statuses are `implemented`, `partial`, `absent`, and `loud`. In `composeGame`, default extensions enable `ctx.changed`, writable place gravity, flexible sim cadence, a no-op `ctx.music`, and capability-aware absence for unsupported SQL/job verbs. A supplied SQL or job port binds the corresponding verb. Bare-kernel defaults differ: most extensions are off, and missing SQL/job verbs throw unless `absentAsUndefined` is enabled. Some loud verbs still throw. A manifest entry is not proof of complete engine semantics; read its note for partial behavior.

`@spawn-standalone/vite` exports `spawnStandalone`, `ssJobs`, `ssSqlJs`, virtual-module ids/types and analysis helpers. It serves `virtual:ss/*`, aliases `builtin/*` and game-tree imports, and requires `game/.import/*` records from the importer. The runtime has no bundled game fonts or HUD stylesheet; the game supplies them. See [Port a local export](porting.md).



The port exports and direct responsibilities are:

| Port | Useful constructors/types | Responsibility |
|---|---|---|
| SQL | `SqlPort`, `createSqlJsPort`, `createHostSqlStores`, `createPlatformSqlStore` | Async tagged SQL execution, migration, per-world persistence, backup/restore and flush. The runtime does not choose a game's schema. |
| Jobs | `JobPort`, `createJobHost`, `createWebWorkerFactory`, `createWorkerPool`, `createJobPauseGate` | Resolve and run `jobs/<id>.js`; jobs are opt-in and otherwise `ctx.job` is undefined under the shell defaults. |
| Music | `MusicPort`, `AudioMusicPort`, `createAudioMusicPort`, `createNullMusicPort` | Opt-in audio-backed `play`, `stop` and `duck`; the shell's default remains no-op. |
| Achievements | `AchievementsPort`, `createAchievementsPort`, JSON stores | Device-local unlock/stat/step state. The game/host supplies definitions and connects the port through kernel extensions. |
| Leaderboards | `LeaderboardPort`, `createLeaderboardPort` | Device-local best scores; does not publish a public board or sync other devices. |

`createSqlJsPort` is a helper, not an automatic composition choice. A game should construct and pass its port to `composeGame({ ports: ... })`; the returned `app.extensions` shows the resolved extension bag.

`createAudioMusicPort(audio)` shares the engine supplied through `parts.audio`; pass the adapter as `ports.music` before boot. Import `createAudioEngine` from `@spawn-standalone/runtime/shell` and the music adapter from `@spawn-standalone/runtime`. Initialize that engine before the first music call (the default renderer/wiring path does this before boot). Base tracks loop and crossfade; named layers default to one-shot overlays. Fade and duck durations use seconds. Drive fades and duck expiry with `const off = app.driver.addFrameListener(frame => music.frame(frame.now))`: `frame.now` is presentation milliseconds and freezes while paused. Call `off()` and `music.dispose()` when disposing the shared audio engine. Streaming, gesture unlock, music volume, mute and host pause remain owned by that engine.

`createAudioEngine({ lazyZeroStreams: true })` defers an entity's stream media creation until its gain first becomes positive. Later zero-gain updates preserve that stream and playback position. This option defaults to `false`; buffer clips and existing pause, mute and disposal behavior are unchanged.

## Content, identity and optional plugins

`rendererOptions` accepts `vendor` decoder URLs, `dynamicTags`, `ignoredTags`, `panelFonts`, `search`, `variantData` and `gorePlugin`. Asset groups and shader families are host-owned string IDs; provide family descriptors instead of enemy/boss/weapon tables. The default canvas has no aspect clamp, light slots take authored records, and night-sky palette/star count are atmosphere options. The optional `@spawn-standalone/runtime/plugins/gore` factory requires explicit tags, capacities and geometry limits and allocates nothing when omitted.

`boot.worldId` defaults to null; `boot.ids` overrides human body/camera IDs. `boot.preloadSets` is explicit. No Director module, home-state key, lobby ID, residency policy or preroll is assumed. The core uses a minimal HostPlatform; web/Playgama features live in adapters. Pause reasons are host-extensible, and adapters aggregate host/ad pause as platform holds.

The public archives exclude legacy PP codecs, preferences, UI styles and fixtures. Internal `ss` symbols, worker flags and the `partPaint` vertex attribute are coordinated contracts. Existing PPBK/PPNV binary formats remain byte-compatible.
