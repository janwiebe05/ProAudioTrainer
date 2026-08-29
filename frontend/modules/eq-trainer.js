'use strict';

// ─── Game State ───────────────────────────────────────────────────────────────
class GameState {
  constructor() {
    this.lives = 3;
    this.maxLives = 3;
    this.score = 0;
    this.level = 1;
    this.round = 0;
    this.streak = 0;
    this.phase = 'idle';
    this.targetFreq = null;
    this.guessFreq = null;
    this.lastResult = null;
    this.sessionScore = 0;
    this.roundStartTime = null;
    this.currentExerciseId = null; // set by startNewRound(), consumed by submitGuess()
  }

  getToleranceOctaves() {
    const tol = { 1: 1.0, 2: 0.5, 3: 0.25 };
    return tol[this.level] || 0.25;
  }

  // Target-frequency generation and guess scoring both moved server-side to
  // paw-core::exercise::eq (Rust) — see AudioEngine/startNewRound/submitGuess
  // below — so the target frequency is never known client-side until the
  // eq_evaluate response reveals it.

  reset() {
    this.lives = 3;
    this.score = 0;
    this.level = 1;
    this.round = 0;
    this.streak = 0;
    this.phase = 'idle';
    this.targetFreq = null;
    this.guessFreq = null;
    this.lastResult = null;
    this.sessionScore = 0;
    this.roundStartTime = null;
  }
}

// ─── Frequency Scale / Canvas ─────────────────────────────────────────────────
class FrequencyScale {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.freqMin = 20;
    this.freqMax = 20000;
    this.padding = { left: 10, right: 10, top: 20, bottom: 30 };
    this.gridFreqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    this.gridLabels = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k'];
  }

  get width() { return this.canvas.width - this.padding.left - this.padding.right; }
  get height() { return this.canvas.height - this.padding.top - this.padding.bottom; }

  freqToX(freq) {
    const logMin = Math.log10(this.freqMin);
    const logMax = Math.log10(this.freqMax);
    return this.padding.left + (Math.log10(freq) - logMin) / (logMax - logMin) * this.width;
  }

  xToFreq(x) {
    const logMin = Math.log10(this.freqMin);
    const logMax = Math.log10(this.freqMax);
    const normalized = (x - this.padding.left) / this.width;
    return Math.pow(10, logMin + normalized * (logMax - logMin));
  }

  draw(gameState, mouseX) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Grid lines and freq labels
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    this.gridFreqs.forEach((freq, idx) => {
      const x = this.freqToX(freq);
      ctx.beginPath();
      ctx.moveTo(x, this.padding.top);
      ctx.lineTo(x, this.padding.top + this.height);
      ctx.stroke();
      ctx.fillText(this.gridLabels[idx], x, this.padding.top + this.height + 18);
    });

    // Baseline
    ctx.strokeStyle = '#4a4a4a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(this.padding.left, this.padding.top + this.height);
    ctx.lineTo(this.padding.left + this.width, this.padding.top + this.height);
    ctx.stroke();

    // Tolerance zone (revealed)
    if (gameState.phase === 'revealed' && gameState.targetFreq) {
      const tolerance = gameState.getToleranceOctaves();
      const lowerX = this.freqToX(gameState.targetFreq / Math.pow(2, tolerance));
      const upperX = this.freqToX(gameState.targetFreq * Math.pow(2, tolerance));
      ctx.fillStyle = 'rgba(76, 175, 80, 0.15)';
      ctx.fillRect(lowerX, this.padding.top, upperX - lowerX, this.height);
    }

    // Crosshair cursor (guessing)
    if (gameState.phase === 'guessing' && mouseX !== null) {
      ctx.strokeStyle = 'rgba(217, 175, 55, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mouseX, this.padding.top);
      ctx.lineTo(mouseX, this.padding.top + this.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(217, 175, 55, 0.9)';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this.xToFreq(mouseX).toFixed(0) + ' Hz', mouseX, this.padding.top - 8);
    }

    // Target marker — gold diamond (revealed)
    if (gameState.phase === 'revealed' && gameState.targetFreq) {
      const tx = this.freqToX(gameState.targetFreq);
      ctx.fillStyle = '#d4af37';
      ctx.beginPath();
      ctx.moveTo(tx, this.padding.top + this.height + 8);
      ctx.lineTo(tx + 6, this.padding.top + this.height - 2);
      ctx.lineTo(tx, this.padding.top + this.height - 12);
      ctx.lineTo(tx - 6, this.padding.top + this.height - 2);
      ctx.closePath();
      ctx.fill();
    }

    // Guess marker — orange dot (revealed)
    if (gameState.phase === 'revealed' && gameState.guessFreq) {
      const gx = this.freqToX(gameState.guessFreq);
      ctx.fillStyle = '#ff8040';
      ctx.beginPath();
      ctx.arc(gx, this.padding.top + this.height - 8, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ─── Tauri bridge helpers ──────────────────────────────────────────────────────
// The exercise clips are now rendered server-side by the Rust core (paw-core)
// instead of live client-side BiquadFilter DSP — see /root/.claude/plans
// (or docs/) for why: consistent, portable DSP across desktop platforms.
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

// ─── Audio Engine ─────────────────────────────────────────────────────────────
// Dry and processed clips arrive as two pre-rendered WAV files (rendered by
// paw-core::exercise::eq — real RBJ peaking EQ, not a live BiquadFilterNode).
// Both loop in perfect sync; A/B toggling is just muting/unmuting one path,
// same instant-switch feel as the old live-filter version.
class AudioEngine {
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

    // Main audio graph: dry + wet paths → masterGain → analyser → destination
    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.isPlaying = false;
    this.eqEnabled = false;
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

  setEQMode(enabled) {
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
    this.eqEnabled = enabled;
  }

  destroy() {
    this.stop();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.masterGain.disconnect();
    this.analyser.disconnect();
  }
}

// ─── EQ Trainer Module ────────────────────────────────────────────────────────
class EQTrainerModule {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.gameState = new GameState();
    this.audioEngine = null;
    this.freqScale = null;
    this.hsManager = new HighscoreManager();
    this.mouseX = null;
    this.rafId = null;
    this.timerInterval = null;
    this.roundTimer = 0;
    this._keyHandler = null;
    this.freqRangeMin = parseInt(localStorage.getItem('freqRangeMin') || '100');
    this.freqRangeMax = parseInt(localStorage.getItem('freqRangeMax') || '8000');
  }

  init() {
    this.render();
    this.setupEventListeners();
    this.startRenderLoop();
    this.setupKeyboard();
    this.hsManager.renderTo('highscore-list');
    this.updateUI();
  }

  render() {
    this.container.innerHTML = `
      <div class="eq-trainer">
        <div class="game-header">
          <div class="level-display">
            <span class="label">LEVEL</span>
            <span class="value" id="level-display">1</span>
          </div>
          <div class="lives-display" id="lives-display"></div>
          <div class="timer-display" id="timer-display">
            <span class="label">TIME</span>
            <span class="timer-bar-wrap"><span class="timer-bar-fill" id="timer-fill"></span></span>
            <span class="timer-value" id="timer-value">0.0s</span>
          </div>
          <div class="score-display">
            <span class="label">SCORE</span>
            <span class="value" id="score-display">0</span>
          </div>
          <div class="streak-display">
            <span class="label">STREAK</span>
            <span class="value" id="streak-value">0</span>
          </div>
        </div>

        <div class="status-display" id="status-display">
          <p id="status-text">Starte ein neues Training.</p>
          <div id="loading-indicator" style="display:none">
            <span class="loader"></span> Datei wird geladen...
          </div>
        </div>

        <div class="ab-controls">
          <button class="btn-rack btn-rack--ab" id="btn-ab-toggle">A / BYPASS</button>
        </div>

        <div class="canvas-wrapper">
          <canvas id="freq-canvas"></canvas>
        </div>

        <div class="action-panel">
          <button class="btn-rack btn-rack--primary" id="btn-action">START</button>
          <button class="btn-rack btn-rack--secondary" id="btn-restart">RESTART</button>
        </div>

        <div class="freq-range-settings">
          <span class="freq-range-label">FREQ RANGE</span>
          <span class="freq-range-sublabel">VON</span>
          <select id="freq-min-select" class="freq-select">
            <option value="20">20 Hz</option>
            <option value="63">63 Hz</option>
            <option value="100">100 Hz</option>
            <option value="200">200 Hz</option>
            <option value="500">500 Hz</option>
            <option value="1000">1 kHz</option>
            <option value="2000">2 kHz</option>
          </select>
          <span class="freq-range-sublabel">BIS</span>
          <select id="freq-max-select" class="freq-select">
            <option value="500">500 Hz</option>
            <option value="1000">1 kHz</option>
            <option value="2000">2 kHz</option>
            <option value="4000">4 kHz</option>
            <option value="8000">8 kHz</option>
            <option value="12800">12.8 kHz</option>
            <option value="16000">16 kHz</option>
          </select>
        </div>

        <div class="result-panel" id="result-panel" style="display:none">
          <div class="result-header">
            <div class="result-hit" id="result-hit"></div>
            <div class="result-title" id="result-title"></div>
          </div>
          <div class="result-details" id="result-details"></div>
          <div class="result-points" id="result-points"></div>
        </div>
      </div>

      <div class="gameover-overlay" id="gameover-overlay" style="display:none">
        <div class="gameover-card">
          <div class="gameover-title">SESSION ENDED</div>
          <div class="gameover-final-score" id="final-score">0</div>
          <div class="gameover-label">FINAL SCORE</div>
          <div class="gameover-stats" id="final-stats"></div>
          <div class="action-panel">
            <button class="btn-rack btn-rack--primary" id="btn-play-again">NEU STARTEN</button>
            <button class="btn-rack" id="btn-go-close">SCHLIESSEN</button>
          </div>
        </div>
      </div>
    `;

    const canvas = this.container.querySelector('#freq-canvas');
    this.freqScale = new FrequencyScale(canvas);
    this.resizeCanvas();
    new ResizeObserver(() => this.resizeCanvas()).observe(this.container.querySelector('.canvas-wrapper'));
  }

  resizeCanvas() {
    const wrapper = this.container.querySelector('.canvas-wrapper');
    const canvas = this.container.querySelector('#freq-canvas');
    if (wrapper && canvas) {
      canvas.width = wrapper.clientWidth;
      canvas.height = 200;
    }
  }

  setupEventListeners() {
    // Single A/B toggle button
    this.container.querySelector('#btn-ab-toggle').addEventListener('click', () => this.toggleAB());

    // Action button: skip during guessing, next round after result
    this.container.querySelector('#btn-action').addEventListener('click', () => {
      if (this.gameState.phase === 'idle') {
        this.startNewRound();
      } else if (this.gameState.phase === 'guessing') {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.startNewRound();
      } else if (this.gameState.phase === 'revealed') {
        this.nextRound();
      }
    });

    this.container.querySelector('#btn-restart').addEventListener('click', () => this.restartGame());
    this.container.querySelector('#btn-play-again').addEventListener('click', () => this.restartGame());
    this.container.querySelector('#btn-go-close').addEventListener('click', () => {
      this.container.querySelector('#gameover-overlay').style.display = 'none';
      this.gameState.phase = 'idle';
    });

    // Freq range selects — initialise from saved values, persist on change
    const minSelect = this.container.querySelector('#freq-min-select');
    const maxSelect = this.container.querySelector('#freq-max-select');
    minSelect.value = this.freqRangeMin;
    maxSelect.value = this.freqRangeMax;

    minSelect.addEventListener('change', () => {
      const val = parseInt(minSelect.value);
      if (val >= this.freqRangeMax) {
        minSelect.value = this.freqRangeMin;
        showToast('VON-Frequenz muss unter BIS-Frequenz liegen', 'error', 2500);
        return;
      }
      this.freqRangeMin = val;
      localStorage.setItem('freqRangeMin', val);
    });

    maxSelect.addEventListener('change', () => {
      const val = parseInt(maxSelect.value);
      if (val <= this.freqRangeMin) {
        maxSelect.value = this.freqRangeMax;
        showToast('BIS-Frequenz muss über VON-Frequenz liegen', 'error', 2500);
        return;
      }
      this.freqRangeMax = val;
      localStorage.setItem('freqRangeMax', val);
    });

    const canvas = this.container.querySelector('#freq-canvas');
    canvas.addEventListener('click', (e) => {
      if (this.gameState.phase !== 'guessing') return;
      const rect = canvas.getBoundingClientRect();
      this.submitGuess(e.clientX - rect.left);
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
    });

    canvas.addEventListener('mouseleave', () => { this.mouseX = null; });
  }

  setupKeyboard() {
    this._keyHandler = (e) => {
      if (e.code === 'Space') { e.preventDefault(); this.togglePlayback(); }
      if (e.key === 'b' || e.key === 'B') this.toggleAB();
      if (e.key === 'n' || e.key === 'N') this.startNewRound();
      if (e.key === 'r' || e.key === 'R') this.restartGame();
      if (e.key === '1') this.setLevel(1);
      if (e.key === '2') this.setLevel(2);
      if (e.key === '3') this.setLevel(3);
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  async startNewRound() {
    if (this.gameState.phase === 'loading') return;
    this.gameState.phase = 'loading';
    this.updateUI();

    const loadingEl = this.container.querySelector('#loading-indicator');
    if (loadingEl) loadingEl.style.display = 'block';

    try {
      // Rust core picks a random library track, renders dry + EQ'd clips,
      // and keeps the target frequency secret until we call eq_evaluate.
      const exercise = await invokeTauri('eq_random', {
        level: this.gameState.level,
        freqMin: this.freqRangeMin,
        freqMax: this.freqRangeMax,
      });
      this.currentExerciseId = exercise.exerciseId;

      const statusEl = this.container.querySelector('#status-text');
      if (statusEl) statusEl.textContent = 'Lade Audio…';

      if (!this.audioEngine) {
        this.audioEngine = new AudioEngine(this.app.getAudioContext());
      } else {
        this.audioEngine.stop();
      }

      await this.audioEngine.loadDryWet(
        tauriFileUrl(exercise.dryPath),
        tauriFileUrl(exercise.processedPath)
      );

      this.gameState.round++;
      this.gameState.targetFreq = null; // unknown client-side until evaluate
      this.gameState.guessFreq = null;
      this.gameState.lastResult = null;
      this.gameState.roundStartTime = null;

      this.audioEngine.play();
      this.selectBypass();

      if (loadingEl) loadingEl.style.display = 'none';
      this.enterGuessing();

    } catch (err) {
      if (loadingEl) loadingEl.style.display = 'none';
      showToast(`Fehler beim Laden: ${err.message}`, 'error');
      const statusEl = this.container.querySelector('#status-text');
      if (statusEl) statusEl.textContent = 'Fehler. Bitte Sound Library befüllen und erneut versuchen.';
      this.gameState.phase = 'idle';
      this.updateUI();
    }
  }

  enterGuessing() {
    this.gameState.phase = 'guessing';
    this.gameState.roundStartTime = Date.now();
    this.startRoundTimer();
    const statusEl = this.container.querySelector('#status-text');
    if (statusEl) statusEl.textContent = 'Klicke die angehobene Frequenz!';
    this.updateUI();
  }

  startRoundTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.roundTimer = (Date.now() - this.gameState.roundStartTime) / 1000;
      const timerEl = this.container.querySelector('#timer-value');
      const timerFill = this.container.querySelector('#timer-fill');
      if (timerEl) timerEl.textContent = this.roundTimer.toFixed(1) + 's';
      if (timerFill) timerFill.style.width = Math.min(100, (this.roundTimer / 10) * 100) + '%';
    }, 100);
  }

  async submitGuess(x) {
    if (this.timerInterval) clearInterval(this.timerInterval);

    const guessFreq = this.freqScale.xToFreq(x);
    const secondsTaken = (Date.now() - this.gameState.roundStartTime) / 1000;
    this.gameState.guessFreq = guessFreq;
    this.gameState.phase = 'revealed';

    // Scoring is authoritative in the Rust core (paw-core::exercise::eq) —
    // the target frequency was never sent to the client, so this call also
    // reveals it for the first time.
    let evalResult;
    try {
      evalResult = await invokeTauri('eq_evaluate', {
        exerciseId: this.currentExerciseId,
        guessFreq,
        secondsTaken,
      });
    } catch (err) {
      showToast(`Auswertung fehlgeschlagen: ${err}`, 'error');
      this.gameState.phase = 'guessing';
      this.updateUI();
      return;
    }

    this.gameState.targetFreq = evalResult.correctFreq;
    let points = evalResult.points;
    // Preserve the streak-bonus UX from the original client-only version.
    if (evalResult.hit && this.gameState.streak >= 3) {
      points += Math.round(points * 0.1);
    }
    const result = { hit: evalResult.hit, octaveDist: evalResult.octaveDist, points, secondsTaken };
    this.gameState.lastResult = result;

    if (result.hit) {
      this.gameState.streak++;
      this.gameState.score += result.points;
      this.gameState.sessionScore += result.points;
      this.showResult(true, result);
    } else {
      this.gameState.streak = 0;
      this.gameState.lives--;
      this.showResult(false, result);
      if (this.gameState.lives <= 0) {
        this.endGame();
        return;
      }
    }

    this.updateUI();
  }

  showResult(hit, result) {
    const panel = this.container.querySelector('#result-panel');
    const hitEl = this.container.querySelector('#result-hit');
    const titleEl = this.container.querySelector('#result-title');
    const detailsEl = this.container.querySelector('#result-details');
    const pointsEl = this.container.querySelector('#result-points');

    if (hit) {
      hitEl.textContent = '✓';
      hitEl.style.color = '#4caf50';
      titleEl.textContent = 'HIT';
      detailsEl.innerHTML = `
        <span class="detail-label">DEVIATION</span>
        <span class="detail-value">${(result.octaveDist * 12).toFixed(1)} semitones</span>
        <span class="detail-label">TIME</span>
        <span class="detail-value">${result.secondsTaken.toFixed(2)}s</span>
      `;
      pointsEl.textContent = `+${result.points}`;
      pointsEl.style.color = '#4caf50';
      panel.style.borderColor = '#4caf50';
      const statusEl = this.container.querySelector('#status-text');
      if (statusEl) statusEl.textContent = `HIT! +${result.points} points`;
    } else {
      hitEl.textContent = '✗';
      hitEl.style.color = '#ff5252';
      titleEl.textContent = 'MISS';
      detailsEl.innerHTML = `
        <span class="detail-label">DEVIATION</span>
        <span class="detail-value">${(result.octaveDist * 12).toFixed(1)} semitones</span>
        <span class="detail-label">TARGET</span>
        <span class="detail-value">${this.gameState.targetFreq.toFixed(0)} Hz</span>
      `;
      pointsEl.textContent = '0';
      pointsEl.style.color = '#ff5252';
      panel.style.borderColor = '#ff5252';
      const statusEl = this.container.querySelector('#status-text');
      if (statusEl) statusEl.textContent = 'MISS. Life lost.';
    }

    panel.style.display = 'block';
  }

  nextRound() {
    const panel = this.container.querySelector('#result-panel');
    if (panel) panel.style.display = 'none';
    this.startNewRound(); // auto-enters guessing after loading
  }

  endGame() {
    this.gameState.phase = 'gameover';
    if (this.audioEngine) this.audioEngine.stop();
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.hsManager.submit(this.gameState.sessionScore, this.gameState.round, this.gameState.level, this.gameState.streak, 'eq')
      .then(() => this.hsManager.renderTo('highscore-list'));

    const overlay = this.container.querySelector('#gameover-overlay');
    this.container.querySelector('#final-score').textContent = this.gameState.sessionScore;
    this.container.querySelector('#final-stats').innerHTML = `
      <div class="stat-item"><div class="stat-label">ROUNDS</div><div class="stat-value">${this.gameState.round}</div></div>
      <div class="stat-item"><div class="stat-label">LEVEL</div><div class="stat-value">${this.gameState.level}</div></div>
      <div class="stat-item"><div class="stat-label">STREAK</div><div class="stat-value">${this.gameState.streak}</div></div>
    `;
    overlay.style.display = 'flex';
  }

  restartGame() {
    this.gameState.reset();
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.roundTimer = 0;
    const overlay = this.container.querySelector('#gameover-overlay');
    if (overlay) overlay.style.display = 'none';
    const panel = this.container.querySelector('#result-panel');
    if (panel) panel.style.display = 'none';
    this.startNewRound();
  }

  setLevel(lvl) {
    if (this.gameState.phase !== 'idle' && this.gameState.phase !== 'revealed') return;
    if (lvl !== this.gameState.level) {
      this.gameState.level = lvl;
      this.updateUI();
    }
  }

  selectBypass() {
    if (!this.audioEngine) return;
    this.audioEngine.setEQMode(false);
    const btn = this.container.querySelector('#btn-ab-toggle');
    if (btn) { btn.textContent = 'A / BYPASS'; btn.classList.remove('active-eq'); }
  }

  selectEQ() {
    if (!this.audioEngine) return;
    this.audioEngine.setEQMode(true);
    const btn = this.container.querySelector('#btn-ab-toggle');
    if (btn) { btn.textContent = 'B / EQ ON'; btn.classList.add('active-eq'); }
  }

  toggleAB() {
    if (!this.audioEngine) return;
    if (this.audioEngine.eqEnabled) { this.selectBypass(); } else { this.selectEQ(); }
  }

  togglePlayback() {
    if (!this.audioEngine) return;
    this.audioEngine.togglePlayback();
  }

  updateUI() {
    this.container.querySelector('#level-display').textContent = this.gameState.level;
    this.container.querySelector('#score-display').textContent = this.gameState.sessionScore;
    this.container.querySelector('#streak-value').textContent = this.gameState.streak;

    const livesEl = this.container.querySelector('#lives-display');
    livesEl.innerHTML = Array.from({ length: this.gameState.maxLives }, (_, i) =>
      `<div class="life-led${i < this.gameState.lives ? ' active' : ''}"></div>`
    ).join('');

    const actionBtn = this.container.querySelector('#btn-action');
    if (this.gameState.phase === 'idle') {
      actionBtn.textContent = 'START';
      actionBtn.disabled = false;
    } else if (this.gameState.phase === 'loading') {
      actionBtn.textContent = 'LADEN...';
      actionBtn.disabled = true;
    } else if (this.gameState.phase === 'guessing') {
      actionBtn.textContent = 'ÜBERSPRINGEN';
      actionBtn.disabled = false;
    } else if (this.gameState.phase === 'revealed') {
      actionBtn.textContent = 'NEXT ROUND';
      actionBtn.disabled = false;
    } else if (this.gameState.phase === 'gameover') {
      actionBtn.disabled = true;
    }

    // Sync sidebar level buttons
    document.querySelectorAll('.level-item').forEach(item => {
      const isSelected = parseInt(item.dataset.level) === this.gameState.level;
      item.classList.toggle('active', isSelected);
      const led = item.querySelector('.sidebar-led--amber');
      if (led) led.classList.toggle('active', isSelected);
    });
  }

  startRenderLoop() {
    const loop = () => {
      if (this.freqScale && this.container.querySelector('#freq-canvas')) {
        this.freqScale.draw(this.gameState, this.mouseX);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    if (this.audioEngine) {
      this.audioEngine.destroy();
      this.audioEngine = null;
    }
  }
}

registerModule('eq-trainer', EQTrainerModule);
