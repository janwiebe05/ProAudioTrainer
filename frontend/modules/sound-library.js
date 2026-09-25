'use strict';

class SoundLibraryModule {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.library = [];
    this.uploading = false;
    this.previewSource = null;
    this.previewingId = null;
  }

  init() {
    this.render();
    this.loadLibrary();
  }

  render() {
    this.container.innerHTML = `
      <div class="sound-library">
        <div class="lib-header">
          <h2>Sound Library</h2>
          <p>Verwalte Audiodateien für das Training — deine eigenen und geteilte.</p>
        </div>

        <div class="lib-upload-zone" id="upload-zone">
          <div class="upload-inner">
            <div class="upload-icon">⬇</div>
            <p class="upload-text">Zu meiner Bibliothek hinzufügen</p>
            <p class="upload-sub">Klicken zum Auswählen — WAV, MP3, OGG, FLAC, AIFF, M4A</p>
          </div>
        </div>

        <div class="lib-upload-zone" id="import-shared-zone" style="margin-top:8px;">
          <div class="upload-inner">
            <div class="upload-icon">⇱</div>
            <p class="upload-text">Geteilten Ordner importieren</p>
            <p class="upload-sub">Für Ordner, die z.B. von der Schule bereitgestellt wurden — für alle Profile auf diesem Rechner sichtbar</p>
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

    this.container.querySelector('#upload-zone').addEventListener('click', () => this.pickFiles());
    this.container.querySelector('#import-shared-zone').addEventListener('click', () => this.pickSharedFolder());
  }

  async loadLibrary() {
    try {
      this.library = await invokeTauri('library_list');
      this.renderLibraryList();
    } catch (err) {
      showToast(`Fehler beim Laden der Bibliothek: ${err}`, 'error');
    }
  }

  async pickFiles() {
    if (this.uploading) return;
    try {
      const selected = await window.__TAURI__.dialog.open({
        multiple: true,
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aiff', 'aif', 'm4a'] }],
      });
      if (!selected) return; // user cancelled
      const paths = Array.isArray(selected) ? selected : [selected];
      await this.handleFiles(paths);
    } catch (err) {
      showToast(`Dateiauswahl fehlgeschlagen: ${err}`, 'error');
    }
  }

  async pickSharedFolder() {
    if (this.uploading) return;
    try {
      const selected = await window.__TAURI__.dialog.open({ directory: true, multiple: false });
      if (!selected) return; // user cancelled
      this.uploading = true;
      const imported = await invokeTauri('library_import_shared_folder', { folderPath: selected });
      showToast(`${imported} geteilte Datei(en) importiert`, 'success');
      await this.loadLibrary();
    } catch (err) {
      showToast(`Import fehlgeschlagen: ${err}`, 'error');
    } finally {
      this.uploading = false;
    }
  }

  async handleFiles(paths) {
    if (!paths || paths.length === 0) return;
    this.uploading = true;
    try {
      const imported = await invokeTauri('library_upload', { paths });
      showToast(`${imported} Datei(en) importiert`, 'success');
      await this.loadLibrary();
    } catch (err) {
      showToast(`Import-Fehler: ${err}`, 'error');
    } finally {
      this.uploading = false;
    }
  }

  renderLibraryList() {
    const listEl = this.container.querySelector('#lib-list');
    const countEl = this.container.querySelector('#stat-count');
    const activeEl = this.container.querySelector('#stat-active');
    const sizeEl = this.container.querySelector('#stat-size');

    countEl.textContent = this.library.length;
    activeEl.textContent = this.library.filter(f => f.active).length;

    let totalSize = 0;
    this.library.forEach(f => totalSize += f.size || 0);
    sizeEl.textContent = (totalSize / (1024 * 1024)).toFixed(1) + ' MB';

    if (this.library.length === 0) {
      listEl.innerHTML = '<div class="lib-empty">Noch keine Dateien. Lade Audiodateien hoch!</div>';
      return;
    }

    listEl.innerHTML = this.library.map(file => {
      const isShared = file.owner === null || file.owner === undefined;
      const badgeClass = isShared ? 'badge-shared' : 'badge-mine';
      const badgeLabel = isShared ? 'Geteilt' : 'Meine Bibliothek';

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
            </div>
          </div>
          <div class="file-actions">
            <button class="btn-rack btn-rack--sm btn-play" data-id="${file.id}">PLAY</button>
            <button class="btn-rack btn-rack--sm btn-toggle-active ${file.active ? 'active' : ''}" data-id="${file.id}">
              ${file.active ? 'ACTIVE' : 'INACTIVE'}
            </button>
            <button class="btn-rack btn-rack--sm btn-delete" data-id="${file.id}">DELETE</button>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.btn-play').forEach(btn => {
      btn.addEventListener('click', () => this.previewFile(btn.dataset.id, btn));
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

  /// Stops the currently playing preview, if any. Called before starting a
  /// new preview, when the same file's button is clicked again, and from
  /// destroy() — previously nothing tracked the preview source at all, so
  /// switching away from the Sound Library module (or to a different file)
  /// left the previous preview playing indefinitely in the background.
  stopPreview() {
    if (this.previewSource) {
      try { this.previewSource.stop(); this.previewSource.disconnect(); } catch { /* already stopped */ }
      this.previewSource = null;
    }
    if (this.previewingId) {
      const prevBtn = this.container.querySelector(`.btn-play[data-id="${this.previewingId}"]`);
      if (prevBtn) prevBtn.textContent = 'PLAY';
      this.previewingId = null;
    }
  }

  async previewFile(fileId, btn) {
    const wasPlayingThisFile = this.previewingId === fileId;
    this.stopPreview();
    if (wasPlayingThisFile) return; // clicking PLAY/STOP on the playing file just stops it

    try {
      const file = this.library.find(f => f.id === fileId);
      if (!file) return;
      const ctx = this.app.getAudioContext();
      const decoded = await fetchAndDecode(ctx, tauriFileUrl(file.path));

      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.onended = () => { if (this.previewingId === fileId) this.stopPreview(); };
      source.start(0);
      this.previewSource = source;
      this.previewingId = fileId;
      if (btn) btn.textContent = 'STOP';
      showToast('Vorschau spielt…', 'info', 2000);
    } catch (err) {
      showToast(`Wiedergabefehler: ${err}`, 'error');
    }
  }

  async toggleActive(fileId, btn) {
    try {
      const file = this.library.find(f => f.id === fileId);
      if (!file) return;
      const newActive = !file.active;
      await invokeTauri('library_toggle_active', { id: fileId, active: newActive });
      file.active = newActive;
      btn.classList.toggle('active', newActive);
      btn.textContent = newActive ? 'ACTIVE' : 'INACTIVE';
      showToast(newActive ? 'Datei aktiviert' : 'Datei deaktiviert', 'info', 2000);
    } catch (err) {
      showToast(`Fehler: ${err}`, 'error');
    }
  }

  async deleteFile(fileId) {
    if (!confirm('Diese Datei löschen?')) return;
    try {
      await invokeTauri('library_delete', { id: fileId });
      await this.loadLibrary();
      showToast('Datei gelöscht', 'success');
    } catch (err) {
      showToast(`Löschfehler: ${err}`, 'error');
    }
  }

  destroy() {
    this.stopPreview();
  }
}

registerModule('sound-library', SoundLibraryModule);
