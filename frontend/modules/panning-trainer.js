'use strict';

class PanningTrainer {
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
    this._destroyed = false;
  }

  init() {
    this.render();
    this.bindEvents();
    this._uninstallShortcuts = installTrainerShortcuts(this.container, { play: '#pan-btn-play', ab: '#pan-btn-ab', primary: ['#pan-btn-start', '#pan-btn-submit', '#pan-btn-next'], skip: ['#pan-btn-skip'], answers: '.dyn-effect-btn' });
    this.setStatus('Bereit. Drücke START um zu beginnen.');
  }
  setLevel(l) { this.level = l; const el = this.container.querySelector('#pan-level'); if (el) el.textContent = ['I','II','III'][l-1] || l; }
  destroy()   { this._destroyed = true; if (this._uninstallShortcuts) this._uninstallShortcuts(); this.stopAudio(); this.stopTimer(); if (this.player) { this.player.destroy(); this.player = null; } this.container.innerHTML = ''; }

  // ─── Render ──────────────────────────────────────────────────────────────────

  render() {
    this.container.innerHTML = `
      <div class="dynamics-trainer">
        <div class="game-header">
          <div class="level-display"><span class="label">LEVEL</span><span class="value" id="pan-level">I</span></div>
          <div class="score-display"><span class="label">SCORE</span><span class="value" id="pan-score">0</span></div>
          <div class="lives-display" id="pan-lives">
            <span class="life-led active"></span><span class="life-led active"></span><span class="life-led active"></span>
          </div>
          <div class="timer-display">
            <span class="label">TIMER</span>
            <div class="timer-bar-wrap"><div class="timer-bar-fill" id="pan-timer-bar"></div></div>
            <span class="timer-value" id="pan-timer">0.0s</span>
          </div>
          <div class="streak-display"><span class="label">STREAK</span><span class="value" id="pan-streak">0x</span></div>
        </div>

        <div class="status-display">
          <span class="loader" id="pan-loader" style="display:none"></span>
          <span id="pan-status">Bereit.</span>
        </div>

        <div class="ab-controls">
          <button class="btn-rack btn-rack--ab" id="pan-btn-play" disabled>▶ PLAY / STOP</button>
          <button class="btn-rack btn-rack--ab active-eq" id="pan-btn-ab" disabled>B · PROCESSED</button>
        </div>

        <!-- Level I: 7 zone buttons -->
        <div class="dyn-effect-panel" id="pan-zone-panel" style="display:none">
          <div class="dyn-panel-label">STEREOPOSITION IDENTIFIZIEREN</div>
          <div class="dyn-effect-btns" id="pan-zone-btns"></div>
        </div>

        <!-- Level II: pan slider -->
        <div class="dyn-effect-panel" id="pan-value-panel" style="display:none">
          <div class="dyn-panel-label">PAN-WERT SCHÄTZEN</div>
          <div class="dyn-param-row">
            <label class="dyn-param-label">L ←→ R</label>
            <input type="range" class="dyn-slider" id="pan-slider" min="-100" max="100" step="1" value="0">
            <span class="dyn-param-value" id="pan-slider-val">CENTER</span>
          </div>
          <div id="pan-stereo-display" style="margin-top:8px;text-align:center;font-family:monospace;font-size:13px;color:#888">
            <span id="pan-stereo-bar"></span>
          </div>
        </div>

        <!-- Level III: width buttons -->
        <div class="dyn-effect-panel" id="pan-width-panel" style="display:none">
          <div class="dyn-panel-label">STEREOBREITE SCHÄTZEN</div>
          <div class="dyn-effect-btns" id="pan-width-btns"></div>
        </div>

        <div class="action-panel">
          <button class="btn-rack btn-rack--primary" id="pan-btn-start">START</button>
          <button class="btn-rack btn-rack--primary" id="pan-btn-submit" disabled style="display:none">ANTWORT PRÜFEN</button>
          <button class="btn-rack btn-rack--secondary" id="pan-btn-skip" disabled>ÜBERSPRINGEN</button>
        </div>

        <div class="result-panel" id="pan-result" style="display:none">
          <div class="result-header">
            <span class="result-hit" id="pan-result-icon"></span>
            <span class="result-title" id="pan-result-title"></span>
            <span class="result-points" id="pan-result-points"></span>
          </div>
          <div class="dyn-result-grid" id="pan-result-details"></div>
          <div class="action-panel" style="margin-top:8px">
            <button class="btn-rack btn-rack--primary" id="pan-btn-next">NÄCHSTE RUNDE</button>
          </div>
        </div>

        <div class="gameover-overlay" id="pan-gameover" style="display:none">
          <div class="gameover-card">
            <div class="gameover-title">SESSION BEENDET</div>
            <div class="gameover-final-score" id="pan-final-score">0</div>
            <div class="gameover-label">GESAMTPUNKTE</div>
            <div class="gameover-stats">
              <div class="stat-item"><div class="stat-label">Runden</div><div class="stat-value" id="pan-stat-rounds">0</div></div>
              <div class="stat-item"><div class="stat-label">Streak</div><div class="stat-value" id="pan-stat-streak">0</div></div>
              <div class="stat-item"><div class="stat-label">Level</div><div class="stat-value" id="pan-stat-level">I</div></div>
            </div>
            <div class="action-panel">
              <button class="btn-rack btn-rack--primary" id="pan-btn-restart">NEU STARTEN</button>
              <button class="btn-rack" id="pan-btn-close">SCHLIESSEN</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  bindEvents() {
    const $ = id => this.container.querySelector(id);
    $('#pan-btn-start').addEventListener('click',   () => this.loadExercise());
    $('#pan-btn-play').addEventListener('click',    () => this.togglePlay());
    $('#pan-btn-ab').addEventListener('click',      () => this.toggleABMode());
    $('#pan-btn-submit').addEventListener('click',  () => this.submitAnswer());
    $('#pan-btn-skip').addEventListener('click',    () => this.skipRound());
    $('#pan-btn-next').addEventListener('click',    () => this.nextRound());
    $('#pan-btn-restart').addEventListener('click', () => this.restart());
    $('#pan-btn-close').addEventListener('click', () => {
      this.container.querySelector('#pan-gameover').style.display = 'none';
      this.restart(); this.phase = 'idle';
    });

    const slider = $('#pan-slider');
    const sliderVal = $('#pan-slider-val');
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value);
      sliderVal.textContent = v === 0 ? 'CENTER' : v > 0 ? `R ${v}` : `L ${Math.abs(v)}`;
      this._updateStereoBar(v);
    });
  }

  _updateStereoBar(v) {
    const el = this.container.querySelector('#pan-stereo-bar');
    if (!el) return;
    // Visual: 21-char bar, cursor position
    const pos = Math.round((v + 100) / 200 * 20);
    const bar = Array(21).fill('·');
    bar[10] = '|'; // center mark
    bar[pos] = '▼';
    el.textContent = 'L [' + bar.join('') + '] R';
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
      // Rust core picks a random library track and renders pan/width via
      // paw-core::dsp::pan (real Web-Audio-spec equal-power panning) or
      // paw-core::dsp::stereo_width — no more live StereoPannerNode/worklet.
      const exercise = await invokeTauri('panning_random', { level: this.level });
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
      this.applyGuessMode(exercise.guessMode, exercise);
      this.setControlsEnabled(true);
      this.setStatus({ zone: 'Stereoposition identifizieren!', value: 'Pan-Wert schätzen!', width: 'Stereobreite schätzen!' }[exercise.guessMode]);
      this.phase = 'playing';
    } catch (err) {
      this.setStatus(`Fehler: ${err}`);
      console.error('[PanningTrainer]', err);
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
    const btn = this.container.querySelector('#pan-btn-play');
    if (btn) btn.textContent = this.isPlaying ? '■ STOP' : '▶ PLAY / STOP';
  }

  toggleABMode() { this.setABMode(this.abMode === 'processed' ? 'bypass' : 'processed'); }

  setABMode(mode) {
    this.abMode = mode;
    if (this.player) this.player.setWetMode(mode === 'processed');
    const btn = this.container.querySelector('#pan-btn-ab');
    if (btn) {
      btn.textContent = mode === 'bypass' ? 'A · ORIGINAL' : 'B · PROCESSED';
      btn.classList.toggle('active-bypass', mode === 'bypass');
      btn.classList.toggle('active-eq',     mode === 'processed');
    }
  }

  // ─── Guess mode UI ────────────────────────────────────────────────────────────

  applyGuessMode(mode, exercise) {
    const zonePanel  = this.container.querySelector('#pan-zone-panel');
    const valuePanel = this.container.querySelector('#pan-value-panel');
    const widthPanel = this.container.querySelector('#pan-width-panel');
    zonePanel.style.display  = mode === 'zone'  ? '' : 'none';
    valuePanel.style.display = mode === 'value' ? '' : 'none';
    widthPanel.style.display = mode === 'width' ? '' : 'none';

    if (mode === 'zone') {
      const wrap = this.container.querySelector('#pan-zone-btns');
      wrap.innerHTML = exercise.panZones.map(z =>
        `<button class="dyn-effect-btn" data-zone="${z.id}">${z.label}</button>`
      ).join('');
      wrap.querySelector('.dyn-effect-btn').classList.add('active');
      wrap.querySelectorAll('.dyn-effect-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          wrap.querySelectorAll('.dyn-effect-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    } else if (mode === 'value') {
      const slider = this.container.querySelector('#pan-slider');
      slider.value = 0;
      this.container.querySelector('#pan-slider-val').textContent = 'CENTER';
      this._updateStereoBar(0);
    } else {
      const wrap = this.container.querySelector('#pan-width-btns');
      wrap.innerHTML = exercise.widthSteps.map(s =>
        `<button class="dyn-effect-btn" data-width="${s.id}">${s.label}</button>`
      ).join('');
      // Pre-select 'normal'
      wrap.querySelectorAll('.dyn-effect-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.width === 'normal');
        btn.addEventListener('click', () => {
          wrap.querySelectorAll('.dyn-effect-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────────────

  startTimer() {
    this.stopTimer();
    this.roundStartTime = Date.now();
    const timerEl  = this.container.querySelector('#pan-timer');
    const timerBar = this.container.querySelector('#pan-timer-bar');
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

  // Feedback text is built client-side: panning_random already reveals the
  // correct answer up front (same as the legacy JS route did), so there is
  // no need for panning_evaluate to also return formatted strings.
  buildFeedback(mode, guesses, correct) {
    const ex = this.exercise;
    if (mode === 'zone') {
      const correctZone = ex.panZones.find(z => z.id === ex.zoneId);
      const correctIdx = ex.panZones.findIndex(z => z.id === ex.zoneId);
      const guessIdx   = ex.panZones.findIndex(z => z.id === guesses.guessZone);
      const partial = Math.abs(correctIdx - guessIdx) === 1;
      return correct ? `Richtig: ${correctZone.label}` : `Falsch. Richtig: ${correctZone.label}${partial ? ' (Nachbarzone)' : ''}`;
    }
    if (mode === 'value') {
      const cv = ex.panValue, gv = guesses.guessPan ?? 0;
      const side = v => v > 0 ? 'R' : v < 0 ? 'L' : 'C';
      return `Richtig: ${side(cv)} ${Math.abs(cv)} | Dein Wert: ${side(gv)} ${Math.abs(gv)}`;
    }
    const correctStep = ex.widthSteps.find(s => s.id === ex.widthId);
    const correctIdx  = ex.widthSteps.findIndex(s => s.id === ex.widthId);
    const guessIdx    = ex.widthSteps.findIndex(s => s.id === guesses.guessWidth);
    const partial = Math.abs(correctIdx - guessIdx) === 1;
    return correct ? `Richtig: ${correctStep.label}` : `Falsch. Richtig: ${correctStep.label}${partial ? ' (Nachbarstufe)' : ''}`;
  }

  async submitAnswer() {
    if (this.phase !== 'playing' || !this.exercise) return;
    this.phase = 'result';
    this.stopTimer();
    this.setControlsEnabled(false);

    const mode = this.exercise.guessMode;
    const guesses = { exerciseId: this.exercise.exerciseId, secondsTaken: this.elapsedSeconds };
    if (mode === 'zone')  guesses.guessZone  = this.container.querySelector('.dyn-effect-btn.active[data-zone]')?.dataset.zone;
    if (mode === 'value') guesses.guessPan   = parseInt(this.container.querySelector('#pan-slider').value);
    if (mode === 'width') guesses.guessWidth = this.container.querySelector('.dyn-effect-btn.active[data-width]')?.dataset.width;

    try {
      const evalResult = await invokeTauri('panning_evaluate', guesses);
      this.applyResult({
        score: evalResult.score,
        correct: evalResult.correct,
        feedback: this.buildFeedback(mode, guesses, evalResult.correct),
      });
    } catch (err) {
      this.setStatus(`Fehler: ${err}`);
      this.phase = 'playing';
      this.setControlsEnabled(true);
    }
  }

  applyResult(data) {
    const { score, correct, feedback } = data;
    this.round++;
    this.score += score;
    if (correct) { this.streak++; } else { this.streak = 0; if (!AppSettings.practiceMode) this.lives--; }
    this.updateHUD();

    const resultEl = this.container.querySelector('#pan-result');
    resultEl.style.display = 'flex';
    this.container.querySelector('#pan-result-icon').textContent  = correct ? '✓' : '✗';
    this.container.querySelector('#pan-result-icon').style.color  = correct ? 'var(--led-green)' : 'var(--led-red)';
    this.container.querySelector('#pan-result-title').textContent = feedback;
    this.container.querySelector('#pan-result-title').style.color = correct ? 'var(--led-green)' : 'var(--led-red)';
    this.container.querySelector('#pan-result-points').textContent = `+${score}`;
    this.container.querySelector('#pan-result-details').innerHTML = `
      <div class="dyn-result-item ${correct ? 'dyn-result-item--ok' : ''}">
        <span class="detail-label">PUNKTE</span>
        <span class="detail-value">${score}</span>
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
    try { await new HighscoreManager().submit(this.score, this.round, this.level, this.streak, 'panning'); } catch {}
    const overlay = this.container.querySelector('#pan-gameover');
    overlay.style.display = 'flex';
    this.container.querySelector('#pan-final-score').textContent = this.score;
    this.container.querySelector('#pan-stat-rounds').textContent = this.round;
    this.container.querySelector('#pan-stat-streak').textContent = this.streak;
    this.container.querySelector('#pan-stat-level').textContent  = ['I','II','III'][this.level-1] || this.level;
  }

  restart() {
    this._scoreSubmitted = false;
    this._destroyed = false;
    const overlay = this.container.querySelector('#pan-gameover');
    if (overlay) overlay.style.display = 'none';
    this.score = this.round = this.streak = 0;
    this.lives = 3; this.phase = 'idle';
    this.updateHUD(); this.loadExercise();
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────────

  setStatus(text, loading = false) {
    const s = this.container.querySelector('#pan-status');
    const l = this.container.querySelector('#pan-loader');
    if (s) s.textContent = text;
    if (l) l.style.display = loading ? 'inline-block' : 'none';
  }

  setControlsEnabled(on) {
    ['#pan-btn-play','#pan-btn-ab','#pan-btn-skip'].forEach(id => {
      const el = this.container.querySelector(id);
      if (el) el.disabled = !on;
    });
    const startBtn  = this.container.querySelector('#pan-btn-start');
    const submitBtn = this.container.querySelector('#pan-btn-submit');
    if (startBtn)  startBtn.style.display  = this.phase === 'idle' ? '' : 'none';
    if (submitBtn) { submitBtn.style.display = this.phase === 'idle' ? 'none' : ''; submitBtn.disabled = !on; }
  }

  hideResult() {
    const el = this.container.querySelector('#pan-result');
    if (el) el.style.display = 'none';
  }

  updateHUD() {
    const $ = id => this.container.querySelector(id);
    if ($('#pan-score'))  $('#pan-score').textContent  = this.score;
    if ($('#pan-streak')) $('#pan-streak').textContent = `${this.streak}x`;
    const livesEl = $('#pan-lives');
    if (livesEl) livesEl.querySelectorAll('.life-led').forEach((led, i) => led.classList.toggle('active', i < this.lives));
  }
}

registerModule('panning-trainer', PanningTrainer);
