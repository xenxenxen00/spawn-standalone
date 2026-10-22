// The fixture game: initialises the Playgama Bridge before play, follows its pause and audio events, saves through
// bridge.storage and shows an interstitial at the end of a run. It draws a title or a mid-play frame on a 2D canvas.
const canvas = document.getElementById('stage');
const g = canvas.getContext('2d');
const state = { paused: false, muted: false, best: 0, ended: false, playing: new URLSearchParams(location.search).get('cover') === 'play' };

function draw() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  g.fillStyle = state.playing ? '#2a8f4a' : '#203a80';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#ffd040';
  g.beginPath();
  g.arc(canvas.width / 2, canvas.height * (state.playing ? 0.35 : 0.5), Math.min(canvas.width, canvas.height) / 6, 0, Math.PI * 2);
  g.fill();
  if (state.ended) {
    g.fillStyle = '#e02020';
    g.fillRect(0, 0, canvas.width, canvas.height / 8);
  }
}

async function boot() {
  const bridge = window.bridge;
  await bridge.initialize();
  bridge.platform.on(bridge.EVENT_NAME.PAUSE_STATE_CHANGED, (p) => (state.paused = p));
  bridge.platform.on(bridge.EVENT_NAME.AUDIO_STATE_CHANGED, (on) => (state.muted = !on));
  const saved = await bridge.storage.get(['best']);
  state.best = Number(saved?.[0] ?? 0);
  addEventListener('resize', draw);
  canvas.addEventListener('pointerdown', () => {
    // a tap ends the run: save, then the results band and the interstitial at that natural break
    state.ended = true;
    bridge.storage.set(['best'], [String(state.best + 1)]);
    bridge.advertisement.showInterstitial('run_end');
    draw();
  });
  draw();
  bridge.platform.sendMessage(bridge.PLATFORM_MESSAGE.GAME_READY);
  document.body.setAttribute('data-booted', '1');
}

boot().catch((e) => document.body.setAttribute('data-boot-error', String(e)));
