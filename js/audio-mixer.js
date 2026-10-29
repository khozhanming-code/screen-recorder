// Routes microphone + system audio into ONE recordable audio track using the Web Audio API.
// Nothing is connected to ctx.destination, so there is never audio feedback through the speakers.

export class AudioMixer {
  constructor() {
    this.ctx = null;
    this.destination = null;
    this.analyser = null;
    this.mic = null;      // { stream, source, gain }
    this.system = null;   // { source, gain }
    this.micVolume = 1;
    this.systemVolume = 1;
  }

  async init() {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('The Web Audio API is not supported in this browser.');
    this.ctx = new AC();
    this.destination = this.ctx.createMediaStreamDestination();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** The single mixed audio track (silent when no source is connected). */
  get track() {
    return this.destination ? this.destination.stream.getAudioTracks()[0] || null : null;
  }

  async setMic(stream) {
    await this.init();
    this.clearMic();
    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = this.micVolume;
    source.connect(gain);
    gain.connect(this.destination);
    gain.connect(this.analyser);
    this.mic = { stream, source, gain };
  }

  clearMic() {
    if (!this.mic) return;
    const { stream, source, gain } = this.mic;
    try { source.disconnect(); gain.disconnect(); } catch { /* already disconnected */ }
    stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }

  /** Connects the audio tracks of a screen-capture stream. Returns false when it has none. */
  async setSystem(screenStream) {
    this.clearSystem();
    const tracks = screenStream ? screenStream.getAudioTracks().filter((t) => t.readyState === 'live') : [];
    if (!tracks.length) return false;
    await this.init();
    const source = this.ctx.createMediaStreamSource(new MediaStream(tracks));
    const gain = this.ctx.createGain();
    gain.gain.value = this.systemVolume;
    source.connect(gain);
    gain.connect(this.destination);
    this.system = { source, gain };
    return true;
  }

  /** Disconnects system audio. The tracks belong to the screen stream, which stops them itself. */
  clearSystem() {
    if (!this.system) return;
    try { this.system.source.disconnect(); this.system.gain.disconnect(); } catch { /* ignore */ }
    this.system = null;
  }

  setMicVolume(v) {
    this.micVolume = v;
    if (this.mic) this.mic.gain.gain.value = v;
  }

  setSystemVolume(v) {
    this.systemVolume = v;
    if (this.system) this.system.gain.gain.value = v;
  }

  async dispose() {
    this.clearMic();
    this.clearSystem();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
    this.ctx = this.destination = this.analyser = null;
  }
}
