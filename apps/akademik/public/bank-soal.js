(function () {
    'use strict';

    const STORAGE_KEY = 'pa_bank_soal_v1';
    const ALLOWED_TYPES = new Set(['PDF', 'Dokumen', 'Spreadsheet', 'Presentasi', 'Gambar', 'Lainnya']);
    const GOOGLE_DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
    const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
    const MAX_DRIVE_URL_LENGTH = 2048;
    const BOOKS_PER_SHELF = 6;
    let records = [];
    let activePreviewId = '';
    let lastPreviewFocus = null;


    function panelTemplate() {
        return `
    <div class="pa-bank-soal-layout">
        <section class="pa-bank-hero" aria-labelledby="bankSoalPageTitle">
            <div class="pa-bank-hero-copy">
                <span class="pa-bank-kicker">📚 Perpustakaan Digital</span>
                <h3 id="bankSoalPageTitle">Bank Soal Kelas Senja</h3>
            </div>
            <div class="pa-bank-hero-actions">
                <span class="pa-bank-count" id="bankSoalCount">0 file</span>
                <button type="button" class="pa-btn pa-btn-primary admin-only" id="bankSoalAddToggle" aria-expanded="false" aria-controls="bankSoalFormCard">➕ Tambah File</button>
            </div>
        </section>

        <section class="pa-card pa-bank-soal-form-card admin-only" id="bankSoalFormCard" hidden>
            <div class="pa-bank-soal-head">
                <div>
                    <span class="pa-bank-kicker">Khusus Admin</span>
                    <h3>Tambahkan dari Google Drive</h3>
                    <p>Tempel link satu file. File tidak diunggah ulang ke server.</p>
                </div>
            </div>
            <form id="bankSoalForm" class="pa-bank-form" novalidate>
                <input type="hidden" id="bankSoalId">
                <div class="pa-form-group">
                    <label for="bankSoalJudul">Judul buku / soal</label>
                    <input id="bankSoalJudul" maxlength="120" required placeholder="Contoh: Latihan Matematika Kelas 6">
                </div>
                <div class="pa-form-group">
                    <label for="bankSoalKategori">Kategori / mata pelajaran</label>
                    <input id="bankSoalKategori" maxlength="60" placeholder="Contoh: Matematika">
                </div>
                <div class="pa-form-group">
                    <label for="bankSoalKelas">Kelas / jenjang</label>
                    <input id="bankSoalKelas" maxlength="60" placeholder="Contoh: Kelas 6 SD">
                </div>
                <div class="pa-form-group">
                    <label for="bankSoalJenis">Jenis file</label>
                    <select id="bankSoalJenis">
                        <option>PDF</option>
                        <option>Dokumen</option>
                        <option>Spreadsheet</option>
                        <option>Presentasi</option>
                        <option>Gambar</option>
                        <option>Lainnya</option>
                    </select>
                </div>
                <div class="pa-form-group pa-full">
                    <label for="bankSoalLink">Link Google Drive</label>
                    <input type="url" id="bankSoalLink" maxlength="2048" required placeholder="https://drive.google.com/file/d/.../view">
                    <small class="pa-bank-drive-help"><span>🔗</span><span>Gunakan link satu file dengan akses “Siapa saja yang memiliki link” sebagai Viewer. Link folder tidak diterima.</span></small>
                </div>
                <div class="pa-form-group pa-full">
                    <label for="bankSoalDeskripsi">Keterangan singkat</label>
                    <textarea id="bankSoalDeskripsi" maxlength="500" placeholder="Materi, semester, atau catatan tambahan."></textarea>
                </div>
                <div class="pa-form-actions pa-full">
                    <button type="submit" class="pa-btn pa-btn-primary" id="bankSoalSubmit">💾 Simpan File</button>
                    <button type="button" class="pa-btn pa-btn-soft" id="bankSoalReset">🔄 Kosongkan</button>
                    <button type="button" class="pa-btn pa-btn-soft" id="bankSoalCancelEdit" hidden>↩️ Batal Edit</button>
                </div>
            </form>
        </section>

        <section class="pa-bank-library-card" aria-labelledby="bankSoalLibraryTitle">
            <div class="pa-bank-library-head">
                <div>
                    <span class="pa-bank-kicker">Rak Buku</span>
                    <h3 id="bankSoalLibraryTitle">Koleksi Bank Soal</h3>
                </div>
                <em class="pa-bank-role-note" id="bankSoalRoleNote">Mode baca tentor</em>
            </div>
            <div class="pa-bank-toolbar">
                <label class="pa-bank-search">
                    <span aria-hidden="true">🔎</span>
                    <input type="search" id="bankSoalSearch" placeholder="Cari judul, mapel, kelas, atau jenis file...">
                </label>
                <select id="bankSoalCategoryFilter" aria-label="Filter kategori bank soal">
                    <option value="all">Semua kategori</option>
                </select>
                <select id="bankSoalClassFilter" aria-label="Filter kelas bank soal">
                    <option value="all">Semua kelas</option>
                </select>
            </div>
            <div id="bankSoalList" class="pa-bookshelf-list" aria-live="polite"></div>
        </section>
    </div>
        `;
    }

    function previewModalTemplate() {
        return `
<div class="pa-wa-modal pa-bank-preview-modal" id="bankSoalPreviewModal" hidden aria-hidden="true">
    <div class="pa-wa-modal-backdrop" data-close-bank-preview></div>
    <section class="pa-wa-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="bankSoalPreviewTitle">
        <div class="pa-wa-modal-head">
            <div>
                <span class="pa-wa-modal-kicker">Bank Soal</span>
                <h2 id="bankSoalPreviewTitle">Preview Bank Soal</h2>
                <p id="bankSoalPreviewSubtitle">File Google Drive</p>
            </div>
            <button type="button" class="pa-wa-modal-close" data-close-bank-preview aria-label="Tutup preview bank soal">×</button>
        </div>
        <div class="pa-wa-modal-body pa-bank-preview-body">
            <span class="pa-bank-preview-status" id="bankSoalPreviewStatus">Memuat preview dari Google Drive...</span>
            <iframe
                id="bankSoalPreviewFrame"
                class="pa-bank-preview-frame"
                src="about:blank"
                title="Preview Bank Soal"
                loading="lazy"
                scrolling="yes"
                referrerpolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-forms"
                allowfullscreen></iframe>
        </div>
        <div class="pa-wa-modal-actions pa-bank-preview-actions">
            <button type="button" class="pa-btn pa-btn-soft pa-bank-fullscreen-btn" id="bankSoalFullscreen" data-bank-fullscreen aria-pressed="false">⛶ Full Screen</button>
            <button type="button" class="pa-btn pa-btn-primary" data-close-bank-preview>Tutup Preview</button>
        </div>
    </section>
</div>
        `;
    }

    function ensureMarkup() {
        const root = document.querySelector('[data-bank-soal-root]');
        if (root && !document.getElementById('bankSoalList')) root.innerHTML = panelTemplate();
        if (root && !isAdmin()) {
            root.querySelectorAll('.admin-only').forEach(element => { element.style.display = 'none'; });
        }
        if (!document.getElementById('bankSoalPreviewModal')) {
            document.body.insertAdjacentHTML('beforeend', previewModalTemplate());
        }
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
            : String(value || '').replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
            })[char]);
    }

    function notify(message, type = 'info') {
        if (window.PACloud && typeof PACloud.showCloudStatus === 'function') {
            PACloud.showCloudStatus(message, type);
            return;
        }
        if (typeof window.PANotify === 'function') window.PANotify(message, { type });
    }

    function cleanFileId(value) {
        const id = String(value || '').trim();
        return FILE_ID_PATTERN.test(id) ? id : '';
    }

    function resourceKeyQuery(url) {
        const resourceKey = String(url.searchParams.get('resourcekey') || '').trim();
        return resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : '';
    }

    function normalizeGoogleDriveLink(value) {
        const raw = String(value || '').trim();
        if (!raw) throw new Error('Link Google Drive wajib diisi.');
        if (raw.length > MAX_DRIVE_URL_LENGTH) throw new Error('Link Google Drive terlalu panjang.');

        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new Error('Link Google Drive tidak valid.');
        }

        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || !GOOGLE_DRIVE_HOSTS.has(host)) {
            throw new Error('Gunakan link HTTPS dari Google Drive atau Google Docs.');
        }

        const path = url.pathname.replace(/\/+$/, '');
        const resourceQuery = resourceKeyQuery(url);
        let fileId = '';
        let kind = 'drive-file';
        let previewUrl = '';
        let sourceUrl = '';

        if (host === 'drive.google.com') {
            const fileMatch = path.match(/^\/file\/(?:u\/\d+\/)?d\/([^/]+)/i);
            fileId = cleanFileId(fileMatch?.[1] || url.searchParams.get('id'));
            if (!fileId) {
                if (/^\/drive\/folders\//i.test(path)) {
                    throw new Error('Link folder belum didukung. Masukkan link satu file Google Drive.');
                }
                throw new Error('ID file Google Drive tidak ditemukan pada link.');
            }
            previewUrl = `https://drive.google.com/file/d/${fileId}/preview${resourceQuery}`;
            sourceUrl = `https://drive.google.com/file/d/${fileId}/view${resourceQuery}`;
        } else {
            const docsMatch = path.match(/^\/(document|spreadsheets|presentation|drawings)\/(?:u\/\d+\/)?d\/([^/]+)/i);
            if (!docsMatch) throw new Error('Jenis link Google Docs belum didukung.');
            kind = docsMatch[1].toLowerCase();
            fileId = cleanFileId(docsMatch[2]);
            if (!fileId) throw new Error('ID file Google Docs tidak valid.');
            previewUrl = `https://docs.google.com/${kind}/d/${fileId}/preview${resourceQuery}`;
            sourceUrl = `https://docs.google.com/${kind}/d/${fileId}/view${resourceQuery}`;
        }

        return { fileId, kind, previewUrl, sourceUrl };
    }

    function inferType(kind, selectedType) {
        if (kind === 'document') return 'Dokumen';
        if (kind === 'spreadsheets') return 'Spreadsheet';
        if (kind === 'presentation') return 'Presentasi';
        return ALLOWED_TYPES.has(selectedType) ? selectedType : 'PDF';
    }

    function loadRecords() {
        const raw = window.PAAuth && typeof PAAuth.loadUserJSON === 'function'
            ? PAAuth.loadUserJSON(STORAGE_KEY, [])
            : [];
        records = (Array.isArray(raw) ? raw : [])
            .filter(item => item && item.id)
            .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        return records;
    }

    function saveRecordsLocal(next, message) {
        records = Array.isArray(next) ? next : [];
        if (window.PACloud && typeof PACloud.saveLocalTable === 'function') {
            PACloud.saveLocalTable(STORAGE_KEY, records, {
                localText: message || 'Bank soal tersimpan lokal • tekan Sinkronkan'
            });
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
                    uploadText: 'Menyimpan bank soal online...',
                    successText: 'Bank soal tersimpan dan siap dibaca tentor ✅'
                });
                records = [saved, ...current.filter(item => String(item.id) !== String(saved.id))];
                return saved;
            } catch (error) {
                if (['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_DRIVE_LINK', 'INVALID_BANK_SOAL'].includes(String(error?.code || ''))) throw error;
                saveRecordsLocal(
                    [record, ...current.filter(item => String(item.id) !== String(record.id))],
                    'Koneksi terputus • bank soal diantrikan untuk Sinkronkan'
                );
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
                    uploadText: 'Menghapus bank soal...',
                    successText: 'Bank soal berhasil dihapus ✅'
                });
                return;
            } catch (error) {
                if (String(error?.code || '') === 'FORBIDDEN') throw error;
            }
        }
        saveRecordsLocal(current.filter(item => String(item.id) !== String(id)), 'Penghapusan diantrikan • tekan Sinkronkan');
    }

    function typeIcon(type) {
        return ({
            PDF: '📕', Dokumen: '📘', Spreadsheet: '📊', Presentasi: '📽️', Gambar: '🖼️', Lainnya: '📎'
        })[type] || '📎';
    }

    function formatDate(value) {
        const date = new Date(value || 0);
        if (Number.isNaN(date.getTime())) return 'Belum disinkronkan';
        return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function hashTone(value) {
        const text = String(value || 'bank-soal');
        let hash = 0;
        for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
        return Math.abs(hash % 9) + 1;
    }

    function chunk(list, size) {
        const output = [];
        for (let index = 0; index < list.length; index += size) output.push(list.slice(index, index + size));
        return output;
    }

    function filteredRecords() {
        const query = String(document.getElementById('bankSoalSearch')?.value || '').trim().toLowerCase();
        const category = String(document.getElementById('bankSoalCategoryFilter')?.value || 'all');
        const className = String(document.getElementById('bankSoalClassFilter')?.value || 'all');
        return loadRecords().filter(item => {
            const haystack = [item.judul, item.kategori, item.kelas, item.jenisFile, item.deskripsi]
                .join(' ').toLowerCase();
            const matchesQuery = !query || haystack.includes(query);
            const matchesCategory = category === 'all' || String(item.kategori || '') === category;
            const matchesClass = className === 'all' || String(item.kelas || '') === className;
            return matchesQuery && matchesCategory && matchesClass;
        });
    }

    function renderCategoryOptions() {
        const select = document.getElementById('bankSoalCategoryFilter');
        if (!select) return;
        const selected = select.value || 'all';
        const categories = [...new Set(loadRecords().map(item => String(item.kategori || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'id'));
        select.innerHTML = '<option value="all">Semua kategori</option>' + categories
            .map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join('');
        select.value = categories.includes(selected) ? selected : 'all';
    }

    function renderClassOptions() {
        const select = document.getElementById('bankSoalClassFilter');
        if (!select) return;
        const selected = select.value || 'all';
        const classes = [...new Set(loadRecords().map(item => String(item.kelas || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'id', { numeric: true, sensitivity: 'base' }));
        select.innerHTML = '<option value="all">Semua kelas</option>' + classes
            .map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join('');
        select.value = classes.includes(selected) ? selected : 'all';
    }

    function bookMarkup(item) {
        const tone = hashTone(item.id || item.judul);
        const subtitle = [item.kategori, item.kelas].filter(Boolean).join(' • ') || 'Koleksi Bank Soal';
        return `
            <article class="pa-book-card pa-book-tone-${tone}" data-bank-id="${escapeHTML(item.id)}">
                <button type="button" class="pa-book-cover" data-bank-preview="${escapeHTML(item.id)}" aria-label="Buka preview ${escapeHTML(item.judul)}">
                    <span class="pa-book-topline">
                        <span class="pa-book-icon" aria-hidden="true">${typeIcon(item.jenisFile)}</span>
                        <em>${escapeHTML(item.jenisFile || 'File')}</em>
                    </span>
                    <strong class="pa-book-title">${escapeHTML(item.judul)}</strong>
                    <span class="pa-book-subtitle">${escapeHTML(subtitle)}</span>
                    <small class="pa-book-updated">Diperbarui ${escapeHTML(formatDate(item.updatedAt || item.createdAt))}</small>
                    <span class="pa-book-open">Baca / Preview <span aria-hidden="true">›</span></span>
                </button>
                ${isAdmin() ? `
                    <div class="pa-book-admin-actions" aria-label="Aksi admin untuk ${escapeHTML(item.judul)}">
                        <button type="button" data-bank-edit="${escapeHTML(item.id)}" title="Edit ${escapeHTML(item.judul)}" aria-label="Edit ${escapeHTML(item.judul)}">✏️</button>
                        <button type="button" data-bank-delete="${escapeHTML(item.id)}" title="Hapus ${escapeHTML(item.judul)}" aria-label="Hapus ${escapeHTML(item.judul)}">🗑️</button>
                    </div>` : ''}
            </article>`;
    }

    function render() {
        const target = document.getElementById('bankSoalList');
        if (!target) return;
        renderCategoryOptions();
        renderClassOptions();
        const visible = filteredRecords();
        const count = document.getElementById('bankSoalCount');
        if (count) count.textContent = `${visible.length} file`;

        const roleNote = document.getElementById('bankSoalRoleNote');
        if (roleNote) roleNote.textContent = isAdmin() ? 'Admin dapat mengelola koleksi' : 'Mode baca tentor';

        if (!visible.length) {
            target.innerHTML = `
                <div class="pa-bank-empty">
                    <span aria-hidden="true">📚</span>
                    <strong>${records.length ? 'Tidak ada buku yang cocok' : 'Rak bank soal masih kosong'}</strong>
                    <p>${isAdmin() ? 'Tekan Tambah File lalu tempel link satu file Google Drive.' : 'Admin belum menambahkan file yang dapat dibaca.'}</p>
                </div>`;
            return;
        }

        target.innerHTML = chunk(visible, BOOKS_PER_SHELF).map((shelf, index) => `
            <section class="pa-bookshelf-row" aria-label="Rak buku ${index + 1}">
                <div class="pa-book-row">${shelf.map(bookMarkup).join('')}</div>
            </section>`).join('');
    }

    function setFormOpen(open) {
        const card = document.getElementById('bankSoalFormCard');
        const toggle = document.getElementById('bankSoalAddToggle');
        if (!card || !isAdmin()) return;
        card.hidden = !open;
        if (toggle) {
            toggle.setAttribute('aria-expanded', String(open));
            toggle.innerHTML = open ? '✕ Tutup Form' : '➕ Tambah File';
        }
        if (open) requestAnimationFrame(() => document.getElementById('bankSoalJudul')?.focus());
    }

    function resetForm(options = {}) {
        const form = document.getElementById('bankSoalForm');
        if (!form) return;
        form.reset();
        document.getElementById('bankSoalId').value = '';
        document.getElementById('bankSoalJenis').value = 'PDF';
        const submit = document.getElementById('bankSoalSubmit');
        if (submit) submit.innerHTML = '💾 Simpan File';
        const cancel = document.getElementById('bankSoalCancelEdit');
        if (cancel) cancel.hidden = true;
        if (options.close === true) setFormOpen(false);
    }

    function editRecord(id) {
        if (!isAdmin()) return;
        const item = loadRecords().find(row => String(row.id) === String(id));
        if (!item) return;
        document.getElementById('bankSoalId').value = item.id || '';
        document.getElementById('bankSoalJudul').value = item.judul || '';
        document.getElementById('bankSoalKategori').value = item.kategori || '';
        document.getElementById('bankSoalKelas').value = item.kelas || '';
        document.getElementById('bankSoalJenis').value = ALLOWED_TYPES.has(item.jenisFile) ? item.jenisFile : 'Lainnya';
        document.getElementById('bankSoalLink').value = item.driveUrl || '';
        document.getElementById('bankSoalDeskripsi').value = item.deskripsi || '';
        document.getElementById('bankSoalSubmit').innerHTML = '💾 Simpan Perubahan';
        document.getElementById('bankSoalCancelEdit').hidden = false;
        setFormOpen(true);
        document.getElementById('bankSoalFormCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function submitForm(event) {
        event.preventDefault();
        if (!isAdmin()) return notify('Hanya admin yang dapat menambahkan bank soal.', 'error');

        const id = String(document.getElementById('bankSoalId').value || '').trim();
        const judul = String(document.getElementById('bankSoalJudul').value || '').trim();
        const kategori = String(document.getElementById('bankSoalKategori').value || '').trim();
        const kelas = String(document.getElementById('bankSoalKelas').value || '').trim();
        const selectedType = String(document.getElementById('bankSoalJenis').value || 'PDF');
        const driveUrl = String(document.getElementById('bankSoalLink').value || '').trim();
        const deskripsi = String(document.getElementById('bankSoalDeskripsi').value || '').trim();

        if (!judul) return notify('Judul file wajib diisi.', 'error');
        if (judul.length > 120 || kategori.length > 60 || kelas.length > 60 || deskripsi.length > 500) {
            return notify('Isi formulir terlalu panjang. Periksa judul, kategori, kelas, atau deskripsi.', 'error');
        }

        let drive;
        try {
            drive = normalizeGoogleDriveLink(driveUrl);
        } catch (error) {
            return notify(error.message, 'error');
        }

        const previous = loadRecords().find(item => String(item.id) === id);
        const now = new Date().toISOString();
        const record = {
            id: id || `bank-soal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            judul,
            kategori,
            kelas,
            jenisFile: inferType(drive.kind, selectedType),
            deskripsi,
            driveUrl: drive.sourceUrl,
            previewUrl: drive.previewUrl,
            driveFileId: drive.fileId,
            driveKind: drive.kind,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
            createdBy: previous?.createdBy || session()?.nama || session()?.username || 'Admin',
            updatedBy: session()?.nama || session()?.username || 'Admin'
        };

        const submit = document.getElementById('bankSoalSubmit');
        if (submit) submit.disabled = true;
        try {
            await upsertRecord(record);
            resetForm({ close: true });
            render();
        } catch (error) {
            notify(error.message || 'Bank soal gagal disimpan.', 'error');
        } finally {
            if (submit) submit.disabled = false;
        }
    }

    async function deleteRecord(id) {
        if (!isAdmin()) return;
        const item = loadRecords().find(row => String(row.id) === String(id));
        if (!item) return;
        if (!window.confirm(`Hapus bank soal “${item.judul}”?`)) return;
        try {
            await removeRecord(item.id);
            if (String(document.getElementById('bankSoalId')?.value || '') === String(item.id)) resetForm({ close: true });
            render();
        } catch (error) {
            notify(error.message || 'Bank soal gagal dihapus.', 'error');
        }
    }

    function openPreview(id, trigger) {
        const item = loadRecords().find(row => String(row.id) === String(id));
        if (!item) return;
        let drive;
        try {
            drive = normalizeGoogleDriveLink(item.driveUrl || item.previewUrl || '');
        } catch (error) {
            return notify(error.message || 'Link preview tidak valid.', 'error');
        }

        const modal = document.getElementById('bankSoalPreviewModal');
        const iframe = document.getElementById('bankSoalPreviewFrame');
        if (!modal || !iframe) return;
        activePreviewId = item.id;
        lastPreviewFocus = trigger || document.activeElement;
        document.getElementById('bankSoalPreviewTitle').textContent = item.judul || 'Preview Bank Soal';
        document.getElementById('bankSoalPreviewSubtitle').textContent = [item.jenisFile, item.kategori, item.kelas].filter(Boolean).join(' • ') || 'File Google Drive';
        const status = document.getElementById('bankSoalPreviewStatus');
        if (status) {
            status.hidden = false;
            status.textContent = 'Memuat preview dari Google Drive...';
        }
        iframe.onload = function () {
            if (status) status.hidden = true;
        };
        iframe.title = `Preview ${item.judul || 'Bank Soal'}`;
        iframe.src = drive.previewUrl;
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('pa-modal-open');
        updateFullscreenButton();
        requestAnimationFrame(() => modal.querySelector('[data-close-bank-preview]')?.focus());
    }

    function previewDialog() {
        return document.querySelector('#bankSoalPreviewModal .pa-wa-modal-dialog');
    }

    function isPreviewFullscreen() {
        const dialog = previewDialog();
        if (!dialog) return false;
        return document.fullscreenElement === dialog || dialog.classList.contains('is-fallback-fullscreen');
    }

    function updateFullscreenButton() {
        const button = document.getElementById('bankSoalFullscreen');
        if (!button) return;
        const fullscreen = isPreviewFullscreen();
        button.textContent = fullscreen ? '⛶ Exit Full Screen' : '⛶ Full Screen';
        button.setAttribute('aria-pressed', fullscreen ? 'true' : 'false');
        button.setAttribute('aria-label', fullscreen ? 'Keluar dari tampilan layar penuh' : 'Buka preview layar penuh');
    }

    async function togglePreviewFullscreen() {
        const dialog = previewDialog();
        if (!dialog) return;

        if (isPreviewFullscreen()) {
            if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
                try { await document.exitFullscreen(); } catch (_) {}
            }
            dialog.classList.remove('is-fallback-fullscreen');
            document.body.classList.remove('pa-bank-fallback-fullscreen');
            updateFullscreenButton();
            return;
        }

        if (typeof dialog.requestFullscreen === 'function') {
            try {
                await dialog.requestFullscreen();
                updateFullscreenButton();
                return;
            } catch (_) {
                // Browser tertentu dapat menolak Fullscreen API; gunakan fallback viewport penuh.
            }
        }

        dialog.classList.add('is-fallback-fullscreen');
        document.body.classList.add('pa-bank-fallback-fullscreen');
        updateFullscreenButton();
    }

    function resetPreviewFullscreen() {
        const dialog = previewDialog();
        if (document.fullscreenElement === dialog && typeof document.exitFullscreen === 'function') {
            document.exitFullscreen().catch(() => {});
        }
        dialog?.classList.remove('is-fallback-fullscreen');
        document.body.classList.remove('pa-bank-fallback-fullscreen');
        updateFullscreenButton();
    }

    function closePreview() {
        const modal = document.getElementById('bankSoalPreviewModal');
        const iframe = document.getElementById('bankSoalPreviewFrame');
        if (!modal || modal.hidden) return;
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        if (iframe) {
            iframe.onload = null;
            iframe.src = 'about:blank';
        }
        resetPreviewFullscreen();
        activePreviewId = '';
        document.body.classList.remove('pa-modal-open');
        if (lastPreviewFocus && typeof lastPreviewFocus.focus === 'function') lastPreviewFocus.focus();
        lastPreviewFocus = null;
    }

    function bindEvents() {
        document.getElementById('bankSoalForm')?.addEventListener('submit', submitForm);
        document.getElementById('bankSoalAddToggle')?.addEventListener('click', () => {
            const card = document.getElementById('bankSoalFormCard');
            setFormOpen(Boolean(card?.hidden));
        });
        document.getElementById('bankSoalReset')?.addEventListener('click', () => resetForm());
        document.getElementById('bankSoalCancelEdit')?.addEventListener('click', () => resetForm({ close: true }));
        document.getElementById('bankSoalSearch')?.addEventListener('input', render);
        document.getElementById('bankSoalCategoryFilter')?.addEventListener('change', render);
        document.getElementById('bankSoalClassFilter')?.addEventListener('change', render);
        document.querySelector('[data-tab="bank-soal"]')?.addEventListener('click', render);

        document.getElementById('bankSoalList')?.addEventListener('click', event => {
            const edit = event.target.closest('[data-bank-edit]');
            const remove = event.target.closest('[data-bank-delete]');
            const preview = event.target.closest('[data-bank-preview]');
            if (edit) editRecord(edit.dataset.bankEdit);
            else if (remove) deleteRecord(remove.dataset.bankDelete);
            else if (preview) openPreview(preview.dataset.bankPreview, preview);
        });

        document.querySelectorAll('[data-close-bank-preview]').forEach(element => element.addEventListener('click', closePreview));
        document.querySelector('[data-bank-fullscreen]')?.addEventListener('click', togglePreviewFullscreen);
        document.addEventListener('fullscreenchange', updateFullscreenButton);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !activePreviewId) return;
            if (isPreviewFullscreen()) return;
            closePreview();
        });
        window.addEventListener('pa-cloud-data-updated', event => {
            if (event.detail && Object.prototype.hasOwnProperty.call(event.detail, 'bank_soal')) render();
        });
    }

    function init() {
        ensureMarkup();
        bindEvents();
        resetForm({ close: true });
        render();
    }

    window.PABankSoal = { render, normalizeGoogleDriveLink, openPreview, closePreview };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
