'use strict';

// Shared UI plumbing used by several modules: persisted settings, the global
// output volume, in-app dialogs (replacing the browser's native confirm()),
// the level-calibration dialog, and keyboard shortcuts for the trainers.

// ─── Settings ─────────────────────────────────────────────────────────────────
const AppSettings = {
  _get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  _set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },

  /// Practice mode: no lives lost, no game over, no highscore entry —
  /// for listening and trying things out without the pressure of a session.
  get practiceMode() { return this._get('practiceMode', false); },
  set practiceMode(on) {
    this._set('practiceMode', !!on);
    document.body.classList.toggle('practice-mode', !!on);
  },

  /// Automatically start the next EQ round shortly after a result.
  get autoNext() { return this._get('autoNext', true); },
  set autoNext(on) { this._set('autoNext', !!on); },

  /// Output volume slider position, 0..1 (mapped to gain in setMasterVolume).
  get volume() { return this._get('masterVolume', 1); },
  get calibrationSeen() { return this._get('calibrationSeen', false); },
  set calibrationSeen(v) { this._set('calibrationSeen', !!v); },
};

// ─── Global output volume ─────────────────────────────────────────────────────
// Every player connects to getOutputNode(ctx) instead of ctx.destination, so
// one slider controls everything (and a stray context created by a module
// still gets the same volume).
const _outputGains = new Map(); // AudioContext -> GainNode

function _volumeToGain(slider) {
  const v = Math.min(1, Math.max(0, slider));
  return v * v; // squared: closer to perceived loudness than a linear slider
}

function getOutputNode(ctx) {
  let gain = _outputGains.get(ctx);
  if (!gain) {
    gain = ctx.createGain();
    gain.gain.value = _volumeToGain(AppSettings.volume);
    gain.connect(ctx.destination);
    _outputGains.set(ctx, gain);
  }
  return gain;
}

function setMasterVolume(slider) {
  AppSettings._set('masterVolume', slider);
  _outputGains.forEach((gain, ctx) => gain.gain.setTargetAtTime(_volumeToGain(slider), ctx.currentTime, 0.02));
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────
function _dialogShell(titleText) {
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `
    <div class="app-dialog" role="dialog" aria-modal="true">
      <h3 class="app-dialog-title"></h3>
      <div class="app-dialog-body"></div>
      <div class="app-dialog-actions"></div>
    </div>`;
  overlay.querySelector('.app-dialog-title').textContent = titleText;
  return overlay;
}

function _mountDialog(overlay, onEscape) {
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onEscape(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) onEscape(); });
  document.body.appendChild(overlay);
  return () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
}

/// In-app replacement for window.confirm(). Resolves true/false. Cancel is
/// focused by default so a stray Enter can't confirm a destructive action.
function confirmDialog(message, { title = 'BESTÄTIGEN', confirmLabel = 'LÖSCHEN', cancelLabel = 'ABBRECHEN' } = {}) {
  return new Promise((resolve) => {
    const overlay = _dialogShell(title);
    overlay.querySelector('.app-dialog-body').textContent = message;
    const actions = overlay.querySelector('.app-dialog-actions');
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-rack btn-rack--sm';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-rack btn-rack--sm btn-rack--danger';
    okBtn.textContent = confirmLabel;
    actions.append(cancelBtn, okBtn);

    let close;
    const finish = (result) => { close(); resolve(result); };
    close = _mountDialog(overlay, () => finish(false));
    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.focus();
  });
}

// ─── Level calibration ────────────────────────────────────────────────────────
// Hearing's frequency balance shifts with playback level (equal-loudness
// contours), so sessions at different volumes aren't comparable. The dialog
// offers a pink-noise reference at a fixed digital level plus the volume slider.
let _pinkNoiseSource = null;

function _createPinkNoiseBuffer(ctx) {
  const seconds = 6;
  const buffer = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    // Paul Kellet's economical pink-noise filter over white noise.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.035; // ≈ -20 dBFS RMS
      b6 = white * 0.115926;
    }
  }
  return buffer;
}

function stopPinkNoise() {
  if (_pinkNoiseSource) {
    try { _pinkNoiseSource.stop(); _pinkNoiseSource.disconnect(); } catch { /* already stopped */ }
    _pinkNoiseSource = null;
  }
}

async function togglePinkNoise(ctx) {
  if (_pinkNoiseSource) { stopPinkNoise(); return false; }
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = _createPinkNoiseBuffer(ctx);
  source.loop = true;
  source.connect(getOutputNode(ctx));
  source.start();
  _pinkNoiseSource = source;
  return true;
}

function showCalibrationDialog(ctx) {
  return new Promise((resolve) => {
    const overlay = _dialogShell('PEGEL KALIBRIEREN');
    const body = overlay.querySelector('.app-dialog-body');
    body.innerHTML = `
      <p>Wie laut man hört, verändert, wie man Frequenzen wahrnimmt. Damit Übungen an
      verschiedenen Tagen vergleichbar bleiben, immer mit demselben Pegel arbeiten.</p>
      <ol>
        <li>Rauschen starten.</li>
        <li>Die <b>Systemlautstärke</b> deines Rechners so einstellen, dass es angenehm
        laut ist — etwa Unterhaltungslautstärke (ca. 75–80 dB SPL, falls du ein Messgerät hast).</li>
        <li>Systemlautstärke danach <b>nicht mehr ändern</b>. Der Regler hier ist nur zum Feinjustieren.</li>
      </ol>
      <label class="app-dialog-slider">
        <span>LAUTSTÄRKE</span>
        <input type="range" id="calib-volume" min="0" max="1" step="0.01">
        <span id="calib-volume-value"></span>
      </label>`;
    const slider = body.querySelector('#calib-volume');
    const valueEl = body.querySelector('#calib-volume-value');
    slider.value = AppSettings.volume;
    const showValue = () => { valueEl.textContent = Math.round(slider.value * 100) + '%'; };
    showValue();
    slider.addEventListener('input', () => { setMasterVolume(parseFloat(slider.value)); showValue(); });

    const actions = overlay.querySelector('.app-dialog-actions');
    const noiseBtn = document.createElement('button');
    noiseBtn.className = 'btn-rack btn-rack--sm';
    noiseBtn.textContent = '▶ RAUSCHEN';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-rack btn-rack--sm btn-rack--primary';
    closeBtn.textContent = 'FERTIG';
    actions.append(noiseBtn, closeBtn);

    let close;
    const finish = () => { stopPinkNoise(); AppSettings.calibrationSeen = true; close(); resolve(); };
    close = _mountDialog(overlay, finish);
    noiseBtn.addEventListener('click', async () => {
      const playing = await togglePinkNoise(ctx);
      noiseBtn.textContent = playing ? '■ RAUSCHEN STOPPEN' : '▶ RAUSCHEN';
    });
    closeBtn.addEventListener('click', finish);
  });
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
function isTypingTarget(e) {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function _usableButton(root, selector) {
  const btn = root.querySelector(selector);
  return btn && !btn.disabled && btn.offsetParent !== null ? btn : null;
}

/// Wires the common trainer shortcuts by clicking the module's own buttons,
/// so behaviour always matches what the mouse does:
///   Space play/stop · B A/B · Enter primary action (start/submit/next) ·
///   S skip · 1-9 pick an answer button.
/// `selectors`: { play, ab, primary: [..], skip: [..], answers }. Ignored while
/// typing in a form field or with Ctrl/Alt/Meta held. Returns an uninstall fn.
function installTrainerShortcuts(container, selectors) {
  const handler = (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return;
    if (!container.isConnected) return;
    const click = (btn) => { if (btn) { e.preventDefault(); btn.click(); } };
    const firstUsable = (list) => (list || []).map(s => _usableButton(container, s)).find(Boolean);

    if (e.code === 'Space') click(_usableButton(container, selectors.play));
    else if (e.key === 'b' || e.key === 'B') click(_usableButton(container, selectors.ab));
    else if (e.key === 'Enter') click(firstUsable(selectors.primary));
    else if (e.key === 's' || e.key === 'S') click(firstUsable(selectors.skip));
    else if (/^[1-9]$/.test(e.key) && selectors.answers) {
      const answers = [...container.querySelectorAll(selectors.answers)].filter(b => !b.disabled && b.offsetParent !== null);
      click(answers[parseInt(e.key, 10) - 1]);
    }
  };
  document.addEventListener('keydown', handler);

  return () => document.removeEventListener('keydown', handler);
}
