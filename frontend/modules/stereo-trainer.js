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
    this.audioBuffer = null;
    this.audioCtx = null;
    this.source = null;
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
      const res = await fetch(`/api/stereo/random?level=${this.level}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error(await res.text());
      this.exercise = await res.json();

      const audioRes = await fetch(this.exercise.audioUrl, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      });
      const arrayBuffer = await audioRes.arrayBuffer();
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

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
      this.setStatus('Fehler: ' + err.message);
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
      const res = await fetch('/api/stereo/evaluate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ exerciseId: this.exercise.exerciseId, answer, secondsTaken }),
      });
      const data = await res.json();

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
        try { await apiCall('POST', '/scores', { score: this.score, rounds: this.round, level: this.level, streak: this.streak, module: 'stereo' }); } catch {}
        // Zeige Gameover-Overlay
        const overlay = this.container.querySelector('#st-gameover');
        if (overlay) {
          this.container.querySelector('#st-go-score').textContent = this.score;
          this.container.querySelector('#st-go-rounds').textContent = this.round;
          overlay.style.display = 'flex';
        }
      }
    } catch (err) {
      this.setStatus('Fehler: ' + err.message);
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

  // ─── Audio ──────────────────────────────────────────────────────────────────

  createStereoWidthNode(ctx, width) {
    // Mid/Side processing: width 0 = mono, width 1 = original
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    // We'll use a ScriptProcessor-free approach via gain nodes
    // L_out = Mid + Side*width, R_out = Mid - Side*width
    // Mid = (L+R)/2, Side = (L-R)/2
    // Implemented as: output = Mid + Side * width
    // Since Web Audio doesn't have subtract natively, we invert with gain -1

    const midL = ctx.createGain(); // L -> mid
    const midR = ctx.createGain(); // R -> mid
    const sideL = ctx.createGain(); // L -> side
    const sideR = ctx.createGain(); // R -> side (inverted)

    midL.gain.value = 0.5;
    midR.gain.value = 0.5;
    sideL.gain.value = 0.5 * width;
    sideR.gain.value = -0.5 * width;

    // Output gains
    const outL = ctx.createGain();
    const outR = ctx.createGain();

    // Mid bus (shared)
    const midBus = ctx.createGain();
    midBus.gain.value = 1;

    // Route: splitter -> mid/side gains -> merger
    splitter.connect(midL); // L -> midL
    splitter.connect(midR, 1); // R -> midR
    splitter.connect(sideL); // L -> sideL
    splitter.connect(sideR, 1); // R -> sideR (inverted)

    // L output = midL + midR + sideL + sideR
    midL.connect(merger, 0, 0);
    midR.connect(merger, 0, 0);
    sideL.connect(merger, 0, 0);
    sideR.connect(merger, 0, 0);

    // R output = midL + midR - sideL - sideR (flip side signs)
    const sideL2 = ctx.createGain();
    const sideR2 = ctx.createGain();
    sideL2.gain.value = -0.5 * width;
    sideR2.gain.value = 0.5 * width;
    splitter.connect(sideL2);
    splitter.connect(sideR2, 1);

    midL.connect(merger, 0, 1);
    midR.connect(merger, 0, 1);
    sideL2.connect(merger, 0, 1);
    sideR2.connect(merger, 0, 1);

    return { input: splitter, output: merger };
  }

  playAudio() {
    if (!this.audioBuffer || !this.audioCtx) return;
    this.stopAudio();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

    const source = this.audioCtx.createBufferSource();
    source.buffer = this.audioBuffer;
    source.loop = true;

    if (this.abMode === 'original') {
      source.connect(this.audioCtx.destination);
    } else {
      const width = this.exercise ? this.exercise.width : 1.0;
      const widthNode = this.createStereoWidthNode(this.audioCtx, width);
      source.connect(widthNode.input);
      widthNode.output.connect(this.audioCtx.destination);
    }

    source.start();
    this.source = source;
    this.isPlaying = true;
    this.container.querySelector('#st-play-btn').textContent = '■ STOP';
  }

  stopAudio() {
    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      this.source = null;
    }
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
    if (this.isPlaying) { this.stopAudio(); this.playAudio(); }
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
