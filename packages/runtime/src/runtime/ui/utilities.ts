// The small utility stylesheet behind `UiHostConfig.utilities`. Spawn's UI realm let a game's markup use these (Tailwind-style) class
// names without defining them; a ported game that relies on them turns the option on. Opt-in: PP's UI never loads it. Only the
// positioning, display, flex/grid alignment, sizing, overflow and pointer classes a HUD uses; it is not Tailwind.
const rule = (name: string, body: string): string => `.${name} { ${body} }`;

const SPACING: ReadonlyArray<readonly [string, string]> = [['0', '0'], ['1', '.25rem'], ['2', '.5rem'], ['3', '.75rem'], ['4', '1rem'], ['6', '1.5rem'], ['8', '2rem']];

const RULES: readonly string[] = [
  // position
  rule('static', 'position: static;'), rule('relative', 'position: relative;'), rule('absolute', 'position: absolute;'),
  rule('fixed', 'position: fixed;'), rule('sticky', 'position: sticky;'),
  rule('inset-0', 'inset: 0;'), rule('inset-x-0', 'left: 0; right: 0;'), rule('inset-y-0', 'top: 0; bottom: 0;'),
  rule('top-0', 'top: 0;'), rule('right-0', 'right: 0;'), rule('bottom-0', 'bottom: 0;'), rule('left-0', 'left: 0;'),
  rule('z-0', 'z-index: 0;'), rule('z-10', 'z-index: 10;'), rule('z-20', 'z-index: 20;'), rule('z-30', 'z-index: 30;'), rule('z-40', 'z-index: 40;'), rule('z-50', 'z-index: 50;'),
  // display
  rule('block', 'display: block;'), rule('inline-block', 'display: inline-block;'), rule('inline', 'display: inline;'),
  rule('flex', 'display: flex;'), rule('inline-flex', 'display: inline-flex;'), rule('grid', 'display: grid;'), rule('hidden', 'display: none;'),
  // flex and grid
  rule('flex-row', 'flex-direction: row;'), rule('flex-col', 'flex-direction: column;'), rule('flex-wrap', 'flex-wrap: wrap;'), rule('flex-nowrap', 'flex-wrap: nowrap;'),
  rule('flex-1', 'flex: 1 1 0%;'), rule('flex-none', 'flex: none;'), rule('shrink-0', 'flex-shrink: 0;'), rule('grow', 'flex-grow: 1;'),
  rule('items-start', 'align-items: flex-start;'), rule('items-center', 'align-items: center;'), rule('items-end', 'align-items: flex-end;'), rule('items-stretch', 'align-items: stretch;'),
  rule('justify-start', 'justify-content: flex-start;'), rule('justify-center', 'justify-content: center;'), rule('justify-end', 'justify-content: flex-end;'), rule('justify-between', 'justify-content: space-between;'),
  rule('place-items-center', 'place-items: center;'),
  ...SPACING.flatMap(([k, v]) => [rule(`gap-${k}`, `gap: ${v};`), rule(`p-${k}`, `padding: ${v};`), rule(`m-${k}`, `margin: ${v};`)]),
  // size, overflow, pointer
  rule('w-full', 'width: 100%;'), rule('h-full', 'height: 100%;'), rule('w-screen', 'width: 100vw;'), rule('h-screen', 'height: 100vh;'), rule('min-h-0', 'min-height: 0;'), rule('min-w-0', 'min-width: 0;'),
  rule('overflow-hidden', 'overflow: hidden;'), rule('overflow-auto', 'overflow: auto;'), rule('overflow-visible', 'overflow: visible;'),
  rule('pointer-events-none', 'pointer-events: none;'), rule('pointer-events-auto', 'pointer-events: auto;'),
  rule('select-none', 'user-select: none; -webkit-user-select: none;'), rule('cursor-pointer', 'cursor: pointer;'),
  rule('opacity-0', 'opacity: 0;'), rule('opacity-50', 'opacity: .5;'), rule('opacity-100', 'opacity: 1;'),
  rule('text-center', 'text-align: center;'), rule('text-left', 'text-align: left;'), rule('text-right', 'text-align: right;'),
  rule('truncate', 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'),
];

/** the stylesheet text (a `<style>` body); placed before the game's own styles so the game can override any rule */
export const UI_UTILITIES_CSS: string = `/* ss utilities */\n${RULES.join('\n')}`;

/** the class names the sheet defines, for tests and tooling */
export const UI_UTILITY_CLASSES: readonly string[] = Object.freeze(RULES.map((r) => r.slice(1, r.indexOf(' '))));
