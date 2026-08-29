'use strict';

class TransientTrainer {
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
    this.abMode = 'processed';
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
    const el = this.container.querySelector('#tr-level');
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
            <span class="value" id="tr-level">I</span>
          </div>
          <div class="score-display">
            <span class="label">SCORE</span>
            <span class="value" id="tr-score">0</span>
          </div>
          <div class="lives-display" id="tr-lives">
            <span class="life-led active"></span>
            <span class="life-led active"></span>
            <span class="life-led active"></span>
          </div>
          <div class="timer-display">
            <span class="label">TIMER</span>
            <div class="timer-bar-wrap"><div class="timer-bar-fill" id="tr-timer-bar"></div></div>
            <span class="timer-value" id="tr-timer">0.0s</span>
          </div>
          <div class="streak-display">
            <span class="label">STREAK</span>
            <span class="value" id="tr-streak">0x</span>
          </div>
        </div>

        <div class="status-display">
          <span class="loader" id="tr-loader" style="display:none"></span>
          <span id="tr-status">Bereit…</span>
        </div>

        <div style="background:#0a0a14;border:1px solid #1a1a3e;border-radius:4px;padding:10px 14px;margin-bottom:12px;font-family:var(--font-mono);font-size:11px;color:var(--text-dim);line-height:1.6;">
          <strong style="color:#d4af37;">TRANSIENT-TRAINER</strong> — Hör dir den komprimierten Sound an und schätze ein,
          wie stark der Kompressor die Transienten (Konsonanten, Anschläge) dämpft.
          Nutze A/B um Original vs. Komprimiert zu vergleichen.
        </div>

        <div class="ab-controls">
          <button class="btn-rack btn-rack--ab" id="tr-play-btn" disabled>▶ PLAY / STOP</button>
          <button class="btn-rack btn-rack--ab" id="tr-ab-btn" disabled>B · KOMPRIMIERT</button>
        </div>

        <div class="dyn-effect-panel" id="tr-answer-section" style="display:none">
          <div class="dyn-panel-label">TRANSIENT-DÄMPFUNG EINSCHÄTZEN</div>
          <div class="dyn-effect-btns" id="tr-answer-buttons"></div>
        </div>

        <div class="action-panel">
          <button class="btn-rack btn-rack--primary" id="tr-start-btn">▶ START</button>
          <button class="btn-rack btn-rack--secondary" id="tr-next-btn" disabled style="display:none">⏭ NÄCHSTE RUNDE</button>
        </div>

        <div class="result-panel" id="tr-result" style="display:none">
          <div class="result-correct" id="tr-result-correct"></div>
          <div class="result-detail" id="tr-result-detail" style="margin-top:6px;font-size:12px;color:var(--text-dim);font-family:var(--font-mono);"></div>
          <div class="result-score" id="tr-result-score"></div>
        </div>

        <div class="gameover-overlay" id="tr-gameover" style="display:none">
          <div class="gameover-card">
            <div class="gameover-title">SESSION BEENDET</div>
            <div class="gameover-final-score" id="tr-go-score">0</div>
            <div class="gameover-label">GESAMTPUNKTE</div>
            <div class="gameover-stats">
              <div class="stat-item"><div class="stat-label">Runden</div><div class="stat-value" id="tr-go-rounds">0</div></div>
            </div>
            <div class="action-panel">
              <button class="btn-rack btn-rack--primary" id="tr-btn-restart">NEU STARTEN</button>
              <button class="btn-rack" id="tr-btn-close">SCHLIESSEN</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.container.querySelector('#tr-start-btn').addEventListener('click', () => this.startRound());
    this.container.querySelector('#tr-play-btn').addEventListener('click', () => this.togglePlay());
    this.container.querySelector('#tr-ab-btn').addEventListener('click', () => this.toggleAB());
    this.container.querySelector('#tr-next-btn').addEventListener('click', () => this.startRound());
    this.container.querySelector('#tr-btn-restart').addEventListener('click', () => {
      this._scoreSubmitted = false;
      this.container.querySelector('#tr-gameover').style.display = 'none';
      this.resetGame(); this.startRound();
    });
    this.container.querySelector('#tr-btn-close').addEventListener('click', () => {
      this.container.querySelector('#tr-gameover').style.display = 'none';
      this.resetGame();
    });
  }

  setStatus(msg) {
    const el = this.container.querySelector('#tr-status');
    if (el) el.textContent = msg;
  }

  setLoading(on) {
    const loader = this.container.querySelector('#tr-loader');
    if (loader) loader.style.display = on ? 'inline-block' : 'none';
  }

  async startRound() {
    if (this.phase === 'loading') return;
    this.stopAudio();
    this.stopTimer();
    this.phase = 'loading';
    this.setLoading(true);
    this.setStatus('Lade Übung…');
    this.container.querySelector('#tr-start-btn').style.display = 'none';
    this.container.querySelector('#tr-next-btn').style.display = 'none';
    this.container.querySelector('#tr-result').style.display = 'none';
    this.container.querySelector('#tr-answer-section').style.display = 'none';
    this.container.querySelector('#tr-play-btn').disabled = true;
    this.container.querySelector('#tr-ab-btn').disabled = true;

    try {
      // Rust core picks a random library track and renders the transient
      // exercise via paw-core::dsp::dynamics (compressor with the preset's
      // attack time — see paw_core::exercise::transient).
      this.exercise = await invokeTauri('transient_random', { level: this.level });

      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!this.player) this.player = new DryWetPlayer(this.audioCtx);
      else this.player.stop();
      await this.player.loadDryWet(tauriFileUrl(this.exercise.dryPath), tauriFileUrl(this.exercise.processedPath));

      this.phase = 'playing';
      this.abMode = 'processed';
      this.roundStartTime = Date.now();
      this.startTimer();
      this.setLoading(false);
      this.setStatus('Hör dir den Sound an. Wie stark sind die Transienten gedämpft?');
      this.container.querySelector('#tr-play-btn').disabled = false;
      this.container.querySelector('#tr-ab-btn').disabled = false;
      this.renderAnswerButtons();
      this.container.querySelector('#tr-answer-section').style.display = 'block';
      this.playAudio();
    } catch (err) {
      this.setLoading(false);
      this.setStatus('Fehler: ' + err);
      this.phase = 'idle';
    }
  }

  renderAnswerButtons() {
    const btns = this.container.querySelector('#tr-answer-buttons');
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
      const data = await invokeTauri('transient_evaluate', {
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
      this.container.querySelector('#tr-answer-section').style.display = 'none';
      this.container.querySelector('#tr-next-btn').style.display = 'inline-block';
      this.container.querySelector('#tr-next-btn').disabled = false;

      if (this.lives === 0) {
        if (this._scoreSubmitted) return;
        this._scoreSubmitted = true;
        this.phase = 'gameover';
        this.setStatus('GAME OVER');
        try { await new HighscoreManager().submit(this.score, this.round, this.level, this.streak, 'transient'); } catch {}
        const overlay = this.container.querySelector('#tr-gameover');
        if (overlay) {
          this.container.querySelector('#tr-go-score').textContent = this.score;
          this.container.querySelector('#tr-go-rounds').textContent = this.round;
          overlay.style.display = 'flex';
        }
      }
    } catch (err) {
      this.setStatus('Fehler: ' + err);
      this.phase = 'idle';
    }
  }

  showResult(data, answer) {
    const panel = this.container.querySelector('#tr-result');
    const correctEl = this.container.querySelector('#tr-result-correct');
    const detailEl = this.container.querySelector('#tr-result-detail');
    const scoreEl = this.container.querySelector('#tr-result-score');

    correctEl.textContent = data.correct ? '✓ RICHTIG!' : `✗ FALSCH — Richtig: ${data.correctAnswer.toUpperCase()}`;
    correctEl.style.color = data.correct ? '#4caf50' : '#ff5252';

    // preset values come from the exercise itself (transient_random already
    // reveals them, same as the legacy JS route did), not from the eval result.
    const ex = this.exercise || {};
    detailEl.innerHTML = `
      ${data.explanation || ''}<br>
      <span style="color:#a0c4ff">Attack: ${ex.attackMs}ms · Ratio: ${ex.ratio}:1 · Threshold: ${ex.thresholdDb}dB</span>
    `;
    scoreEl.textContent = data.points > 0 ? `+${data.points} Punkte` : '0 Punkte';
    panel.style.display = 'block';
  }

  updateHUD() {
    const q = id => this.container.querySelector(id);
    q('#tr-score').textContent = this.score.toLocaleString('de-DE');
    q('#tr-streak').textContent = this.streak + 'x';
    const leds = this.container.querySelectorAll('#tr-lives .life-led');
    leds.forEach((led, i) => led.classList.toggle('active', i < this.lives));
  }

  resetGame() {
    this.score = 0; this.round = 0; this.streak = 0; this.lives = 3;
    this._scoreSubmitted = false;
    this.container.querySelector('#tr-start-btn').style.display = 'inline-block';
    this.container.querySelector('#tr-next-btn').style.display = 'none';
    this.container.querySelector('#tr-answer-section').style.display = 'none';
    this.container.querySelector('#tr-result').style.display = 'none';
    this.updateHUD();
  }

  // ─── Audio (DryWetPlayer — see frontend/shared/dry-wet-player.js) ───────────

  playAudio() {
    if (!this.player) return;
    this.player.play();
    this.player.setWetMode(this.abMode === 'processed');
    this.isPlaying = true;
    this.container.querySelector('#tr-play-btn').textContent = '■ STOP';
  }

  stopAudio() {
    if (this.player) this.player.stop();
    this.isPlaying = false;
    const btn = this.container.querySelector('#tr-play-btn');
    if (btn) btn.textContent = '▶ PLAY';
  }

  togglePlay() {
    if (this.isPlaying) this.stopAudio();
    else this.playAudio();
  }

  toggleAB() {
    this.abMode = this.abMode === 'processed' ? 'original' : 'processed';
    const btn = this.container.querySelector('#tr-ab-btn');
    if (btn) btn.textContent = `A/B: ${this.abMode === 'processed' ? 'KOMPRIMIERT' : 'ORIGINAL'}`;
    if (this.player) this.player.setWetMode(this.abMode === 'processed');
  }

  // ─── Timer ──────────────────────────────────────────────────────────────────

  startTimer() {
    this.elapsedSeconds = 0;
    this.timerInterval = setInterval(() => {
      if (this._destroyed) return;
      this.elapsedSeconds += 0.1;
      const pct = Math.min(100, (this.elapsedSeconds / this.maxTime) * 100);
      const bar = this.container.querySelector('#tr-timer-bar');
      const val = this.container.querySelector('#tr-timer');
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

registerModule('transient-trainer', TransientTrainer);
