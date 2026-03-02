'use strict';

class AdminPanel {
  constructor(app, container) {
    this.app = app;
    this.container = container;
  }

  init() {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (!user || user.role !== 'admin') {
      this.container.innerHTML = '<div style="padding:2rem;color:var(--led-red);text-align:center;letter-spacing:2px">ZUGRIFF VERWEIGERT</div>';
      return;
    }
    this.render();
    this.loadUsers();
  }

  render() {
    this.container.innerHTML = `
      <div class="admin-panel">
        <div class="admin-header">
          <div class="admin-title">ADMIN · BENUTZERVERWALTUNG</div>
        </div>

        <!-- User anlegen -->
        <div class="admin-card">
          <div class="admin-card-title">NEUEN USER ANLEGEN</div>
          <div class="admin-form-row">
            <div class="admin-form-group">
              <label class="admin-label">USERNAME</label>
              <input class="admin-input" id="adm-username" type="text" placeholder="benutzername" autocomplete="off">
            </div>
            <div class="admin-form-group">
              <label class="admin-label">PASSWORT</label>
              <input class="admin-input" id="adm-password" type="password" placeholder="min. 6 Zeichen">
            </div>
            <div class="admin-form-group">
              <label class="admin-label">ROLLE</label>
              <select class="admin-select" id="adm-role">
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button class="btn-rack btn-rack--primary admin-create-btn" id="adm-btn-create">ANLEGEN</button>
          </div>
          <div class="admin-error" id="adm-error"></div>
          <div class="admin-success" id="adm-success"></div>
        </div>

        <!-- User-Liste -->
        <div class="admin-card">
          <div class="admin-card-title">ALLE BENUTZER</div>
          <div id="adm-user-list" class="admin-user-list">
            <div class="admin-loading">Lade…</div>
          </div>
        </div>

        <!-- Passwort-Reset Modal -->
        <div class="admin-modal" id="adm-modal" style="display:none">
          <div class="admin-modal-card">
            <div class="admin-modal-title">PASSWORT ZURÜCKSETZEN</div>
            <div class="admin-modal-user" id="adm-modal-username"></div>
            <input class="admin-input" id="adm-new-password" type="password" placeholder="Neues Passwort (min. 6)">
            <div class="admin-error" id="adm-modal-error"></div>
            <div class="action-panel" style="margin-top:12px">
              <button class="btn-rack btn-rack--primary" id="adm-modal-confirm">SPEICHERN</button>
              <button class="btn-rack btn-rack--secondary" id="adm-modal-cancel">ABBRECHEN</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.container.querySelector('#adm-btn-create').addEventListener('click', () => this.createUser());
    this.container.querySelector('#adm-modal-cancel').addEventListener('click', () => this.closeModal());
    this.container.querySelector('#adm-modal-confirm').addEventListener('click', () => this.confirmPasswordReset());
  }

  async loadUsers() {
    const listEl = this.container.querySelector('#adm-user-list');
    try {
      const users = await apiCall('GET', '/admin/users');
      if (!users.length) {
        listEl.innerHTML = '<div class="admin-loading">Keine User gefunden.</div>';
        return;
      }
      listEl.innerHTML = `
        <div class="admin-user-row admin-user-row--header">
          <span>USERNAME</span>
          <span>ROLLE</span>
          <span>ERSTELLT</span>
          <span></span>
        </div>
        ${users.map(u => `
          <div class="admin-user-row" data-id="${u.id}">
            <span class="admin-user-name">${u.username}</span>
            <span class="admin-user-role admin-user-role--${u.role}">${u.role.toUpperCase()}</span>
            <span class="admin-user-date">${new Date(u.createdAt).toLocaleDateString('de-DE')}</span>
            <span class="admin-user-actions">
              <button class="btn-rack btn-rack--sm btn-rack--secondary adm-btn-pw" data-id="${u.id}" data-name="${u.username}">PW RESET</button>
              <button class="btn-rack btn-rack--sm adm-btn-del" data-id="${u.id}" data-name="${u.username}" ${u.username === 'admin' ? 'disabled' : ''}>LÖSCHEN</button>
            </span>
          </div>
        `).join('')}
      `;

      listEl.querySelectorAll('.adm-btn-pw').forEach(btn => {
        btn.addEventListener('click', () => this.openModal(btn.dataset.id, btn.dataset.name));
      });
      listEl.querySelectorAll('.adm-btn-del').forEach(btn => {
        btn.addEventListener('click', () => this.deleteUser(btn.dataset.id, btn.dataset.name));
      });
    } catch (err) {
      listEl.innerHTML = `<div class="admin-loading" style="color:var(--led-red)">Fehler: ${err.message}</div>`;
    }
  }

  async createUser() {
    const username = this.container.querySelector('#adm-username').value.trim();
    const password = this.container.querySelector('#adm-password').value;
    const role     = this.container.querySelector('#adm-role').value;
    const errorEl  = this.container.querySelector('#adm-error');
    const successEl = this.container.querySelector('#adm-success');

    errorEl.textContent = '';
    successEl.textContent = '';

    try {
      await apiCall('POST', '/admin/users', { username, password, role });
      successEl.textContent = `User "${username}" erfolgreich angelegt.`;
      this.container.querySelector('#adm-username').value = '';
      this.container.querySelector('#adm-password').value = '';
      this.loadUsers();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  async deleteUser(id, name) {
    if (!confirm(`User "${name}" wirklich löschen?`)) return;
    try {
      await apiCall('DELETE', `/admin/users/${id}`);
      this.loadUsers();
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    }
  }

  openModal(id, name) {
    this._resetTargetId = id;
    this.container.querySelector('#adm-modal-username').textContent = name;
    this.container.querySelector('#adm-new-password').value = '';
    this.container.querySelector('#adm-modal-error').textContent = '';
    this.container.querySelector('#adm-modal').style.display = 'flex';
  }

  closeModal() {
    this.container.querySelector('#adm-modal').style.display = 'none';
    this._resetTargetId = null;
  }

  async confirmPasswordReset() {
    const password = this.container.querySelector('#adm-new-password').value;
    const errorEl  = this.container.querySelector('#adm-modal-error');
    errorEl.textContent = '';
    try {
      await apiCall('PATCH', `/admin/users/${this._resetTargetId}/password`, { password });
      this.closeModal();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  destroy() {
    this.container.innerHTML = '';
  }
}

registerModule('admin', AdminPanel);
