// Drives the youtube-nocookie embed over its postMessage protocol (the same
// one YouTube's iframe_api script speaks), so no third-party script runs here.

const box = document.getElementById('player');
const frame = document.getElementById('yt');
const toast = document.getElementById('toast');
const ORIGIN = 'https://www.youtube-nocookie.com';
const id = box.dataset.id;
const PLAYING = 1, PAUSED = 2, ENDED = 0;

const now = { t: 0, d: Number(box.dataset.duration) || 0, state: -1, rate: 1, muted: false };
let connected = false;
let segments = [];
let savedAt = 0;

const send = (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), ORIGIN);
const command = (func, ...args) => send({ event: 'command', func, args });

// The embed only starts reporting after it hears "listening"; repeat until it answers.
const hello = setInterval(() => (connected ? clearInterval(hello) : send({ event: 'listening', id: 1, channel: 'widget' })), 300);

let toastTimer;
function say(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1600);
}

function save(ended = false, beacon = false) {
  if (!now.t && !ended) return;
  savedAt = now.t;
  const body = new URLSearchParams({ t: now.t.toFixed(1), d: now.d.toFixed(1), ended: ended ? '1' : '0' });
  const url = `/videos/${id}/progress`;
  if (beacon) return navigator.sendBeacon(url, body);
  fetch(url, { method: 'POST', body, headers: { 'X-Requested-With': 'fetch' } })
    .then((r) => r.json())
    .then((r) => {
      if (!r.watched) return;
      const form = document.querySelector('.watch-meta [data-toggle="watched"]');
      form.elements.on.value = '0';
      form.querySelector('button').setAttribute('aria-pressed', 'true');
    })
    .catch(() => {});
}

window.addEventListener('message', (e) => {
  if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  connected = true;
  const info = msg.info;
  if (!info) return;
  if (typeof info.duration === 'number' && info.duration > 0) now.d = info.duration;
  if (typeof info.playbackRate === 'number') now.rate = info.playbackRate;
  if (typeof info.muted === 'boolean') now.muted = info.muted;
  if (typeof info.currentTime === 'number') {
    now.t = info.currentTime;
    const hit = segments.find(([from, to]) => now.t >= from && now.t < to - 0.5);
    if (hit) {
      command('seekTo', hit[1], true);
      say('Skipped sponsor');
    }
    if (now.state === PLAYING && Math.abs(now.t - savedAt) >= 10) save();
  }
  if (typeof info.playerState === 'number' && info.playerState !== now.state) {
    now.state = info.playerState;
    if (now.state === PAUSED) save();
    if (now.state === ENDED) save(true);
  }
});

// pagehide also fires when the tab is closed, where fetch would be cancelled.
window.addEventListener('pagehide', () => save(false, true));

if (box.dataset.sponsorblock === '1') {
  fetch(`/videos/${id}/segments`).then((r) => r.json()).then((s) => (segments = s)).catch(() => {});
}

const seek = (to) => command('seekTo', Math.max(0, Math.min(to, now.d || to)), true);
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
function speed(step) {
  const i = Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(now.rate) + step));
  command('setPlaybackRate', RATES[i]);
  say(`${RATES[i]}×`);
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ': case 'k': command(now.state === PLAYING ? 'pauseVideo' : 'playVideo'); break;
    case 'j': seek(now.t - 10); break;
    case 'l': seek(now.t + 10); break;
    case 'ArrowLeft': seek(now.t - 5); break;
    case 'ArrowRight': seek(now.t + 5); break;
    case 'm': command(now.muted ? 'unMute' : 'mute'); say(now.muted ? 'Unmuted' : 'Muted'); break;
    case 'f': document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen(); break;
    case '<': case ',': speed(-1); break;
    case '>': case '.': speed(1); break;
    case 'w': document.querySelector('.watch-meta [data-toggle="watched"]')?.requestSubmit(); break;
    default:
      if (e.key >= '0' && e.key <= '9' && now.d) seek((now.d * Number(e.key)) / 10);
      else return;
  }
  e.preventDefault();
});
