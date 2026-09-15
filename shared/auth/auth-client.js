(function () {
    'use strict';

    const AUTH_KEY = 'pa_auth_session_v1';
    const TUTOR_KEY = 'pa_tutors_v3';
    const USER_CACHE_PREFIX = 'pa_user_cache_v1:';
    const LAST_USERNAME_KEY = 'pa_last_username_v1';

    function loadJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === '') return fallback;
            const parsed = JSON.parse(raw);
            return parsed === null || parsed === undefined ? fallback : parsed;
        } catch (error) {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
        return value;
    }

    function escapeHTML(text) {
        return String(text || '').replace(/[&<>"']/g, function (match) {
            return ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            })[match];
        });
    }

    function normalizeWA(number) {
        let clean = String(number || '').replace(/\D/g, '');
        if (clean.startsWith('0')) clean = '62' + clean.slice(1);
        if (clean && !clean.startsWith('62')) clean = '62' + clean;
        return clean;
    }

    function makeId(prefix) {
        return prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    }

    function slugifyName(name) {
        return String(name || 'tutor')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '')
            .slice(0, 14) || 'tutor';
    }

    function getSession() {
        return loadJSON(AUTH_KEY, null);
    }

    function setSession(session) {
        saveJSON(AUTH_KEY, session);
        if (session && session.username) localStorage.setItem(LAST_USERNAME_KEY, String(session.username));
        return session;
    }

    function sessionIdentity(session) {
        const current = session || getSession();
        if (!current) return 'guest';
        const identity = current.userId || current.tutorId || current.username || current.nama || 'user';
        return String(identity).replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function userDataKey(key, session) {
        return USER_CACHE_PREFIX + sessionIdentity(session) + ':' + String(key || 'data');
    }

    function loadUserJSON(key, fallback, session) {
        return loadJSON(userDataKey(key, session), fallback);
    }

    function saveUserJSON(key, value, session) {
        return saveJSON(userDataKey(key, session), value);
    }

    function removeUserData(key, session) {
        localStorage.removeItem(userDataKey(key, session));
    }

    function migrateLegacyDashboardData(keys, session) {
        const current = session || getSession();
        if (!current || current.role !== 'admin') return;
        (keys || []).forEach(key => {
            const scopedKey = userDataKey(key, current);
            if (localStorage.getItem(scopedKey) !== null) return;
            const legacy = localStorage.getItem(key);
            if (legacy !== null) localStorage.setItem(scopedKey, legacy);
        });
    }

    function loadTutors() {
        const tutors = loadJSON(TUTOR_KEY, []);
        const oldApplicants = loadJSON('petaAcademyTutorApplicants', []);

        if (tutors.length === 0 && oldApplicants.length > 0) {
            const migrated = oldApplicants.map((item, index) => ({
                id: item.id || makeId('tutor'),
                nama: item.nama || 'Tentor',
                wa: normalizeWA(item.wa),
                email: item.email || '',
                domisili: item.domisili || '',
                pendidikan: item.pendidikan || '',
                mapel: item.mapel || '',
                jenjang: item.jenjang || '',
                pengalaman: item.pengalaman || '',
                jadwal: item.jadwal || '',
                foto: item.foto || '',
                username: item.username || `${slugifyName(item.nama)}${index + 1}`,
                password: item.password || `PA${String(1000 + index).slice(-4)}`,
                createdAt: item.createdAt || new Date().toISOString()
            }));
            saveJSON(TUTOR_KEY, migrated);
            return migrated;
        }

        return tutors;
    }

    function saveTutors(tutors) {
        return saveJSON(TUTOR_KEY, tutors);
    }

    function loadUserTutors(session) {
        return loadUserJSON(TUTOR_KEY, [], session);
    }

    function saveUserTutors(tutors, session) {
        return saveUserJSON(TUTOR_KEY, tutors, session);
    }

    function createTutorCredential(name, wa) {
        const tutors = loadTutors();
        const base = slugifyName(name);
        const lastDigits = String(wa || '').replace(/\D/g, '').slice(-4) || Math.floor(1000 + Math.random() * 9000);
        let username = `${base}${lastDigits}`;
        let counter = 1;

        while (tutors.some(tutor => String(tutor.username).toLowerCase() === username.toLowerCase()) || username.toLowerCase() === 'putri') {
            username = `${base}${lastDigits}${counter}`;
            counter++;
        }

        const password = 'PA' + Math.random().toString(36).slice(2, 6).toUpperCase() + lastDigits;
        return { username, password };
    }

    async function logout() {
        const session = getSession();
        try {
            if (session && session.token && window.PACloud && PACloud.isLoginConfigured()) {
                await Promise.race([
                    PACloud.request('logout', { token: session.token }, { skipToken: true }),
                    new Promise(resolve => setTimeout(resolve, 700))
                ]);
            }
        } catch (error) {
            console.warn('Logout server gagal:', error);
        } finally {
            localStorage.removeItem(AUTH_KEY);
            window.location.href = 'login.html';
        }
    }

    function clearSession() {
        localStorage.removeItem(AUTH_KEY);
    }

    function requireLogin() {
        const session = getSession();
        if (!session || !session.token) {
            const from = encodeURIComponent(location.pathname.split('/').pop() || 'jadwal_laporan.html');
            window.location.replace(`login.html?from=${from}`);
            return null;
        }
        return session;
    }

    async function login(username, password) {
        const user = String(username || '').trim();
        const pass = String(password || '');

        if (!user || !pass) {
            return { success: false, message: 'Username dan password wajib diisi.' };
        }

        if (!window.PACloud || !PACloud.isLoginConfigured()) {
            return {
                success: false,
                code: 'CLOUD_NOT_CONFIGURED',
                message: 'Login online belum aktif. Isi LOGIN_SCRIPT_URL di cloud.js.'
            };
        }

        const response = await PACloud.request('login', { username: user, password: pass }, { skipToken: true });
        const result = response.result || { success: false };
        if (result.success && result.session) setSession(result.session);
        return result;
    }

    function getLastUsername() {
        return localStorage.getItem(LAST_USERNAME_KEY) || '';
    }

    function updateAuthNav() {
        const session = getSession();
        document.querySelectorAll('[data-auth-link]').forEach(link => {
            if (session) {
                link.textContent = session.role === 'admin' ? 'Dashboard Admin' : 'Dashboard Tentor';
                link.href = 'jadwal_laporan.html';
                link.classList.add('btn-daftar');
            } else {
                link.textContent = 'Dashboard';
                link.href = 'login.html';
                link.classList.add('btn-daftar');
            }
        });

        document.querySelectorAll('[data-user-badge]').forEach(target => {
            if (!session || !session.token) {
                target.innerHTML = '<a href="login.html" class="btn-daftar">Login</a>';
                return;
            }
            const roleLabel = session.role === 'admin'
                ? ((session.isMainAdmin === true || String(session.userId || '') === 'admin-main') ? 'Admin Utama' : 'Admin')
                : 'Tentor';
            target.innerHTML = `
                <span class="pa-user-pill">${escapeHTML(session.nama)} · ${roleLabel}</span>
                <button type="button" class="pa-logout-btn" data-logout>Logout</button>
            `;
        });

        document.querySelectorAll('[data-logout]').forEach(btn => {
            if (btn.dataset.logoutBound === 'true') return;
            btn.dataset.logoutBound = 'true';
            btn.addEventListener('click', logout);
        });
    }

    window.PAAuth = {
        AUTH_KEY,
        TUTOR_KEY,
        USER_CACHE_PREFIX,
        loadJSON,
        saveJSON,
        loadUserJSON,
        saveUserJSON,
        removeUserData,
        userDataKey,
        sessionIdentity,
        migrateLegacyDashboardData,
        escapeHTML,
        normalizeWA,
        makeId,
        loadTutors,
        saveTutors,
        loadUserTutors,
        saveUserTutors,
        createTutorCredential,
        getSession,
        setSession,
        clearSession,
        logout,
        requireLogin,
        login,
        getLastUsername,
        updateAuthNav
    };

    document.addEventListener('DOMContentLoaded', updateAuthNav);
})();
