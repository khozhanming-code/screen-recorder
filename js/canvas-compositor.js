// Studio mode: draws the screen + webcam overlay onto a canvas and exposes it as a MediaStream.
// A Web Worker drives the draw clock because timers in a background tab are throttled to ~1 fps,
// which is exactly where this tab sits while you record another window.

const CLOCK_SRC = 'let id;onmessage=(e)=>{clearInterval(id);if(e.data.ms){id=setInterval(()=>postMessage(0),e.data.ms);}};';

export class CanvasCompositor {
  /**
   * @param {{screenVideo: HTMLVideoElement, camVideo: HTMLVideoElement,
   *          getOverlay: () => {enabled:boolean, visible:boolean, shape:'circle'|'rect', size:number, mirror:boolean, x:number, y:number}}} opts
   */
  constructor({ screenVideo, camVideo, getOverlay }) {
    this.screenVideo = screenVideo;
    this.camVideo = camVideo;
    this.getOverlay = getOverlay;
    this.canvas = null;
    this.ctx = null;
    this.stream = null;
    this.worker = null;
    this.workerUrl = null;
    this.timer = 0;
  }

  start(width, height, fps) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.draw();
    this.stream = this.canvas.captureStream(fps);
    this.startClock(fps);
    return this.stream;
  }

  startClock(fps) {
    const ms = Math.max(4, Math.round(1000 / fps));
    try {
      this.workerUrl = URL.createObjectURL(new Blob([CLOCK_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = () => this.draw();
      this.worker.postMessage({ ms });
    } catch {
      this.timer = setInterval(() => this.draw(), ms); // fallback: may be throttled in background tabs
    }
  }

  draw() {
    const { ctx, canvas } = this;
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    if (this.screenVideo.readyState >= 2) ctx.drawImage(this.screenVideo, 0, 0, cw, ch);
    const o = this.getOverlay();
    if (o.enabled && o.visible && this.camVideo.readyState >= 2 && this.camVideo.videoWidth) this.drawCamera(o, cw, ch);
  }

  drawCamera(o, cw, ch) {
    const { ctx, camVideo } = this;
    const w = o.size * cw;
    const h = o.shape === 'circle' ? w : w * 0.75;
    const x = Math.min(Math.max(o.x * cw, 0), cw - w);
    const y = Math.min(Math.max(o.y * ch, 0), ch - h);
    const border = Math.max(2, cw / 450);

    // "cover" crop of the webcam frame into the overlay box
    const vw = camVideo.videoWidth;
    const vh = camVideo.videoHeight;
    const boxRatio = w / h;
    let sw = vw;
    let sh = vw / boxRatio;
    if (sh > vh) { sh = vh; sw = vh * boxRatio; }
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = border * 6;
    this.shapePath(o.shape, x, y, w, h);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.clip();
    if (o.mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(camVideo, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      ctx.drawImage(camVideo, sx, sy, sw, sh, x, y, w, h);
    }
    ctx.restore();

    ctx.save();
    ctx.lineWidth = border;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    this.shapePath(o.shape, x + border / 2, y + border / 2, w - border, h - border);
    ctx.stroke();
    ctx.restore();
  }

  shapePath(shape, x, y, w, h) {
    const { ctx } = this;
    ctx.beginPath();
    if (shape === 'circle') {
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      return;
    }
    const r = Math.min(w, h) * 0.12;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  stop() {
    if (this.worker) {
      this.worker.postMessage({ ms: 0 });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) { URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.ctx = null;
    if (this.canvas) { this.canvas.width = this.canvas.height = 0; this.canvas = null; }
  }
}
