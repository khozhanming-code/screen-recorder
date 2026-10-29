// Application wiring: UI events, state, and coordination between the other modules.
import {
  formatDuration, formatBytes, formatDate, timestamp, sanitizeFilename, extensionFor,
  describeMime, downloadBlob, fixDuration, makeThumbnail, frameToBlob,
} from './utils.js';
import { Recorder, pickMimeType } from './recorder.js';
import { AudioMixer } from './audio-mixer.js';
import { CanvasCompositor } from './canvas-compositor.js';
import { LevelMeter } from './visualizer.js';
import * as storage from './storage.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------------------------------------------------------- settings */
const SETTINGS_KEY = 'framecap.settings.v1';
const DEFAULTS = Object.freeze({ resolution: '1080', fps: 30, videoMbps: 8, audioKbps: 128, echo: true, noise: true, filename: 'recording' });
const ALLOWED = {
  resolution: ['720', '1080', '1440', 'source'],
  fps: [30, 60],
  videoMbps: [2.5, 5, 8, 12, 20],
  audioKbps: [64, 96, 128, 192, 256],
};

function validateSettings(raw) {
  const out = { ...DEFAULTS };
  const src = raw && typeof raw === 'object' ? raw : {};
  if (ALLOWED.resolution.includes(String(src.resolution))) out.resolution = String(src.resolution);
  for (const key of ['fps', 'videoMbps', 'audioKbps']) {
    if (ALLOWED[key].includes(Number(src[key]))) out[key] = Number(src[key]);
  }
  if (typeof src.echo === 'boolean') out.echo = src.echo;
  if (typeof src.noise === 'boolean') out.noise = src.noise;
  out.filename = sanitizeFilename(src.filename ?? DEFAULTS.filename);
  return out;
}

function loadSettings() {
  try { return validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { return { ...DEFAULTS }; }
}
function persistSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
}

let settings = loadSettings();

/* ------------------------------------------------------------------- state */
const recorder = new Recorder();
const mixer = new AudioMixer();
const meter = new LevelMeter($('meter'));

const state = {
  screenStream: null,
  camStream: null,
  micOn: false,
  studio: false,
  compositor: null,
  recMeta: null,        // {width, height, fps} of the recording in progress
  flash: '',            // status text shown while idle (e.g. "Recording ready")
  tickTimer: 0,
  preview: null,        // {blob, mimeType, duration, title, fresh, id, saved, downloaded, width, height}
  previewUrl: null,
  libraryUrls: [],
  overlay: { enabled: false, visible: true, shape: 'circle', size: 0.2, mirror: true, x: 0.72, y: 0.66 },
};

const caps = {
  secure: window.isSecureContext,
  display: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
  user: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  recorder: typeof MediaRecorder !== 'undefined',
  idb: 'indexedDB' in window,
};

/* --------------------------------------------------------------- UI helpers */
function toast(message, type = 'info', ms = 4500) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.textContent = message;
  const remove = () => node.remove();
  node.addEventListener('click', remove);
  $('toasts').append(node);
  setTimeout(remove, ms);
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setButton(btn, iconName, label) {
  btn.querySelector('use').setAttribute('href', `#i-${iconName}`);
  const lbl = btn.querySelector('.lbl, span:last-child');
  if (lbl && label != null) lbl.textContent = label;
}

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('statusText').textContent = text;
}

/** Promise-based replacement for confirm()/prompt() using a <dialog>. */
function ask({ title, message = '', confirmText = 'OK', value = null }) {
  return new Promise((resolve) => {
    const dlg = $('askDialog');
    $('askTitle').textContent = title;
    $('askMessage').textContent = message;
    $('askMessage').hidden = !message;
    $('askField').hidden = value === null;
    $('askInput').required = value !== null;
    $('askInput').value = value ?? '';
    $('askOk').textContent = confirmText;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(value === null ? true : sanitizeFilename($('askInput').value));
    }, { once: true });
    dlg.showModal();
    if (value !== null) $('askInput').select();
  });
}

/* ------------------------------------------------------------------ render */
function recordingActive() { return recorder.state === 'recording' || recorder.state === 'paused'; }

function render() {
  const rs = recorder.state;
  const active = recordingActive();
  const busy = rs === 'processing';
  const hasScreen = !!state.screenStream;

  $('btnScreen').disabled = active || busy || !caps.display;
  $('btnScreenEmpty').disabled = !caps.display;
  $('btnRecord').disabled = busy || (!active && (!hasScreen || !caps.recorder));
  $('btnRecord').classList.toggle('is-recording', active);
  setButton($('btnRecord'), active ? 'stop' : 'record', active ? 'Stop' : 'Record');
  $('btnPause').disabled = !active;
  setButton($('btnPause'), rs === 'paused' ? 'play' : 'pause', rs === 'paused' ? 'Resume' : 'Pause');

  $('btnCam').setAttribute('aria-pressed', String(!!state.camStream));
  $('btnCam').disabled = !caps.user;
  $('btnMic').setAttribute('aria-pressed', String(state.micOn));
  $('btnMic').disabled = !caps.user;
  setButton($('btnMic'), state.micOn ? 'mic' : 'mic-off', state.micOn ? 'Mic on' : 'Mic off');
  $('btnStudio').setAttribute('aria-pressed', String(state.studio));
  $('btnStudio').disabled = active || busy;

  const camOn = !!state.camStream;
  for (const id of ['shapeCircle', 'shapeRect', 'camSize', 'camMirror', 'camToggleVisible']) $(id).disabled = !camOn;
  $('shapeCircle').setAttribute('aria-pressed', String(state.overlay.shape === 'circle'));
  $('shapeRect').setAttribute('aria-pressed', String(state.overlay.shape === 'rect'));
  const vis = $('camToggleVisible');
  vis.querySelector('use').setAttribute('href', state.overlay.visible ? '#i-eye-off' : '#i-eye');
  vis.querySelector('span').textContent = state.overlay.visible ? 'Hide' : 'Show';

  $('stageEmpty').hidden = hasScreen;
  $('recBadge').hidden = !active;
  $('stage').classList.toggle('is-rec', active);
  $('recBadgeText').textContent = rs === 'paused' ? 'PAUSED' : 'REC';

  for (const id of ['setRes', 'setFps', 'setVBr', 'setABr']) $(id).disabled = active || busy;
  $('settingsLock').hidden = !(active || busy);

  if (busy) setStatus('processing', 'Processing…');
  else if (rs === 'recording') setStatus('recording', 'Recording');
  else if (rs === 'paused') setStatus('paused', 'Paused');
  else if (state.flash) setStatus('ready', state.flash);
  else if (hasScreen) setStatus('ready', 'Screen ready');
  else setStatus('idle', 'Idle');

  applyOverlay();
  updateHud();
}

function updateHud() {
  let capture = '—';
  if (state.recMeta && recordingActive()) {
    capture = `${state.recMeta.width}×${state.recMeta.height} · ${state.recMeta.fps} FPS`;
  } else if (state.screenStream && screenVideo.videoWidth) {
    const s = state.screenStream.getVideoTracks()[0]?.getSettings?.() || {};
    capture = `${screenVideo.videoWidth}×${screenVideo.videoHeight}`;
    if (s.frameRate) capture += ` · ${Math.round(s.frameRate)} FPS`;
  }
  $('hudRes').textContent = capture;
  const mime = recordingActive() ? recorder.mimeType : (caps.recorder ? pickMimeType() : null);
  $('hudFormat').textContent = mime === null ? 'Unsupported' : describeMime(mime || 'video/webm');
}

function tick() { $('timer').textContent = formatDuration(recorder.elapsedSeconds()); }

/* ---------------------------------------------------------- capability UI */
function showSupportMessages() {
  const problems = [];
  if (!caps.secure) problems.push('This page is not in a secure context. Open it through https:// or http://localhost so the browser allows screen capture.');
  if (!caps.display) problems.push('This browser cannot capture the screen (getDisplayMedia is missing). Use a current desktop version of Chrome, Edge, Firefox or Safari.');
  if (!caps.recorder) problems.push('This browser does not support MediaRecorder, so recording is unavailable.');
  else if (pickMimeType() === '') problems.push('No preferred video format was reported by this browser; it will use its own default format.');
  if (!caps.idb) problems.push('IndexedDB is unavailable, so the recordings library cannot save videos. Downloads still work.');
  if (problems.length) {
    const banner = $('unsupported');
    banner.textContent = problems.join(' ');
    banner.hidden = false;
  }
  if (!caps.idb) $('btnLibrary').disabled = true;
}

/* ----------------------------------------------------------- screen source */
const screenVideo = $('screenVideo');

function updateStageAspect() {
  if (screenVideo.videoWidth && screenVideo.videoHeight) {
    $('stage').style.setProperty('--ar', (screenVideo.videoWidth / screenVideo.videoHeight).toFixed(4));
    applyOverlay();
  }
  updateHud();
}
screenVideo.addEventListener('loadedmetadata', updateStageAspect);
screenVideo.addEventListener('resize', updateStageAspect);

function screenErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'Screen sharing was cancelled or blocked. Click Select screen, choose a screen, window or tab, then press Share. If the browser blocked it, allow screen capture for this site (lock icon in the address bar; on macOS also check System Settings → Privacy → Screen Recording).';
    case 'NotFoundError': return 'No screen or window was available to capture.';
    case 'NotReadableError': return 'The screen could not be read. Another app may be blocking capture.';
    case 'AbortError': return 'Screen capture was interrupted before it started. Try again.';
    case 'NotSupportedError': return 'This browser does not support the requested capture options.';
    default: return `Could not start screen capture: ${(err && (err.message || err.name)) || 'unknown error'}`;
  }
}

async function selectScreen() {
  if (!caps.display) { toast('Screen capture is not supported in this browser.', 'error'); return; }
  if (recordingActive() || recorder.state === 'processing') { toast('Stop the current recording before changing the screen.', 'warn'); return; }
  const video = { frameRate: { ideal: settings.fps } };
  if (settings.resolution !== 'source') video.height = { ideal: Number(settings.resolution) };

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    if (err && err.name === 'TypeError') {
      try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch (err2) { toast(screenErrorMessage(err2), 'error', 9000); return; }
    } else { toast(screenErrorMessage(err), 'error', 9000); return; }
  }

  releaseScreen();
  state.flash = '';
  state.screenStream = stream;
  screenVideo.srcObject = stream;
  screenVideo.play().catch(() => {});
  stream.getVideoTracks()[0].addEventListener('ended', onScreenEnded);

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length) {
    $('sysStatus').textContent = 'System audio: captured from the selected source.';
    $('sysVol').disabled = false;
  } else {
    $('sysStatus').textContent = 'System audio: not captured for this source.';
    $('sysVol').disabled = true;
    toast('System audio was not shared. In Chrome or Edge, pick a browser tab (or a screen on Windows) and tick “Share audio”. Recording will continue without it.', 'warn', 8000);
  }
  toast('Screen selected. Press Record when you are ready.', 'success');
  render();
}

function releaseScreen() {
  if (!state.screenStream) return;
  const old = state.screenStream;
  state.screenStream = null;
  old.getTracks().forEach((t) => { t.removeEventListener('ended', onScreenEnded); t.stop(); });
  screenVideo.srcObject = null;
  mixer.clearSystem();
  $('sysStatus').textContent = 'System audio: select a screen to check.';
  $('sysVol').disabled = true;
}

function onScreenEnded() {
  if (recordingActive()) {
    toast('Screen sharing stopped. Saving what was recorded so far…', 'warn', 6000);
    stopRecording();
  } else {
    toast('Screen sharing ended.', 'info');
  }
  releaseScreen();
  render();
}

/* ------------------------------------------------------------------ webcam */
const camVideo = $('camVideo');
const camOverlay = $('camOverlay');

async function toggleWebcam() {
  if (state.camStream) { disableWebcam(); return; }
  if (!caps.user) { toast('This browser cannot access the webcam.', 'error'); return; }
  try {
    state.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
  } catch (err) {
    const messages = {
      NotAllowedError: 'Webcam permission was denied. Allow camera access for this site in the browser’s address bar, then try again.',
      NotFoundError: 'No webcam was found on this device.',
      NotReadableError: 'The webcam is being used by another application.',
    };
    toast(messages[err.name] || `Could not start the webcam: ${err.message || err.name}`, 'error', 7000);
    return;
  }
  camVideo.srcObject = state.camStream;
  camVideo.play().catch(() => {});
  state.overlay.enabled = true;
  state.overlay.visible = true;
  state.camStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.camStream) { toast('The webcam was disconnected.', 'warn'); disableWebcam(); }
  });
  render();
}

function disableWebcam() {
  if (state.camStream) state.camStream.getTracks().forEach((t) => t.stop());
  state.camStream = null;
  camVideo.srcObject = null;
  state.overlay.enabled = false;
  render();
}

function applyOverlay() {
  const o = state.overlay;
  camOverlay.hidden = !(o.enabled && o.visible);
  camOverlay.classList.toggle('circle', o.shape === 'circle');
  camOverlay.classList.toggle('rect', o.shape === 'rect');
  camOverlay.classList.toggle('mirror', o.mirror);
  camOverlay.style.width = `${o.size * 100}%`;
  clampOverlay();
  camOverlay.style.left = `${o.x * 100}%`;
  camOverlay.style.top = `${o.y * 100}%`;
}

function clampOverlay() {
  const stage = $('stage');
  const o = state.overlay;
  const sw = stage.clientWidth || 1;
  const sh = stage.clientHeight || 1;
  const w = o.size * sw;
  const hgt = o.shape === 'circle' ? w : w * 0.75;
  o.x = Math.min(Math.max(o.x, 0), Math.max(0, 1 - w / sw));
  o.y = Math.min(Math.max(o.y, 0), Math.max(0, 1 - hgt / sh));
}

(function enableOverlayDragging() {
  let drag = null;
  camOverlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    camOverlay.setPointerCapture(e.pointerId);
    const rect = camOverlay.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  });
  camOverlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const stage = $('stage').getBoundingClientRect();
    state.overlay.x = (e.clientX - drag.dx - stage.left) / stage.width;
    state.overlay.y = (e.clientY - drag.dy - stage.top) / stage.height;
    applyOverlay();
  });
  const end = () => { drag = null; };
  camOverlay.addEventListener('pointerup', end);
  camOverlay.addEventListener('pointercancel', end);
  camOverlay.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    state.overlay.x += moves[e.key][0];
    state.overlay.y += moves[e.key][1];
    applyOverlay();
  });
  window.addEventListener('resize', applyOverlay);
})();

/* -------------------------------------------------------------- microphone */
function micConstraints() {
  return { audio: { echoCancellation: settings.echo, noiseSuppression: settings.noise, autoGainControl: true } };
}

async function enableMic() {
  if (!caps.user) { toast('This browser cannot access the microphone.', 'error'); return false; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (err) {
    const messages = {
      NotAllowedError: 'Microphone permission was denied. Allow microphone access for this site in the address bar and try again. Recording still works without it.',
      NotFoundError: 'No microphone was found on this device.',
      NotReadableError: 'The microphone is being used by another application.',
    };
    toast(messages[err.name] || `Could not start the microphone: ${err.message || err.name}`, 'error', 7000);
    return false;
  }
  try {
    await mixer.setMic(stream);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    toast(`Audio mixing is unavailable: ${err.message}`, 'error');
    return false;
  }
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    if (state.micOn) { toast('The microphone was disconnected.', 'warn'); disableMic(); }
  });
  state.micOn = true;
  meter.start(mixer.analyser);
  return true;
}

function disableMic() {
  mixer.clearMic();
  meter.stop();
  state.micOn = false;
  render();
}

async function toggleMic() {
  if (state.micOn) { disableMic(); return; }
  await enableMic();
  render();
}

/* --------------------------------------------------------------- recording */
function computeOutputSize() {
  const track = state.screenStream.getVideoTracks()[0];
  const s = track.getSettings ? track.getSettings() : {};
  const sw = screenVideo.videoWidth || s.width || 1920;
  const sh = screenVideo.videoHeight || s.height || 1080;
  const ratio = sw / sh;
  let height = settings.resolution === 'source' ? sh : Number(settings.resolution);
  let width = Math.round(height * ratio);
  if (width > 3840) { width = 3840; height = Math.round(width / ratio); }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width), height: even(height) };
}

async function startRecording() {
  if (recorder.state !== 'idle') { toast('A recording is already in progress.', 'warn'); return; }
  const screenTrack = state.screenStream && state.screenStream.getVideoTracks()[0];
  if (!screenTrack || screenTrack.readyState !== 'live') { toast('Select a screen first.', 'warn'); return; }
  const mime = pickMimeType();
  if (mime === null) { toast('This browser cannot record video (MediaRecorder is missing).', 'error'); return; }

  state.flash = '';
  $('btnRecord').disabled = true;
  let compositor = null;
  try {
    try { await mixer.init(); } catch (err) { toast(`${err.message} Recording will have no audio.`, 'warn', 6000); }
    const hasSystem = await mixer.setSystem(state.screenStream).catch(() => false);
    if (!hasSystem && state.screenStream.getAudioTracks().length === 0) $('sysStatus').textContent = 'System audio: not captured for this source.';

    const fps = settings.fps;
    let videoTrack;
    if (state.studio) {
      const size = computeOutputSize();
      compositor = new CanvasCompositor({ screenVideo, camVideo, getOverlay: () => state.overlay });
      videoTrack = compositor.start(size.width, size.height, fps).getVideoTracks()[0];
      state.recMeta = { ...size, fps };
    } else {
      const constraints = { frameRate: { ideal: fps } };
      if (settings.resolution !== 'source') constraints.height = { ideal: Number(settings.resolution) };
      await screenTrack.applyConstraints(constraints).catch(() => {}); // best effort; the browser may refuse
      const s = screenTrack.getSettings();
      state.recMeta = { width: s.width || screenVideo.videoWidth, height: s.height || screenVideo.videoHeight, fps: Math.round(s.frameRate || fps) };
      videoTrack = screenTrack;
    }

    const tracks = [videoTrack];
    if (mixer.track) tracks.push(mixer.track);
    recorder.start(new MediaStream(tracks), {
      mimeType: mime,
      videoBitsPerSecond: settings.videoMbps * 1_000_000,
      audioBitsPerSecond: settings.audioKbps * 1000,
    });
    state.compositor = compositor;
  } catch (err) {
    if (compositor) compositor.stop();
    mixer.clearSystem();
    state.recMeta = null;
    toast(err.message || 'Recording could not be started.', 'error', 8000);
    render();
    return;
  }

  tick();
  state.tickTimer = setInterval(tick, 250);
  toast(state.studio ? 'Recording started in Studio mode.' : 'Recording started.', 'success');
  render();
}

function stopRecording() {
  if (!recordingActive()) return;
  clearInterval(state.tickTimer);
  recorder.stop(); // result arrives through recorder.onFinish
  render();
}

function togglePause() {
  if (recorder.state === 'recording') { recorder.pause(); toast('Recording paused.', 'info', 2000); }
  else if (recorder.state === 'paused') { recorder.resume(); toast('Recording resumed.', 'info', 2000); }
  render();
}

recorder.onError = (err) => toast(`Recording error: ${err.message || err.name}`, 'error', 8000);

recorder.onFinish = (err, result) => {
  clearInterval(state.tickTimer);
  if (state.compositor) { state.compositor.stop(); state.compositor = null; }
  mixer.clearSystem();
  const meta = state.recMeta;
  state.recMeta = null;
  tick();
  if (err) {
    state.flash = 'Recording failed';
    toast(err.message || 'The recording failed.', 'error', 9000);
    render();
    return;
  }
  state.flash = 'Recording ready';
  render();
  const title = `${settings.filename} ${formatDate(Date.now())}`;
  openPreview({ ...result, title, fresh: true, width: meta?.width, height: meta?.height });
};

/* ----------------------------------------------------------------- preview */
const previewDialog = $('previewDialog');
const previewVideo = $('previewVideo');

function releasePreview() {
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewVideo.load();
  if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  state.preview = null;
}

function openPreview(info) {
  if (previewDialog.open) previewDialog.close();
  releasePreview();
  state.preview = { saved: false, downloaded: false, ...info };
  const p = state.preview;
  $('previewTitle').textContent = p.title;
  $('pvDuration').textContent = formatDuration(p.duration);
  $('pvSize').textContent = formatBytes(p.blob.size);
  $('pvFormat').textContent = describeMime(p.mimeType);
  $('pvRes').textContent = p.width && p.height ? `${p.width}×${p.height}` : 'Detecting…';
  $('btnSave').hidden = !p.fresh || !caps.idb;
  $('btnSave').disabled = false;

  state.previewUrl = URL.createObjectURL(p.blob);
  previewVideo.src = state.previewUrl;
  previewVideo.onloadedmetadata = async () => {
    if (!(p.width && p.height) && previewVideo.videoWidth) $('pvRes').textContent = `${previewVideo.videoWidth}×${previewVideo.videoHeight}`;
    await fixDuration(previewVideo); // makes the seek bar work for WebM files
  };
  previewVideo.onerror = () => toast('The preview could not be played. You can still download the file and open it in another player.', 'error', 8000);
  previewDialog.showModal();
}

async function closePreview() {
  const p = state.preview;
  if (p && p.fresh && !p.saved && !p.downloaded) {
    const ok = await ask({ title: 'Discard this recording?', message: 'It has not been downloaded or saved to the library yet. Closing the preview will delete it.', confirmText: 'Discard' });
    if (!ok) return;
  }
  previewDialog.close();
}

previewDialog.addEventListener('cancel', (e) => { e.preventDefault(); closePreview(); });
previewDialog.addEventListener('close', releasePreview);

function previewBaseName() { return sanitizeFilename(state.preview.title); }

function downloadPreview() {
  const p = state.preview;
  if (!p) return;
  try {
    downloadBlob(p.blob, `${previewBaseName()}.${extensionFor(p.mimeType)}`);
    p.downloaded = true;
    toast('Download started.', 'success', 2500);
  } catch (err) { toast(`Download failed: ${err.message}`, 'error'); }
}

async function snapshotPreview() {
  const p = state.preview;
  if (!p) return;
  try {
    const blob = await frameToBlob(previewVideo, 'image/png');
    downloadBlob(blob, `${previewBaseName()}-snapshot-${Math.round(previewVideo.currentTime)}s.png`);
    toast('Snapshot saved as PNG.', 'success', 2500);
  } catch (err) { toast(`Snapshot failed: ${err.message}`, 'error', 6000); }
}

async function savePreviewToLibrary() {
  const p = state.preview;
  if (!p || p.saved) return;
  $('btnSave').disabled = true;
  try {
    const thumb = await makeThumbnail(p.blob, p.duration);
    await storage.saveRecording({
      title: p.title, createdAt: Date.now(), duration: p.duration, size: p.blob.size,
      mimeType: p.mimeType, width: p.width, height: p.height, thumb, blob: p.blob,
    });
    p.saved = true;
    $('btnSave').hidden = true;
    toast('Saved to your library.', 'success');
    refreshLibraryCount();
  } catch (err) {
    $('btnSave').disabled = false;
    toast(err.message, 'error', 9000);
  }
}

/* ----------------------------------------------------------------- library */
const libraryDialog = $('libraryDialog');

async function refreshLibraryCount() {
  try { $('libCount').textContent = String(await storage.countRecordings()); } catch { $('libCount').textContent = '0'; }
}

function revokeLibraryUrls() {
  state.libraryUrls.forEach((u) => URL.revokeObjectURL(u));
  state.libraryUrls = [];
}

async function renderLibrary() {
  const list = $('libList');
  let items;
  try {
    items = await storage.getAllRecordings();
  } catch (err) {
    toast(err.message, 'error', 7000);
    return;
  }
  revokeLibraryUrls();
  list.replaceChildren();
  $('libEmpty').hidden = items.length > 0;
  $('libCount').textContent = String(items.length);

  for (const rec of items) {
    let thumb;
    if (rec.thumb) {
      const url = URL.createObjectURL(rec.thumb);
      state.libraryUrls.push(url);
      thumb = h('img', { class: 'lib-thumb', src: url, alt: '', loading: 'lazy' });
    } else {
      thumb = h('div', { class: 'lib-thumb', text: 'No thumbnail' });
    }
    const meta = `${formatDate(rec.createdAt)} · ${formatDuration(rec.duration)} · ${formatBytes(rec.size)}`;
    list.append(h('li', { class: 'lib-card' },
      thumb,
      h('div', { class: 'lib-body' }, h('div', { class: 'lib-title', text: rec.title }), h('div', { class: 'lib-meta', text: meta })),
      h('div', { class: 'lib-actions' },
        h('button', { class: 'btn sm primary', 'aria-label': `Preview ${rec.title}`, onclick: () => previewSaved(rec) }, icon('play'), 'Preview'),
        h('button', { class: 'btn sm', 'aria-label': `Download ${rec.title}`, onclick: () => downloadSaved(rec) }, icon('download'), 'Download'),
        h('button', { class: 'btn sm', 'aria-label': `Rename ${rec.title}`, onclick: () => renameSaved(rec) }, icon('edit'), 'Rename'),
        h('button', { class: 'btn sm danger', 'aria-label': `Delete ${rec.title}`, onclick: () => deleteSaved(rec) }, icon('trash'), 'Delete'),
      ),
    ));
  }

  const est = await storage.estimateStorage();
  $('storageInfo').textContent = est && est.quota ? `Browser storage used: ${formatBytes(est.usage)} of about ${formatBytes(est.quota)} available.` : '';
}

async function openLibrary() {
  if (!caps.idb) { toast('The library needs IndexedDB, which this browser does not provide.', 'error'); return; }
  if (!libraryDialog.open) libraryDialog.showModal();
  await renderLibrary();
}

libraryDialog.addEventListener('close', () => { revokeLibraryUrls(); $('libList').replaceChildren(); });

async function previewSaved(rec) {
  try {
    const blob = await storage.getBlob(rec.id);
    openPreview({ blob, mimeType: rec.mimeType, duration: rec.duration, title: rec.title, fresh: false, id: rec.id, width: rec.width, height: rec.height });
  } catch (err) { toast(err.message, 'error'); }
}

async function downloadSaved(rec) {
  try {
    const blob = await storage.getBlob(rec.id);
    downloadBlob(blob, `${sanitizeFilename(rec.title)}.${extensionFor(rec.mimeType)}`);
  } catch (err) { toast(`Download failed: ${err.message}`, 'error'); }
}

async function renameSaved(rec) {
  const name = await ask({ title: 'Rename recording', value: rec.title, confirmText: 'Rename' });
  if (!name) return;
  try { await storage.renameRecording(rec.id, name); toast('Recording renamed.', 'success', 2500); await renderLibrary(); }
  catch (err) { toast(err.message, 'error'); }
}

async function deleteSaved(rec) {
  const ok = await ask({ title: 'Delete this recording?', message: `“${rec.title}” will be permanently removed from this browser.`, confirmText: 'Delete' });
  if (!ok) return;
  try { await storage.deleteRecording(rec.id); toast('Recording deleted.', 'success', 2500); await renderLibrary(); }
  catch (err) { toast(err.message, 'error'); }
}

/* ---------------------------------------------------------------- settings */
function fillSettingsForm() {
  $('setRes').value = settings.resolution;
  $('setFps').value = String(settings.fps);
  $('setVBr').value = String(settings.videoMbps);
  $('setABr').value = String(settings.audioKbps);
  $('setEcho').checked = settings.echo;
  $('setNoise').checked = settings.noise;
  $('setName').value = settings.filename;
}

async function onSettingsChange() {
  const before = { ...settings };
  settings = validateSettings({
    resolution: $('setRes').value, fps: $('setFps').value, videoMbps: $('setVBr').value, audioKbps: $('setABr').value,
    echo: $('setEcho').checked, noise: $('setNoise').checked, filename: $('setName').value || DEFAULTS.filename,
  });
  persistSettings();
  if (settings.fps === 60 && before.fps !== 60) toast('60 FPS depends on your computer. The browser may deliver fewer frames if it cannot keep up.', 'info', 6000);
  if (state.micOn && (before.echo !== settings.echo || before.noise !== settings.noise)) { await enableMic(); render(); }
  updateHud();
}

/* ------------------------------------------------------------------ events */
$('btnScreen').addEventListener('click', selectScreen);
$('btnScreenEmpty').addEventListener('click', selectScreen);
$('btnCam').addEventListener('click', toggleWebcam);
$('btnMic').addEventListener('click', toggleMic);
$('btnRecord').addEventListener('click', () => (recordingActive() ? stopRecording() : startRecording()));
$('btnPause').addEventListener('click', togglePause);
$('btnStudio').addEventListener('click', () => {
  state.studio = !state.studio;
  toast(state.studio
    ? 'Studio mode on: the webcam overlay will be baked into the recorded video.'
    : 'Studio mode off: the screen is recorded directly. The webcam overlay will not be in the video.', 'info', 5000);
  render();
});
$('btnLibrary').addEventListener('click', openLibrary);
$('btnSettings').addEventListener('click', () => { fillSettingsForm(); $('settingsDialog').showModal(); });
$('btnResetSettings').addEventListener('click', () => { settings = { ...DEFAULTS }; persistSettings(); fillSettingsForm(); render(); toast('Settings reset.', 'success', 2000); });
$('settingsForm').addEventListener('change', onSettingsChange);
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

$('btnDownload').addEventListener('click', downloadPreview);
$('btnSave').addEventListener('click', savePreviewToLibrary);
$('btnSnapshot').addEventListener('click', snapshotPreview);
$('btnClosePreview').addEventListener('click', closePreview);
$('btnPreviewX').addEventListener('click', closePreview);

$('micVol').addEventListener('input', (e) => {
  mixer.setMicVolume(e.target.value / 100);
  $('micVolOut').textContent = `${e.target.value}%`;
});
$('sysVol').addEventListener('input', (e) => {
  mixer.setSystemVolume(e.target.value / 100);
  $('sysVolOut').textContent = `${e.target.value}%`;
});
$('shapeCircle').addEventListener('click', () => { state.overlay.shape = 'circle'; render(); });
$('shapeRect').addEventListener('click', () => { state.overlay.shape = 'rect'; render(); });
$('camSize').addEventListener('input', (e) => {
  state.overlay.size = e.target.value / 100;
  $('camSizeOut').textContent = `${e.target.value}%`;
  applyOverlay();
});
$('camMirror').addEventListener('change', (e) => { state.overlay.mirror = e.target.checked; applyOverlay(); });
$('camToggleVisible').addEventListener('click', () => { state.overlay.visible = !state.overlay.visible; render(); });

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
  if (document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const actions = {
    r: () => !$('btnRecord').disabled && $('btnRecord').click(),
    p: () => !$('btnPause').disabled && $('btnPause').click(),
    s: () => !$('btnScreen').disabled && $('btnScreen').click(),
    c: () => !$('btnCam').disabled && $('btnCam').click(),
    m: () => !$('btnMic').disabled && $('btnMic').click(),
    t: () => !$('btnStudio').disabled && $('btnStudio').click(),
    l: () => !$('btnLibrary').disabled && $('btnLibrary').click(),
    ',': () => $('btnSettings').click(),
  };
  const action = actions[e.key.toLowerCase()];
  if (action) { e.preventDefault(); action(); }
});

window.addEventListener('beforeunload', (e) => {
  if (recordingActive()) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  clearInterval(state.tickTimer);
  state.compositor?.stop();
  releaseScreen();
  state.camStream?.getTracks().forEach((t) => t.stop());
  mixer.dispose();
  meter.stop();
});

/* -------------------------------------------------------------------- init */
fillSettingsForm();
showSupportMessages();
render();
refreshLibraryCount();
