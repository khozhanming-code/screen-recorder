// Draws a segmented microphone level meter from an AnalyserNode.

export class LevelMeter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.raf = 0;
    this.analyser = null;
    this.level = 0;
    this.clear();
  }

  start(analyser) {
    this.stop();
    this.analyser = analyser;
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const target = Math.min(1, rms * 3.2);
      this.level = target > this.level ? target : this.level * 0.88; // fast attack, slow release
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.analyser = null;
    this.level = 0;
    this.clear();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this;
    const segments = 28;
    const gap = 3;
    const w = (canvas.width - gap * (segments - 1)) / segments;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lit = Math.round(this.level * segments);
    for (let i = 0; i < segments; i++) {
      const ratio = i / segments;
      ctx.fillStyle = i < lit
        ? (ratio > 0.85 ? '#f43f5e' : ratio > 0.65 ? '#fbbf24' : '#22d3ee')
        : 'rgba(34,211,238,0.09)';
      ctx.fillRect(i * (w + gap), 0, w, canvas.height);
    }
  }
}
