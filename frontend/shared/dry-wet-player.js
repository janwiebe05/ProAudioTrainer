'use strict';

// ─── Tauri bridge helpers ──────────────────────────────────────────────────────
// Every trainer module's exercise audio is now rendered server-side by the
// Rust core (paw-core) instead of live client-side DSP — see
// /root/.claude/plans (or the project's plan doc) for why: consistent,
// portable DSP across desktop platforms, no more FFmpeg/browser dependency.
async function invokeTauri(cmd, args) {
  if (!window.__TAURI__) throw new Error('Nicht in der Desktop-App — Tauri-Bridge fehlt.');
  return window.__TAURI__.core.invoke(cmd, args);
}

function tauriFileUrl(path) {
  return window.__TAURI__.core.convertFileSrc(path);
}

async function fetchAndDecode(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Audio-Download fehlgeschlagen');
  const arrayBuffer = await res.arrayBuffer();
  return new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
}

// ─── Dry/Wet Player ─────────────────────────────────────────────────────────────
// Shared by every trainer module except eq-match-trainer.js (which stays
// fully live/interactive, since the user continuously adjusts EQ bands and
// needs instant feedback — nothing to pre-render there). All other modules
// get two pre-rendered clips (dry + processed) from a Tauri command and just
// A/B-toggle between them with an instant gain crossfade, same UX as the old
// live-filter versions.
class DryWetPlayer {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.drySource = null;
    this.wetSource = null;
    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();

    this.dryGain.gain.value = 1.0;
    this.wetGain.gain.value = 0.0;
    this.masterGain.gain.value = 0.85;
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.isPlaying = false;
    this.wetEnabled = false;
    this.dryBuffer = null;
    this.wetBuffer = null;
  }

  async loadDryWet(dryUrl, wetUrl) {
    const [dryBuf, wetBuf] = await Promise.all([
      fetchAndDecode(this.ctx, dryUrl),
      fetchAndDecode(this.ctx, wetUrl),
    ]);
    this.dryBuffer = dryBuf;
    this.wetBuffer = wetBuf;
  }

  play() {
    if (!this.dryBuffer || !this.wetBuffer) return;
    if (this.isPlaying) this.stop();
    this.drySource = this.ctx.createBufferSource();
    this.drySource.buffer = this.dryBuffer;
    this.drySource.loop = true;
    this.drySource.connect(this.dryGain);

    this.wetSource = this.ctx.createBufferSource();
    this.wetSource.buffer = this.wetBuffer;
    this.wetSource.loop = true;
    this.wetSource.connect(this.wetGain);

    // Start both together, slightly in the future, so they stay sample-locked.
    const startAt = this.ctx.currentTime + 0.05;
    this.drySource.start(startAt);
    this.wetSource.start(startAt);
    this.isPlaying = true;
  }

  stop() {
    if (this.drySource) {
      this.drySource.stop();
      this.drySource.disconnect();
      this.drySource = null;
    }
    if (this.wetSource) {
      this.wetSource.stop();
      this.wetSource.disconnect();
      this.wetSource = null;
    }
    this.isPlaying = false;
  }

  togglePlayback() {
    if (this.isPlaying) { this.stop(); } else { this.play(); }
  }

  /// enabled=true → processed/wet audible; enabled=false → dry/bypass audible.
  setWetMode(enabled) {
    const now = this.ctx.currentTime;
    const fade = 0.020;
    this.dryGain.gain.cancelScheduledValues(now);
    this.wetGain.gain.cancelScheduledValues(now);
    this.dryGain.gain.setValueAtTime(this.dryGain.gain.value, now);
    this.wetGain.gain.setValueAtTime(this.wetGain.gain.value, now);
    if (enabled) {
      this.dryGain.gain.linearRampToValueAtTime(0, now + fade);
      this.wetGain.gain.linearRampToValueAtTime(1, now + fade);
    } else {
      this.dryGain.gain.linearRampToValueAtTime(1, now + fade);
      this.wetGain.gain.linearRampToValueAtTime(0, now + fade);
    }
    this.wetEnabled = enabled;
  }

  destroy() {
    this.stop();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.masterGain.disconnect();
    this.analyser.disconnect();
  }
}

// ─── Round Timer ─────────────────────────────────────────────────────────────
// Every trainer module (dynamics/panning/stereo/transient/reverb-trainer.js)
// currently hand-rolls the same setInterval loop: track elapsed seconds,
// update a timer bar/text element, call a timeout callback once maxSeconds
// is reached. This class exists to give the *next* trainer module (or a
// future cleanup pass through the existing five, which — being a working,
// tested behavior change across five files — is deliberately not bundled
// into this same commit) one shared, tested place for that logic instead
// of a sixth copy-paste.
class RoundTimer {
  /**
   * @param {object} opts
   * @param {number} opts.maxSeconds - duration before onTimeout fires
   * @param {(elapsed:number, pct:number)=>void} [opts.onTick] - called ~10x/sec
   * @param {()=>void} [opts.onTimeout] - called once, when elapsed >= maxSeconds
   * @param {number} [opts.intervalMs=100]
   */
  constructor({ maxSeconds, onTick, onTimeout, intervalMs = 100 }) {
    this.maxSeconds = maxSeconds;
    this.onTick = onTick;
    this.onTimeout = onTimeout;
    this.intervalMs = intervalMs;
    this.elapsed = 0;
    this._interval = null;
    this._startedAt = null;
  }

  start() {
    this.stop();
    this._startedAt = Date.now();
    this._interval = setInterval(() => {
      this.elapsed = (Date.now() - this._startedAt) / 1000;
      const pct = Math.min(100, (this.elapsed / this.maxSeconds) * 100);
      if (this.onTick) this.onTick(this.elapsed, pct);
      if (this.elapsed >= this.maxSeconds) {
        this.stop();
        if (this.onTimeout) this.onTimeout();
      }
    }, this.intervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }
}
