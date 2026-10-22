import DATA from './lib/data.yml';
export default function render(ctx) {
  return `<div class="hud">${DATA.title}</div>`;
}
