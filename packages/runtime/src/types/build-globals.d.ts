// Compile-time constants injected by `define` in vite.config.ts (build §3.1). Dead-code elimination removes the test hooks
// and the unused platform adapter in production builds; the pack gate re-checks with string scans (build §7.2).
declare const __SS_PLATFORM__: 'playgama' | 'web';
declare const __SS_TEST_HOOKS__: boolean;
declare const __SS_VERSION__: string;
declare const __SS_ORIGIN_COMMIT__: string;
