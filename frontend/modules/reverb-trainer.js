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
    this.audioBuffer = null;
    this.source    = null;
    this.bypassGain    = null;
    this.processedGain = null;
    this.isPlaying = false;
    this.abMode    = 'processed';
    this.elapsedSeconds = 0;
    this.timerInterval  = null;
    this.maxTime   = 45;
    this._irCache  = {};  // cache decoded IR buffers by path
  }

  init()    { this.render(); this.bindEvents(); this.setStatus('Bereit. Drücke START um zu beginnen.'); }
  setLevel(l) {
    this.level = l;
    const el = this.container.querySelector('#rev-level');
    if (el) el.textContent = ['I','II','III'][l-1] || l;
  }
  destroy() { this._destroyed = true; this.stopAudio(); this.stopTimer(); this.container.innerHTML = ''; }

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
    this.stopAudio();
    this.stopTimer();
    this.hideResult();
    this.setControlsEnabled(false);
    this.elapsedSeconds = 0;
    this.phase = 'loading';
    this.setStatus('Lade Übung…', true);

    try {
      const exercise = await apiCall('GET', `/reverb/random?level=${this.level}`);
      this.exercise  = exercise;
      this.renderCategoryButtons(exercise.availableCategories);

      this.setStatus('Lade Audio…', true);
      const token = localStorage.getItem('token');
      const audioRes = await fetch('/api/library/random', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!audioRes.ok) throw new Error('Keine Audiodatei verfügbar');
      const fileInfo = await audioRes.json();

      const [audioAB, irAB] = await Promise.all([
        fetch(`/api/library/${fileInfo.id}/audio`, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => { if (!r.ok) throw new Error('Audio nicht ladbar'); return r.arrayBuffer(); }),
        this._loadIR(exercise.irPath),
      ]);

      const ctx = this.app.getAudioContext();
      this.audioBuffer = await ctx.decodeAudioData(audioAB);
      if (this._destroyed) return;

      await this.buildAudioGraph(irAB);
      this.startPlayback();
      this.startTimer();
      this.setControlsEnabled(true);
      this.setStatus('Identifiziere den Raumtyp!');
      this.phase = 'playing';
    } catch (err) {
      this.setStatus(`Fehler: ${err.message}`);
      console.error('[ReverbTrainer]', err);
    }
  }

  async _loadIR(irPath) {
    if (this._irCache[irPath]) return this._irCache[irPath];
    const res = await fetch(irPath);
    if (!res.ok) throw new Error(`IR nicht ladbar: ${irPath}`);
    const buf = await res.arrayBuffer();
    this._irCache[irPath] = buf;
    return buf;
  }

  // ─── Audio graph ──────────────────────────────────────────────────────────────
  // Signal chain:
  //   source ──┬──► bypassGain ──────────────────────────► destination  (A: dry)
  //            └──► dryGain ──► convolver ──► wetGain ──► destination  (B: wet)
  //
  // ConvolverNode = true convolution reverb (same algorithm as Altiverb/UAD)
  // wetMix from backend controls dry/wet balance

  async buildAudioGraph(irArrayBuffer) {
    const ctx = this.app.getAudioContext();
    const wet = this.exercise.wetMix;

    this.bypassGain    = ctx.createGain();
    this.bypassGain.gain.value = this.abMode === 'bypass' ? 1 : 0;
    this.bypassGain.connect(ctx.destination);

    this.processedGain = ctx.createGain();
    this.processedGain.gain.value = this.abMode === 'processed' ? 1 : 0;
    this.processedGain.connect(ctx.destination);

    // Decode IR
    const irBuffer = await ctx.decodeAudioData(irArrayBuffer.slice(0));
    this._convolver = ctx.createConvolver();
    this._convolver.normalize = true; // normalize IR so loudness is consistent
    this._convolver.buffer    = irBuffer;

    // Wet/dry mix within the processed path
    this._dryGain = ctx.createGain();
    this._dryGain.gain.value = 1 - wet;
    this._wetGain = ctx.createGain();
    this._wetGain.gain.value = wet;

    this._dryGain.connect(this.processedGain);
    this._convolver.connect(this._wetGain);
    this._wetGain.connect(this.processedGain);
    // _effectInput = dry path; source also connects directly to _convolver in startPlayback
  }

  startPlayback() {
    const ctx = this.app.getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    this.source = ctx.createBufferSource();
    this.source.buffer = this.audioBuffer;
    this.source.loop   = true;

    this.source.connect(this.bypassGain);
    if (this._dryGain)   this.source.connect(this._dryGain);   // dry portion of processed path
    if (this._convolver) this.source.connect(this._convolver); // wet (reverb) portion

    this.source.start();
    this.isPlaying = true;
    this.updatePlayButton();
  }

  stopAudio() {
    if (this.source) { try { this.source.stop(); } catch {} this.source = null; }
    [this.bypassGain, this.processedGain, this._dryGain, this._wetGain].forEach(n => {
      if (n) { try { n.disconnect(); } catch {} }
    });
    if (this._convolver) { try { this._convolver.disconnect(); } catch {} this._convolver = null; }
    this.bypassGain = this.processedGain = this._dryGain = this._wetGain = null;
    this._effectInput = null;
    this.isPlaying = false;
    this.updatePlayButton();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.stopAudio();
    } else if (this.audioBuffer && this.exercise) {
      this._loadIR(this.exercise.irPath).then(irAB => {
        this.buildAudioGraph(irAB).then(() => this.startPlayback());
      });
    }
  }

  updatePlayButton() {
    const btn = this.container.querySelector('#rev-btn-play');
    if (btn) btn.textContent = this.isPlaying ? '■ STOP' : '▶ PLAY / STOP';
  }

  toggleABMode() { this.setABMode(this.abMode === 'processed' ? 'bypass' : 'processed'); }

  setABMode(mode) {
    this.abMode = mode;
    if (this.bypassGain)    this.bypassGain.gain.value    = mode === 'bypass'    ? 1 : 0;
    if (this.processedGain) this.processedGain.gain.value = mode === 'processed' ? 1 : 0;
    const btn = this.container.querySelector('#rev-btn-ab');
    if (btn) {
      btn.textContent = mode === 'bypass' ? 'A · TROCKEN' : 'B · REVERB';
      btn.classList.toggle('active-bypass', mode === 'bypass');
      btn.classList.toggle('active-eq',     mode === 'processed');
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────────────

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
      const result = await apiCall('POST', '/reverb/evaluate', {
        exerciseId: this.exercise.exerciseId,
        guessCategory,
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
    const { score, correct, categoryLabel, feedback } = data;
    this.round++;
    this.score += score;
    if (correct) { this.streak++; } else { this.streak = 0; this.lives--; }
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
    this.lives--; this.streak = 0; this.updateHUD();
    if (this.lives <= 0) { this.stopAudio(); this.stopTimer(); this.showGameOver(); }
    else this.loadExercise();
  }

  async showGameOver() {
    this.stopAudio(); this.stopTimer(); this.phase = 'gameover';
    try { await apiCall('POST', '/scores', { score: this.score, rounds: this.round, level: this.level, streak: this.streak }); } catch {}
    const overlay = this.container.querySelector('#rev-gameover');
    overlay.style.display = 'flex';
    this.container.querySelector('#rev-final-score').textContent  = this.score;
    this.container.querySelector('#rev-stat-rounds').textContent  = this.round;
    this.container.querySelector('#rev-stat-streak').textContent  = this.streak;
    this.container.querySelector('#rev-stat-level').textContent   = ['I','II','III'][this.level-1] || this.level;
  }

  restart() {
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
