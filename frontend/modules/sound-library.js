'use strict';

class SoundLibraryModule {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.library = [];
    this.uploading = false;
  }

  init() {
    this.render();
    this.setupEventListeners();
    this.loadLibrary();
  }

  render() {
    const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
    const uploadLabel = isAdmin
      ? 'Zur geteilten Bibliothek hinzufügen'
      : 'Zu meiner Bibliothek hinzufügen';

    this.container.innerHTML = `
      <div class="sound-library">
        <div class="lib-header">
          <h2>Sound Library</h2>
          <p>Upload and manage audio files for EQ training</p>
        </div>

        <div class="lib-upload-zone" id="upload-zone">
          <input type="file" id="lib-file-input" accept=".wav,.mp3,.ogg,.flac,.aiff,.aif,.m4a" multiple style="display:none">
          <div class="upload-inner">
            <div class="upload-icon">⬇</div>
            <p class="upload-text">${this.escape(uploadLabel)}</p>
            <p class="upload-sub">Drag files here or click to select — Supports WAV, MP3, OGG, FLAC, AIFF, M4A</p>
          </div>
        </div>

        <div class="lib-stats">
          <div class="stat-box">
            <span class="stat-label">FILES</span>
            <span class="stat-value" id="stat-count">0</span>
          </div>
          <div class="stat-box">
            <span class="stat-label">ACTIVE</span>
            <span class="stat-value" id="stat-active">0</span>
          </div>
          <div class="stat-box">
            <span class="stat-label">TOTAL SIZE</span>
            <span class="stat-value" id="stat-size">0 MB</span>
          </div>
        </div>

        <div class="lib-list" id="lib-list"></div>
      </div>
    `;

    const uploadZone = this.container.querySelector('#upload-zone');
    const fileInput = this.container.querySelector('#lib-file-input');

    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('drag-over');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
      this.handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
      this.handleFiles(e.target.files);
      e.target.value = '';
    });
  }

  setupEventListeners() {
  }

  async loadLibrary() {
    try {
      this.library = await apiCall('GET', '/library');
      this.renderLibraryList();
    } catch (err) {
      showToast(`Error loading library: ${err.message}`, 'error');
    }
  }

  async handleFiles(files) {
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    this.uploading = true;
    try {
      const res = await fetch('/api/library/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}` },
        body: formData
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }

      const data = await res.json();
      showToast(`${data.uploaded} file(s) uploaded`, 'success');
      await this.loadLibrary();
    } catch (err) {
      showToast(`Upload error: ${err.message}`, 'error');
    } finally {
      this.uploading = false;
    }
  }

  renderLibraryList() {
    const listEl = this.container.querySelector('#lib-list');
    const countEl = this.container.querySelector('#stat-count');
    const activeEl = this.container.querySelector('#stat-active');
    const sizeEl = this.container.querySelector('#stat-size');

    const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
    const currentUsername = CURRENT_USER && CURRENT_USER.username;

    countEl.textContent = this.library.length;
    activeEl.textContent = this.library.filter(f => f.active).length;

    let totalSize = 0;
    this.library.forEach(f => totalSize += f.size || 0);
    sizeEl.textContent = (totalSize / (1024 * 1024)).toFixed(1) + ' MB';

    if (this.library.length === 0) {
      listEl.innerHTML = '<div class="lib-empty">No files yet. Upload some audio files!</div>';
      return;
    }

    listEl.innerHTML = this.library.map(file => {
      // Ownership badge
      const isShared = file.ownerId === null;
      const isOwner = file.ownerId === currentUsername;
      const badgeClass = isShared ? 'badge-shared' : 'badge-mine';
      const badgeLabel = isShared ? 'Shared' : 'Meine Bibliothek';

      // Delete button: visible for admin OR owner of private file
      const canDelete = isAdmin || isOwner;
      const deleteBtn = canDelete
        ? `<button class="btn-rack btn-rack--sm btn-delete" data-id="${file.id}">DELETE</button>`
        : '';

      return `
        <div class="lib-file-item">
          <div class="file-info">
            <div class="file-name">
              ${this.escape(file.originalName)}
              <span class="lib-badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="file-meta">
              <span class="file-size">${(file.size / 1024 / 1024).toFixed(1)} MB</span>
              <span class="file-duration">${file.duration ? (file.duration / 60).toFixed(1) + ' min' : '—'}</span>
              <span class="file-date">${new Date(file.uploadedAt).toLocaleDateString('de-DE')}</span>
            </div>
          </div>
          <div class="file-actions">
            <button class="btn-rack btn-rack--sm btn-play" data-id="${file.id}">PLAY</button>
            <button class="btn-rack btn-rack--sm btn-toggle-active ${file.active ? 'active' : ''}" data-id="${file.id}">
              ${file.active ? 'ACTIVE' : 'INACTIVE'}
            </button>
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');

    // Event listeners für die Buttons
    listEl.querySelectorAll('.btn-play').forEach(btn => {
      btn.addEventListener('click', () => this.previewFile(btn.dataset.id));
    });

    listEl.querySelectorAll('.btn-toggle-active').forEach(btn => {
      btn.addEventListener('click', () => this.toggleActive(btn.dataset.id, btn));
    });

    listEl.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', () => this.deleteFile(btn.dataset.id));
    });
  }

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async previewFile(fileId) {
    try {
      const res = await fetch(`/api/library/${fileId}/audio`, {
        headers: { 'Authorization': `Bearer ${TOKEN}` }
      });
      if (!res.ok) throw new Error('Download failed');

      const buffer = await res.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await new Promise((resolve, reject) => {
        ctx.decodeAudioData(buffer, resolve, reject);
      });

      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.start(0);

      showToast('Playing preview...', 'info', 2000);
    } catch (err) {
      showToast(`Playback error: ${err.message}`, 'error');
    }
  }

  async toggleActive(fileId, btn) {
    try {
      const file = await apiCall('PATCH', `/library/${fileId}/active`);
      btn.classList.toggle('active', file.active);
      btn.textContent = file.active ? 'ACTIVE' : 'INACTIVE';
      showToast(file.active ? 'File activated' : 'File deactivated', 'info', 2000);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  async deleteFile(fileId) {
    if (!confirm('Delete this file?')) return;

    try {
      await apiCall('DELETE', `/library/${fileId}`);
      await this.loadLibrary();
      showToast('File deleted', 'success');
    } catch (err) {
      showToast(`Delete error: ${err.message}`, 'error');
    }
  }

  destroy() {
  }
}

registerModule('sound-library', SoundLibraryModule);

