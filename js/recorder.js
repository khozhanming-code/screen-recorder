// MediaRecorder lifecycle: idle -> recording <-> paused -> processing -> idle.
// The timer only counts time spent in the "recording" state, so paused time is excluded.

export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];

/** Returns the first supported MIME type, '' if the browser has no preference, or null if MediaRecorder is missing. */
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export class Recorder {
  constructor() {
    this.state = 'idle';
    this.mimeType = '';
    this.onStateChange = () => {};
    /** Called once per recording with (error|null, {blob, mimeType, duration, size}|undefined). */
    this.onFinish = () => {};
    this.onError = () => {};
    this.mr = null;
    this.chunks = [];
    this.accumulatedMs = 0;
    this.segmentStart = null;
  }

  setState(next) {
    this.state = next;
    this.onStateChange(next);
  }

  start(stream, { mimeType = '', videoBitsPerSecond, audioBitsPerSecond } = {}) {
    if (this.state !== 'idle') throw new Error('A recording is already in progress.');
    const options = {};
    if (mimeType) options.mimeType = mimeType;
    if (videoBitsPerSecond) options.videoBitsPerSecond = videoBitsPerSecond;
    if (audioBitsPerSecond) options.audioBitsPerSecond = audioBitsPerSecond;

    let mr;
    try {
      mr = new MediaRecorder(stream, options);
    } catch {
      try {
        mr = new MediaRecorder(stream); // fall back to the browser's defaults
      } catch (err) {
        throw new Error(`The browser could not start the recorder (${err.name || 'error'}).`);
      }
    }

    this.chunks = [];
    this.accumulatedMs = 0;
    this.mimeType = mr.mimeType || mimeType || 'video/webm';
    mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    mr.onerror = (e) => {
      this.onError(e.error || new Error('Unknown recorder error'));
      if (mr.state !== 'inactive') { try { mr.stop(); } catch { /* ignore */ } }
    };
    mr.onstop = () => this.finalize();
    try {
      mr.start(1000);
    } catch (err) {
      throw new Error(`Recording could not be started (${err.name || 'error'}).`);
    }
    this.mr = mr;
    this.segmentStart = performance.now();
    this.setState('recording');
  }

  pause() {
    if (this.state !== 'recording') return;
    this.mr.pause();
    this.freezeClock();
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.mr.resume();
    this.segmentStart = performance.now();
    this.setState('recording');
  }

  stop() {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    this.freezeClock();
    this.setState('processing');
    try { this.mr.stop(); } catch (err) { this.finalize(err); }
  }

  elapsedSeconds() {
    const live = this.segmentStart != null ? performance.now() - this.segmentStart : 0;
    return (this.accumulatedMs + live) / 1000;
  }

  freezeClock() {
    if (this.segmentStart != null) {
      this.accumulatedMs += performance.now() - this.segmentStart;
      this.segmentStart = null;
    }
  }

  finalize(error) {
    this.freezeClock(); // covers the case where the browser stopped the recorder by itself
    const chunks = this.chunks;
    const duration = this.accumulatedMs / 1000;
    const mimeType = this.mimeType;
    this.mr = null;
    this.chunks = [];
    this.accumulatedMs = 0;
    this.setState('idle');

    const blob = new Blob(chunks, { type: mimeType.split(';')[0] || 'video/webm' });
    if (error) { this.onFinish(error); return; }
    if (!blob.size) {
      this.onFinish(new Error('The recording is empty because no video data was captured. Keep the shared screen visible and try again.'));
      return;
    }
    this.onFinish(null, { blob, mimeType, duration, size: blob.size });
  }
}
