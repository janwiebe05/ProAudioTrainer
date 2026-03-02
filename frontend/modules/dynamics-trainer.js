'use strict';

// Measure RMS and Peak of AudioBuffer, then set threshold relative to actual
// signal characteristics — same principle as auto-threshold in iZotope/Waves tools.
function adaptParamsToSignal(audioBuffer, params, effectType) {
  const ch         = audioBuffer.getChannelData(0);
  const maxSamples = Math.min(ch.length, audioBuffer.sampleRate * 3);
  let sumSq = 0, peak = 0;
  for (let i = 0; i < maxSamples; i++) {
    const abs = Math.abs(ch[i]);
    sumSq += abs * abs;
    if (abs > peak) peak = abs;
  }
  const rmsDb  = sumSq > 0 ? 20 * Math.log10(Math.sqrt(sumSq / maxSamples)) : -80;
  const peakDb = peak  > 0 ? 20 * Math.log10(peak) : -80;
  // Crest factor = dynamic range of the material (high = punchy/transient-rich)
  const crestDb = peakDb - rmsDb; // typically 6–20 dB

  const p = { ...params };

  if (effectType === 'compressor' || effectType === 'limiter') {
    // Threshold anchored between RMS and Peak — compressor catches transients above RMS
    // Offset from preset preserves the intended "light/heavy" compression character
    const presetMid = effectType === 'limiter' ? -6 : -24;
    const offset    = p.threshold - presetMid;
    // Anchor: RMS + half the crest factor = sits in the upper dynamic range
    const anchor    = rmsDb + crestDb * 0.5;
    p.threshold     = Math.max(-60, Math.min(-1, anchor + offset));
    p.makeupGain    = 0; // no makeup — students hear raw gain reduction as in real sessions
  } else {
    // Gate/Expander: threshold must sit BELOW the signal's average level.
    // Anchor = RMS - 12dB so the threshold is clearly beneath most of the signal,
    // meaning only the quietest passages (tails, gaps) get attenuated.
    const presetMid = -35;
    const offset    = p.threshold - presetMid;
    const anchor    = rmsDb - 12;
    p.threshold     = Math.max(-70, Math.min(-15, anchor + offset));
  }

  return p;
}

// Which optional sliders are relevant per effect type
const EFFECT_PARAMS = {
  compressor: { ratio: true,  gain: true  },
  limiter:    { ratio: false, gain: true  },
  gate:       { ratio: true,  gain: false },
  expander:   { ratio: true,  gain: false },
};

const EFFECT_STRENGTH_LABEL = {
  compressor: 'STÄRKE DER KOMPRESSION',
  limiter:    'STÄRKE DES LIMITINGS',
  gate:       'STÄRKE DES GATINGS',
  expander:   'STÄRKE DES EXPANDERS',
};

class DynamicsTrainer {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.level = 1;
    // Game state
    this.score = 0;
    this.round = 0;
    this.streak = 0;
    this.lives = 3;
    this.phase = 'idle'; // idle | loading | playing | result | gameover
    // Audio graph nodes
    this.audioBuffer = null;
    this.source = null;
    this.bypassGain = null;
    this.processedGain = null;
    this.compressorNode = null;
    this.makeupGainNode = null;
    this.isPlaying = false;
    this.abMode = 'processed';
    // Exercise
    this.exercise = null;
    this.roundStartTime = null;
    this.elapsedSeconds = 0;
    this.timerInterval = null;
    this.maxTime = 45;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  init() {
    this.render();
    this.bindEvents();
    this.setStatus('Bereit. Drücke START um zu beginnen.');
  }

  setLevel(level) {
    this.level = level;
    const el = this.container.querySelector('#dyn-level');
    if (el) el.textContent = ['I', 'II', 'III'][level - 1] || level;
  }

  destroy() {
    this._destroyed = true;
    this.stopAudio();
    this.stopTimer();
    this.container.innerHTML = '';
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  render() {
    this.container.innerHTML = `
      <div class="dynamics-trainer">

        <div class="game-header">
          <div class="level-display">
            <span class="label">LEVEL</span>
            <span class="value" id="dyn-level">I</span>
          </div>
          <div class="score-display">
            <span class="label">SCORE</span>
            <span class="value" id="dyn-score">0</span>
          </div>
          <div class="lives-display" id="dyn-lives">
            <span class="life-led active"></span>
            <span class="life-led active"></span>
            <span class="life-led active"></span>
          </div>
          <div class="timer-display">
            <span class="label">TIMER</span>
            <div class="timer-bar-wrap"><div class="timer-bar-fill" id="dyn-timer-bar"></div></div>
            <span class="timer-value" id="dyn-timer">0.0s</span>
          </div>
          <div class="streak-display">
            <span class="label">STREAK</span>
            <span class="value" id="dyn-streak">0x</span>
          </div>
        </div>

        <div class="status-display">
          <span class="loader" id="dyn-loader" style="display:none"></span>
          <span id="dyn-status">Lade Übung…</span>
        </div>

        <div class="ab-controls">
          <button class="btn-rack btn-rack--ab" id="dyn-btn-play" disabled>▶ PLAY / STOP</button>
          <button class="btn-rack btn-rack--ab active-eq" id="dyn-btn-ab" disabled>B · PROCESSED</button>
        </div>

        <div class="canvas-wrapper" id="dyn-canvas-wrap">
          <div class="dyn-curve-label">INPUT / OUTPUT — TRANSFER CURVE</div>
          <canvas id="dyn-curve-canvas" height="180"></canvas>
        </div>

        <div class="dyn-effect-panel">
          <div class="dyn-panel-label">EFFEKT-TYP IDENTIFIZIEREN</div>
          <div class="dyn-effect-btns">
            <button class="dyn-effect-btn active" data-effect="compressor">COMPRESSOR</button>
            <button class="dyn-effect-btn" data-effect="limiter">LIMITER</button>
            <button class="dyn-effect-btn" data-effect="gate">GATE</button>
            <button class="dyn-effect-btn" data-effect="expander">EXPANDER</button>
          </div>
        </div>

        <!-- Level 2: Stärke wählen -->
        <div class="dyn-effect-panel" id="dyn-amount-panel" style="display:none">
          <div class="dyn-panel-label">STÄRKE DER KOMPRESSION</div>
          <div class="dyn-effect-btns">
            <button class="dyn-amount-btn" data-amount="0">LEICHT</button>
            <button class="dyn-amount-btn" data-amount="1">MITTEL</button>
            <button class="dyn-amount-btn" data-amount="2">STARK</button>
            <button class="dyn-amount-btn" data-amount="3">SEHR STARK</button>
          </div>
        </div>

        <!-- Level 3: Alle Parameter -->
        <div class="dyn-params-panel" id="dyn-params-panel" style="display:none">
          <div class="dyn-panel-label">PARAMETER EINSCHÄTZEN</div>
          <div class="dyn-param-row">
            <label class="dyn-param-label">THRESHOLD</label>
            <input type="range" class="dyn-slider" id="dyn-threshold" min="-60" max="0" step="1" value="-24">
            <span class="dyn-param-value" id="dyn-threshold-val">-24 dB</span>
          </div>
          <div class="dyn-param-row" id="dyn-row-ratio">
            <label class="dyn-param-label">RATIO</label>
            <input type="range" class="dyn-slider" id="dyn-ratio" min="1" max="20" step="0.5" value="4">
            <span class="dyn-param-value" id="dyn-ratio-val">4.0 : 1</span>
          </div>
          <div class="dyn-param-row">
            <label class="dyn-param-label">ATTACK</label>
            <input type="range" class="dyn-slider" id="dyn-attack" min="0.1" max="100" step="0.1" value="10">
            <span class="dyn-param-value" id="dyn-attack-val">10.0 ms</span>
          </div>
          <div class="dyn-param-row">
            <label class="dyn-param-label">RELEASE</label>
            <input type="range" class="dyn-slider" id="dyn-release" min="50" max="500" step="5" value="100">
            <span class="dyn-param-value" id="dyn-release-val">100 ms</span>
          </div>
          <div class="dyn-param-row" id="dyn-row-gain">
            <label class="dyn-param-label">MAKEUP GAIN</label>
            <input type="range" class="dyn-slider" id="dyn-gain" min="0" max="20" step="0.5" value="6">
            <span class="dyn-param-value" id="dyn-gain-val">+6.0 dB</span>
          </div>
        </div>

        <div class="action-panel">
          <button class="btn-rack btn-rack--primary" id="dyn-btn-start">START</button>
          <button class="btn-rack btn-rack--primary" id="dyn-btn-submit" disabled style="display:none">ANTWORT PRÜFEN</button>
          <button class="btn-rack btn-rack--secondary" id="dyn-btn-skip" disabled>ÜBERSPRINGEN</button>
        </div>

        <div class="result-panel" id="dyn-result">
          <div class="result-header">
            <span class="result-hit" id="dyn-result-icon"></span>
            <span class="result-title" id="dyn-result-title"></span>
            <span class="result-points" id="dyn-result-points"></span>
          </div>
          <div class="dyn-result-grid" id="dyn-result-details"></div>
          <div class="action-panel" style="margin-top:8px">
            <button class="btn-rack btn-rack--primary" id="dyn-btn-next">NÄCHSTE RUNDE</button>
          </div>
        </div>

        <div class="gameover-overlay" id="dyn-gameover">
          <div class="gameover-card">
            <div class="gameover-title">SESSION BEENDET</div>
            <div class="gameover-final-score" id="dyn-final-score">0</div>
            <div class="gameover-label">GESAMTPUNKTE</div>
            <div class="gameover-stats">
              <div class="stat-item">
                <div class="stat-label">Runden</div>
                <div class="stat-value" id="dyn-stat-rounds">0</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">Streak</div>
                <div class="stat-value" id="dyn-stat-streak">0</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">Level</div>
                <div class="stat-value" id="dyn-stat-level">I</div>
              </div>
            </div>
            <div class="action-panel">
              <button class="btn-rack btn-rack--primary" id="dyn-btn-restart">NEU STARTEN</button>
            </div>
          </div>
        </div>

      </div>
    `;

    // Size canvas after DOM is painted
    requestAnimationFrame(() => {
      const canvas = this.container.querySelector('#dyn-curve-canvas');
      if (canvas) {
        canvas.width = canvas.offsetWidth || 600;
        this.drawCurve();
      }
    });
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  bindEvents() {
    const $ = id => this.container.querySelector(id);

    $('#dyn-btn-start').addEventListener('click', () => this.loadExercise());
    $('#dyn-btn-play').addEventListener('click', () => this.togglePlay());
    $('#dyn-btn-ab').addEventListener('click', () => this.toggleABMode());
    $('#dyn-btn-submit').addEventListener('click', () => this.submitAnswer());
    $('#dyn-btn-skip').addEventListener('click', () => this.skipRound());
    $('#dyn-btn-next').addEventListener('click', () => this.nextRound());
    $('#dyn-btn-restart').addEventListener('click', () => this.restart());

    this.container.querySelectorAll('.dyn-effect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.dyn-effect-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = this.exercise?.guessMode;
        if (mode === 'type-params') {
          this.updateParamRows(btn.dataset.effect);
        } else if (mode === 'type-amount') {
          const labelEl = this.container.querySelector('#dyn-amount-panel .dyn-panel-label');
          if (labelEl) labelEl.textContent = EFFECT_STRENGTH_LABEL[btn.dataset.effect] || 'STÄRKE';
        }
        this.drawCurve();
      });
    });

    this.container.querySelectorAll('.dyn-amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.dyn-amount-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    const sliderDefs = [
      { id: '#dyn-threshold', valId: '#dyn-threshold-val', fmt: v => `${Math.round(v)} dB`,           redraw: true },
      { id: '#dyn-ratio',     valId: '#dyn-ratio-val',     fmt: v => `${parseFloat(v).toFixed(1)} : 1`, redraw: true },
      { id: '#dyn-attack',    valId: '#dyn-attack-val',    fmt: v => `${parseFloat(v).toFixed(1)} ms`,  redraw: false },
      { id: '#dyn-release',   valId: '#dyn-release-val',   fmt: v => `${Math.round(v)} ms`,             redraw: false },
      { id: '#dyn-gain',      valId: '#dyn-gain-val',      fmt: v => `+${parseFloat(v).toFixed(1)} dB`, redraw: false },
    ];

    sliderDefs.forEach(({ id, valId, fmt, redraw }) => {
      const slider = $(id);
      const valEl  = $(valId);
      slider.addEventListener('input', () => {
        valEl.textContent = fmt(slider.value);
        if (redraw) this.drawCurve();
      });
    });
  }

  // ─── Exercise loading ────────────────────────────────────────────────────────

  async loadExercise() {
    this.stopAudio();
    this.stopTimer();
    this.hideResult();
    this.setControlsEnabled(false);
    this.elapsedSeconds = 0;
    this.phase = 'loading';

    this.setStatus('Lade Übung…', true);

    try {
      const exercise = await apiCall('GET', `/dynamics/random?level=${this.level}`);
      this.exercise = exercise;

      this.setStatus('Lade Audio…', true);
      const token = localStorage.getItem('token');
      const audioRes = await fetch(exercise.audioUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!audioRes.ok) throw new Error('Audio nicht ladbar');

      const arrayBuffer = await audioRes.arrayBuffer();
      const ctx = this.app.getAudioContext();
      this.audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      if (this._destroyed) return;

      // Measure RMS of the audio and adapt threshold relative to signal level
      this.exercise.params = adaptParamsToSignal(this.audioBuffer, this.exercise.params, this.exercise.effectType);

      this.buildAudioGraph();
      this.startPlayback();
      this.startTimer();
      this.applyGuessMode(exercise.guessMode);
      this.setControlsEnabled(true);
      const hints = { 'type-only': 'Identifiziere den Effekttyp!', 'type-amount': 'Effekttyp und Stärke bestimmen!', 'type-params': 'Effekttyp und alle Parameter schätzen!' };
      this.setStatus(hints[exercise.guessMode] || 'Höre das Audio!');
      this.phase = 'playing';
    } catch (err) {
      this.setStatus(`Fehler: ${err.message}`);
      console.error('[DynamicsTrainer]', err);
    }
  }

  // ─── Audio graph ─────────────────────────────────────────────────────────────
//** 
  async buildAudioGraph() {
    const ctx = this.app.getAudioContext();
    const p   = this.exercise.params;
    const effectType = this.exercise.effectType;

    // Sync Tone.js to our shared AudioContext
    if (Tone.getContext().rawContext !== ctx) {
      Tone.setContext(ctx);
    }

    // ── Shared infrastructure ───────────────────────────────────────────
    // Bypass path (A): direct to destination
    this.bypassGain = ctx.createGain();
    this.bypassGain.gain.value = this.abMode === 'bypass' ? 1 : 0;
    this.bypassGain.connect(ctx.destination);

    // Processed output gate
    this.processedGain = ctx.createGain();
    this.processedGain.gain.value = this.abMode === 'processed' ? 1 : 0;
    this.processedGain.connect(ctx.destination);

    // ── Effect-specific path ────────────────────────────────────────────
    switch (effectType) {

      case 'compressor': {
        // Tone.Compressor wraps DynamicsCompressorNode — true compressor
        this._toneEffect = new Tone.Compressor({
          threshold: p.threshold,
          ratio:     p.ratio,
          attack:    p.attack   / 1000,
          release:   p.release  / 1000,
          knee:      3,
        });
        // Makeup gain post-compressor
        this._toneMakeup = new Tone.Gain(Tone.dbToGain(p.makeupGain));
        this._toneEffect.connect(this._toneMakeup);
        this._toneMakeup.connect(this.processedGain);
        this._effectInput = this._toneEffect.input;
        break;
      }

      case 'limiter': {
        // Limiter = Compressor with ratio 20:1 (≈ ∞), fast attack, hard knee
        this._toneEffect = new Tone.Compressor({
          threshold: p.threshold,
          ratio:     20,
          attack:    p.attack   / 1000,
          release:   p.release  / 1000,
          knee:      0,
        });
        this._toneMakeup = new Tone.Gain(Tone.dbToGain(p.makeupGain));
        this._toneEffect.connect(this._toneMakeup);
        this._toneMakeup.connect(this.processedGain);
        this._effectInput = this._toneEffect.input;
        break;
      }

      case 'gate': {
        // AudioWorklet gate — true noise gate with threshold, ratio, attack, release
        if (!this._gateWorkletLoaded) {
          await ctx.audioWorklet.addModule('/worklets/gate-processor.js');
          this._gateWorkletLoaded = true;
        }
        this._workletNode = new AudioWorkletNode(ctx, 'gate-processor');
        this._workletNode.parameters.get('threshold').value = p.threshold;
        this._workletNode.parameters.get('ratio').value     = p.ratio;
        this._workletNode.parameters.get('attack').value    = p.attack   / 1000;
        this._workletNode.parameters.get('release').value   = p.release  / 1000;
        this._workletNode.connect(this.processedGain);
        this._effectInput = this._workletNode;
        break;
      }

      case 'expander': {
        // AudioWorklet downward expander — no Tone.js equivalent
        if (!this._workletLoaded) {
          await ctx.audioWorklet.addModule('/worklets/expander-processor.js');
          this._workletLoaded = true;
        }
        this._workletNode = new AudioWorkletNode(ctx, 'expander-processor');
        this._workletNode.parameters.get('threshold').value = p.threshold;
        this._workletNode.parameters.get('ratio').value     = p.ratio;
        this._workletNode.parameters.get('attack').value    = p.attack   / 1000;
        this._workletNode.parameters.get('release').value   = p.release  / 1000;
        this._workletNode.connect(this.processedGain);
        this._effectInput = this._workletNode; // native AudioNode
        break;
      }
    }
  }

  startPlayback() {
    const ctx = this.app.getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    this.source = ctx.createBufferSource();
    this.source.buffer = this.audioBuffer;
    this.source.loop   = true;

    // Bypass path (A)
    this.source.connect(this.bypassGain);

    // Processed path (B) — connect to correct effect input type
    if (this._effectInput instanceof AudioNode) {
      this.source.connect(this._effectInput);          // AudioWorklet (expander)
    } else if (this._effectInput) {
      this.source.connect(this._effectInput);          // Tone.js input (AudioNode under the hood)
    }

    this.source.start();
    this.isPlaying = true;
    this.updatePlayButton();
  }

  stopAudio() {
    if (this.source) {
      try { this.source.stop(); } catch {}
      this.source = null;
    }
    // Disconnect native gain nodes
    [this.bypassGain, this.processedGain].forEach(node => {
      if (node) { try { node.disconnect(); } catch {} }
    });
    // Dispose Tone.js nodes
    if (this._toneEffect) { try { this._toneEffect.dispose(); } catch {} this._toneEffect = null; }
    if (this._toneMakeup) { try { this._toneMakeup.dispose(); } catch {} this._toneMakeup = null; }
    // Disconnect AudioWorklet node
    if (this._workletNode) { try { this._workletNode.disconnect(); } catch {} this._workletNode = null; }

    this.bypassGain = this.processedGain = null;
    this._effectInput = null;
    this.isPlaying = false;
    this.updatePlayButton();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.stopAudio();
    } else if (this.audioBuffer) {
      this.buildAudioGraph();
      this.startPlayback();
    }
  }

  updatePlayButton() {
    const btn = this.container.querySelector('#dyn-btn-play');
    if (btn) btn.textContent = this.isPlaying ? '■ STOP' : '▶ PLAY / STOP';
  }

  toggleABMode() {
    this.setABMode(this.abMode === 'processed' ? 'bypass' : 'processed');
  }

  setABMode(mode) {
    this.abMode = mode;
    if (this.bypassGain)    this.bypassGain.gain.value    = mode === 'bypass'    ? 1 : 0;
    if (this.processedGain) this.processedGain.gain.value = mode === 'processed' ? 1 : 0;

    const btn = this.container.querySelector('#dyn-btn-ab');
    if (btn) {
      btn.textContent = mode === 'bypass' ? 'A · ORIGINAL' : 'B · PROCESSED';
      btn.classList.toggle('active-bypass', mode === 'bypass');
      btn.classList.toggle('active-eq',     mode === 'processed');
    }
  }

  // ─── Timer ───────────────────────────────────────────────────────────────────

  startTimer() {
    this.stopTimer();
    this.roundStartTime = Date.now();
    const timerEl  = this.container.querySelector('#dyn-timer');
    const timerBar = this.container.querySelector('#dyn-timer-bar');
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds = (Date.now() - this.roundStartTime) / 1000;
      if (timerEl)  timerEl.textContent = `${this.elapsedSeconds.toFixed(1)}s`;
      if (timerBar) timerBar.style.width = `${Math.min(100, (this.elapsedSeconds / this.maxTime) * 100)}%`;
    }, 100);
  }

  stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  }

  // ─── Scoring / Answer ────────────────────────────────────────────────────────

  applyGuessMode(guessMode) {
    const amountPanel = this.container.querySelector('#dyn-amount-panel');
    const paramsPanel = this.container.querySelector('#dyn-params-panel');
    const canvasWrap  = this.container.querySelector('#dyn-canvas-wrap');

    amountPanel.style.display = guessMode === 'type-amount' ? '' : 'none';
    paramsPanel.style.display = guessMode === 'type-params' ? '' : 'none';
    if (canvasWrap) canvasWrap.style.display = guessMode === 'type-params' ? '' : 'none';

    // Reset amount selection — first button pre-selected
    this.container.querySelectorAll('.dyn-amount-btn').forEach(b => b.classList.remove('active'));
    const firstAmount = this.container.querySelector('.dyn-amount-btn[data-amount="0"]');
    if (firstAmount) firstAmount.classList.add('active');

    // Reset effect selection to compressor (always available on all levels)
    this.container.querySelectorAll('.dyn-effect-btn').forEach(b => b.classList.remove('active'));
    const compBtn = this.container.querySelector('.dyn-effect-btn[data-effect="compressor"]');
    if (compBtn) compBtn.classList.add('active');

    // In level 3: show/hide param rows for compressor by default
    if (guessMode === 'type-params') {
      this.updateParamRows('compressor');
    }
  }

  updateParamRows(effect) {
    const cfg = EFFECT_PARAMS[effect] || EFFECT_PARAMS.compressor;
    const rowRatio = this.container.querySelector('#dyn-row-ratio');
    const rowGain  = this.container.querySelector('#dyn-row-gain');
    if (rowRatio) rowRatio.style.display = cfg.ratio ? '' : 'none';
    if (rowGain)  rowGain.style.display  = cfg.gain  ? '' : 'none';
  }

  getGuesses() {
    const $ = id => this.container.querySelector(id);
    const mode = this.exercise?.guessMode || 'type-params';
    const guessType = $('.dyn-effect-btn.active')?.dataset.effect || 'compressor';

    if (mode === 'type-only') {
      return { guessType };
    }
    if (mode === 'type-amount') {
      const guessAmount = parseInt($('.dyn-amount-btn.active')?.dataset.amount ?? 0, 10);
      return { guessType, guessAmount };
    }
    const cfg = EFFECT_PARAMS[guessType] || EFFECT_PARAMS.compressor;
    return {
      guessType,
      guessThreshold: parseFloat($('#dyn-threshold')?.value ?? -24),
      guessRatio:     cfg.ratio ? parseFloat($('#dyn-ratio')?.value   ?? 4)   : undefined,
      guessAttack:    parseFloat($('#dyn-attack')?.value    ?? 10),
      guessRelease:   parseFloat($('#dyn-release')?.value   ?? 100),
      guessGain:      cfg.gain  ? parseFloat($('#dyn-gain')?.value    ?? 6)   : undefined,
    };
  }

  async submitAnswer() {
    if (this.phase !== 'playing' || !this.exercise) return;
    this.phase = 'result';
    this.stopTimer();
    this.setControlsEnabled(false);

    try {
      const result = await apiCall('POST', '/dynamics/evaluate', {
        ...this.getGuesses(),
        exerciseId:   this.exercise.exerciseId,
        secondsTaken: this.elapsedSeconds,
      });
      this.applyResult(result);
    } catch (err) {
      this.setStatus(`Fehler: ${err.message}`);
      this.phase = 'playing';
      this.setControlsEnabled(true);
    }
  }

  applyResult(data) {
    const { score, typeCorrect, effectType, feedback } = data;
    const typeLabels = { compressor: 'COMPRESSOR', limiter: 'LIMITER', gate: 'GATE', expander: 'EXPANDER' };

    this.round++;
    this.score += score;
    if (typeCorrect) { this.streak++; } else { this.streak = 0; this.lives--; }
    this.updateHUD();

    const resultEl = this.container.querySelector('#dyn-result');
    resultEl.style.display = 'flex';

    this.container.querySelector('#dyn-result-icon').textContent  = typeCorrect ? '✓' : '✗';
    this.container.querySelector('#dyn-result-icon').style.color  = typeCorrect ? 'var(--led-green)' : 'var(--led-red)';
    this.container.querySelector('#dyn-result-title').textContent = typeCorrect
      ? `TREFFER · ${typeLabels[effectType]}`
      : `FALSCH · Richtig wäre: ${typeLabels[effectType]}`;
    this.container.querySelector('#dyn-result-title').style.color = typeCorrect ? 'var(--led-green)' : 'var(--led-red)';
    this.container.querySelector('#dyn-result-points').textContent = `+${score}`;

    const detailsEl = this.container.querySelector('#dyn-result-details');
    const feedbackEntries = Object.entries(feedback);
    detailsEl.innerHTML = feedbackEntries.map(([key, text]) => {
      const isGood = !text.includes('Falsch') && !text.includes('Stärke:');
      return `
        <div class="dyn-result-item ${isGood ? 'dyn-result-item--ok' : ''}">
          <span class="detail-label">${key === 'type' ? 'EFFEKT' : key === 'amount' ? 'STÄRKE' : key.toUpperCase()}</span>
          <span class="detail-value">${text}</span>
        </div>`;
    }).join('');

    if (this.lives <= 0) setTimeout(() => this.showGameOver(), 1600);
  }

  // ─── Navigation ──────────────────────────────────────────────────────────────

  nextRound() {
    if (this.lives <= 0) { this.showGameOver(); return; }
    this.loadExercise();
  }

  skipRound() {
    this.lives--;
    this.streak = 0;
    this.updateHUD();
    if (this.lives <= 0) {
      this.stopAudio();
      this.stopTimer();
      this.showGameOver();
    } else {
      this.loadExercise();
    }
  }

  async showGameOver() {
    this.stopAudio();
    this.stopTimer();
    this.phase = 'gameover';

    try {
      await apiCall('POST', '/scores', { score: this.score, rounds: this.round, level: this.level, streak: this.streak });
    } catch {}

    const overlay = this.container.querySelector('#dyn-gameover');
    overlay.style.display = 'flex';
    this.container.querySelector('#dyn-final-score').textContent  = this.score;
    this.container.querySelector('#dyn-stat-rounds').textContent  = this.round;
    this.container.querySelector('#dyn-stat-streak').textContent  = this.streak;
    this.container.querySelector('#dyn-stat-level').textContent   = ['I', 'II', 'III'][this.level - 1] || this.level;
  }

  restart() {
    this._destroyed = false;
    const overlay = this.container.querySelector('#dyn-gameover');
    if (overlay) overlay.style.display = 'none';
    this.score = this.round = this.streak = 0;
    this.lives = 3;
    this.phase = 'idle';
    this.updateHUD();
    this.loadExercise();
  }

  // ─── UI helpers ──────────────────────────────────────────────────────────────

  setStatus(text, loading = false) {
    const s = this.container.querySelector('#dyn-status');
    const l = this.container.querySelector('#dyn-loader');
    if (s) s.textContent = text;
    if (l) l.style.display = loading ? 'inline-block' : 'none';
  }

  setControlsEnabled(on) {
    ['#dyn-btn-play', '#dyn-btn-ab', '#dyn-btn-skip'].forEach(id => {
      const el = this.container.querySelector(id);
      if (el) el.disabled = !on;
    });
    const startBtn  = this.container.querySelector('#dyn-btn-start');
    const submitBtn = this.container.querySelector('#dyn-btn-submit');
    // START only visible in idle phase; once loading begins it disappears permanently
    if (startBtn)  startBtn.style.display  = this.phase === 'idle' ? '' : 'none';
    if (submitBtn) { submitBtn.style.display = this.phase === 'idle' ? 'none' : ''; submitBtn.disabled = !on; }
  }

  hideResult() {
    const el = this.container.querySelector('#dyn-result');
    if (el) el.style.display = 'none';
  }

  updateHUD() {
    const $ = id => this.container.querySelector(id);
    if ($('#dyn-score'))  $('#dyn-score').textContent  = this.score;
    if ($('#dyn-streak')) $('#dyn-streak').textContent = `${this.streak}x`;
    const livesEl = $('#dyn-lives');
    if (livesEl) livesEl.querySelectorAll('.life-led').forEach((led, i) => led.classList.toggle('active', i < this.lives));
  }

  // ─── I/O Curve Canvas ────────────────────────────────────────────────────────

  drawCurve() {
    const canvas = this.container.querySelector('#dyn-curve-canvas');
    if (!canvas) return;
    canvas.width = canvas.offsetWidth || 600;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    const threshold = parseFloat(this.container.querySelector('#dyn-threshold')?.value ?? -24);
    const ratio     = parseFloat(this.container.querySelector('#dyn-ratio')?.value     ?? 4);
    const effect    = this.container.querySelector('.dyn-effect-btn.active')?.dataset.effect || 'compressor';

    const MIN = -60, MAX = 12, SPAN = MAX - MIN;
    const toX = db => ((db - MIN) / SPAN) * W;
    const toY = db => H - ((db - MIN) / SPAN) * H;

    function outDb(inDb) {
      if (effect === 'gate') {
        return inDb < threshold ? threshold + (inDb - threshold) * ratio : inDb;
      }
      if (effect === 'expander') {
        return inDb < threshold ? threshold + (inDb - threshold) / ratio : inDb;
      }
      // compressor / limiter
      return inDb < threshold ? inDb : threshold + (inDb - threshold) / ratio;
    }

    // Background
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = '#1e1e1e';
    ctx.lineWidth = 1;
    for (let db = MIN; db <= MAX; db += 10) {
      ctx.beginPath(); ctx.moveTo(toX(db), 0); ctx.lineTo(toX(db), H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, toY(db)); ctx.lineTo(W, toY(db)); ctx.stroke();
    }

    // 1:1 reference
    ctx.strokeStyle = '#2e2e2e';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(toX(MIN), toY(MIN)); ctx.lineTo(toX(MAX), toY(MAX)); ctx.stroke();
    ctx.setLineDash([]);

    // Threshold marker
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(toX(threshold), 0); ctx.lineTo(toX(threshold), H); ctx.stroke();
    ctx.setLineDash([]);

    // Curve
    const colors = { compressor: '#4caf50', limiter: '#ff5252', gate: '#f5a623', expander: '#42a5f5' };
    ctx.strokeStyle = colors[effect] || '#4caf50';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (let db = MIN; db <= MAX; db += 0.5) {
      const x = toX(db), y = toY(outDb(db));
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#555';
    ctx.font = '10px Share Tech Mono, monospace';
    ctx.fillText('IN →', W - 36, H - 6);
    ctx.fillText('↑ OUT', 4, 14);
    ctx.fillStyle = '#444';
    ctx.fillText(`${threshold} dB`, toX(threshold) + 4, H - 6);
  }
}

registerModule('dynamics-trainer', DynamicsTrainer);
