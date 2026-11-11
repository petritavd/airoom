/**
 * Tiny WebAudio manager. Off by default; toggled from the topbar.
 * - ding(): two-note chime when an agent starts waiting for you / errors
 * - clack(): very quiet keyboard tick from working robots
 */
class SoundManager {
  private ctx: AudioContext | null = null;
  private on: boolean;

  constructor() {
    try {
      this.on = localStorage.getItem('airoom.sound') === '1';
    } catch {
      this.on = false;
    }
  }

  enabled(): boolean {
    return this.on;
  }

  setEnabled(v: boolean) {
    this.on = v;
    try {
      localStorage.setItem('airoom.sound', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (v) this.ensure(); // created inside the user gesture
  }

  private ensure(): AudioContext | null {
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  ding() {
    if (!this.on) return;
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime;
    for (const [freq, at] of [
      [740, 0],
      [988, 0.12],
    ] as const) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.05, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.28);
      o.connect(g).connect(c.destination);
      o.start(t + at);
      o.stop(t + at + 0.3);
    }
  }

  /** Soft descending success chime — an agent finished its work. */
  chime() {
    if (!this.on) return;
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime;
    for (const [freq, at] of [
      [880, 0],
      [659, 0.1],
    ] as const) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.03, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.24);
      o.connect(g).connect(c.destination);
      o.start(t + at);
      o.stop(t + at + 0.26);
    }
  }

  clack() {
    if (!this.on) return;
    const c = this.ensure();
    if (!c) return;
    const len = Math.floor(c.sampleRate * 0.025);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = 0.012;
    src.buffer = buf;
    src.connect(g).connect(c.destination);
    src.start();
  }
}

export const sound = new SoundManager();
