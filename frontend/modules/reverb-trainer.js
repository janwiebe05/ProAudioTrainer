'use strict';

class ReverbTrainer {
  constructor(app, container) {
    this.app       = app;
    this.container = container;
    this.level     = 1;
    this.score     = 0;
    this.round     = 0;
    this.streak    = 0;
    this.lives     = 3;
    this.phase     = 'idle';
    this.exercise  = null;
    this.player    = null;
    this.isPlaying = false;
    this.abMode    = 'processed';
    this.elapsedSeconds = 0;
    this.timerInterval  = null;
    this.maxTime   = 45;
  }

  init() {
    this.render();
    this.bindEvents();
    this._uninstallShortcuts = installTrainerShortcuts(this.container, { play: '#rev-btn-play', ab: '#rev-btn-ab', primary: ['#rev-btn-start', '#rev-btn-submit', '#rev-btn-next'], skip: ['#rev-btn-skip'], answers: '.dyn-effect-btn' });
    this.setStatus('Bereit. Drücke START um zu beginnen.');
  }
  setLevel(l) {
    this.level = l;
    const el = this.container.querySelector('#rev-level');
    if (el) el.textContent = ['I','II','III'][l-1] || l;
  }
  destroy() { this._destroyed = true; if (this._uninstallShortcuts) this._uninstallShortcuts(); this.stopAudio(); this.stopTimer(); if (this.player) { this.player.destroy(); this.player = null; } this.container.innerHTML = ''; }

  // ─── Render ──────────────────────────────────────────────────────────────────

  render() {
    this.container.innerHTML = `
      <div class="dynamics-trainer">
        <div class="game-header">
          <div class="level-display"><span class="label">LEVEL</span><span class="value" id="rev-level">I</span></div>
          <div class="score-display"><span class="label">SCORE</span><span class="value" id="rev-score">0</span></div>
          <div class="lives-display" id="rev-lives">
            <span class="life-led active"></span><span class="life-led active"></span><span class="life-led active"></span>
          </div>
          <div class="timer-display">
            <span class="label">TIMER</span>
            <div class="timer-bar-wrap"><div class="timer-bar-fill" id="rev-timer-bar"></div></div>
            <span class="timer-value" id="rev-timer">0.0s</span>
          </div>
          <div class="streak-display"><span class="label">STREAK</span><span class="value" id="rev-streak">0x</span></div>
        </div>

        <div class="status-display">
          <span class="loader" id="rev-loader" style="display:none"></span>
          <span id="rev-status">Lade Übung…</span>
        </div>

        <div class="ab-controls">
          <button class="btn-rack btn-rack--ab" id="rev-btn-play" disabled>▶ PLAY / STOP</button>
          <button class="btn-rack btn-rack--ab active-eq" id="rev-btn-ab" disabled>B · REVERB</button>
        </div>

        <div class="dyn-effect-panel">
          <div class="dyn-panel-label">RAUMTYP IDENTIFIZIEREN</div>
          <div class="dyn-effect-btns" id="rev-category-btns"></div>
        </div>

        <div class="action-panel">
          <button class="btn-rack btn-rack--primary" id="rev-btn-start">START</button>
          <button class="btn-rack btn-rack--primary" id="rev-btn-submit" disabled style="display:none">ANTWORT PRÜFEN</button>
          <button class="btn-rack btn-rack--secondary" id="rev-btn-skip" disabled>ÜBERSPRINGEN</button>
        </div>

        <div class="result-panel" id="rev-result" style="display:none">
          <div class="result-header">
            <span class="result-hit" id="rev-result-icon"></span>
            <span class="result-title" id="rev-result-title"></span>
            <span class="result-points" id="rev-result-points"></span>
          </div>
          <div class="dyn-result-grid" id="rev-result-details"></div>
          <div class="action-panel" style="margin-top:8px">
            <button class="btn-rack btn-rack--primary" id="rev-btn-next">NÄCHSTE RUNDE</button>
          </div>
        </div>

        <div class="gameover-overlay" id="rev-gameover" style="display:none">
          <div class="gameover-card">
            <div class="gameover-title">SESSION BEENDET</div>
            <div class="gameover-final-score" id="rev-final-score">0</div>
            <div class="gameover-label">GESAMTPUNKTE</div>
            <div class="gameover-stats">
              <div class="stat-item"><div class="stat-label">Runden</div><div class="stat-value" id="rev-stat-rounds">0</div></div>
              <div class="stat-item"><div class="stat-label">Streak</div><div class="stat-value" id="rev-stat-streak">0</div></div>
              <div class="stat-item"><div class="stat-label">Level</div><div class="stat-value" id="rev-stat-level">I</div></div>
            </div>
            <div class="action-panel">
              <button class="btn-rack btn-rack--primary" id="rev-btn-restart">NEU STARTEN</button>
              <button class="btn-rack" id="rev-btn-close">SCHLIESSEN</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  bindEvents() {
    const $ = id => this.container.querySelector(id);
    $('#rev-btn-start').addEventListener('click',   () => this.loadExercise());
    $('#rev-btn-play').addEventListener('click',   () => this.togglePlay());
    $('#rev-btn-ab').addEventListener('click',     () => this.toggleABMode());
    $('#rev-btn-submit').addEventListener('click', () => this.submitAnswer());
    $('#rev-btn-skip').addEventListener('click',   () => this.skipRound());
    $('#rev-btn-next').addEventListener('click',   () => this.nextRound());
    $('#rev-btn-restart').addEventListener('click',() => this.restart());
    $('#rev-btn-close').addEventListener('click', () => {
      this.container.querySelector('#rev-gameover').style.display = 'none';
      this.restart(); this.phase = 'idle';
    });
  }

  renderCategoryButtons(categories) {
    const wrap = this.container.querySelector('#rev-category-btns');
    wrap.innerHTML = categories.map(c =>
      `<button class="dyn-effect-btn" data-cat="${c.id}">${c.label}</button>`
    ).join('');
    // pre-select first
    wrap.querySelector('.dyn-effect-btn')?.classList.add('active');
    wrap.querySelectorAll('.dyn-effect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        wrap.querySelectorAll('.dyn-effect-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  // ─── Exercise loading ─────────────────────────────────────────────────────────

  async loadExercise() {
    // See dynamics-trainer.js's loadExercise() for why this guard and the
    // phase/setControlsEnabled ordering below matter — same shared pattern,
    // same bug (a second START click mid-load could race the first).
    if (this.phase === 'loading') return;
    this.stopAudio();
    this.stopTimer();
    this.hideResult();
    this.phase = 'loading';
    this.setControlsEnabled(false);
    this.elapsedSeconds = 0;
    this.setStatus('Lade Übung…', true);

    try {
      // Rust core picks a random library track AND a random EchoThief IR,
      // convolves them via paw-core::dsp::reverb (real FFT convolution —
      // this replaces the legacy FFmpeg `aconvolve` filter, which never
      // actually existed in FFmpeg and made the reverb trainer unusable).
      const exercise = await invokeTauri('reverb_random', { level: this.level });
      this.exercise = exercise;
      this.renderCategoryButtons(exercise.availableCategories);

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
      this.setControlsEnabled(true);
      this.setStatus('Identifiziere den Raumtyp!');
      this.phase = 'playing';
    } catch (err) {
      this.setStatus(`Fehler: ${err}`);
      console.error('[ReverbTrainer]', err);
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
    const btn = this.container.querySelector('#rev-btn-play');
    if (btn) btn.textContent = this.isPlaying ? '■ STOP' : '▶ PLAY / STOP';
  }

  toggleABMode() { this.setABMode(this.abMode === 'processed' ? 'bypass' : 'processed'); }

  setABMode(mode) {
    this.abMode = mode;
    if (this.player) this.player.setWetMode(mode === 'processed');
    const btn = this.container.querySelector('#rev-btn-ab');
    if (btn) {
      btn.textContent = mode === 'bypass' ? 'A · TROCKEN' : 'B · REVERB';
      btn.classList.toggle('active-bypass', mode === 'bypass');
      btn.classList.toggle('active-eq',     mode === 'processed');
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────────────  // ─── Timer ────────────────────────────────────────────────────────────────────

  startTimer() {
    this.stopTimer();
    this.roundStartTime = Date.now();
    const timerEl  = this.container.querySelector('#rev-timer');
    const timerBar = this.container.querySelector('#rev-timer-bar');
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds = (Date.now() - this.roundStartTime) / 1000;
      if (timerEl)  timerEl.textContent = `${this.elapsedSeconds.toFixed(1)}s`;
      if (timerBar) timerBar.style.width = `${Math.min(100, (this.elapsedSeconds / this.maxTime) * 100)}%`;
    }, 100);
  }

  stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  }

  // ─── Answer ───────────────────────────────────────────────────────────────────

  async submitAnswer() {
    if (this.phase !== 'playing' || !this.exercise) return;
    this.phase = 'result';
    this.stopTimer();
    this.setControlsEnabled(false);

    const guessCategory = this.container.querySelector('.dyn-effect-btn.active')?.dataset.cat;
    try {
      const result = await invokeTauri('reverb_evaluate', {
        exerciseId: this.exercise.exerciseId,
        guessCategory,
        secondsTaken: this.elapsedSeconds,
      });
      // feedback text built here — reverb_evaluate only returns the
      // structured fields (correct/score/categoryLabel), same info the
      // legacy JS route formatted into a string server-side.
      result.feedback = result.correct ? `Richtig: ${result.categoryLabel}` : `Falsch. Es war: ${result.categoryLabel}`;
      this.applyResult(result);
    } catch (err) {
      this.setStatus(`Fehler: ${err}`);
      this.phase = 'playing';
      this.setControlsEnabled(true);
    }
  }

  applyResult(data) {
    const { score, correct, categoryLabel, feedback } = data;
    this.round++;
    this.score += score;
    if (correct) { this.streak++; } else { this.streak = 0; if (!AppSettings.practiceMode) this.lives--; }
    this.updateHUD();

    const resultEl = this.container.querySelector('#rev-result');
    resultEl.style.display = 'flex';
    this.container.querySelector('#rev-result-icon').textContent  = correct ? '✓' : '✗';
    this.container.querySelector('#rev-result-icon').style.color  = correct ? 'var(--led-green)' : 'var(--led-red)';
    this.container.querySelector('#rev-result-title').textContent = correct
      ? `TREFFER · ${categoryLabel}` : `FALSCH · Richtig: ${categoryLabel}`;
    this.container.querySelector('#rev-result-title').style.color = correct ? 'var(--led-green)' : 'var(--led-red)';
    this.container.querySelector('#rev-result-points').textContent = `+${score}`;
    this.container.querySelector('#rev-result-details').innerHTML = `
      <div class="dyn-result-item ${correct ? 'dyn-result-item--ok' : ''}">
        <span class="detail-label">RAUM</span>
        <span class="detail-value">${feedback}</span>
      </div>`;

    if (this.lives <= 0) setTimeout(() => this.showGameOver(), 1600);
  }

  nextRound()  { if (this.lives <= 0) { this.showGameOver(); return; } this.loadExercise(); }

  skipRound() {
    if (!AppSettings.practiceMode) this.lives--; this.streak = 0; this.updateHUD();
    if (this.lives <= 0) { this.stopAudio(); this.stopTimer(); this.showGameOver(); }
    else this.loadExercise();
  }

  async showGameOver() {
    if (this._scoreSubmitted) return;
    this._scoreSubmitted = true;
    this.stopAudio(); this.stopTimer(); this.phase = 'gameover';
    try { await new HighscoreManager().submit(this.score, this.round, this.level, this.streak, 'reverb'); } catch {}
    const overlay = this.container.querySelector('#rev-gameover');
    overlay.style.display = 'flex';
    this.container.querySelector('#rev-final-score').textContent  = this.score;
    this.container.querySelector('#rev-stat-rounds').textContent  = this.round;
    this.container.querySelector('#rev-stat-streak').textContent  = this.streak;
    this.container.querySelector('#rev-stat-level').textContent   = ['I','II','III'][this.level-1] || this.level;
  }

  restart() {
    this._scoreSubmitted = false;
    this._destroyed = false;
    const overlay = this.container.querySelector('#rev-gameover');
    if (overlay) overlay.style.display = 'none';
    this.score = this.round = this.streak = 0;
    this.lives = 3; this.phase = 'idle';
    this.updateHUD(); this.loadExercise();
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────────

  setStatus(text, loading = false) {
    const s = this.container.querySelector('#rev-status');
    const l = this.container.querySelector('#rev-loader');
    if (s) s.textContent = text;
    if (l) l.style.display = loading ? 'inline-block' : 'none';
  }

  setControlsEnabled(on) {
    ['#rev-btn-play','#rev-btn-ab','#rev-btn-skip'].forEach(id => {
      const el = this.container.querySelector(id);
      if (el) el.disabled = !on;
    });
    const startBtn  = this.container.querySelector('#rev-btn-start');
    const submitBtn = this.container.querySelector('#rev-btn-submit');
    if (startBtn)  startBtn.style.display  = this.phase === 'idle' ? '' : 'none';
    if (submitBtn) { submitBtn.style.display = this.phase === 'idle' ? 'none' : ''; submitBtn.disabled = !on; }
  }

  hideResult() {
    const el = this.container.querySelector('#rev-result');
    if (el) el.style.display = 'none';
  }

  updateHUD() {
    const $ = id => this.container.querySelector(id);
    if ($('#rev-score'))  $('#rev-score').textContent  = this.score;
    if ($('#rev-streak')) $('#rev-streak').textContent = `${this.streak}x`;
    const livesEl = $('#rev-lives');
    if (livesEl) livesEl.querySelectorAll('.life-led').forEach((led, i) => led.classList.toggle('active', i < this.lives));
  }
}

registerModule('reverb-trainer', ReverbTrainer);
