/*
  Kelas Senja Cloud Sync — local-first
  - Dashboard membaca dan menyimpan data dari cache akun terlebih dahulu.
  - Data baru dikirim/ditarik saat tombol "Sinkronkan" ditekan.
  - Halaman publik tetap dapat memakai sinkronisasi langsung untuk pendaftaran/galeri.
*/
(function () {
    'use strict';

    const CONFIG = {
        // Backend Cloudflare Worker berada pada domain yang sama.
        LOGIN_SCRIPT_URL: '/api',

        // Semua data operasional juga memakai endpoint yang sama.
        DATA_SCRIPT_URL: '/api'
    };

    const LOGIN_ACTIONS = new Set(['login', 'resetPassword', 'logout']);
    const WRITE_ACTIONS = new Set([
        'upsertRecord',
        'deleteRecord',
        'setReportHistoryMark',
        'approvePendaftar',
        'approveInvoicePayment',
        'parentSubmitPaymentProof',
        'registerTutor',
        'resetPassword'
    ]);

    function emitCloudWriteEvent(type, action) {
        window.dispatchEvent(new CustomEvent('pa-cloud-write-' + type, {
            detail: { action: String(action || ''), at: new Date().toISOString() }
        }));
    }

    const KEY_TO_TABLE = {
        'pa_tutors_v3': 'tutors',
        'pa_students_v3': 'siswa',
        'pa_schedules_v3': 'jadwal',
        'pa_reports_v3': 'laporan',
        'pa_attendance_v1': 'absensi',
        'pa_invoices_v1': 'invoice',
        'pa_gallery_v3': 'gallery',
        'pa_public_registrations_v1': 'pendaftar',
        'pa_tutor_salary_v1': 'gaji',
        'pa_student_rates_v1': 'tarif',
        'pa_bank_soal_v1': 'bank_soal',
        'pa_pelatihan_v1': 'pelatihan'
    };

    const TABLE_TO_KEY = Object.fromEntries(Object.entries(KEY_TO_TABLE).map(([key, table]) => [table, key]));
    const QUEUE_PREFIX = 'pa_sync_queue_v3:';
    const REPORT_MARK_QUEUE_PREFIX = 'pa_report_history_mark_queue_v1:';
    const LAST_SYNC_PREFIX = 'pa_last_cloud_sync_v2:';
    const TABLE_SYNC_CURSOR_PREFIX = 'pa_table_sync_cursor_v1:';
    const DASHBOARD_TABLES = new Set(['tutors', 'siswa', 'jadwal', 'laporan', 'absensi', 'invoice', 'pendaftar', 'gaji', 'tarif', 'bank_soal', 'pelatihan']);
    // Tabel berikut dapat tumbuh sangat besar. Cache browser hanya menyimpan
    // jendela data terbaru; data lengkap dibaca per halaman dari D1 saat menu dibuka.
    const PAGED_TABLES = new Set(['jadwal', 'laporan', 'absensi', 'invoice']);
    const INCREMENTAL_TABLES = new Set(['tutors', 'siswa', 'jadwal', 'absensi', 'invoice', 'pendaftar', 'gaji', 'tarif', 'bank_soal', 'pelatihan']);
    const PAGED_LOCAL_CACHE_LIMITS = Object.freeze({
        jadwal: 240,
        laporan: 120,
        absensi: 320,
        invoice: 320
    });
    const DASHBOARD_OVERVIEW_KEY = 'pa_dashboard_overview_v1';
    const dashboardLocalShadow = new Map();
    let syncing = false;

    function isUrlConfigured(url) {
        return Boolean(String(url || '').trim());
    }

    // Kompatibilitas lama: isConfigured() berarti API data utama sudah siap.
    function isConfigured() {
        return isUrlConfigured(CONFIG.DATA_SCRIPT_URL);
    }

    function isLoginConfigured() {
        return isUrlConfigured(CONFIG.LOGIN_SCRIPT_URL);
    }

    function apiUrlForAction(action) {
        return LOGIN_ACTIONS.has(String(action || ''))
            ? CONFIG.LOGIN_SCRIPT_URL
            : CONFIG.DATA_SCRIPT_URL;
    }

    function getSession() {
        return window.PAAuth && typeof PAAuth.getSession === 'function' ? PAAuth.getSession() : null;
    }

    function identity() {
        const session = getSession();
        if (window.PAAuth && typeof PAAuth.sessionIdentity === 'function') return PAAuth.sessionIdentity(session);
        return String((session && (session.userId || session.tutorId || session.username)) || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function queueStorageKey() {
        return QUEUE_PREFIX + identity();
    }

    function lastSyncStorageKey() {
        return LAST_SYNC_PREFIX + identity();
    }

    function reportMarkQueueStorageKey() {
        return REPORT_MARK_QUEUE_PREFIX + identity();
    }

    function safeJSON(value, fallback) {
        try {
            const parsed = JSON.parse(value);
            return parsed === null || parsed === undefined ? fallback : parsed;
        } catch (error) {
            return fallback;
        }
    }

    function tableAllowedForCurrentSession(table) {
        const session = getSession();
        return !(session && session.role === 'tutor' && (table === 'invoice' || table === 'bank_soal' || table === 'pelatihan'));
    }

    function getQueue() {
        const value = safeJSON(localStorage.getItem(queueStorageKey()) || '[]', []);
        return Array.isArray(value)
            ? value.filter(item => item && DASHBOARD_TABLES.has(item.table) && tableAllowedForCurrentSession(item.table))
            : [];
    }

    function setQueue(queue) {
        const safeQueue = Array.isArray(queue)
            ? queue.filter(item => item && DASHBOARD_TABLES.has(item.table) && tableAllowedForCurrentSession(item.table))
            : [];
        localStorage.setItem(queueStorageKey(), JSON.stringify(safeQueue));
        emitSyncState();
        return safeQueue;
    }

    function getReportMarkQueue() {
        const value = safeJSON(localStorage.getItem(reportMarkQueueStorageKey()) || '[]', []);
        return Array.isArray(value)
            ? value.filter(item => item && String(item.reportId || '').trim())
            : [];
    }

    function setReportMarkQueue(queue) {
        const latestByReport = new Map();
        (Array.isArray(queue) ? queue : []).forEach(item => {
            const reportId = String(item?.reportId || '').trim();
            if (!reportId) return;
            latestByReport.set(reportId, {
                reportId,
                isMarked: item.isMarked === true,
                queuedAt: String(item.queuedAt || new Date().toISOString())
            });
        });
        const safeQueue = Array.from(latestByReport.values());
        localStorage.setItem(reportMarkQueueStorageKey(), JSON.stringify(safeQueue));
        emitSyncState();
        return safeQueue;
    }

    function queueReportHistoryMark(reportId, isMarked) {
        const id = String(reportId || '').trim();
        if (!id) return getReportMarkQueue();
        const next = getReportMarkQueue().filter(item => String(item.reportId) !== id);
        next.push({ reportId: id, isMarked: isMarked === true, queuedAt: new Date().toISOString() });
        return setReportMarkQueue(next);
    }

    function clearQueuedReportHistoryMark(reportId) {
        const id = String(reportId || '').trim();
        if (!id) return getReportMarkQueue();
        return setReportMarkQueue(getReportMarkQueue().filter(item => String(item.reportId) !== id));
    }

    function queueOperation(operation) {
        if (!operation || !DASHBOARD_TABLES.has(operation.table) || !tableAllowedForCurrentSession(operation.table)) return getQueue();
        const id = String(operation.id || (operation.record && operation.record.id) || '');
        if (!id) return getQueue();
        const queueId = operation.table + ':' + id;
        const next = getQueue().filter(item => item.queueId !== queueId);
        next.push({
            queueId,
            table: operation.table,
            type: operation.type === 'delete' ? 'delete' : 'upsert',
            id,
            record: operation.type === 'delete' ? undefined : operation.record,
            queuedAt: new Date().toISOString()
        });
        return setQueue(next);
    }

    function queueTableDiff(table, previousRecords, nextRecords) {
        if (!DASHBOARD_TABLES.has(table)) return;
        const previous = Array.isArray(previousRecords) ? previousRecords : [];
        const next = Array.isArray(nextRecords) ? nextRecords : [];
        const oldMap = new Map(previous.filter(item => item && item.id).map(item => [String(item.id), item]));
        const newMap = new Map(next.filter(item => item && item.id).map(item => [String(item.id), item]));

        // Untuk tabel berhalaman, tidak adanya record di jendela cache BUKAN berarti
        // record tersebut dihapus dari database. Penghapusan harus selalu eksplisit.
        if (!PAGED_TABLES.has(table)) {
            oldMap.forEach((item, id) => {
                if (!newMap.has(id)) queueOperation({ table, type: 'delete', id });
            });
        }
        newMap.forEach((item, id) => {
            const oldItem = oldMap.get(id);
            if (!oldItem || JSON.stringify(oldItem) !== JSON.stringify(item)) {
                queueOperation({ table, type: 'upsert', id, record: item });
            }
        });
    }

    function getDirtyTables() {
        return [...new Set(getQueue().map(item => item.table))];
    }

    function markDirty(keyOrTable) {
        const table = KEY_TO_TABLE[keyOrTable] || keyOrTable;
        const key = TABLE_TO_KEY[table];
        if (!DASHBOARD_TABLES.has(table) || !key) return getDirtyTables();
        readDashboardLocal(key).forEach(record => {
            if (record && record.id) queueOperation({ table, type: 'upsert', id: record.id, record });
        });
        return getDirtyTables();
    }

    function clearDirty(tables) {
        const remove = new Set(tables || getDirtyTables());
        setQueue(getQueue().filter(item => !remove.has(item.table)));
        return getDirtyTables();
    }

    function removeQueuedOperation(queueId) {
        setQueue(getQueue().filter(item => item.queueId !== queueId));
    }

    function clearQueuedRecord(table, id) {
        const queueId = String(table || '') + ':' + String(id || '');
        if (!table || !id) return getQueue();
        return setQueue(getQueue().filter(item => item.queueId !== queueId));
    }

    function currentLocalRecord(table, id) {
        const key = TABLE_TO_KEY[table];
        if (!key) return null;
        const records = readDashboardLocal(key);
        return records.find(item => item && String(item.id || '') === String(id || '')) || null;
    }

    function normalizedQueueForCurrentLocalState() {
        return getQueue().map(operation => {
            const localRecord = currentLocalRecord(operation.table, operation.id);

            // Antrean lama tidak boleh menghapus data yang sekarang masih ada di perangkat.
            if (localRecord) {
                return {
                    ...operation,
                    type: 'upsert',
                    record: localRecord
                };
            }

            // Jika data sudah tidak ada secara lokal, pastikan server juga menghapusnya.
            return {
                ...operation,
                type: 'delete',
                record: undefined
            };
        });
    }

    function tableSyncCursorStorageKey(table) {
        return TABLE_SYNC_CURSOR_PREFIX + identity() + ':' + String(table || '');
    }

    function getTableSyncCursor(table) {
        const raw = safeJSON(localStorage.getItem(tableSyncCursorStorageKey(table)) || '{}', {});
        return {
            at: String(raw?.at || ''),
            id: String(raw?.id || '')
        };
    }

    function setTableSyncCursor(table, cursor) {
        const safe = {
            at: String(cursor?.at || ''),
            id: String(cursor?.id || '')
        };
        if (!safe.at) return getTableSyncCursor(table);
        localStorage.setItem(tableSyncCursorStorageKey(table), JSON.stringify(safe));
        return safe;
    }

    function seedTableSyncCursor(table, serverNow) {
        if (!INCREMENTAL_TABLES.has(String(table || '')) || getTableSyncCursor(table).at) return getTableSyncCursor(table);
        const parsed = Date.parse(String(serverNow || ''));
        const safeAt = Number.isFinite(parsed)
            ? new Date(Math.max(0, parsed - 2000)).toISOString()
            : String(serverNow || new Date().toISOString());
        return setTableSyncCursor(table, { at: safeAt, id: '' });
    }

    function getLastSync() {
        return localStorage.getItem(lastSyncStorageKey()) || '';
    }

    function setLastSync(value) {
        localStorage.setItem(lastSyncStorageKey(), value || new Date().toISOString());
        emitSyncState();
    }

    function getSyncState() {
        const dirtyTables = getDirtyTables();
        const pendingReportMarks = getReportMarkQueue().length;
        return {
            dirtyTables,
            pendingCount: dirtyTables.length + pendingReportMarks,
            pendingOperations: getQueue().length + pendingReportMarks,
            pendingReportMarks,
            lastSync: getLastSync(),
            configured: isConfigured(),
            syncing
        };
    }

    function emitSyncState(extra) {
        window.dispatchEvent(new CustomEvent('pa-sync-state', { detail: { ...getSyncState(), ...(extra || {}) } }));
    }

    function cacheVersion(item) {
        if (!item) return '';
        const raw = item.photoUpdatedAt || item.fotoUpdatedAt || item.updatedAt || item.createdAt || item.fotoFileId || item.fileId || '';
        if (!raw) return '';
        let hash = 0;
        const text = String(raw);
        for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
        return Math.abs(hash).toString(36);
    }

    function appendVersion(url, version) {
        const source = String(url || '');
        if (!source || !version || source.startsWith('data:') || source.startsWith('blob:')) return source;
        const separator = source.includes('?') ? '&' : '?';
        return source + separator + 'v=' + encodeURIComponent(version);
    }

    function driveImageUrl(fileId, size = 1600, version = '') {
        if (!fileId) return '';
        const url = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w' + Number(size || 1600);
        return appendVersion(url, version);
    }

    function cloudFileUrl(fileId, version = '') {
        const id = String(fileId || '');
        if (!id) return '';
        if (id.startsWith('r2-')) return appendVersion('/files/' + encodeURIComponent(id), version);
        return driveImageUrl(id, 1600, version);
    }

    function imageSrc(item, field = 'src') {
        if (!item) return '';
        const version = cacheVersion(item);
        const fileId = item.fileId || item.fotoFileId || item.imageFileId || '';
        if (fileId) return cloudFileUrl(fileId, version);
        return appendVersion(item[field] || item.url || item.data || '', version);
    }

    function showUnifiedToast(text, options = {}) {
        const message = String(text || '').trim();
        if (!message || !document.body) return;

        // Bersihkan elemen toast cloud versi lama agar tidak pernah menumpuk.
        const legacyCloudToast = document.getElementById('paCloudStatus');
        if (legacyCloudToast) {
            clearTimeout(legacyCloudToast._hideTimer);
            legacyCloudToast.classList.remove('show');
            legacyCloudToast.remove();
        }

        let el = document.getElementById('paToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'paToast';
            el.className = 'pa-toast';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.setAttribute('aria-atomic', 'true');
            document.body.appendChild(el);
        }

        const type = String(options.type || 'info');
        const duration = Math.max(1600, Number(options.duration) || (type === 'error' ? 4200 : 2600));

        clearTimeout(el._hideTimer);
        clearTimeout(el._cleanupTimer);
        el.hidden = false;
        el.textContent = message;
        el.dataset.type = type;

        if (options.color) el.style.background = String(options.color);
        else el.style.removeProperty('background');

        // Paksa browser memulai animasi dari keadaan tersembunyi saat toast dipakai ulang.
        el.classList.remove('show');
        void el.offsetWidth;
        requestAnimationFrame(() => el.classList.add('show'));

        el._hideTimer = setTimeout(() => {
            el.classList.remove('show');
            el._cleanupTimer = setTimeout(() => {
                if (!el.classList.contains('show')) {
                    el.textContent = '';
                    el.hidden = true;
                    el.style.removeProperty('background');
                }
            }, 260);
        }, duration);
    }

    // Satu pengelola notifikasi untuk seluruh dashboard agar toast tidak bertumpuk.
    window.PANotify = showUnifiedToast;

    function showCloudStatus(text, type) {
        showUnifiedToast(text, {
            type: type || 'info',
            duration: type === 'error' ? 4200 : 2500
        });
    }

    async function request(action, payload = {}, options = {}) {
        const apiUrl = apiUrlForAction(action);
        if (!isUrlConfigured(apiUrl)) {
            const isLoginAction = LOGIN_ACTIONS.has(String(action || ''));
            const error = new Error(isLoginAction
                ? 'Endpoint login belum dikonfigurasi.'
                : 'Endpoint data belum dikonfigurasi.');
            error.code = isLoginAction ? 'LOGIN_CLOUD_NOT_CONFIGURED' : 'CLOUD_NOT_CONFIGURED';
            throw error;
        }

        const session = getSession();
        const body = { action, ...payload };
        if (!options.skipToken && session && session.token && !body.token) body.token = session.token;

        const isWriteAction = WRITE_ACTIONS.has(String(action || ''));
        if (isWriteAction) emitCloudWriteEvent('start', action);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(options.timeout || 20000));
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(body),
                signal: controller.signal,
                cache: 'no-store'
            });
            const result = await response.json();
            if (!result || result.ok !== true) {
                const error = new Error((result && result.message) || 'Permintaan ke server gagal.');
                error.code = (result && result.code) || 'REQUEST_FAILED';
                throw error;
            }
            return result;
        } catch (error) {
            if (error && error.name === 'AbortError') {
                const timeoutError = new Error('Koneksi terlalu lama. Coba tekan Sinkronkan lagi.');
                timeoutError.code = 'TIMEOUT';
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            if (isWriteAction) emitCloudWriteEvent('end', action);
        }
    }

    function hasEmbeddedImage(value, depth = 0) {
        if (depth > 5 || value === null || value === undefined) return false;
        if (typeof value === 'string') return value.startsWith('data:image/');
        if (Array.isArray(value)) return value.some(item => hasEmbeddedImage(item, depth + 1));
        if (typeof value === 'object') return Object.values(value).some(item => hasEmbeddedImage(item, depth + 1));
        return false;
    }

    function requestTimeoutForPayload(payload, fallback = 20000) {
        return hasEmbeddedImage(payload) ? 60000 : fallback;
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = [...document.scripts].find(script => script.src && script.src.endsWith('/' + src));
            if (existing) {
                if (existing.dataset.loaded === 'true') resolve(existing);
                else existing.addEventListener('load', () => resolve(existing), { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.defer = true;
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                resolve(script);
            }, { once: true });
            script.addEventListener('error', reject, { once: true });
            document.body.appendChild(script);
        });
    }

    function pagedCacheLimit(table) {
        return Number(PAGED_LOCAL_CACHE_LIMITS[String(table || '')] || 180);
    }

    function readDashboardLocal(key) {
        const table = KEY_TO_TABLE[key];
        if (table && dashboardLocalShadow.has(table)) return dashboardLocalShadow.get(table).slice();

        // Cache versi lama kadang berukuran beberapa MB. Jangan memaksa JSON.parse
        // sinkron pada main thread hanya untuk menampilkan data awal.
        if (table && PAGED_TABLES.has(table) && window.PAAuth && typeof PAAuth.userDataKey === 'function') {
            const session = getSession();
            const scopedKey = PAAuth.userDataKey(key, session);
            const raw = localStorage.getItem(scopedKey);
            if (raw && raw.length > 1200000) return [];
        }

        const records = window.PAAuth && typeof PAAuth.loadUserJSON === 'function'
            ? PAAuth.loadUserJSON(key, [])
            : safeJSON(localStorage.getItem(key) || '[]', []);
        const safe = Array.isArray(records) ? records : [];
        if (table && PAGED_TABLES.has(table)) {
            const bounded = safe.slice(0, pagedCacheLimit(table));
            dashboardLocalShadow.set(table, bounded);
            return bounded.slice();
        }
        if (table) dashboardLocalShadow.set(table, safe.slice());
        return safe;
    }

    function writeDashboardLocal(key, value) {
        const table = KEY_TO_TABLE[key];
        const records = Array.isArray(value) ? value : [];
        const cached = table && PAGED_TABLES.has(table)
            ? records.slice(0, pagedCacheLimit(table))
            : records;
        if (table) dashboardLocalShadow.set(table, cached.slice());
        if (window.PAAuth && typeof PAAuth.saveUserJSON === 'function') PAAuth.saveUserJSON(key, cached);
        else localStorage.setItem(key, JSON.stringify(cached));
        return cached;
    }

    function mergeDashboardLocal(key, incoming, deletedIds = []) {
        const table = KEY_TO_TABLE[key];
        const current = readDashboardLocal(key);
        const deleted = new Set((Array.isArray(deletedIds) ? deletedIds : []).map(id => String(id || '')).filter(Boolean));
        const byId = new Map();
        current.forEach(item => {
            const id = String(item?.id || '');
            if (id && !deleted.has(id)) byId.set(id, item);
        });
        (Array.isArray(incoming) ? incoming : []).forEach(item => {
            const id = String(item?.id || '');
            if (id && !deleted.has(id)) byId.set(id, item);
        });
        const merged = Array.from(byId.values()).sort((a, b) => {
            const av = String(a?.updatedAt || a?.createdAt || '');
            const bv = String(b?.updatedAt || b?.createdAt || '');
            return bv.localeCompare(av);
        });
        return writeDashboardLocal(key, table && PAGED_TABLES.has(table) ? merged.slice(0, pagedCacheLimit(table)) : merged);
    }

    function getCachedDashboardOverview() {
        if (window.PAAuth && typeof PAAuth.loadUserJSON === 'function') {
            const value = PAAuth.loadUserJSON(DASHBOARD_OVERVIEW_KEY, {});
            return value && typeof value === 'object' ? value : {};
        }
        return safeJSON(localStorage.getItem(DASHBOARD_OVERVIEW_KEY) || '{}', {});
    }

    function writeDashboardOverviewLocal(value) {
        const data = value && typeof value === 'object' ? value : {};
        if (window.PAAuth && typeof PAAuth.saveUserJSON === 'function') PAAuth.saveUserJSON(DASHBOARD_OVERVIEW_KEY, data);
        else localStorage.setItem(DASHBOARD_OVERVIEW_KEY, JSON.stringify(data));
        return data;
    }

    async function fetchDashboardOverview(options = {}) {
        if (!isConfigured() || !getSession() || navigator.onLine === false) return getCachedDashboardOverview();
        const result = await request('getDashboardOverview', {
            today: options.today || new Date().toLocaleDateString('en-CA'),
            requestedAt: new Date().toISOString()
        }, { timeout: Number(options.timeout || 15000) });
        const dashboard = writeDashboardOverviewLocal(result.dashboard || {});
        if (options.dispatchEvent !== false) {
            window.dispatchEvent(new CustomEvent('pa-cloud-dashboard-updated', { detail: dashboard }));
        }
        return dashboard;
    }

    function getCachedTable(table) {
        const key = TABLE_TO_KEY[String(table || '')];
        return key ? readDashboardLocal(key) : [];
    }

    async function getTablePage(table, options = {}) {
        const safeTable = String(table || '');
        if (!DASHBOARD_TABLES.has(safeTable)) throw new Error('Tabel dashboard tidak dikenal.');
        const limit = Math.max(1, Math.min(100, Number(options.limit || 60) || 60));
        const offset = Math.max(0, Number(options.offset || 0) || 0);
        const result = await request('getTablePage', {
            table: safeTable,
            limit,
            offset,
            month: options.month || '',
            dateFrom: options.dateFrom || '',
            dateTo: options.dateTo || '',
            requestedAt: new Date().toISOString()
        }, { timeout: Number(options.timeout || 30000) });
        const records = Array.isArray(result.records) ? result.records : [];
        const key = TABLE_TO_KEY[safeTable];
        if (key && options.cache !== false) {
            if (PAGED_TABLES.has(safeTable) || options.mergeCache === true) mergeDashboardLocal(key, records);
            else writeDashboardLocal(key, records);
        }
        if (result.serverNow) seedTableSyncCursor(safeTable, result.serverNow);
        return {
            records,
            serverNow: String(result.serverNow || ''),
            page: result.page || { offset, limit, nextOffset: offset + records.length, hasMore: records.length >= limit }
        };
    }

    async function syncTableChanges(table, options = {}) {
        const safeTable = String(table || '');
        if (!INCREMENTAL_TABLES.has(safeTable)) {
            return { table: safeTable, records: [], deletedIds: [], unsupported: true };
        }
        const cursor = getTableSyncCursor(safeTable);
        if (!cursor.at) return { table: safeTable, records: [], deletedIds: [], needsSeed: true };

        const limit = Math.max(1, Math.min(100, Number(options.limit || 100) || 100));
        const maxPages = Math.max(1, Math.min(12, Number(options.maxPages || 6) || 6));
        const records = [];
        const deletedIds = [];
        let current = { ...cursor };
        let pageCount = 0;
        let hasMore = false;

        do {
            const result = await request('getTableChanges', {
                table: safeTable,
                cursorAt: current.at,
                cursorId: current.id,
                limit,
                requestedAt: new Date().toISOString()
            }, { timeout: Number(options.timeout || 20000) });
            const changes = Array.isArray(result.changes) ? result.changes : [];
            changes.forEach(change => {
                if (change?.type === 'delete') {
                    const id = String(change.id || '');
                    if (id) deletedIds.push(id);
                    return;
                }
                if (change?.type === 'upsert' && change.record) records.push(change.record);
            });
            const next = result.nextCursor || current;
            if (String(next.at || '') === String(current.at || '') && String(next.id || '') === String(current.id || '')) {
                hasMore = false;
                break;
            }
            current = { at: String(next.at || current.at), id: String(next.id || current.id) };
            setTableSyncCursor(safeTable, current);
            hasMore = result.hasMore === true;
            pageCount += 1;
        } while (hasMore && pageCount < maxPages);

        const key = TABLE_TO_KEY[safeTable];
        if (key && (records.length || deletedIds.length)) mergeDashboardLocal(key, records, deletedIds);
        if (records.length || deletedIds.length) {
            window.dispatchEvent(new CustomEvent('pa-cloud-table-updated', {
                detail: { table: safeTable, records, deletedIds, incremental: true, hasMore }
            }));
        }
        return { table: safeTable, records, deletedIds, hasMore, cursor: current };
    }

    function readPublicLocal(key) {
        return window.PAAuth && typeof PAAuth.loadJSON === 'function'
            ? PAAuth.loadJSON(key, [])
            : safeJSON(localStorage.getItem(key) || '[]', []);
    }

    function writePublicLocal(key, value) {
        if (window.PAAuth && typeof PAAuth.saveJSON === 'function') return PAAuth.saveJSON(key, value);
        localStorage.setItem(key, JSON.stringify(value));
        return value;
    }


    function updatePublicTutorCache(record, options = {}) {
        const key = TABLE_TO_KEY.tutors;
        if (!key) return [];
        const current = readPublicLocal(key);
        const id = String((record && record.id) || options.id || '');
        let next = current;

        if (options.remove === true) {
            next = current.filter(item => String((item && item.id) || '') !== id);
        } else if (record && id) {
            next = [record, ...current.filter(item => String((item && item.id) || '') !== id)];
        }

        writePublicLocal(key, next);
        const detail = { tutors: next, source: 'admin-update' };
        window.dispatchEvent(new CustomEvent('pa-cloud-data-updated', { detail }));
        window.dispatchEvent(new CustomEvent('pa-public-tutors-updated', { detail }));
        return next;
    }

    function isDashboardLocalFirst(key) {
        const table = KEY_TO_TABLE[key];
        return Boolean(getSession() && DASHBOARD_TABLES.has(table));
    }

    function saveLocalTable(key, value, options = {}) {
        const table = KEY_TO_TABLE[key];
        const records = Array.isArray(value) ? value : [];
        const previous = table && PAGED_TABLES.has(table) && dashboardLocalShadow.has(table)
            ? dashboardLocalShadow.get(table).slice()
            : readDashboardLocal(key);
        writeDashboardLocal(key, records);
        queueTableDiff(table, previous, records);
        if (options.toast !== false) showCloudStatus(options.localText || 'Tersimpan di perangkat • belum disinkronkan', 'local');
        return records;
    }

    async function saveKeyNow(key, value, options = {}) {
        const table = KEY_TO_TABLE[key];
        const records = Array.isArray(value) ? value : [];

        if (isDashboardLocalFirst(key)) return saveLocalTable(key, records, options);

        writePublicLocal(key, records);
        if (!table || !isConfigured()) return records;

        showCloudStatus(options.uploadText || 'Menyimpan online...', 'info');
        const requestPayload = { table, records };
        const result = await request('saveTable', requestPayload, {
            timeout: Number(options.timeout || requestTimeoutForPayload(requestPayload))
        });
        const savedRecords = result.records || records;
        writePublicLocal(key, savedRecords);
        showCloudStatus(options.successText || 'Data tersimpan online ✅', 'ok');
        return savedRecords;
    }

    async function upsertRecordNow(key, record, options = {}) {
        const table = KEY_TO_TABLE[key];
        const localFirst = isDashboardLocalFirst(key);
        const list = localFirst ? readDashboardLocal(key) : readPublicLocal(key);
        const next = [record, ...list.filter(item => item && item.id !== record.id)];
        const canSaveImmediately = Boolean(
            options.forceOnline && table && isConfigured() && getSession() && navigator.onLine !== false
        );

        if (localFirst && !canSaveImmediately) {
            saveLocalTable(key, next, options);
            return record;
        }

        if (localFirst && canSaveImmediately) {
            showCloudStatus(options.uploadText || 'Menyimpan online...', 'info');
            const requestPayload = { table, record };
            const result = await request('upsertRecord', requestPayload, {
                timeout: Number(options.timeout || requestTimeoutForPayload(requestPayload))
            });
            const savedRecord = result.record || record;
            writeDashboardLocal(key, [savedRecord, ...list.filter(item => item && item.id !== savedRecord.id)]);
            clearQueuedRecord(table, savedRecord.id);
            setLastSync(new Date().toISOString());
            showCloudStatus(options.successText || 'Data tersimpan online ✅', 'ok');
            return savedRecord;
        }

        writePublicLocal(key, next);
        if (!table || !isConfigured()) return record;

        showCloudStatus(options.uploadText || 'Menyimpan online...', 'info');
        const publicRegistration = !getSession() && table === 'pendaftar';
        const result = publicRegistration
            ? await request('registerStudent', { record }, { skipToken: true })
            : await request('upsertRecord', { table, record }, {
                timeout: Number(options.timeout || requestTimeoutForPayload({ table, record }))
            });
        const savedRecord = result.record || record;
        writePublicLocal(key, [savedRecord, ...list.filter(item => item && item.id !== savedRecord.id)]);
        showCloudStatus(options.successText || 'Data tersimpan online ✅', 'ok');
        return savedRecord;
    }

    async function deleteRecordNow(key, id, options = {}) {
        const table = KEY_TO_TABLE[key];
        const localFirst = isDashboardLocalFirst(key);
        const list = localFirst ? readDashboardLocal(key) : readPublicLocal(key);
        const next = list.filter(item => item && item.id !== id);
        const canDeleteImmediately = Boolean(
            options.forceOnline && table && isConfigured() && getSession() && navigator.onLine !== false
        );

        if (localFirst && !canDeleteImmediately) {
            if (PAGED_TABLES.has(table)) {
                writeDashboardLocal(key, next);
                queueOperation({ table, type: 'delete', id });
                if (options.toast !== false) showCloudStatus(options.localText || 'Penghapusan tersimpan lokal • sinkronkan saat online', 'local');
            } else {
                saveLocalTable(key, next, options);
            }
            return next;
        }

        if (localFirst && canDeleteImmediately) {
            showCloudStatus(options.uploadText || 'Menghapus online...', 'info');
            const result = await request('deleteRecord', { table, id });
            const records = result.records || next;
            writeDashboardLocal(key, records);
            clearQueuedRecord(table, id);
            setLastSync(new Date().toISOString());
            showCloudStatus(options.successText || 'Data terhapus online ✅', 'ok');
            return records;
        }

        writePublicLocal(key, next);
        if (!table || !isConfigured()) return next;

        showCloudStatus(options.uploadText || 'Menghapus online...', 'info');
        const result = await request('deleteRecord', { table, id });
        const records = result.records || next;
        writePublicLocal(key, records);
        showCloudStatus(options.successText || 'Data terhapus online ✅', 'ok');
        return records;
    }

    async function approvePendaftarNow(registrationId, tutorId, options = {}) {
        if (!registrationId || !tutorId) throw new Error('Pendaftar dan tentor wajib dipilih.');
        const siswaKey = TABLE_TO_KEY.siswa;
        const pendaftarKey = TABLE_TO_KEY.pendaftar;
        const siswaLocal = readDashboardLocal(siswaKey);
        const pendaftarLocal = readDashboardLocal(pendaftarKey);
        const item = pendaftarLocal.find(row => row && row.id === registrationId);
        if (!item) throw new Error('Data pendaftar tidak ditemukan.');

        if (isConfigured() && getSession() && navigator.onLine !== false) {
            if (options.uploadText !== false) {
                showCloudStatus(options.uploadText || 'Menyetujui pendaftar...', 'info');
            }
            const result = await request('approvePendaftar', { registrationId, tutorId });
            const siswa = result.siswa;
            const remaining = Array.isArray(result.pendaftar)
                ? result.pendaftar
                : pendaftarLocal.filter(row => row && row.id !== registrationId);
            if (siswa) writeDashboardLocal(siswaKey, [siswa, ...siswaLocal.filter(row => row && row.id !== siswa.id)]);
            writeDashboardLocal(pendaftarKey, remaining);
            setLastSync(new Date().toISOString());
            if (options.successText !== false) {
                showCloudStatus(options.successText || 'Pendaftar disetujui online ✅', 'ok');
            }
            return { siswa, pendaftar: remaining };
        }

        const normalizeUsername = value => String(value || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().trim().replace(/[^a-z0-9]/g, '').slice(0, 24);
        const nameParts = String(item.namaSiswa || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().trim().split(/\s+/)
            .map(part => part.replace(/[^a-z0-9]/g, '')).filter(Boolean);
        const candidates = [];
        const addCandidate = value => {
            const clean = normalizeUsername(value);
            if (clean && !candidates.includes(clean)) candidates.push(clean);
        };
        nameParts.forEach(addCandidate);
        if (nameParts.length > 1) {
            addCandidate(nameParts[0] + nameParts[1]);
            addCandidate(nameParts[0] + nameParts[nameParts.length - 1]);
            addCandidate(nameParts.join(''));
            addCandidate(nameParts[nameParts.length - 1] + nameParts[0]);
        }
        if (!candidates.length) candidates.push('siswa');
        const used = new Set(siswaLocal.map(row => String(row?.username || '').toLowerCase()).filter(Boolean));
        let username = candidates.find(candidate => !used.has(candidate));
        if (!username) {
            const baseUsername = candidates[candidates.length - 1];
            let number = 2;
            username = (baseUsername + number).slice(0, 24);
            while (used.has(username)) username = (baseUsername + (++number)).slice(0, 24);
        }

        const siswa = {
            id: 'siswa-' + Date.now() + '-' + Math.random().toString(16).slice(2),
            nama: item.namaSiswa || '',
            namaPanggilan: item.namaPanggilan || item.panggilan || '',
            ortu: item.namaOrtu || '',
            wa: item.waOrtu || '',
            jenisKelamin: item.jenisKelamin || '',
            kelas: item.kelas || item.jenjang || '',
            sekolah: item.sekolah || '',
            alamat: item.alamat || '',
            frekuensiLes: item.frekuensiLes || '',
            lokasiLes: item.lokasiLes || '',
            kemampuanBaca: item.kemampuanBaca || '',
            karakteristik: item.karakteristik || '',
            waktuTidakBisa: item.waktuTidakBisa || '',
            subKelas: 'Belum ditentukan',
            namaKelompok: '',
            isPrivat: false,
            semiPrivatGroups: [],
            kelompokGroupName: '',
            username,
            pin: String(Math.floor(1000 + Math.random() * 9000)),
            status: 'Aktif',
            tutorId,
            asalPendaftaranId: item.id,
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString()
        };
        const remaining = pendaftarLocal.filter(row => row && row.id !== registrationId);
        saveLocalTable(siswaKey, [siswa, ...siswaLocal], { toast: false });
        saveLocalTable(pendaftarKey, remaining, { toast: false });
        if (options.localText !== false) {
            showCloudStatus(options.localText || 'Disetujui lokal • sinkronkan saat online', 'local');
        }
        return { siswa, pendaftar: remaining };
    }

    function storeCloudData(data, options = {}) {
        const payload = data || {};
        Object.keys(TABLE_TO_KEY).forEach(table => {
            if (!Object.prototype.hasOwnProperty.call(payload, table)) return;
            const key = TABLE_TO_KEY[table];
            if (DASHBOARD_TABLES.has(table) && getSession()) writeDashboardLocal(key, payload[table] || []);
            else writePublicLocal(key, payload[table] || []);
        });

        if (payload.theme) {
            if (window.PATheme && typeof PATheme.receiveGlobalTheme === 'function') PATheme.receiveGlobalTheme(payload.theme);
            else localStorage.setItem('pa_theme_global_v2', JSON.stringify(payload.theme));
        }

        if (options.markSynced !== false) setLastSync(new Date().toISOString());
        if (options.dispatchEvent !== false) {
            window.dispatchEvent(new CustomEvent('pa-cloud-data-updated', { detail: payload }));
        }
        return payload;
    }

    async function boot(options = {}) {
        if (!options.publicOnly) {
            emitSyncState();
            return { localFirst: true, data: null };
        }
        if (!isConfigured()) return { offline: true, data: null };
        try {
            const result = await request('getPublic', {}, { skipToken: true });
            storeCloudData(result.data || {}, { markSynced: false });
            return result.data || {};
        } catch (error) {
            console.error(error);
            return { offline: true, error: error.message };
        }
    }

    async function runWithConcurrency(items, worker, concurrency = 3) {
        const list = Array.isArray(items) ? items : [];
        let cursor = 0;
        const count = Math.max(1, Math.min(Number(concurrency) || 3, list.length || 1));
        await Promise.all(Array.from({ length: count }, async () => {
            while (cursor < list.length) {
                const index = cursor++;
                await worker(list[index], index);
            }
        }));
    }

    async function syncNow(options = {}) {
        if (syncing) return null;
        const session = getSession();
        if (!session || !session.token) {
            const error = new Error('Silakan login kembali sebelum sinkronisasi.');
            error.code = 'UNAUTHORIZED';
            throw error;
        }
        if (!isConfigured()) {
            const error = new Error('Backend Cloudflare belum dikonfigurasi.');
            error.code = 'CLOUD_NOT_CONFIGURED';
            throw error;
        }

        const dirty = getDirtyTables();
        syncing = true;
        emitSyncState({ syncing: true });
        showCloudStatus(dirty.length ? 'Mengirim perubahan lokal...' : 'Memeriksa data terbaru...', 'info');

        try {
            const queuedOperations = normalizedQueueForCurrentLocalState();
            // Operasi lokal tetap berurutan karena jadwal -> absensi -> laporan/invoice
            // dapat memiliki relasi. Menjalankannya paralel bisa membuat record anak
            // tiba di server sebelum record induknya.
            for (const operation of queuedOperations) {
                if (operation.type === 'delete') {
                    await request('deleteRecord', { table: operation.table, id: operation.id });
                } else {
                    await request('upsertRecord', { table: operation.table, record: operation.record });
                }
                removeQueuedOperation(operation.queueId);
            }

            await runWithConcurrency(getReportMarkQueue(), async mark => {
                await request('setReportHistoryMark', {
                    reportId: mark.reportId,
                    isMarked: mark.isMarked
                });
                clearQueuedReportHistoryMark(mark.reportId);
            }, 3);

            // Sinkronisasi tidak lagi menarik seluruh database. Setelah perubahan
            // terkirim, cukup refresh ringkasan dashboard. Tabel besar akan diambil
            // per halaman ketika menu terkait benar-benar dibuka.
            const dashboard = await fetchDashboardOverview({
                today: options.today,
                timeout: Number(options.timeout || 20000),
                dispatchEvent: options.dispatchEvent !== false
            });
            const data = { dashboard };

            // Bila layar aktif sudah punya cursor incremental, ambil hanya perubahan
            // sejak sinkron terakhir. Tidak perlu menarik ulang satu halaman penuh.
            const requestedTables = [...new Set((Array.isArray(options.tables) ? options.tables : [])
                .map(table => String(table || ''))
                .filter(table => INCREMENTAL_TABLES.has(table)))];
            await runWithConcurrency(requestedTables, async table => {
                data[table] = await syncTableChanges(table, { maxPages: 8, timeout: Number(options.timeout || 20000) });
            }, 2);

            syncing = false;
            setLastSync(new Date().toISOString());
            emitSyncState({ syncing: false, success: true });
            showCloudStatus('Sinkronisasi data selesai ✅', 'ok');

            // Backup Drive tidak boleh menahan tombol Sinkronkan. Jalankan sesudah
            // data selesai agar koneksi Drive yang lambat tidak membuat UI terasa macet.
            if (session.role === 'admin') {
                void request('dailyBackupOnSync', {
                    requestedAt: new Date().toISOString()
                }, { timeout: 120000 }).catch(backupError => {
                    console.warn('Backup otomatis di background gagal:', backupError);
                });
            }
            return data;
        } catch (error) {
            console.error(error);
            syncing = false;
            emitSyncState({ syncing: false, error: error.message });
            if (error.code === 'UNAUTHORIZED') {
                showCloudStatus('Sesi cloud habis. Login kembali untuk sinkronisasi.', 'error');
            } else {
                showCloudStatus(error.message || 'Sinkronisasi gagal.', 'error');
            }
            throw error;
        }
    }

    async function syncTheme(theme) {
        if (!isConfigured()) throw new Error('Backend Cloudflare belum dikonfigurasi.');
        const session = getSession();
        const mainAdmin = window.PATheme && typeof PATheme.isMainAdmin === 'function'
            ? PATheme.isMainAdmin(session)
            : Boolean(session && session.role === 'admin' && String(session.userId || '') === 'admin-main');
        if (!mainAdmin) {
            const error = new Error('Hanya admin utama yang dapat menerapkan tema untuk semua pengguna.');
            error.code = 'FORBIDDEN';
            throw error;
        }
        const result = await request('saveTheme', { theme });
        showCloudStatus('Tema utama tersimpan online ✅', 'ok');
        return result.theme || theme;
    }

    async function setReportHistoryMarkNow(reportId, isMarked, options = {}) {
        const id = String(reportId || '').trim();
        if (!id) throw new Error('ID laporan belum tersedia.');

        queueReportHistoryMark(id, isMarked);
        if (!isConfigured() || !getSession() || navigator.onLine === false) {
            if (options.localText !== false) {
                showCloudStatus(options.localText || 'Tanda laporan tersimpan lokal • sinkronkan saat online', 'local');
            }
            return { reportId: id, historyMarked: isMarked === true, queued: true };
        }

        try {
            const result = await request('setReportHistoryMark', {
                reportId: id,
                isMarked: isMarked === true
            });
            clearQueuedReportHistoryMark(id);
            setLastSync(new Date().toISOString());
            if (options.successText !== false) {
                showCloudStatus(options.successText || 'Tanda laporan tersinkron ✅', 'ok');
            }
            return result.report || { reportId: id, historyMarked: isMarked === true };
        } catch (error) {
            showCloudStatus(error.message || 'Tanda laporan belum dapat disinkronkan.', 'error');
            throw error;
        }
    }

    async function refreshReportHistoryMarks(options = {}) {
        if (!isConfigured() || !getSession() || navigator.onLine === false) return [];
        try {
            const result = await request('getReportHistoryMarks', {
                requestedAt: new Date().toISOString()
            }, { timeout: 20000 });
            const marks = Array.isArray(result.marks) ? result.marks : [];
            const markedIds = new Set(marks
                .filter(item => item && item.isMarked !== false)
                .map(item => String(item.reportId || item.id || '').trim())
                .filter(Boolean));

            // Perubahan yang masih mengantre di perangkat ini selalu menang atas
            // snapshot server agar klik offline tidak berkedip atau hilang.
            getReportMarkQueue().forEach(item => {
                const id = String(item?.reportId || '').trim();
                if (!id) return;
                if (item.isMarked === true) markedIds.add(id);
                else markedIds.delete(id);
            });

            const reportKey = TABLE_TO_KEY.laporan;
            if (reportKey) {
                const reports = readDashboardLocal(reportKey).map(report => ({
                    ...report,
                    historyMarked: markedIds.has(String(report?.id || ''))
                }));
                writeDashboardLocal(reportKey, reports);
            }

            window.dispatchEvent(new CustomEvent('pa-report-history-marks-updated', {
                detail: { marks, markedIds: [...markedIds] }
            }));
            return marks;
        } catch (error) {
            if (options.silent !== true) {
                showCloudStatus(error.message || 'Tanda laporan belum dapat diperbarui.', 'error');
            }
            if (options.throwOnError === true) throw error;
            return [];
        }
    }

    async function parentLogin(username, pin) {
        const result = await request('parentLogin', { username, pin }, { skipToken: true });
        return result.result || { success: false };
    }

    async function parentGetData(parentToken) {
        // requestedAt membuat setiap permintaan unik dan cache browser/proxy tidak memakai respons lama.
        const result = await request('parentGetData', {
            parentToken,
            requestedAt: new Date().toISOString()
        }, { skipToken: true });
        return result.data || { student: {}, laporan: [], absensi: [], invoice: [] };
    }

    async function parentSubmitPaymentProof(parentToken, invoiceId, proofData, fileName) {
        const result = await request('parentSubmitPaymentProof', {
            parentToken,
            invoiceId,
            proofData,
            fileName,
            requestedAt: new Date().toISOString()
        }, { skipToken: true, timeout: 60000 });
        return result.invoice;
    }

    async function approveInvoicePaymentNow(invoiceId) {
        const result = await request('approveInvoicePayment', {
            invoiceId,
            requestedAt: new Date().toISOString()
        }, { timeout: 30000 });
        return result.invoice;
    }

    async function parentLogout(parentToken) {
        return request('parentLogout', { parentToken }, { skipToken: true, timeout: 5000 });
    }

    async function resetPassword(username, identityValue, newPassword) {
        const result = await request('resetPassword', { username, identity: identityValue, newPassword }, { skipToken: true });
        return result.result || { success: false };
    }

    async function registerTutor(record, options = {}) {
        if (!isConfigured()) throw new Error('Pendaftaran tentor membutuhkan koneksi ke backend Cloudflare.');
        showCloudStatus(options.uploadText || 'Menyimpan pendaftaran tentor...', 'info');
        const result = await request('registerTutor', { record }, { skipToken: true });
        showCloudStatus(options.successText || 'Akun tentor tersimpan online ✅', 'ok');
        return result.tutor;
    }

    async function fileBase64(fileId) {
        if (!fileId || !isConfigured()) return null;
        const result = await request('fileBase64', { fileId });
        return result.dataUrl || null;
    }

    // Kompatibilitas dengan kode lama: sekarang hanya menandai perubahan lokal.
    function syncKey(key) {
        markDirty(key);
    }

    function forceSyncAll() {
        return syncNow();
    }

    window.PACloud = {
        CONFIG,
        isConfigured,
        isLoginConfigured,
        apiUrlForAction,
        KEY_TO_TABLE,
        TABLE_TO_KEY,
        boot,
        request,
        fetchDashboardOverview,
        getCachedDashboardOverview,
        getCachedTable,
        getTablePage,
        syncTableChanges,
        loadScript,
        syncKey,
        saveLocalTable,
        saveKeyNow,
        upsertRecordNow,
        deleteRecordNow,
        approvePendaftarNow,
        parentLogin,
        parentGetData,
        parentSubmitPaymentProof,
        approveInvoicePaymentNow,
        parentLogout,
        resetPassword,
        registerTutor,
        syncTheme,
        setReportHistoryMarkNow,
        refreshReportHistoryMarks,
        syncNow,
        forceSyncAll,
        markDirty,
        clearDirty,
        getSyncState,
        getDirtyTables,
        getQueue,
        getReportMarkQueue,
        clearQueuedRecord,
        clearQueuedReportHistoryMark,
        getLastSync,
        getTableSyncCursor,
        fileBase64,
        driveImageUrl,
        cloudFileUrl,
        imageSrc,
        updatePublicTutorCache,
        showCloudStatus
    };

    setTimeout(emitSyncState, 0);
})();
