'use strict';

// ─── VintageKnob ──────────────────────────────────────────────────────────────
class VintageKnob {
  constructor(container, opts) {
    this.min = opts.min ?? -18;
    this.max = opts.max ?? 18;
    this.value = opts.default ?? 0;
    this.defaultValue = opts.default ?? 0;
    this.step = opts.step ?? 0.1;
    this.fineStep = opts.fineStep ?? 0.01;
    this.label = opts.label ?? '';
    this.unit = opts.unit ?? '';
    this.onChange = opts.onChange ?? (() => {});
    this.enabled = true;
    this._dragStartY = null;
    this._dragStartVal = null;
    this._isShift = false;

    this.el = document.createElement('div');
    this.el.className = 'knob-wrap';
    this.el.innerHTML = `
      <div class="knob-label">${this.label}</div>
      <div class="knob-body">
        <div class="knob-track"></div>
        <div class="knob-cap">
          <div class="knob-pointer"></div>
        </div>
      </div>
      <div class="knob-display">—</div>
    `;
    container.appendChild(this.el);

    this._cap = this.el.querySelector('.knob-cap');
    this._display = this.el.querySelector('.knob-display');

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onDblClick = this._onDblClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);

    this._cap.addEventListener('mousedown', this._onMouseDown);
    this._cap.addEventListener('dblclick', this._onDblClick);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);

    this._update();
  }

  _onKeyDown(e) { if (e.key === 'Shift') this._isShift = true; }
  _onKeyUp(e) { if (e.key === 'Shift') this._isShift = false; }

  _onMouseDown(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this._dragStartY = e.clientY;
    this._dragStartVal = this.value;
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    this._cap.classList.add('dragging');
  }

  _onMouseMove(e) {
    const dy = this._dragStartY - e.clientY;
    const range = this.max - this.min;
    const sensitivity = this._isShift ? 0.05 : 0.5;
    const delta = (dy / 100) * range * sensitivity;
    const raw = this._dragStartVal + delta;
    const stepped = Math.round(raw / this.step) * this.step;
    this.value = Math.max(this.min, Math.min(this.max, stepped));
    this._update();
    this.onChange(this.value);
  }

  _onMouseUp() {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    this._cap.classList.remove('dragging');
  }

  _onDblClick() {
    if (!this.enabled) return;
    this.value = this.defaultValue;
    this._update();
    this.onChange(this.value);
  }

  _update() {
    const range = this.max - this.min;
    const normalized = (this.value - this.min) / range;
    const deg = -135 + normalized * 270;
    this._cap.style.transform = `rotate(${deg}deg)`;
    const disp = this.unit === 'Hz'
      ? (this.value >= 1000 ? (this.value / 1000).toFixed(1) + 'k' : Math.round(this.value) + '')
      : (this.value >= 0 ? '+' : '') + this.value.toFixed(this.step < 0.1 ? 2 : 1);
    this._display.textContent = disp + (this.unit && this.unit !== 'Hz' ? ' ' + this.unit : (this.unit === 'Hz' ? ' Hz' : ''));
  }

  setValue(v) {
    this.value = Math.max(this.min, Math.min(this.max, v));
    this._update();
  }

  getValue() { return this.value; }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.el.classList.toggle('knob-disabled', !enabled);
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    this.el.remove();
  }
}

// ─── EQ Match Audio Engine ────────────────────────────────────────────────────
class EQMatchAudioEngine {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.isPlaying = false;
    this.mode = 'A'; // A=dry, B=hidden+user, C=hidden only

    // Gain nodes for path switching
    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();

    this.dryGain.gain.value = 1;
    this.wetGain.gain.value = 0;
    this.masterGain.gain.value = 0.85;
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // 4 hidden biquad filters (in series)
    this.hiddenFilters = [1, 2, 3, 4].map(() => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.gain.value = 0;
      return f;
    });

    // 4 user biquad filters (in series)
    this.userFilters = [1, 2, 3, 4].map(() => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.gain.value = 0;
      return f;
    });

    // User EQ bypass: userEQGain=1 (mode B), hiddenOnlyGain=1 (mode C)
    this.userEQGain = this.ctx.createGain();
    this.hiddenOnlyGain = this.ctx.createGain();
    this.userEQGain.gain.value = 1;
    this.hiddenOnlyGain.gain.value = 0;

    // Chain: hiddenFilters[0→1→2→3] → userFilters[0→1→2→3] → userEQGain → wetGain
    //                                → hiddenOnlyGain → wetGain  (mode C bypass)
    for (let i = 0; i < 3; i++) this.hiddenFilters[i].connect(this.hiddenFilters[i + 1]);
    for (let i = 0; i < 3; i++) this.userFilters[i].connect(this.userFilters[i + 1]);
    this.hiddenFilters[3].connect(this.userFilters[0]);
    this.userFilters[3].connect(this.userEQGain);
    this.userEQGain.connect(this.wetGain);
    this.hiddenFilters[3].connect(this.hiddenOnlyGain);
    this.hiddenOnlyGain.connect(this.wetGain);

    // Both paths → master → analyser → out
    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  async loadAudio(arrayBuffer) {
    this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
  }

  play() {
    if (!this.audioBuffer) return;
    if (this.isPlaying) this.stop();
    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.loop = true;
    this.sourceNode.connect(this.dryGain);
    this.sourceNode.connect(this.hiddenFilters[0]);
    this.sourceNode.start(0);
    this.isPlaying = true;
  }

  stop() {
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch {}
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.isPlaying = false;
  }

  togglePlayback() {
    if (this.isPlaying) this.stop(); else this.play();
  }

  setMode(mode) {
    this.mode = mode;
    const now = this.ctx.currentTime;
    const fade = 0.015;
    const dry = mode === 'A' ? 1 : 0;
    const wet = mode !== 'A' ? 1 : 0;
    this.dryGain.gain.cancelScheduledValues(now);
    this.wetGain.gain.cancelScheduledValues(now);
    this.dryGain.gain.setValueAtTime(this.dryGain.gain.value, now);
    this.wetGain.gain.setValueAtTime(this.wetGain.gain.value, now);
    this.dryGain.gain.linearRampToValueAtTime(dry, now + fade);
    this.wetGain.gain.linearRampToValueAtTime(wet, now + fade);

    // In mode C: route only hidden signal (bypass user filters)
    if (mode === 'C') {
      this.userEQGain.gain.setValueAtTime(0, now);
      this.hiddenOnlyGain.gain.setValueAtTime(1, now);
    } else {
      // mode B: hidden + user filters
      this.userEQGain.gain.setValueAtTime(1, now);
      this.hiddenOnlyGain.gain.setValueAtTime(0, now);
    }
  }

  setHiddenBands(bands) {
    const typeMap = { lowshelf: 'lowshelf', peaking: 'peaking', highshelf: 'highshelf' };
    [1, 2, 3, 4].forEach((id, i) => {
      const b = bands[id];
      if (!b) return;
      const f = this.hiddenFilters[i];
      f.type = typeMap[b.type] || 'peaking';
      f.frequency.value = b.frequency;
      f.gain.value = b.gain;
      if (b.Q !== null && b.Q !== undefined) f.Q.value = b.Q;
    });
  }

  setUserBand(bandIdx, params) {
    // bandIdx: 0-3
    const f = this.userFilters[bandIdx];
    if (params.gain !== undefined) f.gain.value = params.gain;
    if (params.frequency !== undefined) f.frequency.value = params.frequency;
    if (params.Q !== undefined) f.Q.value = params.Q;
    if (params.type !== undefined) f.type = params.type;
  }

  flattenUserFilters() {
    this.userFilters.forEach(f => { f.gain.value = 0; });
  }

  destroy() {
    this.stop();
    try {
      this.dryGain.disconnect(); this.wetGain.disconnect();
      this.masterGain.disconnect(); this.analyser.disconnect();
      this.userEQGain.disconnect(); this.hiddenOnlyGain.disconnect();
      this.hiddenFilters.forEach(f => f.disconnect());
      this.userFilters.forEach(f => f.disconnect());
    } catch {}
  }
}

// ─── EQ Curve Display ────────────────────────────────────────────────────────
class EQCurveDisplay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.freqMin = 20;
    this.freqMax = 20000;
    this.dbMin = -24;
    this.dbMax = 24;
    this.pad = { left: 38, right: 12, top: 14, bottom: 26 };

    // Log-spaced frequency array for getFrequencyResponse()
    this.N = 512;
    this.freqArray = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const t = i / (this.N - 1);
      this.freqArray[i] = this.freqMin * Math.pow(this.freqMax / this.freqMin, t);
    }

    this.userMag = null;
    this.hiddenMag = null;
  }

  _freqToX(f) {
    const w = this.canvas.width - this.pad.left - this.pad.right;
    return this.pad.left + Math.log10(f / this.freqMin) / Math.log10(this.freqMax / this.freqMin) * w;
  }

  _dbToY(db) {
    const h = this.canvas.height - this.pad.top - this.pad.bottom;
    return this.pad.top + (this.dbMax - db) / (this.dbMax - this.dbMin) * h;
  }

  _computeMag(filters) {
    const mag = new Float32Array(this.N).fill(1);
    const phase = new Float32Array(this.N);
    filters.forEach(f => {
      const m = new Float32Array(this.N);
      f.getFrequencyResponse(this.freqArray, m, phase);
      for (let i = 0; i < this.N; i++) mag[i] *= m[i];
    });
    return mag;
  }

  updateUserCurve(filters) {
    this.userMag = this._computeMag(filters);
    this.draw();
  }

  revealHiddenCurve(filters) {
    this.hiddenMag = this._computeMag(filters);
    this.draw();
  }

  clearHidden() { this.hiddenMag = null; this.draw(); }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // Background
    ctx.fillStyle = '#0e0e0e';
    ctx.fillRect(0, 0, W, H);

    // dB grid
    [-18, -12, -6, 0, 6, 12, 18].forEach(db => {
      const y = this._dbToY(db);
      ctx.strokeStyle = db === 0 ? '#484848' : '#222';
      ctx.lineWidth = db === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(W - this.pad.right, y);
      ctx.stroke();
      ctx.fillStyle = '#4a4a4a';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText((db > 0 ? '+' : '') + db, this.pad.left - 4, y + 3);
    });

    // Freq grid
    const fGrid = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const fLabels = ['50', '100', '200', '500', '1k', '2k', '5k', '10k'];
    fGrid.forEach((f, i) => {
      const x = this._freqToX(f);
      ctx.strokeStyle = '#1e1e1e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, this.pad.top);
      ctx.lineTo(x, H - this.pad.bottom);
      ctx.stroke();
      ctx.fillStyle = '#4a4a4a';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(fLabels[i], x, H - this.pad.bottom + 14);
    });

    // Hidden curve (revealed) — orange
    if (this.hiddenMag) {
      this._drawCurve(this.hiddenMag, '#ff6b35', 2, 'rgba(255,107,53,0.12)');
    }

    // User curve — gold
    if (this.userMag) {
      this._drawCurve(this.userMag, '#d4af37', 2.5, 'rgba(212,175,55,0.10)');
    }

    // Legend
    if (this.hiddenMag) {
      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = '#d4af37';
      ctx.textAlign = 'left';
      ctx.fillText('▬ DEIN EQ', this.pad.left + 4, this.pad.top + 12);
      ctx.fillStyle = '#ff6b35';
      ctx.fillText('▬ HIDDEN EQ', this.pad.left + 80, this.pad.top + 12);
    }
  }

  _drawCurve(magArr, color, lw, fill) {
    const ctx = this.ctx;
    const zeroY = this._dbToY(0);

    // Fill area
    ctx.beginPath();
    for (let i = 0; i < this.N; i++) {
      const db = Math.max(this.dbMin, Math.min(this.dbMax, 20 * Math.log10(Math.max(magArr[i], 1e-9))));
      const x = this._freqToX(this.freqArray[i]);
      const y = this._dbToY(db);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineTo(this._freqToX(this.freqMax), zeroY);
    ctx.lineTo(this._freqToX(this.freqMin), zeroY);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < this.N; i++) {
      const db = Math.max(this.dbMin, Math.min(this.dbMax, 20 * Math.log10(Math.max(magArr[i], 1e-9))));
      const x = this._freqToX(this.freqArray[i]);
      const y = this._dbToY(db);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

// ─── EQ Match Trainer Module ──────────────────────────────────────────────────
class EQMatchTrainerModule {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.level = 1;
    this.audioEngine = null;
    this.exercise = null;
    this.knobs = {};
    this.curveDisplay = null;
    this.timerInterval = null;
    this.secondsElapsed = 0;
    this.submitted = false;
    this.mode = 'A';
    this._keyHandler = null;
  }

  init() {
    this.render();
    this._keyHandler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
      if (e.code === 'KeyB') this._cycleMode();
      if (e.code === 'KeyN') this._newRound();
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  render() {
    this.container.innerHTML = `
      <div class="eqm-chassis">
        <div class="eqm-header">
          <div class="eqm-title-block">
            <div class="eqm-brand">EQ MATCH</div>
            <div class="eqm-sub">4-BAND RESTORE TRAINER</div>
          </div>
          <div class="eqm-controls-top">
            <div class="eqm-mode-group">
              <button class="eqm-mode-btn active" data-mode="A">
                <span class="eqm-mode-led active"></span>A
              </button>
              <button class="eqm-mode-btn" data-mode="B">
                <span class="eqm-mode-led"></span>B
              </button>
              <button class="eqm-mode-btn" data-mode="C">
                <span class="eqm-mode-led"></span>C
              </button>
            </div>
            <div class="eqm-mode-labels">
              <span>FLAT</span><span>FLAT+EQ</span><span>PROCESSED</span>
            </div>
          </div>
          <div class="eqm-transport">
            <button class="btn-rack btn-rack--primary" id="eqm-play-btn">
              <span class="btn-rack-led" id="eqm-play-led"></span>
              PLAY
            </button>
            <div class="eqm-timer-wrap">
              <div class="eqm-timer-label">TIME</div>
              <div class="eqm-timer" id="eqm-timer">—</div>
            </div>
          </div>
        </div>

        <div class="eqm-status-bar" id="eqm-status">
          <span class="eqm-status-led" id="eqm-status-led"></span>
          <span id="eqm-status-text">Lade Übung…</span>
        </div>

        <div class="eqm-curve-wrap">
          <canvas id="eqm-curve-canvas" class="eqm-curve-canvas"></canvas>
        </div>

        <div class="eqm-bands" id="eqm-bands">
          <!-- Bands rendered by JS -->
        </div>

        <div class="eqm-footer">
          <div class="eqm-hint">
            <span>Drag = grob &nbsp;|&nbsp; Shift+Drag = fein &nbsp;|&nbsp; Doppelklick = Reset</span>
          </div>
          <div class="eqm-actions">
            <button class="btn-rack btn-rack--secondary" id="eqm-new-btn">
              <span class="btn-rack-led"></span>NEUE RUNDE
            </button>
            <button class="btn-rack btn-rack--primary" id="eqm-submit-btn" disabled>
              <span class="btn-rack-led" id="eqm-submit-led"></span>AUSWERTEN
            </button>
          </div>
        </div>

        <div class="eqm-results" id="eqm-results" style="display:none"></div>
      </div>
    `;

    document.querySelectorAll('.eqm-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });
    document.getElementById('eqm-play-btn').addEventListener('click', () => this._togglePlay());
    document.getElementById('eqm-new-btn').addEventListener('click', () => this._newRound());
    document.getElementById('eqm-submit-btn').addEventListener('click', () => this._submit());

    this._newRound();
  }

  _initCurveDisplay() {
    const canvas = document.getElementById('eqm-curve-canvas');
    if (!canvas) return;
    const wrap = canvas.parentElement;

    const setup = () => {
      canvas.width = wrap.clientWidth || 800;
      canvas.height = 160;
      if (!this.curveDisplay) this.curveDisplay = new EQCurveDisplay(canvas);
      this.curveDisplay.draw();
      this._updateCurve();
    };

    requestAnimationFrame(setup);

    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = new ResizeObserver(() => {
      canvas.width = wrap.clientWidth || 800;
      if (this.curveDisplay) { this.curveDisplay.draw(); this._updateCurve(); }
    });
    this._resizeObserver.observe(wrap);
  }

  _updateCurve() {
    if (!this.curveDisplay || !this.audioEngine) return;
    this.curveDisplay.updateUserCurve(this.audioEngine.userFilters);
  }

  async _newRound() {
    this._stopTimer();
    this.submitted = false;
    this.secondsElapsed = 0;
    this.mode = 'A';
    this._setModeUI('A');
    this.curveDisplay = null;

    if (this.audioEngine) { this.audioEngine.destroy(); this.audioEngine = null; }
    this._destroyKnobs();

    document.getElementById('eqm-results').style.display = 'none';
    document.getElementById('eqm-submit-btn').disabled = true;
    document.getElementById('eqm-submit-led').classList.remove('active');
    this._setStatus('loading', 'Lade Übung…');

    try {
      // Rust core (paw_core::exercise::eq_match) picks a random library
      // track and the hidden target curve, but does NOT render any audio —
      // this trainer is the one exception that stays fully live client-side
      // (the student continuously adjusts EQ bands and needs instant
      // feedback), so we just get the track's own unmodified file back.
      const data = await invokeTauri('eq_match_random', { level: this.level });
      this.exercise = data;

      const actx = this.app.getAudioContext();
      if (actx.state === 'suspended') await actx.resume();
      this.audioEngine = new EQMatchAudioEngine(actx);

      const buf = await (await fetch(tauriFileUrl(data.dryPath))).arrayBuffer();
      await this.audioEngine.loadAudio(buf);
      this.audioEngine.setHiddenBands(data.hiddenBands);

      this._renderBands(data);
      this._initCurveDisplay();
      this._updateCurve();
      this._setStatus('ready', `Level ${this.level} — Stelle den Gegen-EQ ein und klicke AUSWERTEN`);
      document.getElementById('eqm-submit-btn').disabled = false;
      document.getElementById('eqm-submit-led').classList.add('active');

      if (data.timeLimit) {
        this._updateTimerDisplay(data.timeLimit);
        this._startTimer(data.timeLimit);
      } else {
        document.getElementById('eqm-timer').textContent = '—';
      }

    } catch (err) {
      this._setStatus('error', 'Fehler: ' + err);
    }
  }

  _renderBands(data) {
    const bandsEl = document.getElementById('eqm-bands');
    bandsEl.innerHTML = '';
    this.knobs = {};

    [1, 2, 3, 4].forEach(id => {
      const band = data.hiddenBands[id];
      const bandEl = document.createElement('div');
      bandEl.className = 'eqm-band';
      bandEl.dataset.band = id;

      const typeLabel = { lowshelf: 'LOW SHELF', peaking: id === 2 ? 'LOW MID' : 'HIGH MID', highshelf: 'HIGH SHELF' }[band.type] || band.type.toUpperCase();

      bandEl.innerHTML = `
        <div class="eqm-band-header">
          <div class="eqm-band-num">BAND ${id}</div>
          <div class="eqm-band-type">${typeLabel}</div>
          <div class="eqm-band-led-wrap">
            <span class="eqm-band-led" id="eqm-band-led-${id}"></span>
          </div>
        </div>
        <div class="eqm-knobs-row" id="eqm-knobs-${id}"></div>
        <div class="eqm-band-result" id="eqm-band-result-${id}" style="display:none"></div>
      `;
      bandsEl.appendChild(bandEl);

      const knobRow = document.getElementById(`eqm-knobs-${id}`);
      this.knobs[id] = {};

      // Gain knob (always)
      const gainRange = { 1: 15, 2: 12, 3: 8 }[this.level] || 15;
      this.knobs[id].gain = new VintageKnob(knobRow, {
        min: -gainRange, max: gainRange, default: 0, step: 0.5,
        label: 'GAIN', unit: 'dB',
        onChange: (v) => {
          if (this.audioEngine && this.mode !== 'C') {
            this.audioEngine.setUserBand(id - 1, { gain: v });
            this._updateCurve();
          }
        }
      });

      // Freq knob (level 2+)
      if (data.userControlsFreq) {
        const def = { 1: [40, 300], 2: [200, 1200], 3: [1000, 8000], 4: [4000, 16000] }[id];
        const defaultFreq = Math.round((def[0] + def[1]) / 2);
        this.knobs[id].freq = new VintageKnob(knobRow, {
          min: def[0], max: def[1], default: defaultFreq, step: 10,
          label: 'FREQ', unit: 'Hz',
          onChange: (v) => {
            if (this.audioEngine && this.mode !== 'C') {
              this.audioEngine.setUserBand(id - 1, { frequency: v });
              this._updateCurve();
            }
          }
        });
        // Init filter freq
        this.audioEngine.setUserBand(id - 1, { frequency: defaultFreq });
      } else {
        // Fixed freq — set filter to fixed value
        const fixedFreqs = { 1: 100, 2: 500, 3: 3000, 4: 8000 };
        this.audioEngine.setUserBand(id - 1, { frequency: fixedFreqs[id] });
      }

      // Q knob (level 2+ for peaking bands)
      if (data.userControlsQ && band.type === 'peaking') {
        this.knobs[id].q = new VintageKnob(knobRow, {
          min: 0.3, max: 6.0, default: 1.0, step: 0.1,
          label: 'Q', unit: '',
          onChange: (v) => {
            if (this.audioEngine && this.mode !== 'C') {
              this.audioEngine.setUserBand(id - 1, { Q: v });
              this._updateCurve();
            }
          }
        });
        this.audioEngine.setUserBand(id - 1, { Q: 1.0 });
      }

      // Set filter type
      this.audioEngine.setUserBand(id - 1, { type: band.type, gain: 0 });
    });
  }

  _setMode(mode) {
    if (!this.audioEngine || this.submitted) return;
    this.mode = mode;
    this._setModeUI(mode);
    this.audioEngine.setMode(mode);

    // Re-apply user knob values when switching back to B
    if (mode === 'B') {
      [1, 2, 3, 4].forEach(id => {
        const k = this.knobs[id];
        if (!k) return;
        if (k.gain) this.audioEngine.setUserBand(id - 1, { gain: k.gain.getValue() });
        if (k.freq) this.audioEngine.setUserBand(id - 1, { frequency: k.freq.getValue() });
        if (k.q) this.audioEngine.setUserBand(id - 1, { Q: k.q.getValue() });
      });
    }
  }

  _setModeUI(mode) {
    document.querySelectorAll('.eqm-mode-btn').forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.querySelector('.eqm-mode-led').classList.toggle('active', active);
    });
  }

  _cycleMode() {
    const modes = ['A', 'B', 'C'];
    const next = modes[(modes.indexOf(this.mode) + 1) % 3];
    this._setMode(next);
  }

  _togglePlay() {
    if (!this.audioEngine) return;
    const btn = document.getElementById('eqm-play-btn');
    const led = document.getElementById('eqm-play-led');
    this.audioEngine.togglePlayback();
    const playing = this.audioEngine.isPlaying;
    btn.textContent = '';
    btn.innerHTML = `<span class="btn-rack-led ${playing ? 'active' : ''}" id="eqm-play-led"></span>${playing ? 'STOP' : 'PLAY'}`;
    if (led) led.classList.toggle('active', playing);
  }

  _startTimer(limit) {
    this.timerInterval = setInterval(() => {
      this.secondsElapsed++;
      const remaining = limit - this.secondsElapsed;
      this._updateTimerDisplay(remaining);
      if (remaining <= 0) {
        this._stopTimer();
        this._submit(true);
      }
    }, 1000);
  }

  _stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  }

  _updateTimerDisplay(seconds) {
    const el = document.getElementById('eqm-timer');
    if (!el) return;
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    el.textContent = `${m}:${sec.toString().padStart(2, '0')}`;
    el.classList.toggle('eqm-timer--warn', s <= 15);
  }

  async _submit(forced = false) {
    if (this.submitted || !this.exercise) return;
    this.submitted = true;
    this._stopTimer();

    document.getElementById('eqm-submit-btn').disabled = true;
    document.getElementById('eqm-submit-led').classList.remove('active');

    const userBands = {};
    [1, 2, 3, 4].forEach(id => {
      const k = this.knobs[id];
      const band = this.exercise.hiddenBands[id];
      userBands[id] = {
        gain: k?.gain?.getValue() ?? 0,
        frequency: k?.freq?.getValue() ?? band.frequency,
        Q: k?.q?.getValue() ?? (band.Q ?? 1.0),
      };
    });

    try {
      const result = await invokeTauri('eq_match_evaluate', {
        exerciseId: this.exercise.exerciseId,
        userBands,
        secondsTaken: this.secondsElapsed,
      });
      this._showResults(result);
    } catch (err) {
      this._setStatus('error', 'Fehler beim Auswerten: ' + err);
      this.submitted = false;
      document.getElementById('eqm-submit-btn').disabled = false;
    }
  }

  _showResults(result) {
    const { score, timeFactor, bandResults, hiddenBands } = result;

    // Reveal hidden EQ curve
    if (this.curveDisplay && this.audioEngine) {
      this.curveDisplay.revealHiddenCurve(this.audioEngine.hiddenFilters);
    }

    // Show hidden EQ on knobs (reveal)
    [1, 2, 3, 4].forEach(id => {
      const hidden = hiddenBands[id];
      const br = bandResults[id];
      const led = document.getElementById(`eqm-band-led-${id}`);
      const resultEl = document.getElementById(`eqm-band-result-${id}`);

      if (led) {
        const s = br.bandScore ?? br.gainScore ?? 0;
        led.style.background = s >= 0.75 ? 'var(--led-green)' : s >= 0.4 ? 'var(--led-amber)' : 'var(--led-red)';
        led.style.boxShadow = s >= 0.75 ? '0 0 6px rgba(76,175,80,0.7)' : s >= 0.4 ? '0 0 6px rgba(255,193,7,0.7)' : '0 0 6px rgba(255,82,82,0.7)';
      }

      if (resultEl) {
        const pct = Math.round((br.bandScore ?? br.gainScore ?? 0) * 100);
        const hiddenGainStr = hidden.gain >= 0 ? `+${hidden.gain}` : `${hidden.gain}`;
        const userGainStr = br.userGain >= 0 ? `+${br.userGain.toFixed(1)}` : `${br.userGain.toFixed(1)}`;
        let extra = '';
        if (br.hiddenFreq) extra += ` &nbsp;|&nbsp; ${hidden.frequency}Hz`;
        if (br.hiddenQ) extra += ` &nbsp;|&nbsp; Q${hidden.Q}`;
        resultEl.innerHTML = `
          <div class="eqm-band-score-bar">
            <div class="eqm-band-score-fill" style="width:${pct}%"></div>
          </div>
          <div class="eqm-band-score-text">
            <span>Ziel: <b>${hiddenGainStr} dB${extra}</b></span>
            <span>Du: <b>${userGainStr} dB</b></span>
            <span class="eqm-band-pct">${pct}%</span>
          </div>
        `;
        resultEl.style.display = 'block';
      }
    });

    const resultsEl = document.getElementById('eqm-results');
    const grade = score >= 800 ? '★★★' : score >= 500 ? '★★☆' : '★☆☆';
    const timeInfo = this.exercise.timeLimit
      ? `<span class="eqm-result-time">Zeit: ${this.secondsElapsed}s &nbsp;|&nbsp; Faktor: ${(timeFactor * 100).toFixed(0)}%</span>`
      : '';
    resultsEl.innerHTML = `
      <div class="eqm-result-panel">
        <div class="eqm-result-grade">${grade}</div>
        <div class="eqm-result-score">${score} <span>PTS</span></div>
        ${timeInfo}
        <button class="btn-rack btn-rack--primary" id="eqm-next-btn">
          <span class="btn-rack-led active"></span>NÄCHSTE RUNDE
        </button>
      </div>
    `;
    resultsEl.style.display = 'flex';
    document.getElementById('eqm-next-btn').addEventListener('click', () => this._newRound());

    this._setStatus('done', `Ergebnis: ${score} Punkte ${grade}`);
    new HighscoreManager().submit(score, 1, this.exercise?.level || 1, 0, 'eq-match').catch(() => {});
  }

  _setStatus(type, text) {
    const led = document.getElementById('eqm-status-led');
    const txt = document.getElementById('eqm-status-text');
    if (txt) txt.textContent = text;
    if (led) {
      led.className = 'eqm-status-led';
      if (type === 'ready') { led.style.background = 'var(--led-green)'; led.style.boxShadow = '0 0 6px rgba(76,175,80,0.7)'; }
      else if (type === 'error') { led.style.background = 'var(--led-red)'; led.style.boxShadow = '0 0 6px rgba(255,82,82,0.7)'; }
      else if (type === 'done') { led.style.background = 'var(--led-amber)'; led.style.boxShadow = '0 0 6px rgba(255,193,7,0.7)'; }
      else { led.style.background = '#444'; led.style.boxShadow = 'none'; }
    }
  }

  _destroyKnobs() {
    Object.values(this.knobs).forEach(band => {
      Object.values(band).forEach(k => k.destroy());
    });
    this.knobs = {};
  }

  setLevel(level) {
    this.level = level;
    this._newRound();
  }

  destroy() {
    this._stopTimer();
    if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this.audioEngine) { this.audioEngine.destroy(); this.audioEngine = null; }
    this._destroyKnobs();
  }
}

registerModule('eq-match-trainer', EQMatchTrainerModule);
