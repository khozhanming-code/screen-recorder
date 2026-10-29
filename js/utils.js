// Small, dependency-free helpers shared by the other modules.
export const pad = (n) => String(n).padStart(2, '0');

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function timestamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function sanitizeFilename(name) {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || 'recording';
}

export function extensionFor(mime = '') {
  if (/mp4/i.test(mime)) return 'mp4';
  if (/ogg/i.test(mime)) return 'ogv';
  return 'webm';
}

/** "video/webm;codecs=vp9,opus" -> "WebM (VP9, OPUS)" */
export function describeMime(mime = '') {
  if (!mime) return '—';
  const container = /mp4/i.test(mime) ? 'MP4' : /ogg/i.test(mime) ? 'Ogg' : 'WebM';
  const codecs = (mime.match(/codecs=([^;]+)/i) || [])[1];
  return codecs ? `${container} (${codecs.replace(/"/g, '').split(',').map((c) => c.trim().toUpperCase()).join(', ')})` : container;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function waitFor(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onOk);
      target.removeEventListener('error', onErr);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('Media error')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    target.addEventListener(event, onOk);
    target.addEventListener('error', onErr);
  });
}

/**
 * MediaRecorder WebM files have no duration header, so <video>.duration is Infinity.
 * Seeking far past the end makes the browser compute the real duration.
 */
export async function fixDuration(video, timeoutMs = 4000) {
  if (Number.isFinite(video.duration)) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener('timeupdate', onTime);
      resolve();
    };
    const onTime = () => {
      if (Number.isFinite(video.duration)) { video.currentTime = 0; finish(); }
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener('timeupdate', onTime);
    video.currentTime = 1e101;
  });
}

/** Draws the current frame of a <video> to an image Blob. */
export function frameToBlob(video, type = 'image/png', quality, maxWidth) {
  return new Promise((resolve, reject) => {
    const w0 = video.videoWidth;
    const h0 = video.videoHeight;
    if (!w0 || !h0) { reject(new Error('The video has no decoded frame yet. Play or seek the video once and try again.')); return; }
    const scale = maxWidth ? Math.min(1, maxWidth / w0) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    try {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (err) { reject(err); return; }
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality);
  });
}

/** Creates a small JPEG thumbnail from a recording Blob. Returns null on failure. */
export async function makeThumbnail(blob, durationSeconds = 0) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.src = url;
    await waitFor(video, 'loadeddata', 8000);
    await fixDuration(video);
    const total = Number.isFinite(video.duration) ? video.duration : durationSeconds;
    const t = Math.min(1, total / 2);
    if (t > 0) {
      video.currentTime = t;
      await waitFor(video, 'seeked', 5000);
    }
    return await frameToBlob(video, 'image/jpeg', 0.72, 320);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
