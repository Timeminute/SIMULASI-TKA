import {
  ApiError, TABLES, clone, makeId, normalizeDate, normalizeIdentity,
  invoiceBelongsToStudentIdentity, normalizeName, normalizeTime, normalizeUsername, nowIso,
  recordBelongsToStudentIdentity, sanitizeInvoiceForParent, stripStudentPin, truthy, usernameCandidates
} from './utils.js';
import { randomToken, verifyPassword, hashPassword } from './crypto.js';
import { getMeta, setMeta } from './db.js';
import {
  clearAttempts, createOrUpdateUser, deleteRecord, deleteUser, destroySession,
  findRecordByUsername, getRecord, getUserById, getUserByUsername, listRecords, listReportHistoryMarks,
  rateLimitStatus, recordFailedAttempt, replaceTable, requireSession, saveSession,
  setReportHistoryMark, upsertRecord
} from './repository.js';
import { fileAsDataUrl, processRecordUploads, uploadDataUrl } from './files.js';
import { getDriveBackupSettings, runDriveBackup, runDriveBackupIfDueOnSync, setDriveBackupEnabled } from './backup.js';
import { normalizeGoogleDriveLink } from './drive-links.js';
import { normalizeGoogleDriveFolderLink, listPelatihanFolder } from './drive-folder.js';

const STAFF_TTL_DEFAULT = 6 * 60 * 60;
const PARENT_TTL_DEFAULT = 6 * 60 * 60;
const BANK_SOAL_TYPES = new Set(['PDF', 'Dokumen', 'Spreadsheet', 'Presentasi', 'Gambar', 'Lainnya']);

function normalizeBankSoalRecord(record) {
  const item = clone(record || {});
  const judul = String(item.judul || '').trim();
  const kategori = String(item.kategori || '').trim();
  const kelas = String(item.kelas || '').trim();
  const deskripsi = String(item.deskripsi || '').trim();

  if (!judul) throw new ApiError('Judul bank soal wajib diisi.', 'INVALID_BANK_SOAL');
  if (judul.length > 120 || kategori.length > 60 || kelas.length > 60 || deskripsi.length > 500) {
    throw new ApiError('Data bank soal terlalu panjang.', 'INVALID_BANK_SOAL');
  }

  let drive;
  try {
    drive = normalizeGoogleDriveLink(item.driveUrl || item.previewUrl || '');
  } catch (error) {
    throw new ApiError(error.message || 'Link Google Drive tidak valid.', 'INVALID_DRIVE_LINK');
  }

  const inferredType = drive.kind === 'document'
    ? 'Dokumen'
    : drive.kind === 'spreadsheets'
      ? 'Spreadsheet'
      : drive.kind === 'presentation'
        ? 'Presentasi'
        : '';

  return {
    ...item,
    judul,
    kategori,
    kelas,
    deskripsi,
    jenisFile: inferredType || (BANK_SOAL_TYPES.has(item.jenisFile) ? item.jenisFile : 'PDF'),
    driveUrl: drive.sourceUrl,
    previewUrl: drive.previewUrl,
    driveFileId: drive.fileId,
    driveKind: drive.kind
  };
}


function normalizePelatihanRecord(record) {
  const item = clone(record || {});
  let folder;
  try {
    folder = normalizeGoogleDriveFolderLink(item.folderUrl || item.driveUrl || '');
  } catch (error) {
    throw new ApiError(error.message || 'Link folder Google Drive tidak valid.', 'INVALID_DRIVE_FOLDER', 400);
  }
  return {
    ...item,
    folderUrl: folder.sourceUrl,
    folderId: folder.folderId,
    folderResourceKey: folder.resourceKey || '',
    displayName: String(item.displayName || '').trim().slice(0, 120)
  };
}

function ttl(env, key, fallback) {
  const value = Number(env[key] || fallback);
  return Number.isFinite(value) && value >= 1800 ? value : fallback;
}

function requireAdmin(session) {
  if (!session || session.role !== 'admin') throw new ApiError('Aksi ini hanya boleh dilakukan oleh admin.', 'FORBIDDEN', 403);
}

function requireMainAdmin(session) {
  requireAdmin(session);
  if (!(session.isMainAdmin === true || String(session.userId) === 'admin-main')) {
    throw new ApiError('Aksi ini hanya boleh dilakukan oleh admin utama.', 'FORBIDDEN', 403);
  }
}

async function verifyOwnerAccess(env, session, setupKey) {
  requireAdmin(session);
  const identity = String(session.userId || session.username || 'admin');
  const limit = await rateLimitStatus(env, 'owner-access', identity, 5, 900);
  if (limit.blocked) {
    throw new ApiError('Terlalu banyak percobaan Setup Key. Coba lagi sekitar 15 menit.', 'TOO_MANY_ATTEMPTS', 429);
  }
  const expected = String(env.SETUP_KEY || '').trim();
  const supplied = String(setupKey || '').trim();
  if (!expected) {
    throw new ApiError('Secret SETUP_KEY belum dipasang di Cloudflare.', 'OWNER_NOT_CONFIGURED', 503);
  }
  if (!supplied || supplied !== expected) {
    await recordFailedAttempt(env, 'owner-access', identity, 900);
    throw new ApiError('Setup Key tidak sesuai.', 'INVALID_SETUP_KEY', 403);
  }
  await clearAttempts(env, 'owner-access', identity);
}

function assertTable(table) {
  if (!TABLES.has(table) || table === 'admins') throw new ApiError(`Table tidak dikenal: ${table}`, 'UNKNOWN_TABLE');
}

function normalizeSchedule(record) {
  const item = clone(record || {});
  item.tanggal = normalizeDate(item.tanggal || item.date || '');
  item.jamMulai = normalizeTime(item.jamMulai || item.mulai || '');
  item.jamSelesai = normalizeTime(item.jamSelesai || item.selesai || '');
  if ((!item.jamMulai || !item.jamSelesai) && item.jam) {
    const parts = String(item.jam).split(/\s*[–—-]\s*/);
    if (!item.jamMulai && parts[0]) item.jamMulai = normalizeTime(parts[0]);
    if (!item.jamSelesai && parts[1]) item.jamSelesai = normalizeTime(parts[1]);
  }
  if (item.jamMulai || item.jamSelesai) {
    item.jam = item.jamMulai && item.jamSelesai
      ? `${item.jamMulai}–${item.jamSelesai}`
      : item.jamMulai || item.jamSelesai;
  }
  return item;
}

function isGroupScheduleRecord(schedule) {
  return Boolean(schedule && (
    schedule.tipeJadwal === 'group' || schedule.scheduleType === 'group' ||
    schedule.groupName || schedule.namaKelompok ||
    (Array.isArray(schedule.groupMemberIds) && schedule.groupMemberIds.length) ||
    (Array.isArray(schedule.groupMemberNames) && schedule.groupMemberNames.length)
  ));
}


function normalizeReportDetailInput(detail, reportId, index = 0) {
  const rawScore = detail?.nilai;
  const score = rawScore === '' || rawScore == null ? '' : Number(rawScore);
  const rawRating = Number(detail?.rating || 0);
  return {
    id: String(detail?.id || `${reportId}:detail:${detail?.muridId || detail?.siswaId || index + 1}`),
    laporanId: String(reportId || ''),
    muridId: String(detail?.muridId || detail?.siswaId || detail?.studentId || '').trim(),
    muridNama: String(detail?.muridNama || detail?.nama || detail?.namaSiswa || '').trim(),
    nilai: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : '',
    rating: Number.isFinite(rawRating) ? Math.max(0, Math.min(5, Math.round(rawRating))) : 0,
    pr: String(detail?.pr || '').trim(),
    catatan: String(detail?.catatan || '').trim(),
    sortOrder: Number.isFinite(Number(detail?.sortOrder)) ? Number(detail.sortOrder) : index
  };
}

async function normalizeReportDetails(env, item, isGroupReport) {
  const explicit = Array.isArray(item.details) ? item.details : [];
  const memberIds = Array.isArray(item.groupMemberIds) ? item.groupMemberIds.map(value => String(value || '')).filter(Boolean) : [];
  const memberNames = Array.isArray(item.groupMemberNames) ? item.groupMemberNames.map(value => String(value || '')) : [];
  const source = explicit.length
    ? explicit
    : memberIds.length
      ? memberIds.map((muridId, index) => ({
          muridId,
          muridNama: memberNames[index] || '',
          nilai: item.nilai,
          rating: item.rating,
          pr: item.pr,
          catatan: item.catatan
        }))
      : (item.siswaId || item.nama)
        ? [{
            muridId: item.siswaId || '',
            muridNama: item.nama || '',
            nilai: item.nilai,
            rating: item.rating,
            pr: item.pr,
            catatan: item.catatan
          }]
        : [];

  const seen = new Set();
  const details = [];
  for (let index = 0; index < source.length; index += 1) {
    const normalized = normalizeReportDetailInput(source[index], item.id, index);
    if (!normalized.muridId && normalized.muridNama) {
      const students = await listRecords(env, 'siswa');
      const match = students.find(student => normalizeName(student.nama || '') === normalizeName(normalized.muridNama));
      normalized.muridId = String(match?.id || '');
    }
    if (!normalized.muridNama && normalized.muridId) {
      const student = await getRecord(env, 'siswa', normalized.muridId);
      normalized.muridNama = String(student?.nama || '');
    }
    const key = normalized.muridId || normalizeName(normalized.muridNama);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    details.push(normalized);
  }

  if (!details.length) {
    throw new ApiError('Laporan wajib memiliki sedikitnya satu data siswa.', 'INVALID_REPORT_DETAIL');
  }
  if (isGroupReport && memberIds.length) {
    const allowed = new Set(memberIds);
    const invalid = details.find(detail => detail.muridId && !allowed.has(detail.muridId));
    if (invalid) throw new ApiError('Detail siswa tidak sesuai dengan anggota kelompok yang hadir.', 'INVALID_REPORT_DETAIL');
  }
  return details;
}

function normalizeInvoice(record) {
  const item = clone(record || {});
  item.tanggal = normalizeDate(item.tanggal || item.tanggalInvoice || item.createdAt || item.updatedAt || '');
  const rawType = String(item.tipeTagihan || item.jenisTagihan || '').trim().toLowerCase();
  const hasMonthly = Boolean(item.bulanTagihan || item.periode);
  item.tipeTagihan = ['bulanan', 'per bulan', 'per-bulan'].includes(rawType) || hasMonthly ? 'bulanan' : 'pertemuan';
  if (item.tipeTagihan === 'bulanan') {
    const period = String(item.bulanTagihan || item.periode || item.tanggal.slice(0, 7)).slice(0, 7);
    item.bulanTagihan = /^\d{4}-\d{2}$/.test(period) ? period : '';
  } else {
    item.bulanTagihan = '';
  }
  const sessions = Number(item.jumlahSesi || 1);
  item.jumlahSesi = Number.isFinite(sessions) && sessions > 0 ? Math.round(sessions) : 1;
  const total = Number(item.total || 0);
  item.total = Number.isFinite(total) && total > 0 ? total : 0;
  item.lunas = truthy(item.lunas);
  return item;
}

async function uniqueParentUsername(env, name, excludeId, preferred = '') {
  const students = await listRecords(env, 'siswa');
  const used = new Set(students
    .filter(item => String(item.id || '') !== String(excludeId || ''))
    .map(item => normalizeUsername(item.username || ''))
    .filter(Boolean));
  const preferredClean = normalizeUsername(preferred);
  if (preferredClean) {
    if (!/^[a-z0-9._-]{2,24}$/.test(preferredClean)) {
      throw new ApiError('Username harus 2–24 karakter berupa huruf, angka, titik, garis bawah, atau tanda minus.', 'INVALID_USERNAME');
    }
    if (used.has(preferredClean)) throw new ApiError(`Username "${preferredClean}" sudah digunakan siswa lain.`, 'USERNAME_TAKEN');
    return preferredClean;
  }
  const candidates = usernameCandidates(name);
  const free = candidates.find(candidate => !used.has(candidate));
  if (free) return free;
  const base = candidates.at(-1) || 'siswa';
  let number = 2;
  let candidate = `${base}${number}`.slice(0, 24);
  while (used.has(candidate)) candidate = `${base}${++number}`.slice(0, 24);
  return candidate;
}

function generatePin() {
  const bytes = new Uint16Array(1);
  crypto.getRandomValues(bytes);
  return String(1000 + (bytes[0] % 9000));
}

async function bindAttendance(env, record, migration = false) {
  const item = clone(record || {});
  let schedule = null;
  const scheduleId = String(item.jadwalId || item.scheduleId || '').trim();
  if (scheduleId) schedule = await getRecord(env, 'jadwal', scheduleId);
  if (!schedule && !migration) {
    const schedules = await listRecords(env, 'jadwal');
    schedule = schedules.find(row =>
      (!item.siswaId || String(row.siswaId || '') === String(item.siswaId || '')) &&
      (!item.tutorId || String(row.tutorId || '') === String(item.tutorId || '')) &&
      (!item.tanggal || normalizeDate(row.tanggal) === normalizeDate(item.tanggal)) &&
      (!item.mulai || normalizeTime(row.jamMulai || row.mulai) === normalizeTime(item.mulai))
    ) || null;
  }
  if (!schedule) {
    if (migration) return item;
    throw new ApiError('Absensi wajib terhubung dengan jadwal les yang dipilih.', 'INVALID_ATTENDANCE');
  }
  const groupSchedule = isGroupScheduleRecord(schedule);
  const scheduledStudent = !groupSchedule && schedule.siswaId ? await getRecord(env, 'siswa', schedule.siswaId) : null;
  const selectedStudent = item.siswaId ? await getRecord(env, 'siswa', item.siswaId) : null;
  const student = scheduledStudent || selectedStudent;
  const tutor = schedule.tutorId ? await getRecord(env, 'tutors', schedule.tutorId) : null;
  item.jadwalId = String(schedule.id || '');
  item.siswaId = groupSchedule
    ? String(item.siswaId || selectedStudent?.id || '')
    : String(schedule.siswaId || item.siswaId || '');
  item.nama = groupSchedule
    ? (selectedStudent?.nama || item.nama || '')
    : (student?.nama || item.nama || schedule.siswa || '');
  item.kelas = student?.kelas || item.kelas || '';
  item.tutorId = String(schedule.tutorId || item.tutorId || '');
  item.tutorNama = tutor?.nama || item.tutorNama || '';
  item.tanggal = normalizeDate(item.tanggal || schedule.tanggal || '');
  item.mulai = normalizeTime(item.mulai || schedule.jamMulai || schedule.mulai || '');
  item.selesai = normalizeTime(item.selesai || schedule.jamSelesai || schedule.selesai || '');
  item.mapel = item.mapel || schedule.mapel || '';
  if (groupSchedule) {
    item.scheduleType = 'group';
    item.groupName = item.groupName || schedule.groupName || schedule.namaKelompok || schedule.siswa || '';
    item.groupType = item.groupType || schedule.groupClassType || schedule.groupType || 'Kelompok';
    item.groupClassType = item.groupClassType || schedule.groupClassType || schedule.groupType || 'Kelompok';
  }
  return item;
}

async function bindReport(env, record, migration = false) {
  const item = clone(record || {});
  const attendanceId = String(item.absensiId || '').trim();
  const scheduleId = String(item.jadwalId || '').trim();
  const isGroupReport = Boolean(
    item.groupName || item.groupType || item.groupClassType ||
    (Array.isArray(item.groupMemberIds) && item.groupMemberIds.length) ||
    (Array.isArray(item.groupMemberNames) && item.groupMemberNames.length) ||
    (Array.isArray(item.absensiIds) && item.absensiIds.length)
  );
  let attendance = attendanceId ? await getRecord(env, 'absensi', attendanceId) : null;
  if (!attendance && scheduleId) {
    const rows = await listRecords(env, 'absensi');
    attendance = rows.find(row => String(row.jadwalId || '') === scheduleId) || null;
  }
  if (attendance) {
    item.absensiId = String(attendance.id || item.absensiId || '');
    item.jadwalId = String(attendance.jadwalId || item.jadwalId || '');
    item.tutorId = String(item.tutorId || attendance.tutorId || '');
    item.tutorNama = item.tutorNama || attendance.tutorNama || '';
    item.tanggal = normalizeDate(attendance.tanggal || item.tanggal || '');
    item.mulai = normalizeTime(attendance.mulai || item.mulai || '');
    item.selesai = normalizeTime(attendance.selesai || item.selesai || '');
    item.mapel = attendance.mapel || item.mapel || '';

    if (isGroupReport) {
      // Laporan kelompok hanya dibuat sekali, tetapi harus tetap terbaca oleh
      // semua orang tua melalui groupMemberIds/groupMemberNames. Jangan timpa
      // nama kelompok dengan nama siswa pertama yang absensinya dipakai sebagai
      // sumber jadwal.
      item.siswaId = String(item.siswaId || '');
      item.nama = item.nama || (item.groupName ? `${item.groupType || 'Kelompok'}: ${item.groupName}` : 'Kelompok');
      item.kelas = item.kelas || attendance.kelas || '';
      item.kehadiran = item.kehadiran || attendance.status || attendance.kehadiran || 'Hadir';
    } else {
      item.siswaId = String(attendance.siswaId || item.siswaId || '');
      item.nama = attendance.nama || item.nama || '';
      item.kelas = attendance.kelas || item.kelas || '';
      item.kehadiran = attendance.status || attendance.kehadiran || item.kehadiran || 'Hadir';
    }
  }
  if (!item.jadwalId && !item.absensiId && !migration) {
    throw new ApiError('Laporan harus terhubung dengan absensi atau jadwal les yang valid.', 'INVALID_REPORT');
  }
  item.details = await normalizeReportDetails(env, item, isGroupReport);
  if (isGroupReport) {
    item.groupMemberIds = item.details.map(detail => detail.muridId).filter(Boolean);
    item.groupMemberNames = item.details.map(detail => detail.muridNama).filter(Boolean);
    item.siswaId = '';
    item.pr = '';
    item.nilai = '';
    item.rating = 0;
    item.catatan = '';
  } else if (item.details[0]) {
    item.siswaId = item.siswaId || item.details[0].muridId;
    item.nama = item.nama || item.details[0].muridNama;
    item.pr = item.details[0].pr;
    item.nilai = item.details[0].nilai;
    item.rating = item.details[0].rating;
    item.catatan = item.details[0].catatan;
  }
  return item;
}

async function processRecord(env, request, table, input, options = {}) {
  let item = clone(input || {});
  if (!item.id) item.id = makeId(table === 'siswa' ? 'siswa' : table.replace(/s$/, '') || 'data');
  item.updatedAt = nowIso();
  item.createdAt = item.createdAt || item.updatedAt;

  if (table === 'jadwal') item = { ...item, ...normalizeSchedule(item) };
  if (table === 'invoice') item = { ...item, ...normalizeInvoice(item) };
  if (table === 'bank_soal') item = normalizeBankSoalRecord(item);
  if (table === 'pelatihan') item = normalizePelatihanRecord(item);
  if (table === 'note') {
    item.title = String(item.title || '').trim().slice(0, 120);
    item.content = String(item.content || '').replace(/\r\n/g, '\n').slice(0, 20000);
    if (!item.title && !item.content.trim()) throw new ApiError('Note tidak boleh kosong.', 'INVALID_NOTE');
  }
  if (table === 'siswa') {
    const pin = String(item.pin || '').replace(/\D/g, '').slice(0, 4);
    item.pin = /^\d{4}$/.test(pin) ? pin : generatePin();
    item.username = await uniqueParentUsername(env, item.nama || '', item.id, item.username || '');
    item.status = item.status || 'Aktif';
  }
  if (table === 'absensi') item = await bindAttendance(env, item, options.migration === true);
  if (table === 'laporan') item = await bindReport(env, item, options.migration === true);
  item = await processRecordUploads(env, request, table, item);
  return item;
}

async function authorizeWrite(env, session, table, record) {
  if (session.role === 'admin') return;
  const tutorId = String(session.tutorId || '');
  if (table === 'jadwal') {
    if (String(record.tutorId || '') !== tutorId) throw new ApiError('Akun ini tidak memiliki izin untuk mengubah data tersebut.', 'FORBIDDEN', 403);
    const existing = await getRecord(env, 'jadwal', record.id);
    if (existing && String(existing.tutorId || '') !== tutorId) throw new ApiError('Akun ini tidak memiliki izin untuk mengubah data tersebut.', 'FORBIDDEN', 403);
    return;
  }
  if ((table === 'laporan' || table === 'absensi') && String(record.tutorId || '') === tutorId) return;
  throw new ApiError('Akun ini tidak memiliki izin untuk mengubah data tersebut.', 'FORBIDDEN', 403);
}

async function authorizeDelete(env, session, table, id) {
  if (session.role === 'admin') return;
  if (['jadwal', 'laporan', 'absensi'].includes(table)) {
    const found = await getRecord(env, table, id);
    if (found && String(found.tutorId || '') === String(session.tutorId || '')) return;
  }
  throw new ApiError('Akun ini tidak memiliki izin untuk menghapus data tersebut.', 'FORBIDDEN', 403);
}

async function saveOne(env, request, session, table, rawRecord, options = {}) {
  const item = await processRecord(env, request, table, rawRecord, options);
  if (!options.skipAuthorization) await authorizeWrite(env, session, table, item);
  if (table === 'note') {
    const existing = await getRecord(env, table, item.id);
    const expectedUpdatedAt = String(rawRecord?.expectedUpdatedAt || '').trim();
    if (existing && expectedUpdatedAt && String(existing.updatedAt || '') !== expectedUpdatedAt) {
      throw new ApiError('Note sudah berubah di perangkat lain. Muat versi terbaru atau simpan ulang untuk menimpa versi tersebut.', 'NOTE_CONFLICT', 409);
    }
    delete item.expectedUpdatedAt;
    const actor = String(session.nama || session.username || session.userId || 'Admin');
    item.createdBy = existing?.createdBy || actor;
    item.updatedBy = actor;
  } else if (table === 'bank_soal' || table === 'pelatihan') {
    const existing = await getRecord(env, table, item.id);
    const actor = String(session.nama || session.username || session.userId || 'Admin');
    item.createdBy = existing?.createdBy || actor;
    item.updatedBy = actor;
  }
  if (table === 'tutors') {
    const password = String(rawRecord?.password || '');
    await createOrUpdateUser(env, item, 'tutor', { password });
    item.password = password || (await getRecord(env, 'tutors', item.id, { includePassword: true }))?.password || '';
  }
  if (table === 'admins') {
    const password = String(rawRecord?.password || '');
    await createOrUpdateUser(env, item, 'admin', { password, isMainAdmin: item.id === 'admin-main' || truthy(item.isMainAdmin) });
    item.password = password || (await getRecord(env, 'admins', item.id, { includePassword: true }))?.password || '';
  }
  return upsertRecord(env, table, item);
}

function attendanceTimestamp(record) {
  const value = new Date(record?.updatedAt || record?.createdAt || 0).getTime() || 0;
  return Number.isFinite(value) ? value : 0;
}

function preferAttendanceSnapshot(current, candidate) {
  if (!current) return candidate;
  const currentLegacy = Boolean(current.legacySourceId || String(current.id || '').startsWith('absensi-legacy-'));
  const candidateLegacy = Boolean(candidate.legacySourceId || String(candidate.id || '').startsWith('absensi-legacy-'));
  if (currentLegacy !== candidateLegacy) return candidateLegacy ? current : candidate;
  return attendanceTimestamp(candidate) >= attendanceTimestamp(current) ? candidate : current;
}

function normalizeAttendanceSnapshot(records, schedules, students, tutors) {
  const normalizedSchedules = (schedules || []).map(normalizeSchedule);
  const scheduleById = new Map(normalizedSchedules.map(item => [String(item.id || ''), item]));
  const studentById = new Map((students || []).map(item => [String(item.id || ''), item]));
  const tutorById = new Map((tutors || []).map(item => [String(item.id || ''), item]));

  const findSchedule = source => {
    const scheduleId = String(source.jadwalId || source.scheduleId || '').trim();
    if (scheduleId && scheduleById.has(scheduleId)) return scheduleById.get(scheduleId);

    const sourceStudentId = String(source.siswaId || '').trim();
    const sourceStudentName = normalizeName(source.nama || '');
    const sourceTutorId = String(source.tutorId || '').trim();
    const sourceDate = normalizeDate(source.tanggal || '');
    const sourceStart = normalizeTime(source.mulai || source.jamMulai || '');
    const matches = normalizedSchedules.filter(schedule => {
      const student = studentById.get(String(schedule.siswaId || ''));
      const scheduleStudentId = String(schedule.siswaId || '').trim();
      const scheduleStudentName = normalizeName(student?.nama || schedule.siswa || '');
      const sameStudent = Boolean(
        (sourceStudentId && scheduleStudentId && sourceStudentId === scheduleStudentId) ||
        (sourceStudentName && scheduleStudentName && sourceStudentName === scheduleStudentName)
      );
      if (!sameStudent) return false;
      if (sourceTutorId && String(schedule.tutorId || '') !== sourceTutorId) return false;
      if (sourceDate && normalizeDate(schedule.tanggal || '') !== sourceDate) return false;
      if (sourceStart && normalizeTime(schedule.jamMulai || schedule.mulai || '') !== sourceStart) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const selected = new Map();
  const order = [];
  for (const raw of records || []) {
    if (!raw) continue;
    const item = clone(raw);
    const schedule = findSchedule(item);
    if (schedule) {
      const groupSchedule = isGroupScheduleRecord(schedule);
      const student = groupSchedule
        ? studentById.get(String(item.siswaId || ''))
        : studentById.get(String(schedule.siswaId || item.siswaId || ''));
      const tutor = tutorById.get(String(schedule.tutorId || ''));
      item.jadwalId = String(schedule.id || '');
      item.siswaId = groupSchedule
        ? String(item.siswaId || student?.id || '')
        : String(schedule.siswaId || item.siswaId || '');
      item.nama = groupSchedule
        ? (student?.nama || item.nama || '')
        : (student?.nama || schedule.siswa || item.nama || '');
      item.kelas = student?.kelas || item.kelas || '';
      item.tutorId = String(schedule.tutorId || item.tutorId || '');
      item.tutorNama = tutor?.nama || item.tutorNama || '';
      item.tanggal = normalizeDate(item.tanggal || schedule.tanggal || '');
      item.mulai = normalizeTime(item.mulai || schedule.jamMulai || schedule.mulai || '');
      item.selesai = normalizeTime(item.selesai || schedule.jamSelesai || schedule.selesai || '');
      item.mapel = item.mapel || schedule.mapel || '';
      if (groupSchedule) {
        item.scheduleType = 'group';
        item.groupName = item.groupName || schedule.groupName || schedule.namaKelompok || schedule.siswa || '';
        item.groupType = item.groupType || schedule.groupClassType || schedule.groupType || 'Kelompok';
        item.groupClassType = item.groupClassType || schedule.groupClassType || schedule.groupType || 'Kelompok';
      }
    } else {
      item.jadwalId = String(item.jadwalId || item.scheduleId || '').trim();
      item.tanggal = normalizeDate(item.tanggal || '');
      item.mulai = normalizeTime(item.mulai || item.jamMulai || '');
      item.selesai = normalizeTime(item.selesai || item.jamSelesai || '');
    }
    item.status = item.status || item.kehadiran || '';

    const itemStudentId = String(item.siswaId || '').trim();
    const itemDate = normalizeDate(item.tanggal || '');
    const studentKey = normalizeName(itemStudentId || item.nama || '');
    const tutorKey = normalizeName(item.tutorId || item.tutorNama || '');
    const fallback = `${studentKey}|${tutorKey}|${itemDate || ''}|${item.mulai || ''}`;
    // Absensi kelompok disimpan sebagai beberapa baris untuk jadwal yang sama,
    // masing-masing mewakili satu siswa. Tanggal ikut menjadi kunci supaya
    // jadwal yang sama pada hari berbeda tidak saling menimpa.
    const key = item.jadwalId && itemStudentId
      ? `jadwal|${item.jadwalId}|tanggal|${itemDate}|siswa|${itemStudentId}`
      : item.jadwalId
      ? `jadwal|${item.jadwalId}|tanggal|${itemDate}`
      : (fallback !== '|||'
        ? `fallback|${fallback}`
        : `id|${String(item.id || '')}`);
    if (!selected.has(key)) order.push(key);
    selected.set(key, preferAttendanceSnapshot(selected.get(key), item));
  }
  return order.map(key => selected.get(key)).filter(Boolean);
}

async function getAllData(env, session) {
  const [tutors, siswa, jadwal, laporan, absensi, invoice, gallery, pendaftar, gaji, tarif, bankSoal, pelatihan, themeRows] = await Promise.all([
    listRecords(env, 'tutors'),
    listRecords(env, 'siswa'),
    listRecords(env, 'jadwal'),
    listRecords(env, 'laporan'),
    listRecords(env, 'absensi'),
    listRecords(env, 'invoice'),
    listRecords(env, 'gallery'),
    listRecords(env, 'pendaftar'),
    listRecords(env, 'gaji'),
    listRecords(env, 'tarif'),
    listRecords(env, 'bank_soal'),
    listRecords(env, 'pelatihan'),
    listRecords(env, 'theme')
  ]);
  const all = { tutors, siswa, jadwal, laporan, absensi: normalizeAttendanceSnapshot(absensi, jadwal, siswa, tutors), invoice, gallery, pendaftar, gaji, tarif, bank_soal: bankSoal, pelatihan, theme: themeRows[0] || null };
  if (session.role === 'admin') return all;
  const tutorId = String(session.tutorId || '');
  return {
    tutors: tutors.filter(item => String(item.id || '') === tutorId).map(item => { const safe = clone(item); delete safe.password; return safe; }),
    siswa: siswa.filter(item => String(item.tutorId || '') === tutorId).map(stripStudentPin),
    jadwal: jadwal.filter(item => String(item.tutorId || '') === tutorId),
    laporan: laporan.filter(item => String(item.tutorId || '') === tutorId),
    absensi: all.absensi.filter(item => String(item.tutorId || '') === tutorId),
    invoice: [],
    gallery,
    pendaftar: [],
    gaji: gaji.filter(item => String(item.tutorId || '') === tutorId && truthy(item.ditampilkan)),
    tarif: [],
    bank_soal: bankSoal,
    pelatihan,
    theme: all.theme
  };
}

async function filterTable(env, table, session) {
  let rows = await listRecords(env, table);
  if (table === 'absensi') {
    const [schedules, students, tutors] = await Promise.all([
      listRecords(env, 'jadwal'),
      listRecords(env, 'siswa'),
      listRecords(env, 'tutors')
    ]);
    rows = normalizeAttendanceSnapshot(rows, schedules, students, tutors);
  }
  if (session.role === 'admin') return rows;
  const tutorId = String(session.tutorId || '');
  if (table === 'tutors') return rows.filter(item => String(item.id || '') === tutorId).map(item => { const safe = clone(item); delete safe.password; return safe; });
  if (table === 'siswa') return rows.filter(item => String(item.tutorId || '') === tutorId).map(stripStudentPin);
  if (['jadwal', 'laporan', 'absensi'].includes(table)) return rows.filter(item => String(item.tutorId || '') === tutorId);
  if (table === 'invoice' || table === 'pendaftar') return [];
  if (table === 'tarif') return [];
  if (table === 'gaji') return rows.filter(item => String(item.tutorId || '') === tutorId && truthy(item.ditampilkan));
  return rows;
}

async function getPublicData(env) {
  const [tutors, gallery, theme] = await Promise.all([
    listRecords(env, 'tutors'),
    listRecords(env, 'gallery'),
    listRecords(env, 'theme')
  ]);
  return {
    tutors: tutors.map(item => ({
      id: item.id,
      nama: item.nama || '',
      mapel: item.mapel || '',
      jenjang: item.jenjang || '',
      foto: item.foto || '',
      fotoFileId: item.fotoFileId || '',
      showOnHome: item.showOnHome,
      tampilBeranda: item.tampilBeranda
    })),
    gallery,
    theme: theme[0] || null
  };
}

async function staffLogin(env, username, password) {
  const userName = String(username || '').trim();
  const pass = String(password || '');
  if (!userName || !pass) return { success: false, message: 'Username dan password wajib diisi.' };
  const limit = await rateLimitStatus(env, 'staff-login', userName, 10, 900);
  if (limit.blocked) throw new ApiError('Terlalu banyak percobaan. Coba lagi sekitar 15 menit.', 'TOO_MANY_ATTEMPTS', 429);
  const user = await getUserByUsername(env, userName);
  if (!user || !(await verifyPassword(pass, String(user.password_hash || '')))) {
    await recordFailedAttempt(env, 'staff-login', userName, 900);
    return { success: false, message: 'Username atau password salah.' };
  }
  await clearAttempts(env, 'staff-login', userName);
  const session = await saveSession(env, randomToken(), user, ttl(env, 'SESSION_TTL_SECONDS', STAFF_TTL_DEFAULT));
  return { success: true, session };
}

async function saveParentSession(env, student) {
  const token = randomToken();
  const { sha256 } = await import('./crypto.js');
  const tokenHash = await sha256(token);
  const timestamp = nowIso();
  const expiresAt = Math.floor(Date.now() / 1000) + ttl(env, 'PARENT_SESSION_TTL_SECONDS', PARENT_TTL_DEFAULT);
  const base = {
    role: 'parent',
    studentId: String(student.id || ''),
    studentName: student.nama || '',
    username: student.username || '',
    className: student.kelas || '',
    parentName: student.ortu || '',
    loginAt: timestamp
  };
  await env.DB.prepare(
    `INSERT INTO ks_parent_sessions(token_hash, student_id, session_json, expires_at, created_at)
     VALUES(?, ?, ?, ?, ?)`
  ).bind(tokenHash, String(student.id || ''), JSON.stringify(base), expiresAt, timestamp).run();
  return { ...base, token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

async function requireParentSession(env, token) {
  const clean = String(token || '').trim();
  if (!clean) throw new ApiError('Sesi orang tua tidak ditemukan.', 'UNAUTHORIZED', 401);
  const { sha256 } = await import('./crypto.js');
  const tokenHash = await sha256(clean);
  const row = await env.DB.prepare(
    'SELECT student_id, session_json, expires_at FROM ks_parent_sessions WHERE token_hash = ? LIMIT 1'
  ).bind(tokenHash).first();
  if (!row || Number(row.expires_at) <= Math.floor(Date.now() / 1000)) {
    await env.DB.prepare('DELETE FROM ks_parent_sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new ApiError('Sesi orang tua sudah habis. Silakan login kembali.', 'UNAUTHORIZED', 401);
  }
  const student = await getRecord(env, 'siswa', String(row.student_id || ''));
  if (!student) throw new ApiError('Data siswa tidak ditemukan.', 'NOT_FOUND', 404);
  return { ...JSON.parse(String(row.session_json || '{}')), token: clean, student };
}

async function parentLogin(env, username, pin) {
  const cleanUsername = normalizeUsername(username);
  const cleanPin = String(pin || '').replace(/\D/g, '').slice(0, 4);
  if (!cleanUsername || !/^\d{4}$/.test(cleanPin)) return { success: false, message: 'Username dan PIN 4 digit wajib diisi.' };
  const limit = await rateLimitStatus(env, 'parent-login', cleanUsername, 10, 900);
  if (limit.blocked) throw new ApiError('Terlalu banyak percobaan. Coba lagi sekitar 15 menit.', 'TOO_MANY_ATTEMPTS', 429);
  const student = await findRecordByUsername(env, 'siswa', cleanUsername);
  if (!student || String(student.pin || '').replace(/\D/g, '').slice(0, 4) !== cleanPin) {
    await recordFailedAttempt(env, 'parent-login', cleanUsername, 900);
    return { success: false, message: 'Username atau PIN tidak sesuai. Hubungi admin bila belum menerima akses.' };
  }
  await clearAttempts(env, 'parent-login', cleanUsername);
  return { success: true, session: await saveParentSession(env, student) };
}

async function getParentData(env, parentSession) {
  const student = parentSession.student;
  const studentId = String(student.id || '');
  const studentName = normalizeName(student.nama || '');
  const [reports, attendance, invoices, schedules, students, tutors] = await Promise.all([
    listRecords(env, 'laporan'),
    listRecords(env, 'absensi'),
    listRecords(env, 'invoice'),
    listRecords(env, 'jadwal'),
    listRecords(env, 'siswa'),
    listRecords(env, 'tutors')
  ]);
  const belongs = (item, nameField = 'nama') =>
    recordBelongsToStudentIdentity(item, student, students, nameField);
  const normalizedAttendance = normalizeAttendanceSnapshot(attendance, schedules, students, tutors);
  const parentAttendance = normalizedAttendance.filter(item => belongs(item, 'nama'));
  const parentAttendanceIds = new Set(parentAttendance.map(item => String(item.id || '')).filter(Boolean));
  const groupRecordBelongsToParent = (item, nameField = 'nama') => {
    if (belongs(item, nameField)) return true;
    const memberIds = Array.isArray(item.groupMemberIds) ? item.groupMemberIds.map(id => String(id || '').trim()) : [];
    if (studentId && memberIds.includes(studentId)) return true;
    const rawMemberNames = Array.isArray(item.groupMemberNames) ? item.groupMemberNames : [];
    const memberNames = rawMemberNames.map(name => normalizeName(name || ''));
    const matchingMemberIndex = studentName ? memberNames.indexOf(studentName) : -1;
    if (matchingMemberIndex >= 0 && recordBelongsToStudentIdentity({
      siswaId: memberIds[matchingMemberIndex] || '',
      nama: rawMemberNames[matchingMemberIndex] || ''
    }, student, students, 'nama')) return true;
    const linkedAttendanceIds = Array.isArray(item.absensiIds) ? item.absensiIds.map(id => String(id || '')).filter(Boolean) : [];
    if (linkedAttendanceIds.some(id => parentAttendanceIds.has(id))) return true;
    return false;
  };
  const reportBelongsToParent = item => {
    if (groupRecordBelongsToParent(item, 'nama')) return true;
    const details = Array.isArray(item.details) ? item.details : [];
    return details.some(detail =>
      String(detail.muridId || '') === studentId ||
      (studentName && normalizeName(detail.muridNama || '') === studentName)
    );
  };
  const reportForParent = item => {
    const safe = clone(item || {});
    const details = Array.isArray(safe.details) ? safe.details : [];
    const detail = details.find(row =>
      String(row.muridId || '') === studentId ||
      (studentName && normalizeName(row.muridNama || '') === studentName)
    );
    if (detail) {
      safe.siswaId = studentId;
      safe.nama = student.nama || detail.muridNama || safe.nama || '';
      safe.nilai = detail.nilai;
      safe.rating = detail.rating;
      safe.pr = detail.pr;
      safe.catatan = detail.catatan;
      safe.details = [detail];
    }
    return safe;
  };
  const invoiceBelongsToParent = item =>
    invoiceBelongsToStudentIdentity(item, student, students) || groupRecordBelongsToParent(item, 'namaSiswa');
  const parentReports = reports.filter(reportBelongsToParent).map(reportForParent);
  const parentInvoices = invoices.filter(invoiceBelongsToParent).map(sanitizeInvoiceForParent);
  const parentSchedules = schedules.filter(item => groupRecordBelongsToParent(item, 'nama'));

  return {
    // Kirim seluruh field data siswa agar panel orang tua tidak kehilangan informasi
    // ketika ada kolom baru pada database. Field sensitif akses internal tetap tidak dikirim.
    student: (() => {
      const safeStudent = clone(student || {});
      delete safeStudent.pin;
      delete safeStudent.password;
      return safeStudent;
    })(),
    laporan: parentReports,
    absensi: parentAttendance,
    invoice: parentInvoices,
    jadwal: parentSchedules,
    // Metadata lengkap untuk sinkronisasi tampilan panel orang tua.
    meta: {
      totalLaporan: parentReports.length,
      totalAbsensi: parentAttendance.length,
      totalInvoice: parentInvoices.length,
      totalJadwal: parentSchedules.length
    },
    generatedAt: nowIso()
  };
}

async function setup(env, body) {
  const expected = String(env.SETUP_KEY || '').trim();
  if (!expected || String(body.setupKey || '').trim() !== expected) throw new ApiError('Kunci pemasangan tidak sesuai.', 'INVALID_SETUP_KEY', 403);
  const existing = await env.DB.prepare('SELECT COUNT(*) AS total FROM ks_users').first();
  if (Number(existing?.total || 0) > 0 || await getMeta(env, 'setup_complete') === '1') {
    throw new ApiError('Pemasangan sudah pernah diselesaikan.', 'ALREADY_INSTALLED', 409);
  }
  const account = {
    id: 'admin-main',
    nama: String(body.name || 'Admin Utama').trim() || 'Admin Utama',
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    wa: String(body.wa || '').trim(),
    email: String(body.email || '').trim(),
    isMainAdmin: true,
    createdAt: nowIso()
  };
  await createOrUpdateUser(env, account, 'admin', { password: account.password, isMainAdmin: true });
  await upsertRecord(env, 'admins', account);
  await setMeta(env, 'setup_complete', '1', nowIso());
  return { success: true, message: 'Pemasangan selesai. Silakan login sebagai admin utama.' };
}

async function approveRegistration(env, request, session, registrationId, tutorId, studentId) {
  requireAdmin(session);
  const registration = await getRecord(env, 'pendaftar', registrationId);
  if (!registration) throw new ApiError('Data pendaftar tidak ditemukan atau sudah diproses.', 'NOT_FOUND', 404);
  const tutor = await getRecord(env, 'tutors', tutorId);
  if (!tutor) throw new ApiError('Tentor yang dipilih tidak ditemukan.', 'NOT_FOUND', 404);
  const timestamp = nowIso();
  const student = await processRecord(env, request, 'siswa', {
    id: studentId || makeId('siswa'),
    nama: registration.namaSiswa || registration.nama || '',
    namaPanggilan: registration.namaPanggilan || registration.panggilan || registration.nickname || '',
    subKelas: registration.subKelas || registration.jenisKelas || registration.tipeKelas || 'Belum ditentukan',
    namaKelompok: registration.namaKelompok || registration.kelompok || registration.groupName || '',
    isPrivat: false,
    semiPrivatGroups: [],
    kelompokGroupName: '',
    ortu: registration.namaOrtu || registration.ortu || '',
    wa: registration.waOrtu || registration.wa || '',
    jenisKelamin: registration.jenisKelamin || '',
    kelas: registration.kelas || registration.jenjang || '',
    sekolah: registration.sekolah || '',
    alamat: registration.alamat || '',
    frekuensiLes: registration.frekuensiLes || '',
    lokasiLes: registration.lokasiLes || '',
    kemampuanBaca: registration.kemampuanBaca || '',
    karakteristik: registration.karakteristik || '',
    waktuTidakBisa: registration.waktuTidakBisa || '',
    status: 'Aktif',
    tutorId,
    asalPendaftaranId: registration.id,
    createdAt: timestamp,
    approvedAt: timestamp
  });
  await upsertRecord(env, 'siswa', student);
  await deleteRecord(env, 'pendaftar', registrationId);
  return { siswa: student, pendaftar: await listRecords(env, 'pendaftar') };
}

async function submitPaymentProof(env, request, parentSession, invoiceId, proofData, fileName) {
  const invoice = await getRecord(env, 'invoice', invoiceId);
  const student = parentSession.student;
  const students = await listRecords(env, 'siswa');
  const belongs = invoice && invoiceBelongsToStudentIdentity(invoice, student, students);
  if (!belongs) throw new ApiError('Tagihan tidak ditemukan untuk akun orang tua ini.', 'NOT_FOUND', 404);
  if (truthy(invoice.lunas)) throw new ApiError('Tagihan ini sudah lunas.');
  const uploaded = await uploadDataUrl(env, request, proofData, `bukti-transfer-${invoice.namaSiswa || student.nama || invoice.id}`);
  const timestamp = nowIso();
  const updated = normalizeInvoice({
    ...invoice,
    lunas: false,
    statusVerifikasi: 'menunggu_verifikasi',
    buktiTransferUrl: uploaded.directUrl,
    buktiTransferViewUrl: uploaded.viewUrl,
    buktiTransferThumbnailUrl: uploaded.thumbnailUrl,
    buktiTransferFileId: uploaded.fileId,
    buktiTransferNamaFile: String(fileName || 'bukti-transfer.jpg').slice(0, 120),
    buktiTransferDikirimPada: timestamp,
    buktiTransferDikirimOleh: student.ortu || student.nama || '',
    pembayaranDisetujuiPada: '',
    pembayaranDisetujuiOleh: '',
    updatedAt: timestamp
  });
  await upsertRecord(env, 'invoice', updated);
  return sanitizeInvoiceForParent(updated);
}

async function approveInvoicePayment(env, session, invoiceId) {
  requireAdmin(session);
  const invoice = await getRecord(env, 'invoice', invoiceId);
  if (!invoice) throw new ApiError('Invoice tidak ditemukan.', 'NOT_FOUND', 404);
  if (String(invoice.statusVerifikasi || '') !== 'menunggu_verifikasi' && !invoice.buktiTransferUrl) {
    throw new ApiError('Belum ada bukti transfer yang menunggu verifikasi.');
  }
  const meetings = Array.isArray(invoice.tanggalPertemuan) ? invoice.tanggalPertemuan : [];
  const paidDates = meetings.map(row => typeof row === 'string' ? row : row?.tanggal || row?.date).filter(Boolean);
  const updated = normalizeInvoice({
    ...invoice,
    lunas: true,
    statusVerifikasi: 'disetujui',
    tanggalDibayar: paidDates.length ? paidDates : invoice.tanggalDibayar || [],
    tanggalPertemuan: meetings.map(row => typeof row === 'string'
      ? { tanggal: row, selesai: true, dibayar: true }
      : { ...row, dibayar: true }),
    pembayaranDisetujuiPada: nowIso(),
    pembayaranDisetujuiOleh: session.nama || session.username || 'Admin',
    updatedAt: nowIso()
  });
  await upsertRecord(env, 'invoice', updated);
  return updated;
}

async function ownerGetTutorCredentials(env, session, setupKey) {
  await verifyOwnerAccess(env, session, setupKey);
  const tutors = await listRecords(env, 'tutors', { includePassword: true });
  return tutors.map(item => ({
    id: String(item.id || ''),
    nama: item.nama || 'Tentor',
    username: item.username || '',
    password: item.password || '',
    updatedAt: item.updatedAt || ''
  }));
}

async function ownerUpdateTutorCredential(env, session, body) {
  await verifyOwnerAccess(env, session, body.setupKey);
  const tutorId = String(body.tutorId || '').trim();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!tutorId) throw new ApiError('ID tentor belum tersedia.', 'INVALID_ACCOUNT');
  if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) {
    throw new ApiError('Username harus 3–24 karakter dan hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda minus.', 'INVALID_USERNAME');
  }
  if (password.length < 6 || password.length > 80) {
    throw new ApiError('Password tentor harus terdiri dari 6–80 karakter.', 'INVALID_PASSWORD');
  }
  const tutor = await getRecord(env, 'tutors', tutorId, { includePassword: true });
  if (!tutor) throw new ApiError('Data tentor tidak ditemukan.', 'NOT_FOUND', 404);
  const updatedAt = nowIso();
  const updated = {
    ...tutor,
    username,
    password,
    passwordUpdatedAt: updatedAt,
    updatedAt
  };
  await createOrUpdateUser(env, updated, 'tutor', { password });
  await upsertRecord(env, 'tutors', updated);
  return {
    id: tutorId,
    nama: updated.nama || 'Tentor',
    username,
    password,
    updatedAt
  };
}

async function ownerGetAdminCredentials(env, session, setupKey) {
  await verifyOwnerAccess(env, session, setupKey);
  const admins = await listRecords(env, 'admins', { includePassword: true });
  return admins
    .filter(item => String(item.id || '') !== 'admin-main' && !truthy(item.isMainAdmin))
    .map(item => ({
      id: String(item.id || ''),
      nama: item.nama || item.name || 'Admin',
      username: item.username || '',
      password: item.password || '',
      wa: item.wa || '',
      email: item.email || '',
      updatedAt: item.updatedAt || ''
    }));
}

function validateSecondaryAdminInput(body) {
  const nama = String(body.nama || body.name || '').trim();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const wa = String(body.wa || '').trim();
  const email = String(body.email || '').trim();
  if (nama.length < 2 || nama.length > 80) {
    throw new ApiError('Nama admin harus terdiri dari 2–80 karakter.', 'INVALID_NAME');
  }
  if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) {
    throw new ApiError('Username harus 3–24 karakter dan hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda minus.', 'INVALID_USERNAME');
  }
  if (password.length < 3 || password.length > 80) {
    throw new ApiError('Password admin tambahan harus terdiri dari 3–80 karakter.', 'INVALID_PASSWORD');
  }
  if (!wa && !email) {
    throw new ApiError('Isi minimal nomor WhatsApp atau email untuk pemulihan password.', 'IDENTITY_REQUIRED');
  }
  return { nama, username, password, wa, email };
}

async function ownerCreateAdmin(env, session, body) {
  await verifyOwnerAccess(env, session, body.setupKey);
  const input = validateSecondaryAdminInput(body);
  const timestamp = nowIso();
  const account = {
    id: makeId('admin'),
    ...input,
    isMainAdmin: false,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await createOrUpdateUser(env, account, 'admin', {
    password: account.password,
    isMainAdmin: false,
    active: true
  });
  await upsertRecord(env, 'admins', account);
  return account;
}

async function ownerUpdateAdminCredential(env, session, body) {
  await verifyOwnerAccess(env, session, body.setupKey);
  const adminId = String(body.adminId || '').trim();
  if (!adminId || adminId === 'admin-main') {
    throw new ApiError('Akun admin utama tidak dapat diubah dari daftar admin tambahan.', 'MAIN_ADMIN_PROTECTED', 403);
  }
  const existing = await getRecord(env, 'admins', adminId, { includePassword: true });
  if (!existing || truthy(existing.isMainAdmin)) {
    throw new ApiError('Akun admin tambahan tidak ditemukan.', 'NOT_FOUND', 404);
  }
  const input = validateSecondaryAdminInput(body);
  const updated = {
    ...existing,
    ...input,
    id: adminId,
    isMainAdmin: false,
    active: true,
    passwordUpdatedAt: nowIso(),
    updatedAt: nowIso()
  };
  await createOrUpdateUser(env, updated, 'admin', {
    password: updated.password,
    isMainAdmin: false,
    active: true
  });
  await upsertRecord(env, 'admins', updated);
  return updated;
}

async function ownerDeleteAdmin(env, session, body) {
  await verifyOwnerAccess(env, session, body.setupKey);
  const adminId = String(body.adminId || '').trim();
  if (!adminId || adminId === 'admin-main') {
    throw new ApiError('Admin utama tidak dapat dihapus.', 'MAIN_ADMIN_PROTECTED', 403);
  }
  const existing = await getRecord(env, 'admins', adminId);
  if (!existing || truthy(existing.isMainAdmin)) {
    throw new ApiError('Akun admin tambahan tidak ditemukan.', 'NOT_FOUND', 404);
  }
  await deleteRecord(env, 'admins', adminId);
  await deleteUser(env, adminId);
  return { success: true, id: adminId };
}

async function resetPassword(env, username, identity, newPassword) {
  const userName = String(username || '').trim();
  const identityValue = normalizeIdentity(identity);
  const password = String(newPassword || '');
  if (!userName || !identityValue || !password) throw new ApiError('Semua kolom wajib diisi.');
  if (password.length > 80) throw new ApiError('Password baru maksimal 80 karakter.');
  const limit = await rateLimitStatus(env, 'reset-password', userName, 5, 900);
  if (limit.blocked) throw new ApiError('Terlalu banyak percobaan. Coba lagi sekitar 15 menit.', 'TOO_MANY_ATTEMPTS', 429);
  const user = await getUserByUsername(env, userName);
  const minimumPasswordLength = user?.role === 'admin' ? 3 : 6;
  if (password.length < minimumPasswordLength) {
    throw new ApiError(user?.role === 'admin'
      ? 'Password admin baru minimal 3 karakter.'
      : 'Password tentor baru minimal 6 karakter.');
  }
  const matches = user && [user.email, user.wa].some(value => value && normalizeIdentity(value) === identityValue);
  if (!matches) {
    await recordFailedAttempt(env, 'reset-password', userName, 900);
    throw new ApiError('Username dan email/WhatsApp tidak sesuai dengan data akun.');
  }
  const passwordHash = await hashPassword(password);
  await env.DB.prepare('UPDATE ks_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, nowIso(), String(user.id)).run();
  const table = user.role === 'admin' ? 'admins' : 'tutors';
  const record = await getRecord(env, table, user.id, { includePassword: true });
  if (record) await upsertRecord(env, table, { ...record, password, passwordUpdatedAt: nowIso(), updatedAt: nowIso() });
  await clearAttempts(env, 'reset-password', userName);
  return { success: true, message: 'Password berhasil diperbarui. Silakan login menggunakan password baru.' };
}

async function importRecords(env, request, session, body) {
  requireMainAdmin(session);
  const table = String(body.table || '');
  if (!TABLES.has(table)) throw new ApiError('Nama tabel impor tidak dikenal.');
  const records = Array.isArray(body.records) ? body.records : [];
  if (records.length > 100) throw new ApiError('Maksimal 100 data per sekali impor.');
  let imported = 0;
  const errors = [];
  for (let index = 0; index < records.length; index += 1) {
    try {
      await saveOne(env, request, session, table, records[index], { migration: true, skipAuthorization: true });
      imported += 1;
    } catch (error) {
      errors.push({ index, id: records[index]?.id || '', message: error.message || String(error) });
    }
  }
  return { table, imported, failed: errors.length, errors };
}

export async function dispatchAction(env, request, body) {
  const action = String(body.action || '').trim();
  if (!action) throw new ApiError('Action belum dikirim.', 'MISSING_ACTION');

  if (action === 'setup') return { ok: true, result: await setup(env, body) };
  if (action === 'getPublic') return { ok: true, data: await getPublicData(env) };
  if (action === 'login') return { ok: true, result: await staffLogin(env, body.username, body.password) };
  if (action === 'logout') {
    await destroySession(env, body.token || '');
    return { ok: true };
  }
  if (action === 'parentLogin') return { ok: true, result: await parentLogin(env, body.username || body.studentName, body.pin) };
  if (action === 'parentGetData') {
    const parentSession = await requireParentSession(env, body.parentToken || '');
    return { ok: true, data: await getParentData(env, parentSession) };
  }
  if (action === 'parentSubmitPaymentProof') {
    const parentSession = await requireParentSession(env, body.parentToken || '');
    const invoice = await submitPaymentProof(env, request, parentSession, body.invoiceId || '', body.proofData || '', body.fileName || 'bukti-transfer.jpg');
    return { ok: true, invoice };
  }
  if (action === 'parentLogout') {
    const { sha256 } = await import('./crypto.js');
    if (body.parentToken) await env.DB.prepare('DELETE FROM ks_parent_sessions WHERE token_hash = ?').bind(await sha256(String(body.parentToken))).run();
    return { ok: true };
  }
  if (action === 'resetPassword') return { ok: true, result: await resetPassword(env, body.username, body.identity, body.newPassword) };
  if (action === 'registerStudent') {
    const record = await processRecord(env, request, 'pendaftar', { ...(body.record || {}), status: body.record?.status || 'Menunggu Persetujuan Admin' });
    await upsertRecord(env, 'pendaftar', record);
    return { ok: true, record };
  }
  if (action === 'registerTutor') {
    const raw = { ...(body.record || {}), id: makeId('tutor'), showOnHome: false, tampilBeranda: false };
    const fakeAdmin = { role: 'admin', isMainAdmin: true, userId: 'public-registration' };
    const tutor = await saveOne(env, request, fakeAdmin, 'tutors', raw, { skipAuthorization: true });
    return { ok: true, tutor };
  }

  const session = await requireSession(env, body.token || '');

  if (action === 'ownerGetTutorCredentials') {
    return { ok: true, accounts: await ownerGetTutorCredentials(env, session, body.setupKey) };
  }
  if (action === 'ownerUpdateTutorCredential') {
    return { ok: true, account: await ownerUpdateTutorCredential(env, session, body) };
  }

  if (action === 'ownerGetAdminCredentials') {
    return { ok: true, accounts: await ownerGetAdminCredentials(env, session, body.setupKey) };
  }
  if (action === 'ownerCreateAdmin') {
    return { ok: true, account: await ownerCreateAdmin(env, session, body) };
  }
  if (action === 'ownerUpdateAdminCredential') {
    return { ok: true, account: await ownerUpdateAdminCredential(env, session, body) };
  }
  if (action === 'ownerDeleteAdmin') {
    return { ok: true, result: await ownerDeleteAdmin(env, session, body) };
  }
  if (action === 'ownerGetBackupSettings') {
    await verifyOwnerAccess(env, session, body.setupKey);
    return { ok: true, backup: await getDriveBackupSettings(env) };
  }
  if (action === 'ownerSetBackupEnabled') {
    await verifyOwnerAccess(env, session, body.setupKey);
    const enabled = truthy(body.enabled);
    const actor = session.nama || session.username || 'Owner';
    return { ok: true, backup: await setDriveBackupEnabled(env, enabled, actor) };
  }
  if (action === 'ownerRunBackupNow') {
    await verifyOwnerAccess(env, session, body.setupKey);
    const actor = session.nama || session.username || 'Owner';
    return { ok: true, result: await runDriveBackup(env, { reason: 'manual', actor, force: true }) };
  }
  if (action === 'dailyBackupOnSync') {
    if (!session || session.role !== 'admin') {
      return { ok: true, result: { ok: true, skipped: true, reason: 'not-admin' } };
    }
    const actor = session.nama || session.username || 'Admin';
    return { ok: true, result: await runDriveBackupIfDueOnSync(env, { actor }) };
  }
  if (action === 'getAll') return { ok: true, data: await getAllData(env, session) };
  if (action === 'getNotes') {
    requireAdmin(session);
    return { ok: true, notes: await listRecords(env, 'note') };
  }
  if (action === 'listPelatihanFolder') {
    const sourceId = String(body.sourceId || '').trim();
    if (!sourceId) throw new ApiError('Sumber folder Pelatihan belum dipilih.', 'MISSING_PELATIHAN_SOURCE');
    const source = await getRecord(env, 'pelatihan', sourceId);
    if (!source) throw new ApiError('Sumber folder Pelatihan tidak ditemukan.', 'NOT_FOUND', 404);
    return { ok: true, source, library: await listPelatihanFolder(env, source.folderUrl || '') };
  }
  if (action === 'upsertRecord') {
    const table = String(body.table || '');
    assertTable(table);
    const record = await saveOne(env, request, session, table, body.record || {});
    if (table === 'tutors') delete record.password;
    return { ok: true, table, record };
  }
  if (action === 'deleteRecord') {
    const table = String(body.table || '');
    assertTable(table);
    await authorizeDelete(env, session, table, body.id || '');
    await deleteRecord(env, table, body.id || '');
    if (table === 'tutors') await deleteUser(env, body.id || '');
    return { ok: true, table, records: await filterTable(env, table, session) };
  }
  if (action === 'getReportHistoryMarks') {
    return {
      ok: true,
      marks: await listReportHistoryMarks(env, session.role === 'tutor' ? { tutorId: session.tutorId } : {})
    };
  }
  if (action === 'setReportHistoryMark') {
    const reportId = String(body.reportId || body.id || '').trim();
    const report = await getRecord(env, 'laporan', reportId);
    if (!report) throw new ApiError('Laporan tidak ditemukan.', 'NOT_FOUND', 404);
    await authorizeWrite(env, session, 'laporan', report);
    const actor = session.nama || session.username || session.userId || session.tutorId || '';
    return {
      ok: true,
      report: await setReportHistoryMark(env, reportId, truthy(body.isMarked), actor)
    };
  }
  if (action === 'approvePendaftar') {
    const result = await approveRegistration(env, request, session, body.registrationId || body.id, body.tutorId, body.studentId);
    return { ok: true, ...result };
  }
  if (action === 'approveInvoicePayment') {
    return { ok: true, invoice: await approveInvoicePayment(env, session, body.invoiceId || body.id) };
  }
  if (action === 'saveTable') {
    const table = String(body.table || '');
    assertTable(table);
    const records = Array.isArray(body.records) ? body.records : [];
    if (session.role === 'admin') {
      const previousTutorIds = table === 'tutors'
        ? new Set((await listRecords(env, 'tutors')).map(item => String(item.id || '')).filter(Boolean))
        : new Set();
      const processed = [];
      for (const record of records) processed.push(await processRecord(env, request, table, record));
      if (table === 'tutors') {
        for (let i = 0; i < processed.length; i += 1) {
          const password = String(records[i]?.password || '');
          await createOrUpdateUser(env, processed[i], 'tutor', { password });
          processed[i].password = password || (await getRecord(env, 'tutors', processed[i].id, { includePassword: true }))?.password || '';
          previousTutorIds.delete(String(processed[i].id || ''));
        }
      }
      await replaceTable(env, table, processed);
      if (table === 'tutors') {
        for (const removedId of previousTutorIds) await deleteUser(env, removedId);
      }
    } else {
      if (!['jadwal', 'laporan', 'absensi'].includes(table)) throw new ApiError('Akun ini tidak memiliki izin.', 'FORBIDDEN', 403);
      const processed = [];
      for (const record of records) {
        const item = await processRecord(env, request, table, record);
        await authorizeWrite(env, session, table, item);
        processed.push(item);
      }
      await replaceTable(env, table, processed, {
        preserve: item => String(item.tutorId || '') !== String(session.tutorId || '')
      });
    }
    return { ok: true, table, records: await filterTable(env, table, session) };
  }
  if (action === 'saveAll') {
    requireAdmin(session);
    const tables = body.tables || {};
    for (const [table, records] of Object.entries(tables)) {
      if (!TABLES.has(table) || table === 'admins' || table === 'theme' || !Array.isArray(records)) continue;
      const processed = [];
      for (const record of records) processed.push(await processRecord(env, request, table, record));
      await replaceTable(env, table, processed);
    }
    if (body.theme && (session.isMainAdmin || session.userId === 'admin-main')) {
      await replaceTable(env, 'theme', [{ id: 'main', ...body.theme, updatedAt: nowIso() }]);
    }
    return { ok: true, data: await getAllData(env, session) };
  }
  if (action === 'saveTheme') {
    requireMainAdmin(session);
    const theme = { id: 'main', ...(body.theme || {}), updatedAt: nowIso() };
    await replaceTable(env, 'theme', [theme]);
    return { ok: true, theme };
  }
  if (action === 'fileBase64') return { ok: true, dataUrl: await fileAsDataUrl(env, body.fileId || '') };
  if (action === 'syncLoginAccounts') {
    requireMainAdmin(session);
    const tutors = await listRecords(env, 'tutors', { includePassword: true });
    for (const tutor of tutors) await createOrUpdateUser(env, tutor, 'tutor', { password: tutor.password || '' });
    return { ok: true, result: { synced: tutors.length } };
  }
  if (action === 'importRecords') return { ok: true, result: await importRecords(env, request, session, body) };
  if (action === 'exportAll') {
    requireMainAdmin(session);
    const data = {};
    for (const table of TABLES) data[table] = await listRecords(env, table, { includePassword: true });
    return { ok: true, data, exportedAt: nowIso() };
  }
  throw new ApiError(`Action tidak dikenal: ${action}`, 'UNKNOWN_ACTION');
}
