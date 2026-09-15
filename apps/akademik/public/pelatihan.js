(function () {
    'use strict';

    const STORAGE_KEY = 'pa_pelatihan_v1';
    const GOOGLE_DRIVE_HOST = 'drive.google.com';
    const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
    const MAX_URL_LENGTH = 2048;
    const CACHE_TTL_MS = 60 * 1000;
    const BOOKS_PER_ROW = 6;

    let records = [];
    const libraries = new Map();
    const loadingSources = new Set();
    let activePreview = null;
    let lastPreviewFocus = null;

    function panelTemplate() {
        return `
        <div class="pa-training-layout">
            <section class="pa-bank-hero pa-training-hero" aria-labelledby="pelatihanPageTitle">
                <div class="pa-bank-hero-copy">
                    <span class="pa-bank-kicker">🎓 Perpustakaan Pelatihan</span>
                    <h3 id="pelatihanPageTitle">Pelatihan Soal TKA</h3>
                </div>
                <div class="pa-bank-hero-actions">
                    <span class="pa-bank-count" id="pelatihanBookCount">0 buku</span>
                    <button type="button" class="pa-btn pa-btn-primary admin-only" id="pelatihanAddToggle" aria-expanded="false" aria-controls="pelatihanFormCard">➕ Tambah Link Folder</button>
                </div>
            </section>

            <section class="pa-card pa-training-form-card admin-only" id="pelatihanFormCard" hidden>
                <div class="pa-bank-soal-head">
                    <div>
                        <span class="pa-bank-kicker">Khusus Admin</span>
                        <h3>Hubungkan Folder Google Drive</h3>
                        <p>Tidak ada upload file dan tidak perlu memasukkan buku satu per satu.</p>
                    </div>
                </div>
                <form id="pelatihanForm" class="pa-bank-form" novalidate>
                    <input type="hidden" id="pelatihanSourceId">
                    <div class="pa-form-group pa-full">
                        <label for="pelatihanDisplayName">Nama folder di tampilan web</label>
                        <input type="text" id="pelatihanDisplayName" maxlength="120" placeholder="Contoh: Soal TKA Matematika">
                        <small class="pa-bank-drive-help"><span>✏️</span><span>Opsional. Nama ini hanya tampil di web dan tidak mengubah nama folder asli di Google Drive.</span></small>
                    </div>
                    <div class="pa-form-group pa-full">
                        <label for="pelatihanFolderLink">Link folder Google Drive</label>
                        <input type="url" id="pelatihanFolderLink" maxlength="2048" required placeholder="https://drive.google.com/drive/folders/ID_FOLDER">
                        <small class="pa-bank-drive-help"><span>🔗</span><span>Folder harus dapat dibaca oleh “Siapa saja yang memiliki link”. Hanya PDF dan DOCX yang akan menjadi buku.</span></small>
                    </div>
                    <div class="pa-form-actions pa-full">
                        <button type="submit" class="pa-btn pa-btn-primary" id="pelatihanSubmit">💾 Simpan Link Folder</button>
                        <button type="button" class="pa-btn pa-btn-soft" id="pelatihanCancelEdit" hidden>↩️ Batal Edit</button>
                    </div>
                </form>
            </section>

            <section class="pa-bank-library-card pa-training-library" aria-label="Rak buku Pelatihan Soal TKA">
                <div class="pa-training-library-actions">
                    <button type="button" class="pa-btn pa-btn-soft" id="pelatihanRefresh">↻ Muat Ulang Isi Folder</button>
                </div>
                <div class="pa-training-toolbar">
                    <label class="pa-bank-search">
                        <span aria-hidden="true">🔎</span>
                        <input type="search" id="pelatihanSearch" placeholder="Cari nama PDF, DOCX, atau nama subfolder...">
                    </label>
                    <span class="pa-training-sync-note" id="pelatihanSyncNote">Isi folder dibaca langsung dari Google Drive.</span>
                </div>
                <div id="pelatihanShelfList" class="pa-training-shelf-list" aria-live="polite"></div>
            </section>
        </div>`;
    }

    function previewModalTemplate() {
        return `
        <div class="pa-wa-modal pa-bank-preview-modal pa-training-preview-modal" id="pelatihanPreviewModal" hidden aria-hidden="true">
            <div class="pa-wa-modal-backdrop" data-close-pelatihan-preview></div>
            <section class="pa-wa-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="pelatihanPreviewTitle">
                <div class="pa-wa-modal-head">
                    <div>
                        <span class="pa-wa-modal-kicker">Pelatihan</span>
                        <h2 id="pelatihanPreviewTitle">Preview Buku</h2>
                        <p id="pelatihanPreviewSubtitle">PDF / DOCX</p>
                    </div>
                    <button type="button" class="pa-wa-modal-close" data-close-pelatihan-preview aria-label="Tutup preview Pelatihan">×</button>
                </div>
                <div class="pa-wa-modal-body pa-bank-preview-body">
                    <span class="pa-bank-preview-status" id="pelatihanPreviewStatus">Memuat dokumen...</span>
                    <iframe
                        id="pelatihanPreviewFrame"
                        class="pa-bank-preview-frame"
                        src="about:blank"
                        title="Preview Buku Pelatihan"
                        loading="lazy"
                        scrolling="yes"
                        referrerpolicy="strict-origin-when-cross-origin"
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        allowfullscreen></iframe>
                </div>
                <div class="pa-wa-modal-actions pa-bank-preview-actions">
                    <button type="button" class="pa-btn pa-btn-soft" id="pelatihanFullscreen" aria-pressed="false">⛶ Full Screen</button>
                    <button type="button" class="pa-btn pa-btn-primary" data-close-pelatihan-preview>Tutup Preview</button>
                </div>
            </section>
        </div>`;
    }

    function ensureMarkup() {
        const root = document.querySelector('[data-pelatihan-root]');
        if (root && !document.getElementById('pelatihanShelfList')) root.innerHTML = panelTemplate();
        if (root && !isAdmin()) root.querySelectorAll('.admin-only').forEach(element => { element.style.display = 'none'; });
        if (!document.getElementById('pelatihanPreviewModal')) document.body.insertAdjacentHTML('beforeend', previewModalTemplate());
    }

    function session() {
        return window.PAAuth && typeof PAAuth.getSession === 'function' ? PAAuth.getSession() : null;
    }

    function isAdmin() {
        return session()?.role === 'admin';
    }

    function escapeHTML(value) {
        return window.PAAuth && typeof PAAuth.escapeHTML === 'function'
            ? PAAuth.escapeHTML(String(value || ''))
            : String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
    }

    function notify(message, type = 'info') {
        if (window.PACloud && typeof PACloud.showCloudStatus === 'function') return PACloud.showCloudStatus(message, type);
        if (typeof window.PANotify === 'function') window.PANotify(message, { type });
    }

    function normalizeFolderLink(value) {
        const raw = String(value || '').trim();
        if (!raw) throw new Error('Link folder Google Drive wajib diisi.');
        if (raw.length > MAX_URL_LENGTH) throw new Error('Link folder Google Drive terlalu panjang.');
        let url;
        try { url = new URL(raw); } catch { throw new Error('Link folder Google Drive tidak valid.'); }
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== GOOGLE_DRIVE_HOST) throw new Error('Gunakan link HTTPS folder dari Google Drive.');
        const path = url.pathname.replace(/\/+$/, '');
        const match = path.match(/^\/drive\/(?:u\/\d+\/)?folders\/([^/]+)$/i) || path.match(/^\/folders\/([^/]+)$/i);
        const folderId = String(match?.[1] || '').trim();
        if (!FILE_ID_PATTERN.test(folderId)) throw new Error('Link harus menuju satu folder Google Drive, bukan file.');
        const resourceKey = String(url.searchParams.get('resourcekey') || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 300);
        return {
            folderId,
            sourceUrl: `https://drive.google.com/drive/folders/${folderId}${resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : ''}`
        };
    }

    function loadRecords() {
        const raw = window.PAAuth && typeof PAAuth.loadUserJSON === 'function' ? PAAuth.loadUserJSON(STORAGE_KEY, []) : [];
        records = (Array.isArray(raw) ? raw : [])
            .filter(item => item && item.id && item.folderUrl)
            .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        return records;
    }

    function saveRecordsLocal(next, message) {
        records = Array.isArray(next) ? next : [];
        if (window.PACloud && typeof PACloud.saveLocalTable === 'function') {
            PACloud.saveLocalTable(STORAGE_KEY, records, { localText: message || 'Link Pelatihan tersimpan lokal • tekan Sinkronkan' });
        } else if (window.PAAuth && typeof PAAuth.saveUserJSON === 'function') {
            PAAuth.saveUserJSON(STORAGE_KEY, records);
        }
        return records;
    }

    async function upsertRecord(record) {
        const current = loadRecords();
        if (window.PACloud && typeof PACloud.upsertRecordNow === 'function' && navigator.onLine !== false) {
            try {
                const saved = await PACloud.upsertRecordNow(STORAGE_KEY, record, {
                    forceOnline: true,
                    uploadText: 'Menyimpan link folder Pelatihan...',
                    successText: 'Folder Pelatihan tersimpan ✅'
                });
                records = [saved, ...current.filter(item => String(item.id) !== String(saved.id))];
                return saved;
            } catch (error) {
                if (['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_DRIVE_FOLDER'].includes(String(error?.code || ''))) throw error;
                saveRecordsLocal([record, ...current.filter(item => String(item.id) !== String(record.id))], 'Koneksi terputus • link Pelatihan diantrikan untuk Sinkronkan');
                return record;
            }
        }
        saveRecordsLocal([record, ...current.filter(item => String(item.id) !== String(record.id))]);
        return record;
    }

    async function removeRecord(id) {
        const current = loadRecords();
        if (window.PACloud && typeof PACloud.deleteRecordNow === 'function' && navigator.onLine !== false) {
            try {
                records = await PACloud.deleteRecordNow(STORAGE_KEY, id, {
                    forceOnline: true,
                    uploadText: 'Menghapus link folder Pelatihan...',
                    successText: 'Folder Pelatihan dihapus ✅'
                });
                return;
            } catch (error) {
                if (String(error?.code || '') === 'FORBIDDEN') throw error;
            }
        }
        saveRecordsLocal(current.filter(item => String(item.id) !== String(id)), 'Penghapusan Pelatihan diantrikan • tekan Sinkronkan');
    }

    function hashTone(value) {
        const text = String(value || 'pelatihan');
        let hash = 0;
        for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
        return Math.abs(hash % 9) + 1;
    }

    function chunks(list, size) {
        const output = [];
        for (let index = 0; index < list.length; index += size) output.push(list.slice(index, index + size));
        return output;
    }

    function formatDate(value) {
        const date = new Date(value || 0);
        if (Number.isNaN(date.getTime())) return 'Tanggal tidak tersedia';
        return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function formatSize(value) {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    }

    function relativePath(book, rootName) {
        const path = String(book.folderPath || '').trim();
        if (!path) return rootName || 'Folder Pelatihan';
        if (rootName && path === rootName) return rootName;
        if (rootName && path.startsWith(rootName + ' / ')) return path.slice(rootName.length + 3);
        return path;
    }

    function bookMarkup(book, library) {
        const tone = hashTone(book.id || book.name);
        const path = relativePath(book, library?.folder?.name || '');
        const meta = [path, formatSize(book.size)].filter(Boolean).join(' • ');
        return `
            <article class="pa-book-card pa-book-tone-${tone}" data-pelatihan-book-id="${escapeHTML(book.id)}">
                <button type="button" class="pa-book-cover" data-pelatihan-preview="${escapeHTML(book.id)}" aria-label="Buka ${escapeHTML(book.name)}">
                    <span class="pa-book-topline">
                        <span class="pa-book-icon" aria-hidden="true">${book.type === 'DOCX' ? '📘' : '📕'}</span>
                        <em>${escapeHTML(book.type || 'File')}</em>
                    </span>
                    <strong class="pa-book-title">${escapeHTML(book.name)}</strong>
                    <span class="pa-book-subtitle">${escapeHTML(meta || 'Pelatihan')}</span>
                    <small class="pa-book-updated">Diperbarui ${escapeHTML(formatDate(book.modifiedTime))}</small>
                    <span class="pa-book-open">Baca / Preview <span aria-hidden="true">›</span></span>
                </button>
            </article>`;
    }

    function queryText() {
        return String(document.getElementById('pelatihanSearch')?.value || '').trim().toLowerCase();
    }

    function visibleBooks(library) {
        const query = queryText();
        const books = Array.isArray(library?.books) ? library.books : [];
        if (!query) return books;
        return books.filter(book => [book.name, book.type, book.folderName, book.folderPath].join(' ').toLowerCase().includes(query));
    }

    function sourceShell(record) {
        const cached = libraries.get(String(record.id));
        const library = cached?.library;
        const title = String(record.displayName || '').trim() || library?.folder?.name || 'Folder Pelatihan';
        const books = library ? visibleBooks(library) : [];
        const error = cached?.error || '';
        const loading = loadingSources.has(String(record.id));
        let content = '';

        if (loading && !library) {
            content = `<div class="pa-training-state"><span class="pa-training-spinner" aria-hidden="true"></span><strong>Membaca isi folder...</strong><p>PDF dan DOCX sedang diambil dari Google Drive.</p></div>`;
        } else if (error && !library) {
            content = `<div class="pa-training-state pa-training-state-error"><span aria-hidden="true">⚠️</span><strong>Folder belum dapat dibaca</strong><p>${escapeHTML(error)}</p><button type="button" class="pa-btn pa-btn-soft" data-pelatihan-retry="${escapeHTML(record.id)}">Coba Lagi</button></div>`;
        } else if (!books.length) {
            content = `<div class="pa-training-state"><span aria-hidden="true">📚</span><strong>${queryText() ? 'Tidak ada buku yang cocok' : 'Belum ada PDF atau DOCX'}</strong><p>${queryText() ? 'Coba kata pencarian lain.' : 'File selain PDF/DOCX sengaja tidak ditampilkan.'}</p></div>`;
        } else {
            content = chunks(books, BOOKS_PER_ROW).map((row, index) => `
                <section class="pa-bookshelf-row" aria-label="${escapeHTML(title)} rak ${index + 1}">
                    <div class="pa-book-row">${row.map(book => bookMarkup(book, library)).join('')}</div>
                </section>`).join('');
        }

        return `
            <section class="pa-training-shelf" data-pelatihan-source="${escapeHTML(record.id)}">
                <header class="pa-training-shelf-head">
                    <div>
                        <span class="pa-training-folder-icon" aria-hidden="true">📁</span>
                        <div>
                            <h4>${escapeHTML(title)}</h4>
                            <p>${library ? `${library.books.length} buku PDF/DOCX${library.truncated ? ' • sebagian hasil dibatasi' : ''}` : 'Link folder Google Drive'}</p>
                        </div>
                    </div>
                    <div class="pa-training-shelf-actions">
                        <button type="button" class="pa-btn pa-btn-soft" data-pelatihan-retry="${escapeHTML(record.id)}">↻ Refresh</button>
                        ${isAdmin() ? `<button type="button" class="pa-btn pa-btn-soft pa-training-edit-btn" data-pelatihan-edit="${escapeHTML(record.id)}" aria-label="Edit nama folder khusus tampilan web">✏️ Edit Nama</button><button type="button" class="pa-training-icon-btn pa-training-delete" data-pelatihan-delete="${escapeHTML(record.id)}" aria-label="Hapus folder">🗑️</button>` : ''}
                    </div>
                </header>
                <div class="pa-training-shelf-body">${content}</div>
            </section>`;
    }

    function updateCount() {
        const total = loadRecords().reduce((sum, record) => sum + (libraries.get(String(record.id))?.library?.books?.length || 0), 0);
        const count = document.getElementById('pelatihanBookCount');
        if (count) count.textContent = `${total} buku`;
    }

    function renderShelves() {
        const target = document.getElementById('pelatihanShelfList');
        if (!target) return;
        const list = loadRecords();
        if (!list.length) {
            target.innerHTML = `<div class="pa-training-empty"><span aria-hidden="true">📁</span><strong>Belum ada folder Pelatihan</strong><p>${isAdmin() ? 'Tekan Tambah Link Folder lalu tempel link folder Google Drive.' : 'Admin belum menghubungkan folder Pelatihan.'}</p></div>`;
            updateCount();
            return;
        }
        target.innerHTML = list.map(sourceShell).join('');
        updateCount();
    }

    async function fetchLibrary(record, options = {}) {
        const id = String(record?.id || '');
        if (!id || loadingSources.has(id)) return;
        const cached = libraries.get(id);
        if (!options.force && cached?.library && Date.now() - Number(cached.fetchedAt || 0) < CACHE_TTL_MS) return;
        if (!window.PACloud || typeof PACloud.request !== 'function') {
            libraries.set(id, { error: 'Backend Cloudflare belum siap untuk membaca folder.', fetchedAt: Date.now() });
            renderShelves();
            return;
        }
        if (navigator.onLine === false) {
            libraries.set(id, { ...(cached || {}), error: 'Perangkat sedang offline. Sambungkan internet untuk membaca isi folder.' });
            renderShelves();
            return;
        }

        loadingSources.add(id);
        renderShelves();
        try {
            const result = await PACloud.request('listPelatihanFolder', { sourceId: id }, { timeout: 30000 });
            libraries.set(id, { library: result.library || { books: [], folder: {} }, fetchedAt: Date.now(), error: '' });
        } catch (error) {
            const message = String(error?.code || '') === 'DRIVE_API_NOT_CONFIGURED'
                ? 'Google Drive API Key belum dipasang di Cloudflare. Admin perlu memasang secret GOOGLE_DRIVE_API_KEY satu kali.'
                : (error?.message || 'Isi folder gagal dibaca. Pastikan folder dapat diakses dengan link.');
            libraries.set(id, { ...(cached || {}), error: message, fetchedAt: Date.now() });
        } finally {
            loadingSources.delete(id);
            renderShelves();
        }
    }

    async function hydrateShelves(options = {}) {
        const list = loadRecords();
        await Promise.all(list.map(record => fetchLibrary(record, options)));
    }

    function render(options = {}) {
        ensureMarkup();
        renderShelves();
        hydrateShelves(options);
    }

    function setFormOpen(open) {
        const card = document.getElementById('pelatihanFormCard');
        const toggle = document.getElementById('pelatihanAddToggle');
        if (!card || !toggle) return;
        card.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '✕ Tutup Form' : '➕ Tambah Link Folder';
        if (open) requestAnimationFrame(() => document.getElementById('pelatihanFolderLink')?.focus());
    }

    function resetForm(options = {}) {
        const form = document.getElementById('pelatihanForm');
        form?.reset();
        const id = document.getElementById('pelatihanSourceId');
        if (id) id.value = '';
        const submit = document.getElementById('pelatihanSubmit');
        if (submit) submit.textContent = '💾 Simpan Link Folder';
        const cancel = document.getElementById('pelatihanCancelEdit');
        if (cancel) cancel.hidden = true;
        if (options.close) setFormOpen(false);
    }

    function editSource(id) {
        if (!isAdmin()) return;
        const item = loadRecords().find(record => String(record.id) === String(id));
        if (!item) return;
        document.getElementById('pelatihanSourceId').value = item.id || '';
        document.getElementById('pelatihanDisplayName').value = item.displayName || '';
        document.getElementById('pelatihanFolderLink').value = item.folderUrl || '';
        document.getElementById('pelatihanSubmit').textContent = '💾 Simpan Perubahan';
        document.getElementById('pelatihanCancelEdit').hidden = false;
        setFormOpen(true);
    }

    async function submitForm(event) {
        event.preventDefault();
        if (!isAdmin()) return notify('Hanya admin yang dapat menambahkan folder Pelatihan.', 'error');
        const id = String(document.getElementById('pelatihanSourceId')?.value || '').trim();
        const displayName = String(document.getElementById('pelatihanDisplayName')?.value || '').trim().slice(0, 120);
        const rawLink = String(document.getElementById('pelatihanFolderLink')?.value || '').trim();
        let normalized;
        try { normalized = normalizeFolderLink(rawLink); } catch (error) { return notify(error.message, 'error'); }

        const existing = id ? loadRecords().find(item => String(item.id) === id) : null;
        const record = {
            ...(existing || {}),
            id: id || `pelatihan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            folderUrl: normalized.sourceUrl,
            folderId: normalized.folderId,
            displayName,
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const submit = document.getElementById('pelatihanSubmit');
        if (submit) submit.disabled = true;
        try {
            const saved = await upsertRecord(record);
            libraries.delete(String(saved.id || record.id));
            resetForm({ close: true });
            render({ force: true });
        } catch (error) {
            notify(error?.message || 'Link folder Pelatihan gagal disimpan.', 'error');
        } finally {
            if (submit) submit.disabled = false;
        }
    }

    async function deleteSource(id) {
        if (!isAdmin()) return notify('Hanya admin yang dapat menghapus folder Pelatihan.', 'error');
        const item = loadRecords().find(record => String(record.id) === String(id));
        if (!item) return;
        if (!window.confirm('Hapus link folder ini dari Pelatihan? File asli di Google Drive tidak akan dihapus.')) return;
        try {
            await removeRecord(id);
            libraries.delete(String(id));
            render();
        } catch (error) {
            notify(error?.message || 'Folder Pelatihan gagal dihapus.', 'error');
        }
    }

    function findBook(bookId) {
        for (const cached of libraries.values()) {
            const library = cached?.library;
            const book = library?.books?.find(item => String(item.id) === String(bookId));
            if (book) return { book, library };
        }
        return null;
    }

    function previewDialog() {
        return document.querySelector('#pelatihanPreviewModal .pa-wa-modal-dialog');
    }

    function setFullscreenButton(active) {
        const button = document.getElementById('pelatihanFullscreen');
        if (!button) return;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.textContent = active ? '⛶ Keluar Full Screen' : '⛶ Full Screen';
    }

    async function toggleFullscreen() {
        const dialog = previewDialog();
        if (!dialog) return;
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else if (typeof dialog.requestFullscreen === 'function') await dialog.requestFullscreen();
        } catch {
            notify('Mode full screen tidak didukung pada perangkat ini.', 'error');
        }
    }

    function openPreview(bookId, trigger) {
        const found = findBook(bookId);
        if (!found) return notify('Buku belum selesai dimuat. Coba lagi sebentar.', 'error');
        const { book } = found;
        const modal = document.getElementById('pelatihanPreviewModal');
        const frame = document.getElementById('pelatihanPreviewFrame');
        if (!modal || !frame) return;
        activePreview = book;
        lastPreviewFocus = trigger || document.activeElement;
        document.getElementById('pelatihanPreviewTitle').textContent = book.name || 'Preview Buku';
        document.getElementById('pelatihanPreviewSubtitle').textContent = [book.type, book.folderPath].filter(Boolean).join(' • ');
        const status = document.getElementById('pelatihanPreviewStatus');
        if (status) {
            status.hidden = false;
            status.textContent = 'Memuat preview dari Google Drive...';
        }
        frame.src = book.previewUrl || 'about:blank';
        frame.onload = () => { if (status) status.hidden = true; };
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('pa-modal-open');
        requestAnimationFrame(() => modal.querySelector('.pa-wa-modal-close')?.focus());
    }

    async function closePreview(restoreFocus = true) {
        const modal = document.getElementById('pelatihanPreviewModal');
        const frame = document.getElementById('pelatihanPreviewFrame');
        if (document.fullscreenElement && previewDialog()?.contains(document.fullscreenElement)) {
            try { await document.exitFullscreen(); } catch (_) {}
        }
        if (frame) {
            frame.onload = null;
            frame.src = 'about:blank';
        }
        if (modal) {
            modal.hidden = true;
            modal.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('pa-modal-open');
        activePreview = null;
        setFullscreenButton(false);
        if (restoreFocus && lastPreviewFocus && typeof lastPreviewFocus.focus === 'function') lastPreviewFocus.focus();
        lastPreviewFocus = null;
    }

    function bindEvents() {
        document.getElementById('pelatihanForm')?.addEventListener('submit', submitForm);
        document.getElementById('pelatihanAddToggle')?.addEventListener('click', () => setFormOpen(document.getElementById('pelatihanFormCard')?.hidden !== false));
        document.getElementById('pelatihanCancelEdit')?.addEventListener('click', () => resetForm({ close: true }));
        document.getElementById('pelatihanRefresh')?.addEventListener('click', () => render({ force: true }));
        document.getElementById('pelatihanSearch')?.addEventListener('input', renderShelves);
        document.querySelector('[data-tab="pelatihan"]')?.addEventListener('click', () => render());
        document.getElementById('pelatihanFullscreen')?.addEventListener('click', toggleFullscreen);
        document.addEventListener('fullscreenchange', () => setFullscreenButton(Boolean(document.fullscreenElement && previewDialog()?.contains(document.fullscreenElement))));

        document.getElementById('pelatihanShelfList')?.addEventListener('click', event => {
            const preview = event.target.closest('[data-pelatihan-preview]');
            if (preview) return openPreview(preview.dataset.pelatihanPreview, preview);
            const retry = event.target.closest('[data-pelatihan-retry]');
            if (retry) {
                const record = loadRecords().find(item => String(item.id) === String(retry.dataset.pelatihanRetry));
                if (record) fetchLibrary(record, { force: true });
                return;
            }
            const edit = event.target.closest('[data-pelatihan-edit]');
            if (edit) return editSource(edit.dataset.pelatihanEdit);
            const remove = event.target.closest('[data-pelatihan-delete]');
            if (remove) return deleteSource(remove.dataset.pelatihanDelete);
        });

        document.querySelectorAll('[data-close-pelatihan-preview]').forEach(element => element.addEventListener('click', () => closePreview()));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !document.getElementById('pelatihanPreviewModal')?.hidden) closePreview();
        });
        window.addEventListener('pa-cloud-data-updated', event => {
            if (event.detail && Object.prototype.hasOwnProperty.call(event.detail, 'pelatihan')) {
                libraries.clear();
                render({ force: true });
            }
        });
    }

    function init() {
        ensureMarkup();
        bindEvents();
        renderShelves();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();

    window.PAPelatihan = { render, normalizeFolderLink, openPreview, closePreview };
})();
