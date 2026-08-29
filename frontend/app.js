'use strict';

const API_BASE = '/api';
let TOKEN = localStorage.getItem('token');
let CURRENT_USER = JSON.parse(localStorage.getItem('user') || 'null');

// ─── Authenticated API helper ─────────────────────────────────────────────────
async function apiCall(method, endpoint, data = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    }
  };
  if (data !== null) opts.body = JSON.stringify(data);
  const res = await fetch(API_BASE + endpoint, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── Highscore Manager ────────────────────────────────────────────────────────
class HighscoreManager {
  async submit(score, rounds, level, streak, module = 'eq') {
    try {
      if (window.__TAURI__) {
        await invokeTauri('scores_submit', { module, score, rounds, level, streak });
      } else {
        await apiCall('POST', '/scores', { score, rounds, level, streak, module });
      }
    } catch (err) {
      console.warn('Score submit error:', err);
    }
  }

  // Desktop: no multi-user leaderboard (single local profile) — shows each
  // module's personal best instead of a global rank/username list.
  async renderTo(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    try {
      if (window.__TAURI__) {
        const overview = await invokeTauri('progress_overview');
        if (!overview || overview.length === 0) {
          el.innerHTML = '<div class="hs-entry"><span class="hs-rank">—</span><span class="hs-name">—</span><span class="hs-score">—</span></div>';
          return;
        }
        const sorted = [...overview].sort((a, b) => b.bestScore - a.bestScore);
        el.innerHTML = sorted.map((m, i) => `
          <div class="hs-entry">
            <span class="hs-rank">${i + 1}</span>
            <span class="hs-name">${m.module.toUpperCase()}</span>
            <span class="hs-score">${m.bestScore}</span>
          </div>
        `).join('');
        return;
      }

      const scores = await apiCall('GET', '/scores/highscores');
      if (!scores || scores.length === 0) {
        el.innerHTML = '<div class="hs-entry"><span class="hs-rank">—</span><span class="hs-name">—</span><span class="hs-score">—</span></div>';
        return;
      }
      el.innerHTML = scores.map(s => `
        <div class="hs-entry">
          <span class="hs-rank">${s.rank}</span>
          <span class="hs-name">${s.username}</span>
          <span class="hs-score">${s.score}</span>
        </div>
      `).join('');
    } catch (err) {
      console.warn('Highscore load error:', err);
    }
  }
}

// ─── Main Application ─────────────────────────────────────────────────────────
// MODULE_REGISTRY is populated by each module file via registerModule()

class App {
  constructor() {
    this.audioContext = null;
    this.currentModule = null;
    this.currentModuleId = null;
    this.vuInterval = null;
    this.loginVuInterval = null;
  }

  getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.audioContext;
  }

  async init() {
    this.setupEventListeners();
    if (window.__TAURI__) {
      // Desktop build: no network auth. A single local profile (just a
      // display name, no password) is created once on first launch and
      // reused on every subsequent start.
      const existingName = await invokeTauri('profile_get').catch(() => null);
      if (existingName) {
        CURRENT_USER = { username: existingName, role: 'local' };
        this.showApp();
      } else {
        this.showOnboarding();
      }
      return;
    }
    if (TOKEN) {
      try {
        const res = await apiCall('POST', '/auth/verify');
        CURRENT_USER = { username: res.username, role: res.role };
        this.showApp();
      } catch {
        TOKEN = null;
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        this.showLogin();
      }
    } else {
      this.showLogin();
    }
  }

  showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
    this.startLoginVU();
  }

  // Desktop-only: first-launch profile creation. Reuses the login screen's
  // chassis/VU-meter chrome, just repurposes the form for a single
  // "what's your name" field instead of username+password auth.
  showOnboarding() {
    this._onboarding = true;
    const passwordGroup = document.getElementById('login-password')?.closest('.form-group');
    if (passwordGroup) passwordGroup.style.display = 'none';
    const usernameLabel = document.querySelector('#login-form .form-group .form-label');
    if (usernameLabel) usernameLabel.textContent = 'DEIN NAME';
    const usernameInput = document.getElementById('login-username');
    if (usernameInput) usernameInput.placeholder = 'z.B. Jan';
    const btn = document.getElementById('login-btn');
    if (btn) btn.lastChild.textContent = 'WEITER';
    this.showLogin();
  }

  showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    document.getElementById('header-username').textContent = CURRENT_USER?.username || '—';
    this.stopLoginVU();
    const isAdmin = CURRENT_USER?.role === 'admin';
    const navAdminBtn = document.getElementById('nav-admin-btn');
    const sidebarAdminBtn = document.getElementById('sidebar-admin-btn');
    if (navAdminBtn) navAdminBtn.style.display = isAdmin ? '' : 'none';
    if (sidebarAdminBtn) sidebarAdminBtn.style.display = isAdmin ? '' : 'none';
    const sidebarSystemSection = document.getElementById('sidebar-system-section');
    if (sidebarSystemSection) sidebarSystemSection.style.display = isAdmin ? '' : 'none';
    this.loadModule('eq-trainer');
    this.startHeaderVU();
    this.loadHighscores();
  }

  startLoginVU() {
    const strips = document.querySelectorAll('.vu-led-strip');
    this.loginVuInterval = setInterval(() => {
      strips.forEach(strip => {
        const leds = strip.querySelectorAll('.vu-led');
        const count = Math.floor(Math.random() * (leds.length + 1));
        leds.forEach((led, i) => led.classList.toggle('active', i < count));
      });
    }, 120);
  }

  stopLoginVU() {
    if (this.loginVuInterval) {
      clearInterval(this.loginVuInterval);
      this.loginVuInterval = null;
    }
  }

  startHeaderVU() {
    const fillL = document.getElementById('vu-fill-l');
    const fillR = document.getElementById('vu-fill-r');
    this.vuInterval = setInterval(() => {
      if (fillL) fillL.style.height = (Math.random() * 100) + '%';
      if (fillR) fillR.style.height = (Math.random() * 100) + '%';
    }, 800);
  }

  closeMobileMenu() {
    const mobileSidebar = document.querySelector('.app-sidebar');
    const mobileBackdrop = document.getElementById('mobile-sidebar-backdrop');
    if (mobileSidebar) mobileSidebar.classList.remove('mobile-open');
    if (mobileBackdrop) mobileBackdrop.classList.remove('visible');
  }

  loadModule(moduleId) {
    if (this.currentModule && typeof this.currentModule.destroy === 'function') {
      this.currentModule.destroy();
      this.currentModule = null;
    }

    const Cls = MODULE_REGISTRY[moduleId];
    const container = document.getElementById('main-content');

    if (!Cls) {
      container.innerHTML = '<div style="padding:2rem;color:#888;text-align:center">Dieses Modul ist noch nicht verfügbar.</div>';
      return;
    }

    container.innerHTML = '';
    this.currentModule = new Cls(this, container);
    this.currentModule.init();
    this.currentModuleId = moduleId;

    document.querySelectorAll('[data-module]').forEach(el => {
      const isActive = el.dataset.module === moduleId;
      el.classList.toggle('active', isActive);
      const led = el.querySelector('.nav-btn-led, .sidebar-led');
      if (led) led.classList.toggle('active', isActive);
    });
  }

  async loadHighscores() {
    const hsm = new HighscoreManager();
    await hsm.renderTo('highscore-list');
  }

  setupEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const errorEl = document.getElementById('login-error');
      const btn = document.getElementById('login-btn');
      const led = document.getElementById('login-btn-led');

      errorEl.textContent = '';
      btn.disabled = true;
      if (led) led.classList.add('active');

      if (this._onboarding) {
        // Desktop first-launch: create the local profile, no auth involved.
        try {
          await invokeTauri('profile_set', { username });
          CURRENT_USER = { username, role: 'local' };
          this.showApp();
        } catch (err) {
          errorEl.textContent = String(err);
          if (led) led.classList.remove('active');
          btn.disabled = false;
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen');

        TOKEN = data.token;
        CURRENT_USER = { username: data.username, role: data.role };
        localStorage.setItem('token', TOKEN);
        localStorage.setItem('user', JSON.stringify(CURRENT_USER));
        this.showApp();
      } catch (err) {
        errorEl.textContent = err.message;
        if (led) led.classList.remove('active');
        btn.disabled = false;
      }
    });

    // Change Password Modal
    document.getElementById('change-password-btn').addEventListener('click', () => {
      document.getElementById('cp-current').value = '';
      document.getElementById('cp-new').value = '';
      document.getElementById('cp-confirm').value = '';
      document.getElementById('cp-error').textContent = '';
      const modal = document.getElementById('change-password-modal');
      modal.style.display = 'flex';
    });

    document.getElementById('cp-cancel').addEventListener('click', () => {
      document.getElementById('change-password-modal').style.display = 'none';
    });

    document.getElementById('change-password-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.style.display = 'none';
      }
    });

    document.getElementById('change-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = document.getElementById('cp-current').value;
      const newPw   = document.getElementById('cp-new').value;
      const confirm = document.getElementById('cp-confirm').value;
      const errorEl = document.getElementById('cp-error');

      errorEl.textContent = '';

      if (newPw.length < 6) {
        errorEl.textContent = 'Neues Passwort muss mindestens 6 Zeichen lang sein.';
        return;
      }
      if (newPw !== confirm) {
        errorEl.textContent = 'Passwörter stimmen nicht überein.';
        return;
      }

      try {
        await apiCall('POST', '/auth/change-password', { currentPassword: current, newPassword: newPw });
        document.getElementById('change-password-modal').style.display = 'none';
        showToast('Passwort erfolgreich geändert.', 'success');
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => {
      TOKEN = null;
      CURRENT_USER = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (this.currentModule && typeof this.currentModule.destroy === 'function') {
        this.currentModule.destroy();
        this.currentModule = null;
      }
      if (this.vuInterval) {
        clearInterval(this.vuInterval);
        this.vuInterval = null;
      }
      this.showLogin();
    });

    // Nav module buttons (header nav removed, kept for backwards compat if any remain)
    document.querySelectorAll('.nav-btn[data-module]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('coming-soon')) return;
        this.loadModule(btn.dataset.module);
      });
    });

    // Sidebar module items
    document.querySelectorAll('.sidebar-item[data-module]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('disabled')) return;
        this.loadModule(btn.dataset.module);
        this.closeMobileMenu();
      });
    });

    // Mobile hamburger menu
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileSidebar = document.querySelector('.app-sidebar');
    const mobileBackdrop = document.getElementById('mobile-sidebar-backdrop');

    if (mobileMenuBtn) {
      mobileMenuBtn.addEventListener('click', () => {
        const isOpen = mobileSidebar.classList.contains('mobile-open');
        if (isOpen) {
          this.closeMobileMenu();
        } else {
          mobileSidebar.classList.add('mobile-open');
          mobileBackdrop.classList.add('visible');
        }
      });
    }

    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', () => this.closeMobileMenu());
    }

    // Level buttons
    document.querySelectorAll('.level-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const level = parseInt(btn.dataset.level, 10);
        document.querySelectorAll('.level-item').forEach(b => {
          b.classList.remove('active');
          b.querySelector('.sidebar-led')?.classList.remove('active');
        });
        btn.classList.add('active');
        btn.querySelector('.sidebar-led')?.classList.add('active');
        if (this.currentModule && typeof this.currentModule.setLevel === 'function') {
          this.currentModule.setLevel(level);
        }
      });
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
