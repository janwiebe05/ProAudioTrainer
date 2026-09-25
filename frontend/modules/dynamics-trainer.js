'use strict';

// The old client-side RMS/peak threshold auto-adaptation (adaptParamsToSignal)
// no longer applies here: Rust now decides params AND renders the audio in
// one step, before the client ever sees it. paw-core DOES adapt the
// threshold to the clip's actual measured level (see
// paw_core::exercise::dynamics::adapt_params_to_signal, called from
// commands/dynamics.rs before rendering) — the values this module receives
// and displays are already the calibrated ones, not static preset numbers.

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
    // Audio playback (DryWetPlayer)
    this.player = null;
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
    this._uninstallShortcuts = installTrainerShortcuts(this.container, { play: '#dyn-btn-play', ab: '#dyn-btn-ab', primary: ['#dyn-btn-start', '#dyn-btn-submit', '#dyn-btn-next'], skip: ['#dyn-btn-skip'], answers: '.dyn-effect-btn' });
    this.setStatus('Bereit. Drücke START um zu beginnen.');
  }

  setLevel(level) {
    this.level = level;
    const el = this.container.querySelector('#dyn-level');
    if (el) el.textContent = ['I', 'II', 'III'][level - 1] || level;
  }

  destroy() {
    this._destroyed = true;
    if (this._uninstallShortcuts) this._uninstallShortcuts();
    this.stopAudio();
    this.stopTimer();
    if (this.player) { this.player.destroy(); this.player = null; }
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
            <input type="range" class="dyn-slider" id="dyn-threshold" min="-70" max="0" step="1" value="-24">
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
              <button class="btn-rack" id="dyn-btn-close">SCHLIESSEN</button>
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
    $('#dyn-btn-close').addEventListener('click', () => {
      this.container.querySelector('#dyn-gameover').style.display = 'none';
      this.restart(); this.phase = 'idle';
    });

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
    // Without this guard, a second START click while the first
    // invokeTauri()/loadDryWet() round-trip is still in flight starts a
    // second concurrent load; both write this.player/this.exercise, so
    // whichever resolves last "wins" and the round can end up scored
    // against a mismatched exercise.
    if (this.phase === 'loading') return;
    this.stopAudio();
    this.stopTimer();
    this.hideResult();
    // phase flips to 'loading' before setControlsEnabled(false) — that call
    // hides the START button based on `this.phase !== 'idle'`, so this
    // order must hold or START stays visible/clickable during the load.
    this.phase = 'loading';
    this.setControlsEnabled(false);
    this.elapsedSeconds = 0;

    this.setStatus('Lade Übung…', true);

    try {
      // Rust core picks a random library track, chooses/renders the effect,
      // and returns two pre-rendered clips — no more live Tone.js/worklet
      // graph building on the client.
      const exercise = await invokeTauri('dynamics_random', { level: this.level });
      this.exercise = exercise;

      this.setStatus('Lade Audio…', true);
      if (!this.player) this.player = new DryWetPlayer(this.app.getAudioContext());
      else this.player.stop();
      await this.player.loadDryWet(tauriFileUrl(exercise.dryPath), tauriFileUrl(exercise.processedPath));
      if (this._destroyed) return;

      this.player.play();
      this.setABMode(this.abMode);
      this.isPlaying = true;
      this.updatePlayButton();

      this.startTimer();
      this.applyGuessMode(exercise.guessMode);
      this.setControlsEnabled(true);
      const hints = { 'type-only': 'Identifiziere den Effekttyp!', 'type-amount': 'Effekttyp und Stärke bestimmen!', 'type-params': 'Effekttyp und alle Parameter schätzen!' };
      this.setStatus(hints[exercise.guessMode] || 'Höre das Audio!');
      this.phase = 'playing';
    } catch (err) {
      this.setStatus(`Fehler: ${err}`);
      console.error('[DynamicsTrainer]', err);
      // Without resetting phase, setControlsEnabled() keeps hiding START
      // forever (it only shows in 'idle') — a failed round otherwise
      // leaves the trainer permanently stuck with no way to retry.
      this.phase = 'idle';
      this.setControlsEnabled(true);
    }
  }

  // ─── Audio playback (DryWetPlayer — see frontend/shared/dry-wet-player.js) ──

  async togglePlay() {
    if (!this.player) return;
    await this.player.togglePlayback();
    this.isPlaying = this.player.isPlaying;
    this.updatePlayButton();
  }

  stopAudio() {
    if (this.player) this.player.stop();
    this.isPlaying = false;
    this.updatePlayButton();
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
    if (this.player) this.player.setWetMode(mode === 'processed');

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

  // Feedback text is built here rather than in Rust: the exercise's actual
  // effect/params are already known client-side (dynamics_random reveals
  // them up front, same as the legacy JS route did) so there is no reason
  // to round-trip formatted strings — dynamics_evaluate just returns the
  // score and whether the effect type was guessed correctly.
  buildFeedback(guesses, typeCorrect) {
    const typeLabels = { compressor: 'COMPRESSOR', limiter: 'LIMITER', gate: 'GATE', expander: 'EXPANDER' };
    const ex = this.exercise;
    const feedback = {
      type: typeCorrect ? `Richtig: ${typeLabels[ex.effect]}` : `Falsch. Es war: ${typeLabels[ex.effect]}`,
    };

    if (ex.guessMode === 'type-amount') {
      const amountCorrect = guesses.guessAmount === ex.amountIndex;
      feedback.amount = amountCorrect
        ? `Stärke korrekt: ${ex.amountLabels[ex.amountIndex]}`
        : `Stärke: du hast ${ex.amountLabels[guesses.guessAmount] ?? '?'} gewählt, richtig wäre ${ex.amountLabels[ex.amountIndex]}`;
    } else if (ex.guessMode === 'type-params') {
      const fmt = {
        threshold: v => `${v} dB`, ratio: v => `${v}:1`, attack: v => `${v} ms`,
        release: v => `${v} ms`, makeupGain: v => `+${v} dB`,
      };
      const correctVals = {
        threshold: ex.thresholdDb, ratio: ex.ratio, attack: ex.attackMs,
        release: ex.releaseMs, makeupGain: ex.makeupDb,
      };
      const evalParamsByEffect = {
        compressor: ['threshold', 'ratio', 'attack', 'release', 'makeupGain'],
        limiter:    ['threshold', 'attack', 'release', 'makeupGain'],
        gate:       ['threshold', 'ratio', 'attack', 'release'],
        expander:   ['threshold', 'ratio', 'attack', 'release'],
      };
      const guessMap = {
        threshold: guesses.guessThreshold, ratio: guesses.guessRatio,
        attack: guesses.guessAttack, release: guesses.guessRelease, makeupGain: guesses.guessGain,
      };
      for (const key of evalParamsByEffect[ex.effect] || evalParamsByEffect.compressor) {
        const g = guessMap[key];
        if (g == null) continue;
        feedback[key] = `Richtig: ${fmt[key](correctVals[key])}  |  Dein Wert: ${fmt[key](g)}`;
      }
    }
    return feedback;
  }

  async submitAnswer() {
    if (this.phase !== 'playing' || !this.exercise) return;
    this.phase = 'result';
    this.stopTimer();
    this.setControlsEnabled(false);

    const guesses = this.getGuesses();
    try {
      const evalResult = await invokeTauri('dynamics_evaluate', {
        exerciseId:     this.exercise.exerciseId,
        guessEffect:    guesses.guessType,
        guessAmount:    guesses.guessAmount,
        guessThreshold: guesses.guessThreshold,
        guessRatio:     guesses.guessRatio,
        guessAttackMs:  guesses.guessAttack,
        guessReleaseMs: guesses.guessRelease,
        guessMakeupDb:  guesses.guessGain,
        secondsTaken:   this.elapsedSeconds,
      });
      this.applyResult({
        score: evalResult.score,
        typeCorrect: evalResult.typeCorrect,
        effectType: this.exercise.effect,
        feedback: this.buildFeedback(guesses, evalResult.typeCorrect),
      });
    } catch (err) {
      this.setStatus(`Fehler: ${err}`);
      this.phase = 'playing';
      this.setControlsEnabled(true);
    }
  }

  applyResult(data) {
    const { score, typeCorrect, effectType, feedback } = data;
    const typeLabels = { compressor: 'COMPRESSOR', limiter: 'LIMITER', gate: 'GATE', expander: 'EXPANDER' };

    this.round++;
    this.score += score;
    if (typeCorrect) { this.streak++; } else { this.streak = 0; if (!AppSettings.practiceMode) this.lives--; }
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
    if (!AppSettings.practiceMode) this.lives--;
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
    if (this._scoreSubmitted) return;
    this._scoreSubmitted = true;
    this.stopAudio();
    this.stopTimer();
    this.phase = 'gameover';

    try {
      await new HighscoreManager().submit(this.score, this.round, this.level, this.streak, 'dynamics');
    } catch {}

    const overlay = this.container.querySelector('#dyn-gameover');
    overlay.style.display = 'flex';
    this.container.querySelector('#dyn-final-score').textContent  = this.score;
    this.container.querySelector('#dyn-stat-rounds').textContent  = this.round;
    this.container.querySelector('#dyn-stat-streak').textContent  = this.streak;
    this.container.querySelector('#dyn-stat-level').textContent   = ['I', 'II', 'III'][this.level - 1] || this.level;
  }

  restart() {
    this._scoreSubmitted = false;
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
