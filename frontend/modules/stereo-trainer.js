'use strict';

class StereoTrainer {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.level = 1;
    this.score = 0;
    this.round = 0;
    this.streak = 0;
    this.lives = 3;
    this.phase = 'idle';
    this.exercise = null;
    this.audioCtx = null;
    this.player = null;
    this.isPlaying = false;
    this.abMode = 'processed'; // 'processed' | 'original'
    this.roundStartTime = null;
    this.elapsedSeconds = 0;
    this.timerInterval = null;
    this.maxTime = 45;
    this._destroyed = false;
  }

  init() {
    this.render();
    this.bindEvents();
    this.setStatus('Bereit. Drücke START um zu beginnen.');
  }

  setLevel(level) {
    this.level = level;
    const el = this.container.querySelector('#st-level');
    if (el) el.textContent = ['I', 'II', 'III'][level - 1] || level;
  }

  destroy() {
    this._destroyed = true;
    this.stopAudio();
    this.stopTimer();
    if (this.player) { this.player.destroy(); this.player = null; }
    this.container.innerHTML = '';
  }

  render() {
    this.container.innerHTML = `
      <div class="dynamics-trainer">
        <div class="game-header">
          <div class="level-display">
            <span class="label">LEVEL</span>
            <span class="value" id="st-level">I</span>
          </div>
          <div class="score-display">
            <span class="label">SCORE</span>
            <span class="value" id="st-score">0</span>
          </div>
          <div class="lives-display" id="st-lives">
            <span class="life-led active"></span>
            <span class="life-led active"></span>
            <span class="life-led active"></span>
          </div>
          <div class="timer-display">
            <span class="label">TIMER</span>
            <div class="timer-bar-wrap"><div class="timer-bar-fill" id="st-timer-bar"></div></div>
            <span class="timer-value" id="st-timer">0.0s</span>
          </div>
          <div class="streak-display">
            <span class="label">STREAK</span>
            <span class="value" id="st-streak">0x</span>
          </div>
        </div>

        <div class="status-display">
          <span class="loader" id="st-loader" style="display:none"></span>
          <span id="st-status">Bereit…</span>
        </div>

        <div class="ab-controls">
          <button class="btn-rack btn-rack--ab" id="st-play-btn" disabled>▶ PLAY / STOP</button>
          <button class="btn-rack btn-rack--ab" id="st-ab-btn" disabled title="A/B: Original vs. Bearbeitet">B · PROCESSED</button>
        </div>

        <div class="dyn-effect-panel" id="st-answer-section" style="display:none">
          <div class="dyn-panel-label">STEREOBREITE EINSCHÄTZEN</div>
          <div class="dyn-effect-btns" id="st-answer-buttons"></div>
        </div>

        <div class="action-panel">
          <button class="btn-rack btn-rack--primary" id="st-start-btn">▶ START</button>
          <button class="btn-rack btn-rack--secondary" id="st-next-btn" disabled style="display:none">⏭ NÄCHSTE RUNDE</button>
        </div>

        <div class="result-panel" id="st-result" style="display:none">
          <div class="result-correct" id="st-result-correct"></div>
          <div class="result-detail" id="st-result-detail"></div>
          <div class="result-score" id="st-result-score"></div>
        </div>

        <div class="gameover-overlay" id="st-gameover" style="display:none">
          <div class="gameover-card">
            <div class="gameover-title">SESSION BEENDET</div>
            <div class="gameover-final-score" id="st-go-score">0</div>
            <div class="gameover-label">GESAMTPUNKTE</div>
            <div class="gameover-stats">
              <div class="stat-item"><div class="stat-label">Runden</div><div class="stat-value" id="st-go-rounds">0</div></div>
            </div>
            <div class="action-panel">
              <button class="btn-rack btn-rack--primary" id="st-btn-restart">NEU STARTEN</button>
              <button class="btn-rack" id="st-btn-close">SCHLIESSEN</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.container.querySelector('#st-start-btn').addEventListener('click', () => this.startRound());
    this.container.querySelector('#st-play-btn').addEventListener('click', () => this.togglePlay());
    this.container.querySelector('#st-ab-btn').addEventListener('click', () => this.toggleAB());
    this.container.querySelector('#st-next-btn').addEventListener('click', () => this.startRound());
    this.container.querySelector('#st-btn-restart').addEventListener('click', () => {
      this._scoreSubmitted = false;
      this.container.querySelector('#st-gameover').style.display = 'none';
      this.resetGame(); this.startRound();
    });
    this.container.querySelector('#st-btn-close').addEventListener('click', () => {
      this.container.querySelector('#st-gameover').style.display = 'none';
      this.resetGame();
    });
  }

  setStatus(msg) {
    const el = this.container.querySelector('#st-status');
    if (el) el.textContent = msg;
  }

  setLoading(on) {
    const loader = this.container.querySelector('#st-loader');
    if (loader) loader.style.display = on ? 'inline-block' : 'none';
  }

  async startRound() {
    if (this.phase === 'loading') return;
    this.stopAudio();
    this.stopTimer();
    this.phase = 'loading';
    this.setLoading(true);
    this.setStatus('Lade Übung…');
    // START verstecken, NEXT verstecken
    this.container.querySelector('#st-start-btn').style.display = 'none';
    this.container.querySelector('#st-next-btn').style.display = 'none';
    this.container.querySelector('#st-result').style.display = 'none';
    this.container.querySelector('#st-answer-section').style.display = 'none';
    this.container.querySelector('#st-play-btn').disabled = true;
    this.container.querySelector('#st-ab-btn').disabled = true;

    try {
      // Rust core picks a random library track and renders the M/S width
      // clip via paw-core::dsp::stereo_width (1:1 port of the old
      // ms-width-processor.js worklet formula).
      this.exercise = await invokeTauri('stereo_random', { level: this.level });

      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!this.player) this.player = new DryWetPlayer(this.audioCtx);
      else this.player.stop();
      await this.player.loadDryWet(tauriFileUrl(this.exercise.dryPath), tauriFileUrl(this.exercise.processedPath));

      this.phase = 'playing';
      this.abMode = 'processed';
      this.roundStartTime = Date.now();
      this.startTimer();
      this.setLoading(false);
      this.setStatus('Hör dir den Sound an und schätze die Stereobreite ein.');
      this.container.querySelector('#st-play-btn').disabled = false;
      this.container.querySelector('#st-ab-btn').disabled = false;
      this.renderAnswerButtons();
      this.container.querySelector('#st-answer-section').style.display = 'block';
      this.playAudio();
    } catch (err) {
      this.setLoading(false);
      this.setStatus('Fehler: ' + err);
      this.phase = 'idle';
    }
  }

  renderAnswerButtons() {
    const btns = this.container.querySelector('#st-answer-buttons');
    btns.innerHTML = this.exercise.options.map(opt =>
      `<button class="btn-rack answer-btn" data-answer="${opt}">${opt.toUpperCase()}</button>`
    ).join('');
    btns.querySelectorAll('.answer-btn').forEach(btn => {
      btn.addEventListener('click', () => this.submitAnswer(btn.dataset.answer));
    });
  }

  async submitAnswer(answer) {
    if (this.phase !== 'playing') return;
    this.phase = 'result';
    this.stopAudio();
    this.stopTimer();
    const secondsTaken = Math.round((Date.now() - this.roundStartTime) / 1000);

    try {
      const data = await invokeTauri('stereo_evaluate', {
        exerciseId: this.exercise.exerciseId, answer, secondsTaken,
      });

      this.score += data.points || 0;
      this.round += 1;
      if (data.correct) {
        this.streak += 1;
      } else {
        this.streak = 0;
        this.lives = Math.max(0, this.lives - 1);
      }

      this.updateHUD();
      this.showResult(data, answer);
      this.container.querySelector('#st-answer-section').style.display = 'none';
      this.container.querySelector('#st-next-btn').style.display = 'inline-block';
      this.container.querySelector('#st-next-btn').disabled = false;

      if (this.lives === 0) {
        if (this._scoreSubmitted) return;
        this._scoreSubmitted = true;
        this.phase = 'gameover';
        this.setStatus('GAME OVER');
        try { await new HighscoreManager().submit(this.score, this.round, this.level, this.streak, 'stereo'); } catch {}
        // Zeige Gameover-Overlay
        const overlay = this.container.querySelector('#st-gameover');
        if (overlay) {
          this.container.querySelector('#st-go-score').textContent = this.score;
          this.container.querySelector('#st-go-rounds').textContent = this.round;
          overlay.style.display = 'flex';
        }
      }
    } catch (err) {
      this.setStatus('Fehler: ' + err);
      this.phase = 'idle';
    }
  }

  showResult(data, answer) {
    const panel = this.container.querySelector('#st-result');
    const correctEl = this.container.querySelector('#st-result-correct');
    const detailEl = this.container.querySelector('#st-result-detail');
    const scoreEl = this.container.querySelector('#st-result-score');

    correctEl.textContent = data.correct ? '✓ RICHTIG!' : `✗ FALSCH — Richtig: ${data.correctAnswer.toUpperCase()}`;
    correctEl.style.color = data.correct ? '#4caf50' : '#ff5252';
    detailEl.textContent = data.explanation || '';
    scoreEl.textContent = data.points > 0 ? `+${data.points} Punkte` : '0 Punkte';
    panel.style.display = 'block';
  }

  updateHUD() {
    const q = id => this.container.querySelector(id);
    q('#st-score').textContent = this.score.toLocaleString('de-DE');
    q('#st-streak').textContent = this.streak + 'x';
    const leds = this.container.querySelectorAll('#st-lives .life-led');
    leds.forEach((led, i) => led.classList.toggle('active', i < this.lives));
  }

  resetGame() {
    this.score = 0; this.round = 0; this.streak = 0; this.lives = 3;
    this._scoreSubmitted = false;
    this.container.querySelector('#st-start-btn').style.display = 'inline-block';
    this.container.querySelector('#st-next-btn').style.display = 'none';
    this.container.querySelector('#st-answer-section').style.display = 'none';
    this.container.querySelector('#st-result').style.display = 'none';
    this.updateHUD();
  }

  // ─── Audio (DryWetPlayer — see frontend/shared/dry-wet-player.js) ───────────

  playAudio() {
    if (!this.player) return;
    this.player.play();
    this.player.setWetMode(this.abMode === 'processed');
    this.isPlaying = true;
    this.container.querySelector('#st-play-btn').textContent = '■ STOP';
  }

  stopAudio() {
    if (this.player) this.player.stop();
    this.isPlaying = false;
    const btn = this.container.querySelector('#st-play-btn');
    if (btn) btn.textContent = '▶ PLAY';
  }

  togglePlay() {
    if (this.isPlaying) this.stopAudio();
    else this.playAudio();
  }

  toggleAB() {
    this.abMode = this.abMode === 'processed' ? 'original' : 'processed';
    const btn = this.container.querySelector('#st-ab-btn');
    if (btn) btn.textContent = `A/B: ${this.abMode === 'processed' ? 'PROCESSED' : 'ORIGINAL'}`;
    if (this.player) this.player.setWetMode(this.abMode === 'processed');
  }

    // ─── Timer ──────────────────────────────────────────────────────────────────

  startTimer() {
    this.elapsedSeconds = 0;
    this.timerInterval = setInterval(() => {
      if (this._destroyed) return;
      this.elapsedSeconds += 0.1;
      const pct = Math.min(100, (this.elapsedSeconds / this.maxTime) * 100);
      const bar = this.container.querySelector('#st-timer-bar');
      const val = this.container.querySelector('#st-timer');
      if (bar) bar.style.width = pct + '%';
      if (val) val.textContent = this.elapsedSeconds.toFixed(1) + 's';
      if (this.elapsedSeconds >= this.maxTime && this.phase === 'playing') {
        this.submitAnswer('__timeout__');
      }
    }, 100);
  }

  stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  }
}

registerModule('stereo-trainer', StereoTrainer);
