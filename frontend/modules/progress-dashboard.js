'use strict';

class ProgressDashboard {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.summary = null;
    this.sessions = [];
    this.weakspots = [];
  }

  init() {
    this.render();
    this.loadData();
  }

  setLevel() {} // no-op, required by module interface

  destroy() {
    this.container.innerHTML = '';
  }

  async loadData() {
    if (this._loading) return;
    this._loading = true;

    try {
      if (window.__TAURI__) {
        const [summary, sessions, overview] = await Promise.all([
          invokeTauri('progress_summary'),
          invokeTauri('scores_recent', { limit: 20 }),
          invokeTauri('progress_overview'),
        ]);
        this.summary = summary;
        this.sessions = sessions;
        // Reuse the existing weakspots rendering (module/avgScore/sessionCount)
        // fed from progress_overview's per-module totals instead of a
        // dedicated backend endpoint.
        this.weakspots = overview.map(m => ({
          module: m.module,
          avgScore: m.sessions > 0 ? Math.round(m.totalScore / m.sessions) : 0,
          sessionCount: m.sessions,
        }));
        this.renderData();
        return;
      }

      const token = localStorage.getItem('token');
      if (!token) {
        this.container.querySelector('#prog-status').textContent = 'Nicht eingeloggt.';
        return;
      }
      const headers = { 'Authorization': `Bearer ${token}` };
      const [sumRes, sessRes, weakRes] = await Promise.all([
        fetch('/api/progress/summary', { headers }),
        fetch('/api/progress/sessions', { headers }),
        fetch('/api/progress/weakspots', { headers }),
      ]);
      if (!sumRes.ok || !sessRes.ok || !weakRes.ok) {
        const status = [sumRes, sessRes, weakRes].find(r => !r.ok)?.status;
        if (status === 401) {
          this.container.querySelector('#prog-status').textContent = 'Session abgelaufen – bitte neu einloggen.';
        } else {
          this.container.querySelector('#prog-status').textContent = `Fehler beim Laden (HTTP ${status}).`;
        }
        return;
      }
      this.summary   = await sumRes.json();
      this.sessions  = await sessRes.json();
      this.weakspots = await weakRes.json();
      this.renderData();
    } catch (err) {
      this.container.querySelector('#prog-status').textContent = `Fehler beim Laden der Daten: ${err}`;
    } finally {
      this._loading = false;
    }
  }

  render() {
    this.container.innerHTML = `
      <div class="dynamics-trainer">
        <div class="game-header">
          <div class="level-display">
            <span class="label">MODUL</span>
            <span class="value" style="font-size:1rem">PROGRESS</span>
          </div>
          <div style="flex:1"></div>
          <button class="btn-rack btn-rack--sm" id="prog-refresh-btn">↻ REFRESH</button>
        </div>

        <div id="prog-status" style="color:var(--text-dim);font-family:var(--font-mono);font-size:12px;padding:8px 0;">Lade Daten…</div>

        <!-- Stats Row -->
        <div id="prog-stats" class="prog-stats-row" style="display:none">
          <div class="prog-stat-card">
            <div class="prog-stat-value" id="prog-total-points">—</div>
            <div class="prog-stat-label">GESAMTPUNKTE</div>
          </div>
          <div class="prog-stat-card">
            <div class="prog-stat-value" id="prog-total-rounds">—</div>
            <div class="prog-stat-label">GESAMTRUNDEN</div>
          </div>
          <div class="prog-stat-card">
            <div class="prog-stat-value" id="prog-avg-score">—</div>
            <div class="prog-stat-label">Ø SCORE</div>
          </div>
          <div class="prog-stat-card">
            <div class="prog-stat-value" id="prog-best-streak">—</div>
            <div class="prog-stat-label">BESTER STREAK</div>
          </div>
          <div class="prog-stat-card">
            <div class="prog-stat-value" id="prog-sessions">—</div>
            <div class="prog-stat-label">SESSIONS</div>
          </div>
        </div>

        <!-- Module Performance -->
        <div id="prog-modules-section" style="display:none;margin-top:16px;">
          <div class="sidebar-label" style="margin-bottom:8px;">MODUL-PERFORMANCE</div>
          <div id="prog-module-bars"></div>
        </div>

        <!-- Learning Curve Canvas -->
        <div id="prog-curve-section" style="display:none;margin-top:16px;">
          <div class="sidebar-label" style="margin-bottom:8px;">LERNKURVE (letzte 20 Sessions)</div>
          <canvas id="prog-canvas" width="700" height="160" style="width:100%;max-width:700px;background:#0a0a14;border:1px solid #1a1a3e;border-radius:4px;display:block;"></canvas>
        </div>

        <!-- Session History -->
        <div id="prog-history-section" style="display:none;margin-top:16px;">
          <div class="sidebar-label" style="margin-bottom:8px;">SESSION-HISTORY</div>
          <div style="overflow-x:auto;">
            <table id="prog-table" style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:12px;">
              <thead>
                <tr style="color:var(--text-dim);border-bottom:1px solid #1a1a3e;">
                  <th style="text-align:left;padding:6px 8px;">DATUM</th>
                  <th style="text-align:left;padding:6px 8px;">MODUL</th>
                  <th style="text-align:right;padding:6px 8px;">SCORE</th>
                  <th style="text-align:right;padding:6px 8px;">RUNDEN</th>
                  <th style="text-align:right;padding:6px 8px;">LEVEL</th>
                  <th style="text-align:right;padding:6px 8px;">STREAK</th>
                </tr>
              </thead>
              <tbody id="prog-tbody"></tbody>
            </table>
          </div>
        </div>

      </div>
    `;

    this.container.querySelector('#prog-refresh-btn').addEventListener('click', () => {
      this.container.querySelector('#prog-status').textContent = 'Lade Daten…';
      this.container.querySelector('#prog-stats').style.display = 'none';
      this.container.querySelector('#prog-modules-section').style.display = 'none';
      this.container.querySelector('#prog-curve-section').style.display = 'none';
      this.container.querySelector('#prog-history-section').style.display = 'none';
      this.loadData();
    });
  }

  renderData() {
    const s = this.summary;
    this.container.querySelector('#prog-status').textContent = '';

    // Stats
    this.container.querySelector('#prog-total-points').textContent = (s.totalPoints || 0).toLocaleString('de-DE');
    this.container.querySelector('#prog-total-rounds').textContent = (s.totalRounds || 0).toLocaleString('de-DE');
    this.container.querySelector('#prog-avg-score').textContent = (s.avgScore || 0).toLocaleString('de-DE');
    this.container.querySelector('#prog-best-streak').textContent = (s.bestStreak ?? s.currentStreak ?? 0) + 'x';
    this.container.querySelector('#prog-sessions').textContent = (s.sessionCount || 0);
    this.container.querySelector('#prog-stats').style.display = 'flex';

    // Module bars
    if (this.weakspots.length > 0) {
      const barsEl = this.container.querySelector('#prog-module-bars');
      barsEl.innerHTML = this.weakspots.map(w => {
        const pct = Math.min(100, Math.round(w.avgScore / 10));
        const color = w.avgScore > 700 ? '#4caf50' : w.avgScore > 400 ? '#d4af37' : '#ff5252';
        return `
          <div style="margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:11px;color:var(--text-dim);margin-bottom:3px;">
              <span>${w.module.toUpperCase()}</span>
              <span style="color:${color}">${w.avgScore} pts · ${w.sessionCount} Sessions</span>
            </div>
            <div style="background:#0a0a14;border:1px solid #1a1a3e;border-radius:2px;height:10px;">
              <div style="width:${pct}%;height:100%;background:${color};border-radius:2px;transition:width 0.4s;"></div>
            </div>
          </div>`;
      }).join('');
      this.container.querySelector('#prog-modules-section').style.display = 'block';
    }

    // Learning curve
    if (this.sessions.length > 1) {
      this.drawCurve();
      this.container.querySelector('#prog-curve-section').style.display = 'block';
    }

    // Session history (last 10)
    const tbody = this.container.querySelector('#prog-tbody');
    const recent = this.sessions.slice(0, 10);
    if (recent.length > 0) {
      tbody.innerHTML = recent.map(s => {
        const d = new Date(s.date || s.createdAt);
        const dateStr = isNaN(d) ? '—' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
        const scoreColor = s.score > 700 ? '#4caf50' : s.score > 400 ? '#d4af37' : '#ff5252';
        return `<tr style="border-bottom:1px solid #0f0f2a;">
          <td style="padding:5px 8px;color:var(--text-dim)">${dateStr}</td>
          <td style="padding:5px 8px;color:#a0c4ff">${(s.module || 'eq').toUpperCase()}</td>
          <td style="padding:5px 8px;text-align:right;color:${scoreColor};font-weight:bold">${(s.score || 0).toLocaleString('de-DE')}</td>
          <td style="padding:5px 8px;text-align:right;color:var(--text-dim)">${s.rounds || 0}</td>
          <td style="padding:5px 8px;text-align:right;color:var(--text-dim)">${s.level || 1}</td>
          <td style="padding:5px 8px;text-align:right;color:var(--text-dim)">${s.streak || 0}x</td>
        </tr>`;
      }).join('');
      this.container.querySelector('#prog-history-section').style.display = 'block';
    }
  }

  drawCurve() {
    const canvas = this.container.querySelector('#prog-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const pad = { top: 16, right: 16, bottom: 24, left: 48 };

    // Use last 20 sessions in chronological order
    const data = this.sessions.slice(0, 20).reverse();
    const scores = data.map(s => s.score || 0);
    const maxScore = Math.max(...scores, 1000);
    const minScore = 0;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#1a1a3e';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (H - pad.top - pad.bottom) * (1 - i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#3a3a6e';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxScore * i / 4), pad.left - 4, y + 4);
    }

    if (scores.length < 2) return;

    // Line
    const xStep = (W - pad.left - pad.right) / (scores.length - 1);
    const yScale = (H - pad.top - pad.bottom) / (maxScore - minScore);

    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#4caf50';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    scores.forEach((score, i) => {
      const x = pad.left + i * xStep;
      const y = H - pad.bottom - (score - minScore) * yScale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dots
    ctx.fillStyle = '#4caf50';
    scores.forEach((score, i) => {
      const x = pad.left + i * xStep;
      const y = H - pad.bottom - (score - minScore) * yScale;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    });
  }
}

// Inject minimal styles for stat cards
(function() {
  if (document.getElementById('prog-styles')) return;
  const style = document.createElement('style');
  style.id = 'prog-styles';
  style.textContent = `
    .prog-stats-row { display:flex; gap:12px; flex-wrap:wrap; margin-top:12px; }
    .prog-stat-card { flex:1; min-width:100px; background:#0a0a14; border:1px solid #1a1a3e; border-radius:4px; padding:12px 16px; text-align:center; }
    .prog-stat-value { font-family:var(--font-mono); font-size:1.6rem; font-weight:700; color:#d4af37; line-height:1; }
    .prog-stat-label { font-family:var(--font-mono); font-size:10px; color:var(--text-dim); margin-top:4px; letter-spacing:1px; }
  `;
  document.head.appendChild(style);
})();

registerModule('progress-dashboard', ProgressDashboard);
