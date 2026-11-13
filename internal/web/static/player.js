// TubeShelf's player: the youtube-nocookie embed without YouTube's controls, driven over its postMessage
// protocol (the one YouTube's iframe_api script speaks), so no third-party script runs on this page.
// Every control, shortcut and the fullscreen mode belong to this page; the embed only shows the video.

// The page may swap a watch page in without loading it (app.js does, so the click that opened the video
// still counts as the user's go-ahead for sound); mount() starts the player found in the page, and
// unmount() saves the position and drops every listener and timer of the one before.
let active = null;
export function unmount() {
  active?.();
  active = null;
}
export function mount() {
  unmount();
  const box = document.getElementById('player');
  if (box) active = setup(box);
}

function setup(box) {
  const abort = new AbortController();
  const { signal } = abort;
  const frame = document.getElementById('yt');
  const toast = document.getElementById('toast');
  const track = box.querySelector('.track');
  const volumeInput = box.querySelector('.volume input');
  const speedButton = box.querySelector('.speed');
  const speedMenu = document.getElementById('speed-menu');
  const keysDialog = document.getElementById('keys');
  const ORIGIN = 'https://www.youtube-nocookie.com';
  const id = box.dataset.id;
  const ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3;
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  const now = { t: Number(box.dataset.start) || 0, at: performance.now(), d: Number(box.dataset.duration) || 0, state: -1, rate: 1, loaded: 0 };
  let connected = false;
  let segments = [];
  let savedAt = now.t;
  let captions = false;
  // Set when the browser refused to start with sound and the video started muted instead; the stored choice stays.
  let forcedMute = false;

  // Volume and mute are remembered in this browser. A muted start also starts the embed muted.
  const sound = (() => {
    try { return { volume: 100, muted: false, ...JSON.parse(localStorage.getItem('player-sound')) }; } catch { return { volume: 100, muted: false }; }
  })();
  const keepSound = () => { try { localStorage.setItem('player-sound', JSON.stringify(sound)); } catch { /* storage blocked */ } };
  frame.src = frame.dataset.src + (sound.muted ? '&mute=1' : '');

  const send = (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), ORIGIN);
  const command = (func, ...args) => send({ event: 'command', func, args });

  // The embed only starts reporting after it hears "listening"; repeat until it answers.
  const hello = setInterval(() => (connected ? clearInterval(hello) : send({ event: 'listening', id: 1, channel: 'widget' })), 250);

  let toastTimer;
  function say(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 1600);
  }

  const clock = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  // ---------- Progress ----------
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
  // pagehide also fires when the tab is closed, where fetch would be cancelled.
  addEventListener('pagehide', () => save(false, true), { signal });

  // ---------- Drawing ----------
  let scrubbing = null; // seconds while the knob is dragged
  const position = () => (scrubbing ?? (now.state === PLAYING ? now.t + ((performance.now() - now.at) / 1000) * now.rate : now.t));

  function draw() {
    const t = Math.min(position(), now.d || Infinity);
    const pct = now.d ? (t / now.d) * 100 : 0;
    track.style.setProperty('--played', `${pct}%`);
    track.style.setProperty('--loaded', `${now.loaded * 100}%`);
    track.setAttribute('aria-valuenow', Math.floor(t));
    track.setAttribute('aria-valuetext', `${clock(t)} of ${clock(now.d)}`);
    box.querySelector('.now').textContent = clock(t);
    raf = requestAnimationFrame(draw);
  }
  let raf = requestAnimationFrame(draw);

  function drawSegments() {
    const host = box.querySelector('.segments');
    host.replaceChildren();
    if (!now.d) return;
    for (const [from, to] of segments) {
      const s = document.createElement('span');
      s.style.setProperty('left', `${(from / now.d) * 100}%`);
      s.style.setProperty('width', `${((to - from) / now.d) * 100}%`);
      host.append(s);
    }
  }

  function drawState() {
    const playing = now.state === PLAYING || now.state === BUFFERING;
    box.classList.toggle('playing', playing);
    const play = box.querySelector('[data-act="play"]');
    play.setAttribute('aria-label', playing ? 'Pause (k)' : 'Play (k)');
    play.dataset.tip = playing ? 'Pause' : 'Play';
    if (playing) box.classList.remove('blocked');
    wake();
  }

  function drawSound() {
    const off = sound.muted || forcedMute;
    box.classList.toggle('muted', off || sound.volume === 0);
    box.classList.toggle('asks-sound', forcedMute);
    volumeInput.value = off ? 0 : sound.volume;
    volumeInput.style.setProperty('--fill', `${volumeInput.value}%`);
    const mute = box.querySelector('[data-act="mute"]');
    mute.setAttribute('aria-label', off ? 'Unmute (m)' : 'Mute (m)');
    mute.dataset.tip = off ? 'Unmute' : 'Mute';
  }
  drawSound();

  // ---------- Messages from the embed ----------
  const running = () => now.state === PLAYING || now.state === BUFFERING;
  function askToPlay() {
    box.classList.add('blocked');
    say('Press play or k to start');
  }
  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!connected) {
      connected = true;
      command('addEventListener', 'onAutoplayBlocked');
      command('setVolume', sound.volume);
      command(sound.muted ? 'mute' : 'unMute');
      // Should the embed neither start nor report a block (see onAutoplayBlocked), the play button asks for a click.
      setTimeout(() => { if (!running() && !forcedMute) askToPlay(); }, 6000);
    }
    // The browser refused to start with sound: start muted, which browsers allow; m or the sound button
    // gives the sound back. If even that is refused, the play button asks for one click.
    if (msg.event === 'onAutoplayBlocked' && !forcedMute && !sound.muted) {
      forcedMute = true;
      command('mute');
      command('playVideo');
      drawSound();
      say('Your browser started this muted · press m for sound');
      setTimeout(() => { if (!running()) askToPlay(); }, 1500);
    }
    const info = msg.info;
    if (!info) return;
    if (typeof info.duration === 'number' && info.duration > 0 && info.duration !== now.d) {
      now.d = info.duration;
      track.setAttribute('aria-valuemax', Math.floor(now.d));
      box.querySelector('.total').textContent = clock(now.d);
      drawSegments();
    }
    if (typeof info.videoLoadedFraction === 'number') now.loaded = info.videoLoadedFraction;
    if (typeof info.playbackRate === 'number' && info.playbackRate !== now.rate) {
      now.rate = info.playbackRate;
      speedButton.textContent = `${now.rate}×`;
      for (const b of speedMenu.querySelectorAll('[data-rate]')) b.setAttribute('aria-checked', Number(b.dataset.rate) === now.rate);
    }
    if (typeof info.currentTime === 'number') {
      now.t = info.currentTime;
      now.at = performance.now();
      const hit = segments.find(([from, to]) => now.t >= from && now.t < to - 0.5);
      if (hit) {
        seek(hit[1]);
        say('Skipped sponsor');
      }
      if (now.state === PLAYING && Math.abs(now.t - savedAt) >= 10) save();
    }
    if (typeof info.playerState === 'number' && info.playerState !== now.state) {
      now.state = info.playerState;
      now.at = performance.now();
      drawState();
      // YouTube turns captions on by itself (a muted start, again after a seek) and does not report it;
      // each settled state puts back the choice made here.
      if (now.state === PLAYING || now.state === PAUSED) command(captions ? 'loadModule' : 'unloadModule', 'captions');
      if (now.state === PAUSED) save();
      if (now.state === ENDED) save(true);
    }
  }, { signal });

  if (box.dataset.sponsorblock === '1') {
    fetch(`/videos/${id}/segments`).then((r) => r.json()).then((s) => { segments = s || []; drawSegments(); }).catch(() => {});
  }

  // ---------- Actions ----------
  function seek(to) {
    to = Math.max(0, Math.min(to, now.d ? now.d - 0.5 : to));
    now.t = to;
    now.at = performance.now();
    command('seekTo', to, true);
  }
  const toggle = () => command(now.state === PLAYING || now.state === BUFFERING ? 'pauseVideo' : 'playVideo');
  function setVolume(v) {
    forcedMute = false;
    sound.volume = Math.max(0, Math.min(100, Math.round(v)));
    sound.muted = sound.volume === 0;
    command('setVolume', sound.volume);
    command(sound.muted ? 'mute' : 'unMute');
    keepSound();
    drawSound();
  }
  // After a forced mute, m, the sound button or the volume bring the sound back.
  function liftMute() {
    if (!forcedMute) return;
    forcedMute = false;
    command('setVolume', sound.volume);
    command('unMute');
    drawSound();
    say('Sound on');
  }

  function mute() {
    if (forcedMute) return liftMute();
    sound.muted = !sound.muted;
    if (!sound.muted && sound.volume === 0) sound.volume = 50;
    command(sound.muted ? 'mute' : 'unMute');
    if (!sound.muted) command('setVolume', sound.volume);
    keepSound();
    drawSound();
    say(sound.muted ? 'Muted' : 'Sound on');
  }
  function speed(rate) {
    command('setPlaybackRate', rate);
    say(`${rate}×`);
  }
  const step = (dir) => speed(RATES[Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(now.rate) + dir))]);
  function toggleCaptions() {
    captions = !captions;
    command(captions ? 'loadModule' : 'unloadModule', 'captions');
    box.querySelector('[data-act="captions"]').setAttribute('aria-pressed', captions);
    say(captions ? 'Captions on' : 'Captions off');
  }
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen()).catch(() => {});

  // Fullscreen: the bar lies over the video and fades out while playing and untouched. Pointer moves over the
  // embed never reach this page, so while playing a layer of ours (.screen::after) covers it: it sees moves,
  // and a click on it pauses. Paused, the layer is gone and YouTube's own links work.
  let idleTimer;
  function wake() {
    box.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (document.fullscreenElement === box && running() && !box.querySelector('.bar:hover, .bar :focus-visible') && !speedMenu.matches(':popover-open')) box.classList.add('idle');
    }, 2500);
  }
  box.addEventListener('pointermove', wake);
  document.addEventListener('fullscreenchange', wake, { signal });
  box.querySelector('.screen').addEventListener('click', (e) => { if (e.target.classList.contains('screen')) toggle(); });
  const showKeys = () => (keysDialog.open ? keysDialog.close() : keysDialog.showModal());

  const actions = {
    play: toggle, back: () => seek(position() - 10), forward: () => seek(position() + 10), mute,
    captions: toggleCaptions, fullscreen, keys: showKeys,
  };
  box.querySelector('.buttons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) actions[b.dataset.act]();
  });
  speedMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rate]');
    if (!b) return;
    speed(Number(b.dataset.rate));
    speedMenu.hidePopover();
  });
  volumeInput.addEventListener('input', () => setVolume(Number(volumeInput.value)));

  // ---------- Seek bar: click or drag, with the time under the pointer ----------
  const hoverTime = track.querySelector('.hover-time');
  const at = (e) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  track.addEventListener('pointermove', (e) => {
    if (!now.d) return;
    const f = at(e);
    hoverTime.hidden = false;
    hoverTime.textContent = clock(f * now.d);
    hoverTime.style.setProperty('left', `${f * 100}%`);
    if (scrubbing !== null) scrubbing = f * now.d;
  });
  track.addEventListener('pointerleave', () => { if (scrubbing === null) hoverTime.hidden = true; });
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !now.d) return;
    track.setPointerCapture(e.pointerId);
    scrubbing = at(e) * now.d;
    box.classList.add('scrubbing');
  });
  const endScrub = (e, cancel) => {
    if (scrubbing === null) return;
    const to = scrubbing;
    scrubbing = null;
    box.classList.remove('scrubbing');
    hoverTime.hidden = !track.matches(':hover');
    if (!cancel) seek(to);
  };
  track.addEventListener('pointerup', (e) => endScrub(e, false));
  track.addEventListener('pointercancel', (e) => endScrub(e, true));

  // ---------- Keyboard: one owner ----------
  // A click on the video moves focus into the embed, which ignores keys (disablekb); take focus back.
  addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement === frame) box.focus({ preventScroll: true });
  }, 0), { signal });

  document.addEventListener('keydown', (e) => {
    wake();
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input:not([type="range"]), select, textarea, dialog.palette')) return;
    if (e.target === volumeInput && e.key.startsWith('Arrow')) return;
    if (keysDialog.open && e.key !== '?') return;
    // As on YouTube, by physical key so every layout works (a German Shift+. gives ":"): Shift+. and Shift+,
    // change the speed; . and , step one frame while paused.
    if (e.code === 'Period' || e.code === 'Comma') {
      const dir = e.code === 'Period' ? 1 : -1;
      if (e.shiftKey) step(dir);
      else if (!running()) seek(position() + dir / 30);
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case ' ':
        if (e.target.closest('button, a, summary')) return; // space presses the focused control
        toggle(); break;
      case 'k': toggle(); break;
      case 'j': seek(position() - 10); break;
      case 'l': seek(position() + 10); break;
      case 'ArrowLeft': seek(position() - 5); break;
      case 'ArrowRight': seek(position() + 5); break;
      case 'ArrowUp': setVolume((sound.muted ? 0 : sound.volume) + 5); say(`Volume ${sound.volume}%`); break;
      case 'ArrowDown': setVolume((sound.muted ? 0 : sound.volume) - 5); say(`Volume ${sound.volume}%`); break;
      case 'm': mute(); break;
      case 'c': toggleCaptions(); break;
      case 'f': fullscreen(); break;
      case '<': step(-1); break;
      case '>': step(1); break;
      case '?': showKeys(); break;
      case 'w': document.querySelector('.watch-meta [data-toggle="watched"]')?.requestSubmit(); break;
      default:
        if (e.key >= '0' && e.key <= '9' && now.d) seek((now.d * Number(e.key)) / 10);
        else return;
    }
    e.preventDefault();
  }, { signal });

  return () => {
    abort.abort();
    clearInterval(hello);
    cancelAnimationFrame(raf);
    clearTimeout(toastTimer);
    clearTimeout(idleTimer);
    if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
    save();
  };
}

mount();
