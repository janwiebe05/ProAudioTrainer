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
    this.audioBuffer = null;
    this.source    = null;
    this.bypassGain    = null;
    this.processedGain = null;
    this.isPlaying = false;
    this.abMode    = 'processed';
    this.elapsedSeconds = 0;
    this.timerInterval  = null;
    this.maxTime   = 45;
    this._msWorkletLoaded = false;
    this._destroyed = false;
  }

  init()      { this.render(); this.bindEvents(); this.setStatus('Bereit. Drücke START um zu beginnen.'); }
  setLevel(l) { this.level = l; const el = this.container.querySelector('#pan-level'); if (el) el.textContent = ['I','II','III'][l-1] || l; }
  destroy()   { this._destroyed = true; this.stopAudio(); this.stopTimer(); this.container.innerHTML = ''; }

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
    this.stopAudio();
    this.stopTimer();
    this.hideResult();
    this.setControlsEnabled(false);
    this.elapsedSeconds = 0;
    this.phase = 'loading';
    this.setStatus('Lade Übung…', true);

    try {
      const exercise = await apiCall('GET', `/panning/random?level=${this.level}`);
      this.exercise = exercise;

      this.setStatus('Lade Audio…', true);
      const token = localStorage.getItem('token');
      const audioRes = await fetch(exercise.audioUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!audioRes.ok) throw new Error('Audio nicht ladbar');

      const ctx = this.app.getAudioContext();
      this.audioBuffer = await ctx.decodeAudioData(await audioRes.arrayBuffer());
      if (this._destroyed) return;

      await this.buildAudioGraph();
      this.startPlayback();
      this.startTimer();
      this.applyGuessMode(exercise.guessMode, exercise);
      this.setControlsEnabled(true);
      this.setStatus({ zone: 'Stereoposition identifizieren!', value: 'Pan-Wert schätzen!', width: 'Stereobreite schätzen!' }[exercise.guessMode]);
      this.phase = 'playing';
    } catch (err) {
      this.setStatus(`Fehler: ${err.message}`);
      console.error('[PanningTrainer]', err);
    }
  }

  // ─── Audio graph ──────────────────────────────────────────────────────────────
  // A (bypass): source → bypassGain → destination  (original, unprocessed)
  // B (processed):
  //   Level I+II: source → StereoPannerNode → processedGain → destination
  //   Level III:  source → AudioWorklet(ms-width) → processedGain → destination

  async buildAudioGraph() {
    const ctx = this.app.getAudioContext();
    const p   = this.exercise.params;
    const mode = this.exercise.guessMode;

    this.bypassGain = ctx.createGain();
    this.bypassGain.gain.value = this.abMode === 'bypass' ? 1 : 0;
    this.bypassGain.connect(ctx.destination);

    this.processedGain = ctx.createGain();
    this.processedGain.gain.value = this.abMode === 'processed' ? 1 : 0;
    this.processedGain.connect(ctx.destination);

    if (mode === 'zone' || mode === 'value') {
      // StereoPannerNode: equal-power pan law, ITU-R BS.775 compliant
      this._pannerNode = ctx.createStereoPanner();
      this._pannerNode.pan.value = p.panValue / 100; // -1..+1
      this._pannerNode.connect(this.processedGain);
      this._effectInput = this._pannerNode;
    } else {
      // M/S Width via AudioWorklet
      if (!this._msWorkletLoaded) {
        await ctx.audioWorklet.addModule('/worklets/ms-width-processor.js');
        this._msWorkletLoaded = true;
      }
      this._workletNode = new AudioWorkletNode(ctx, 'ms-width-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this._workletNode.parameters.get('width').value = p.width;
      this._workletNode.connect(this.processedGain);
      this._effectInput = this._workletNode;
    }
  }

  startPlayback() {
    const ctx = this.app.getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    this.source = ctx.createBufferSource();
    this.source.buffer = this.audioBuffer;
    this.source.loop   = true;
    this.source.connect(this.bypassGain);
    this.source.connect(this._effectInput);
    this.source.start();
    this.isPlaying = true;
    this.updatePlayButton();
  }

  stopAudio() {
    if (this.source) { try { this.source.stop(); } catch {} this.source = null; }
    [this.bypassGain, this.processedGain].forEach(n => { if (n) { try { n.disconnect(); } catch {} } });
    if (this._pannerNode)  { try { this._pannerNode.disconnect();  } catch {} this._pannerNode  = null; }
    if (this._workletNode) { try { this._workletNode.disconnect(); } catch {} this._workletNode = null; }
    this.bypassGain = this.processedGain = this._effectInput = null;
    this.isPlaying = false;
    this.updatePlayButton();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.stopAudio();
    } else if (this.audioBuffer && this.exercise) {
      this.buildAudioGraph().then(() => this.startPlayback());
    }
  }

  updatePlayButton() {
    const btn = this.container.querySelector('#pan-btn-play');
    if (btn) btn.textContent = this.isPlaying ? '■ STOP' : '▶ PLAY / STOP';
  }

  toggleABMode() { this.setABMode(this.abMode === 'processed' ? 'bypass' : 'processed'); }

  setABMode(mode) {
    this.abMode = mode;
    if (this.bypassGain)    this.bypassGain.gain.value    = mode === 'bypass'    ? 1 : 0;
    if (this.processedGain) this.processedGain.gain.value = mode === 'processed' ? 1 : 0;
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

  async submitAnswer() {
    if (this.phase !== 'playing' || !this.exercise) return;
    this.phase = 'result';
    this.stopTimer();
    this.setControlsEnabled(false);

    const mode = this.exercise.guessMode;
    const body = { exerciseId: this.exercise.exerciseId, secondsTaken: this.elapsedSeconds };
    if (mode === 'zone')  body.guessZone  = this.container.querySelector('.dyn-effect-btn.active[data-zone]')?.dataset.zone;
    if (mode === 'value') body.guessPan   = parseInt(this.container.querySelector('#pan-slider').value);
    if (mode === 'width') body.guessWidth = this.container.querySelector('.dyn-effect-btn.active[data-width]')?.dataset.width;

    try {
      const result = await apiCall('POST', '/panning/evaluate', body);
      this.applyResult(result);
    } catch (err) {
      this.setStatus(`Fehler: ${err.message}`);
      this.phase = 'playing';
      this.setControlsEnabled(true);
    }
  }

  applyResult(data) {
    const { score, correct, feedback } = data;
    this.round++;
    this.score += score;
    if (correct) { this.streak++; } else { this.streak = 0; this.lives--; }
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
    this.lives--; this.streak = 0; this.updateHUD();
    if (this.lives <= 0) { this.stopAudio(); this.stopTimer(); this.showGameOver(); }
    else this.loadExercise();
  }

  async showGameOver() {
    if (this._scoreSubmitted) return;
    this._scoreSubmitted = true;
    this.stopAudio(); this.stopTimer(); this.phase = 'gameover';
    try { await apiCall('POST', '/scores', { score: this.score, rounds: this.round, level: this.level, streak: this.streak, module: 'panning' }); } catch {}
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
