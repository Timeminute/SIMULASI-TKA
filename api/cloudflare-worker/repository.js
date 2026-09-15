import {
  ApiError, TABLES, clone, normalizeName, normalizeUsername,
  nowIso, truthy
} from './utils.js';
import { hashPassword, openText, sealText, sha256 } from './crypto.js';

function assertTable(table) {
  if (!TABLES.has(table)) throw new ApiError(`Table tidak dikenal: ${table}`, 'UNKNOWN_TABLE');
}

function dateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return raw.slice(0, 10);
}

function invoicePeriodKey(record) {
  const student = normalizeName(record.namaSiswa || record.siswaId || '');
  if (!student) return '';
  const type = String(record.tipeTagihan || '').toLowerCase() === 'bulanan' ? 'bulanan' : 'pertemuan';
  const period = type === 'bulanan'
    ? String(record.bulanTagihan || '').slice(0, 7)
    : dateKey(record.tanggal || '');
  return period ? `${student}|${type}|${period}` : '';
}

function attendancePeriodKey(record) {
  const scheduleId = String(record.jadwalId || record.scheduleId || '').trim();
  const student = normalizeName(record.siswaId || record.nama || record.groupName || '');
  const tutor = normalizeName(record.tutorId || record.tutorNama || '');
  const date = dateKey(record.tanggal || record.date || '');
  const start = String(record.mulai || record.jamMulai || '').trim();
  if (scheduleId && student && date) return `${scheduleId}|${date}|${student}`;
  if (scheduleId && date) return `${scheduleId}|${date}`;
  return (student || tutor || date || start) ? `${student}|${tutor}|${date}|${start}` : '';
}

function indexFields(table, record) {
  return {
    tutorId: String(record.tutorId || (table === 'tutors' ? record.id : '') || ''),
    studentId: String(record.siswaId || (table === 'siswa' ? record.id : '') || ''),
    scheduleId: String(record.jadwalId || record.scheduleId || ''),
    attendanceId: String(record.absensiId || ''),
    usernameNorm: table === 'siswa' ? normalizeUsername(record.username || '') : '',
    periodKey: table === 'invoice' ? invoicePeriodKey(record) : (table === 'absensi' ? attendancePeriodKey(record) : '')
  };
}

async function encodeSensitiveRecord(table, record, env) {
  const item = clone(record || {});
  if ((table === 'admins' || table === 'tutors') && Object.prototype.hasOwnProperty.call(item, 'password')) {
    const password = String(item.password || '');
    if (password) item.passwordCipher = await sealText(password, env.APP_SECRET || '');
    delete item.password;
  }
  return item;
}

async function decodeSensitiveRecord(table, record, env, options = {}) {
  const item = clone(record || {});
  if (table === 'admins' || table === 'tutors') {
    if (options.includePassword) item.password = await openText(item.passwordCipher || '', env.APP_SECRET || '');
    delete item.passwordCipher;
  }
  return item;
}


function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function reportDetailId(reportId, studentId, index = 0) {
  const safeStudent = String(studentId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '-');
  return `${String(reportId || 'laporan')}:detail:${safeStudent || index + 1}`;
}

function normalizeReportDetails(record) {
  const item = clone(record || {});
  const explicit = Array.isArray(item.details) ? item.details : [];
  const memberIds = Array.isArray(item.groupMemberIds) ? item.groupMemberIds : [];
  const memberNames = Array.isArray(item.groupMemberNames) ? item.groupMemberNames : [];
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
  return source.map((detail, index) => {
    const muridId = String(detail?.muridId || detail?.siswaId || detail?.studentId || memberIds[index] || '').trim();
    const muridNama = String(detail?.muridNama || detail?.nama || detail?.namaSiswa || memberNames[index] || '').trim();
    const key = muridId || normalizeName(muridNama);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const rawScore = detail?.nilai;
    const score = rawScore === '' || rawScore == null ? null : Number(rawScore);
    const rawRating = Number(detail?.rating || 0);
    return {
      id: reportDetailId(item.id, muridId, index),
      laporanId: String(item.id || detail?.laporanId || ''),
      muridId,
      muridNama,
      nilai: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
      rating: Number.isFinite(rawRating) ? Math.max(0, Math.min(5, Math.round(rawRating))) : 0,
      pr: String(detail?.pr || ''),
      catatan: String(detail?.catatan || ''),
      sortOrder: Number.isFinite(Number(detail?.sortOrder)) ? Number(detail.sortOrder) : index,
      createdAt: String(detail?.createdAt || item.createdAt || nowIso()),
      updatedAt: String(detail?.updatedAt || item.updatedAt || nowIso())
    };
  }).filter(Boolean);
}

function reportFromRows(row, details = []) {
  const item = {
    id: String(row.id || ''),
    tanggal: String(row.tanggal || ''),
    kelompokId: String(row.kelompok_id || ''),
    tutorId: String(row.tutor_id || ''),
    materi: String(row.materi || ''),
    aktivitas: String(row.aktivitas || ''),
    jadwalId: String(row.jadwal_id || ''),
    absensiId: String(row.absensi_id || ''),
    tutorNama: String(row.tutor_nama || ''),
    siswaId: String(row.siswa_id || ''),
    nama: String(row.nama || ''),
    groupName: String(row.group_name || ''),
    groupType: String(row.group_type || ''),
    groupClassType: String(row.group_type || ''),
    mulai: String(row.mulai || ''),
    selesai: String(row.selesai || ''),
    kelas: String(row.kelas || ''),
    mapel: String(row.mapel || ''),
    kehadiran: String(row.kehadiran || ''),
    images: parseJsonArray(row.images_json),
    absensiIds: parseJsonArray(row.absensi_ids_json),
    groupMemberIds: parseJsonArray(row.group_member_ids_json),
    groupMemberNames: parseJsonArray(row.group_member_names_json),
    details,
    historyMarked: Number(row.history_marked || 0) === 1,
    historyMarkedAt: String(row.history_marked_at || ''),
    historyMarkedBy: String(row.history_marked_by || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || '')
  };

  // Kompatibilitas laporan privat lama: bagian lain aplikasi masih membaca
  // nilai/pr/rating/catatan dari level laporan. Untuk laporan kelompok, data
  // tetap hanya berada pada details agar tidak tertukar antarsiswa.
  const isGroup = Boolean(item.groupName || item.groupMemberIds.length > 1 || details.length > 1);
  if (!isGroup && details[0]) {
    item.pr = details[0].pr || '';
    item.nilai = details[0].nilai == null ? '' : details[0].nilai;
    item.rating = details[0].rating || 0;
    item.catatan = details[0].catatan || '';
  } else {
    item.pr = '';
    item.nilai = '';
    item.rating = 0;
    item.catatan = '';
  }
  return item;
}

function legacyReportFromRecord(row) {
  let item;
  try {
    item = JSON.parse(String(row?.data_json || '{}'));
  } catch {
    return null;
  }
  if (!item || typeof item !== 'object') return null;
  item = clone(item);
  item.id = String(item.id || row?.record_id || '').trim();
  if (!item.id) return null;
  const details = normalizeReportDetails(item);
  item.details = details;
  item.groupMemberIds = Array.isArray(item.groupMemberIds) && item.groupMemberIds.length
    ? item.groupMemberIds.map(value => String(value || '')).filter(Boolean)
    : details.map(detail => detail.muridId).filter(Boolean);
  item.groupMemberNames = Array.isArray(item.groupMemberNames) && item.groupMemberNames.length
    ? item.groupMemberNames.map(value => String(value || '')).filter(Boolean)
    : details.map(detail => detail.muridNama).filter(Boolean);
  item.createdAt = String(item.createdAt || row?.created_at || '');
  item.updatedAt = String(item.updatedAt || row?.updated_at || item.createdAt || '');
  item.historyMarked = item.historyMarked === true;
  return item;
}

function normalizePageOptions(options = {}) {
  const rawLimit = Number(options.limit || 0);
  const rawOffset = Number(options.offset || 0);
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 0,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? Math.max(0, Math.floor(rawOffset)) : 0,
    month: /^\d{4}-\d{2}$/.test(String(options.month || '')) ? String(options.month) : '',
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(String(options.dateFrom || '')) ? String(options.dateFrom) : '',
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(String(options.dateTo || '')) ? String(options.dateTo) : ''
  };
}

async function listReports(env, options = {}) {
  const page = normalizePageOptions(options);
  let sql = `SELECT h.*,
    CASE WHEN m.laporan_id IS NULL THEN 0 ELSE 1 END AS history_marked,
    COALESCE(m.updated_at, '') AS history_marked_at,
    COALESCE(m.updated_by, '') AS history_marked_by
    FROM laporan_harian h
    LEFT JOIN laporan_harian_mark m ON m.laporan_id = h.id`;
  const where = [];
  const binds = [];
  if (options.tutorId) {
    where.push('h.tutor_id = ?');
    binds.push(String(options.tutorId));
  }
  if (page.month) {
    where.push('h.tanggal LIKE ?');
    binds.push(`${page.month}%`);
  }
  if (page.dateFrom) {
    where.push('h.tanggal >= ?');
    binds.push(page.dateFrom);
  }
  if (page.dateTo) {
    where.push('h.tanggal <= ?');
    binds.push(page.dateTo);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY h.updated_at DESC, h.created_at DESC';
  if (page.limit) sql += ` LIMIT ${page.limit} OFFSET ${page.offset}`;

  let legacySql = `SELECT record_id, data_json, created_at, updated_at
    FROM ks_records WHERE table_name = 'laporan'`;
  const legacyBinds = [];
  if (options.tutorId) {
    legacySql += ' AND tutor_id = ?';
    legacyBinds.push(String(options.tutorId));
  }
  if (page.month) {
    legacySql += " AND json_extract(data_json, '$.tanggal') LIKE ?";
    legacyBinds.push(`${page.month}%`);
  }
  if (page.dateFrom) {
    legacySql += " AND json_extract(data_json, '$.tanggal') >= ?";
    legacyBinds.push(page.dateFrom);
  }
  if (page.dateTo) {
    legacySql += " AND json_extract(data_json, '$.tanggal') <= ?";
    legacyBinds.push(page.dateTo);
  }
  legacySql += ' ORDER BY updated_at DESC, created_at DESC';
  if (page.limit) legacySql += ` LIMIT ${page.limit} OFFSET ${page.offset}`;

  // Ambil header dan fallback legacy terlebih dahulu. Detail hanya diambil untuk
  // laporan pada halaman aktif, bukan seluruh tabel. Ini yang menjaga pembacaan
  // laporan tetap ringan meskipun histori sudah puluhan ribu baris.
  const [headerResult, legacyResult] = await Promise.all([
    env.DB.prepare(sql).bind(...binds).all(),
    env.DB.prepare(legacySql).bind(...legacyBinds).all()
  ]);

  const headerRows = headerResult.results || [];
  const ids = headerRows.map(row => String(row.id || '')).filter(Boolean);
  const detailMap = new Map();
  if (ids.length) {
    // SQLite/D1 memiliki batas jumlah variabel bind dalam satu statement.
    // Jangan kirim seluruh id halaman sekaligus karena data besar dapat
    // memicu D1_ERROR: too many SQL variables. Ambil detail secara batch kecil.
    const ID_BATCH_SIZE = 80;
    const detailRows = [];
    for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
      const chunk = ids.slice(start, start + ID_BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const detailResult = await env.DB.prepare(
        `SELECT * FROM laporan_harian_detail
         WHERE laporan_id IN (${placeholders})
         ORDER BY laporan_id, sort_order, created_at`
      ).bind(...chunk).all();
      detailRows.push(...(detailResult.results || []));
    }
    for (const row of detailRows) {
      const key = String(row.laporan_id || '');
      if (!detailMap.has(key)) detailMap.set(key, []);
      detailMap.get(key).push({
        id: String(row.id || ''),
        laporanId: key,
        muridId: String(row.murid_id || ''),
        muridNama: String(row.murid_nama || ''),
        nilai: row.nilai == null ? '' : Number(row.nilai),
        rating: Number(row.rating || 0),
        pr: String(row.pr || ''),
        catatan: String(row.catatan || ''),
        sortOrder: Number(row.sort_order || 0),
        createdAt: String(row.created_at || ''),
        updatedAt: String(row.updated_at || '')
      });
    }
  }

  const normalized = headerRows.map(row => reportFromRows(row, detailMap.get(String(row.id || '')) || []));
  const knownIds = new Set(normalized.map(item => String(item.id || '')));
  const legacy = (legacyResult.results || [])
    .map(legacyReportFromRecord)
    .filter(item => item && !knownIds.has(String(item.id || '')));
  const merged = [...normalized, ...legacy].sort((a, b) => {
    const left = new Date(a?.updatedAt || a?.createdAt || 0).getTime() || 0;
    const right = new Date(b?.updatedAt || b?.createdAt || 0).getTime() || 0;
    return right - left;
  });
  return page.limit ? merged.slice(0, page.limit) : merged;
}

async function getReport(env, id) {
  const reportId = String(id || '').trim();
  if (!reportId) return null;
  const [row, detailResult] = await Promise.all([
    env.DB.prepare(
      `SELECT h.*,
        CASE WHEN m.laporan_id IS NULL THEN 0 ELSE 1 END AS history_marked,
        COALESCE(m.updated_at, '') AS history_marked_at,
        COALESCE(m.updated_by, '') AS history_marked_by
       FROM laporan_harian h
       LEFT JOIN laporan_harian_mark m ON m.laporan_id = h.id
       WHERE h.id = ? LIMIT 1`
    ).bind(reportId).first(),
    env.DB.prepare(
      `SELECT * FROM laporan_harian_detail
       WHERE laporan_id = ? ORDER BY sort_order, created_at`
    ).bind(reportId).all()
  ]);
  if (!row) return null;
  const details = (detailResult.results || []).map(detail => ({
    id: String(detail.id || ''),
    laporanId: String(detail.laporan_id || ''),
    muridId: String(detail.murid_id || ''),
    muridNama: String(detail.murid_nama || ''),
    nilai: detail.nilai == null ? '' : Number(detail.nilai),
    rating: Number(detail.rating || 0),
    pr: String(detail.pr || ''),
    catatan: String(detail.catatan || ''),
    sortOrder: Number(detail.sort_order || 0),
    createdAt: String(detail.created_at || ''),
    updatedAt: String(detail.updated_at || '')
  }));
  return reportFromRows(row, details);
}

async function upsertReport(env, record, options = {}) {
  const item = clone(record || {});
  const id = String(item.id || '').trim();
  if (!id) throw new ApiError('ID laporan belum tersedia.', 'INVALID_REPORT');
  const details = normalizeReportDetails(item);
  if (!details.length) {
    throw new ApiError('Laporan wajib memiliki sedikitnya satu data siswa.', 'INVALID_REPORT_DETAIL');
  }

  // INSERT memakai createdAt dari record; saat konflik created_at tidak diubah,
  // jadi tidak perlu SELECT pendahuluan hanya untuk mengambil nilai lama.
  const createdAt = String(item.createdAt || nowIso());
  const updatedAt = String(item.updatedAt || nowIso());
  const memberIds = Array.isArray(item.groupMemberIds) && item.groupMemberIds.length
    ? item.groupMemberIds.map(value => String(value || '')).filter(Boolean)
    : details.map(detail => detail.muridId).filter(Boolean);
  const memberNames = Array.isArray(item.groupMemberNames) && item.groupMemberNames.length
    ? item.groupMemberNames.map(value => String(value || '')).filter(Boolean)
    : details.map(detail => detail.muridNama).filter(Boolean);
  const groupMode = Boolean(item.groupName || memberIds.length > 1 || details.length > 1);

  const statements = [
    env.DB.prepare(
      `INSERT INTO laporan_harian(
        id, tanggal, kelompok_id, tutor_id, materi, aktivitas, jadwal_id, absensi_id,
        tutor_nama, siswa_id, nama, group_name, group_type, mulai, selesai, kelas,
        mapel, kehadiran, images_json, absensi_ids_json, group_member_ids_json,
        group_member_names_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tanggal = excluded.tanggal,
        kelompok_id = excluded.kelompok_id,
        tutor_id = excluded.tutor_id,
        materi = excluded.materi,
        aktivitas = excluded.aktivitas,
        jadwal_id = excluded.jadwal_id,
        absensi_id = excluded.absensi_id,
        tutor_nama = excluded.tutor_nama,
        siswa_id = excluded.siswa_id,
        nama = excluded.nama,
        group_name = excluded.group_name,
        group_type = excluded.group_type,
        mulai = excluded.mulai,
        selesai = excluded.selesai,
        kelas = excluded.kelas,
        mapel = excluded.mapel,
        kehadiran = excluded.kehadiran,
        images_json = excluded.images_json,
        absensi_ids_json = excluded.absensi_ids_json,
        group_member_ids_json = excluded.group_member_ids_json,
        group_member_names_json = excluded.group_member_names_json,
        updated_at = excluded.updated_at`
    ).bind(
      id,
      String(item.tanggal || ''),
      String(item.kelompokId || item.groupName || (groupMode ? item.jadwalId || '' : '')),
      String(item.tutorId || ''),
      String(item.materi || ''),
      String(item.aktivitas || ''),
      String(item.jadwalId || item.scheduleId || ''),
      String(item.absensiId || ''),
      String(item.tutorNama || ''),
      groupMode ? '' : String(item.siswaId || details[0]?.muridId || ''),
      String(item.nama || ''),
      String(item.groupName || ''),
      String(item.groupType || item.groupClassType || ''),
      String(item.mulai || ''),
      String(item.selesai || ''),
      String(item.kelas || ''),
      String(item.mapel || ''),
      String(item.kehadiran || ''),
      JSON.stringify(Array.isArray(item.images) ? item.images : []),
      JSON.stringify(Array.isArray(item.absensiIds) ? item.absensiIds : []),
      JSON.stringify(memberIds),
      JSON.stringify(memberNames),
      createdAt,
      updatedAt
    ),
    env.DB.prepare('DELETE FROM laporan_harian_detail WHERE laporan_id = ?').bind(id)
  ];

  // D1 membatasi 100 bound parameters per query. Satu detail memakai 11,
  // sehingga maksimal 9 detail digabung dalam satu INSERT. Ini memangkas
  // jumlah query secara drastis pada laporan kelompok dan proses migrasi.
  const DETAIL_ROWS_PER_QUERY = 9;
  for (let start = 0; start < details.length; start += DETAIL_ROWS_PER_QUERY) {
    const chunk = details.slice(start, start + DETAIL_ROWS_PER_QUERY);
    const valuesSql = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const bindings = [];
    chunk.forEach((detail, offset) => {
      const index = start + offset;
      bindings.push(
        detail.id || reportDetailId(id, detail.muridId, index),
        id,
        detail.muridId,
        detail.muridNama,
        detail.nilai === '' || detail.nilai == null ? null : detail.nilai,
        detail.rating,
        detail.pr,
        detail.catatan,
        index,
        detail.createdAt || createdAt,
        updatedAt
      );
    });
    statements.push(env.DB.prepare(
      `INSERT INTO laporan_harian_detail(
        id, laporan_id, murid_id, murid_nama, nilai, rating, pr, catatan,
        sort_order, created_at, updated_at
      ) VALUES ${valuesSql}`
    ).bind(...bindings));
  }
  // Bersihkan format JSON lama hanya setelah header dan semua detail berhasil.
  statements.push(env.DB.prepare(
    "DELETE FROM ks_records WHERE table_name = 'laporan' AND record_id = ?"
  ).bind(id));

  try {
    // D1 batch bersifat transaksional: jika satu detail gagal, header dan detail
    // lain ikut dibatalkan sehingga tidak ada laporan setengah tersimpan.
    await env.DB.batch(statements);
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('ux_laporan_harian_jadwal') || message.includes('laporan_harian.jadwal_id')) {
      throw new ApiError('Jadwal les ini sudah memiliki satu laporan harian.', 'DUPLICATE_REPORT');
    }
    if (message.includes('laporan_harian_detail.laporan_id') || message.includes('laporan_harian_detail.murid_id')) {
      throw new ApiError('Data siswa pada laporan kelompok terduplikasi.', 'DUPLICATE_REPORT_DETAIL');
    }
    throw error;
  }
  if (options.skipReadback === true) {
    return {
      ...item,
      id,
      createdAt,
      updatedAt,
      groupMemberIds: memberIds,
      groupMemberNames: memberNames,
      details
    };
  }
  return getReport(env, id);
}

async function deleteReport(env, id) {
  const reportId = String(id || '').trim();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM laporan_harian_mark WHERE laporan_id = ?').bind(reportId),
    env.DB.prepare('DELETE FROM laporan_harian_detail WHERE laporan_id = ?').bind(reportId),
    env.DB.prepare('DELETE FROM laporan_harian WHERE id = ?').bind(reportId),
    env.DB.prepare("DELETE FROM ks_records WHERE table_name = 'laporan' AND record_id = ?").bind(reportId)
  ]);
}

export async function listReportHistoryMarks(env, options = {}) {
  let sql = `SELECT m.laporan_id, m.updated_at, m.updated_by
    FROM laporan_harian_mark m
    INNER JOIN laporan_harian h ON h.id = m.laporan_id`;
  const binds = [];
  if (options.tutorId) {
    sql += ' WHERE h.tutor_id = ?';
    binds.push(String(options.tutorId));
  }
  sql += ' ORDER BY m.updated_at DESC';
  const result = await env.DB.prepare(sql).bind(...binds).all();
  return (result.results || []).map(row => ({
    reportId: String(row.laporan_id || ''),
    isMarked: true,
    updatedAt: String(row.updated_at || ''),
    updatedBy: String(row.updated_by || '')
  }));
}

export async function setReportHistoryMark(env, reportId, isMarked, actor = '') {
  const id = String(reportId || '').trim();
  if (!id) throw new ApiError('ID laporan belum tersedia.', 'INVALID_REPORT');

  const report = await getReport(env, id);
  if (!report) throw new ApiError('Laporan tidak ditemukan.', 'NOT_FOUND', 404);

  if (isMarked) {
    await env.DB.prepare(
      `INSERT INTO laporan_harian_mark(laporan_id, updated_at, updated_by)
       VALUES(?, ?, ?)
       ON CONFLICT(laporan_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).bind(id, nowIso(), String(actor || '')).run();
  } else {
    await env.DB.prepare('DELETE FROM laporan_harian_mark WHERE laporan_id = ?').bind(id).run();
  }

  return getReport(env, id);
}

export async function listRecords(env, table, options = {}) {
  assertTable(table);
  if (table === 'laporan') return listReports(env, options);
  const page = normalizePageOptions(options);
  let sql = 'SELECT data_json FROM ks_records WHERE table_name = ?';
  const binds = [table];
  if (options.tutorId) {
    sql += ' AND tutor_id = ?';
    binds.push(String(options.tutorId));
  }
  if (options.studentId) {
    sql += ' AND student_id = ?';
    binds.push(String(options.studentId));
  }
  if (page.month) {
    sql += " AND json_extract(data_json, '$.tanggal') LIKE ?";
    binds.push(`${page.month}%`);
  }
  if (page.dateFrom) {
    sql += " AND json_extract(data_json, '$.tanggal') >= ?";
    binds.push(page.dateFrom);
  }
  if (page.dateTo) {
    sql += " AND json_extract(data_json, '$.tanggal') <= ?";
    binds.push(page.dateTo);
  }
  sql += ' ORDER BY updated_at DESC, created_at DESC';
  if (page.limit) sql += ` LIMIT ${page.limit} OFFSET ${page.offset}`;
  const result = await env.DB.prepare(sql).bind(...binds).all();
  const output = [];
  for (const row of result.results || []) {
    try {
      const parsed = JSON.parse(String(row.data_json || '{}'));
      output.push(await decodeSensitiveRecord(table, parsed, env, options));
    } catch {
      // Baris rusak dilewati agar satu data tidak membuat seluruh dashboard gagal.
    }
  }
  return output;
}


export async function listRecordChanges(env, table, options = {}) {
  assertTable(table);
  if (table === 'laporan') {
    throw new ApiError('Sinkronisasi incremental laporan memakai loader halaman.', 'INCREMENTAL_UNSUPPORTED');
  }

  const rawLimit = Number(options.limit || 100);
  const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100));
  const cursorAt = String(options.cursorAt || '').trim();
  const cursorId = String(options.cursorId || '').trim();
  const tutorId = String(options.tutorId || '').trim();

  const tutorWhere = tutorId ? ' AND tutor_id = ?' : '';
  let sql = `SELECT kind, record_id, data_json, changed_at FROM (
    SELECT 'upsert' AS kind, record_id, data_json, updated_at AS changed_at
      FROM ks_records WHERE table_name = ?${tutorWhere}
    UNION ALL
    SELECT 'delete' AS kind, record_id, NULL AS data_json, deleted_at AS changed_at
      FROM ks_deleted_records WHERE table_name = ?${tutorWhere}
  ) changes
  WHERE (changed_at > ? OR (changed_at = ? AND record_id > ?))`;
  const binds = tutorId
    ? [table, tutorId, table, tutorId, cursorAt, cursorAt, cursorId]
    : [table, table, cursorAt, cursorAt, cursorId];

  sql += ` ORDER BY changed_at ASC, record_id ASC LIMIT ${limit + 1}`;
  const result = await env.DB.prepare(sql).bind(...binds).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const changes = [];

  for (const row of selected) {
    const kind = String(row.kind || '');
    const id = String(row.record_id || '');
    const changedAt = String(row.changed_at || '');
    if (!id || !changedAt) continue;
    if (kind === 'delete') {
      changes.push({ type: 'delete', id, changedAt });
      continue;
    }
    try {
      const parsed = JSON.parse(String(row.data_json || '{}'));
      const record = await decodeSensitiveRecord(table, parsed, env, options);
      changes.push({ type: 'upsert', id, changedAt, record });
    } catch {
      // Satu record rusak tidak boleh menghentikan incremental sync.
    }
  }

  // Cursor harus maju berdasarkan baris DB terakhir, bukan hanya record yang
  // berhasil didecode. Dengan begitu satu JSON rusak tidak membuat sync berulang
  // pada baris yang sama selamanya.
  const lastRow = selected.length ? selected[selected.length - 1] : null;
  return {
    changes,
    hasMore,
    nextCursor: lastRow
      ? { at: String(lastRow.changed_at || cursorAt), id: String(lastRow.record_id || cursorId) }
      : { at: cursorAt, id: cursorId }
  };
}

export async function getRecord(env, table, id, options = {}) {
  assertTable(table);
  if (table === 'laporan') return getReport(env, id);
  const row = await env.DB.prepare(
    'SELECT data_json FROM ks_records WHERE table_name = ? AND record_id = ? LIMIT 1'
  ).bind(table, String(id || '')).first();
  if (!row) return null;
  try {
    return decodeSensitiveRecord(table, JSON.parse(String(row.data_json || '{}')), env, options);
  } catch {
    return null;
  }
}

export async function findRecordByUsername(env, table, username, options = {}) {
  assertTable(table);
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const row = await env.DB.prepare(
    `SELECT data_json FROM ks_records
     WHERE table_name = ? AND username_norm = ? LIMIT 1`
  ).bind(table, normalized).first();
  if (!row) return null;
  return decodeSensitiveRecord(table, JSON.parse(String(row.data_json || '{}')), env, options);
}

export async function upsertRecord(env, table, record, options = {}) {
  assertTable(table);
  if (table === 'laporan') return upsertReport(env, record, options);
  const item = clone(record || {});
  const id = String(item.id || '').trim();
  if (!id) throw new ApiError('ID data belum tersedia.', 'INVALID_RECORD');
  const stored = await encodeSensitiveRecord(table, item, env);
  const index = indexFields(table, stored);
  // Hindari SELECT sebelum setiap UPSERT. created_at hanya dipakai saat INSERT;
  // pada konflik kolom tersebut sengaja tidak di-update sehingga nilai lama tetap aman.
  const createdAt = String(stored.createdAt || nowIso());
  const updatedAt = String(stored.updatedAt || nowIso());
  stored.createdAt = stored.createdAt || createdAt;
  stored.updatedAt = updatedAt;
  const dataJson = JSON.stringify(stored);
  if (table === 'absensi' && index.periodKey) {
    // Satu siswa hanya boleh punya satu absensi untuk jadwal + tanggal yang sama.
    // Bila client mengirim ID baru untuk kejadian yang sama, baris lama diganti.
    await env.DB.prepare(
      'DELETE FROM ks_records WHERE table_name = ? AND period_key = ? AND record_id <> ?'
    ).bind(table, index.periodKey, id).run();
  }
  try {
    await env.DB.prepare(
      `INSERT INTO ks_records(
        table_name, record_id, data_json, tutor_id, student_id, schedule_id,
        attendance_id, username_norm, period_key, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(table_name, record_id) DO UPDATE SET
        data_json = excluded.data_json,
        tutor_id = excluded.tutor_id,
        student_id = excluded.student_id,
        schedule_id = excluded.schedule_id,
        attendance_id = excluded.attendance_id,
        username_norm = excluded.username_norm,
        period_key = excluded.period_key,
        updated_at = excluded.updated_at`
    ).bind(
      table, id, dataJson, index.tutorId, index.studentId, index.scheduleId,
      index.attendanceId, index.usernameNorm, index.periodKey, createdAt, updatedAt
    ).run();
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('ux_ks_student_username') || (table === 'siswa' && message.includes('ks_records.username_norm'))) {
      throw new ApiError(`Username "${item.username || ''}" sudah digunakan siswa lain.`, 'USERNAME_TAKEN');
    }
    if (table === 'absensi' && (
      message.includes('ux_ks_attendance_schedule') ||
      message.includes('ux_ks_attendance_schedule_student') ||
      message.includes('ux_ks_attendance_occurrence') ||
      message.includes('ks_records.schedule_id') ||
      message.includes('ks_records.period_key')
    )) {
      throw new ApiError('Tanggal ini sudah memiliki data absensi untuk siswa tersebut.', 'DUPLICATE_ATTENDANCE');
    }
    if (table === 'laporan' && (message.includes('ux_ks_report_schedule') || message.includes('ks_records.schedule_id'))) {
      throw new ApiError('Jadwal les ini sudah memiliki satu laporan harian.', 'DUPLICATE_REPORT');
    }
    if (table === 'invoice' && (message.includes('ux_ks_invoice_period') || message.includes('ks_records.period_key'))) {
      throw new ApiError('Invoice duplikat terdeteksi untuk siswa dan periode tersebut.', 'DUPLICATE_INVOICE');
    }
    throw error;
  }
  return decodeSensitiveRecord(table, stored, env, { includePassword: true });
}

export async function deleteRecord(env, table, id) {
  assertTable(table);
  if (table === 'laporan') return deleteReport(env, id);
  await env.DB.prepare('DELETE FROM ks_records WHERE table_name = ? AND record_id = ?')
    .bind(table, String(id || '')).run();
}

export async function replaceTable(env, table, records, options = {}) {
  assertTable(table);
  const incoming = Array.isArray(records) ? records : [];
  const keepIds = new Set(incoming.map(item => String(item?.id || '')).filter(Boolean));
  for (const record of incoming) await upsertRecord(env, table, record);
  const current = await listRecords(env, table, { includePassword: true });
  for (const item of current) {
    const id = String(item?.id || '');
    if (!id || keepIds.has(id)) continue;
    if (options.preserve && options.preserve(item)) continue;
    await deleteRecord(env, table, id);
  }
  return listRecords(env, table, { includePassword: true });
}

export async function createOrUpdateUser(env, account, role, options = {}) {
  const username = String(account.username || '').trim();
  const usernameNorm = normalizeUsername(username);
  if (!/^[a-z0-9._-]{3,24}$/.test(usernameNorm)) {
    throw new ApiError('Username harus 3–24 karakter dan hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda minus.', 'INVALID_USERNAME');
  }
  const id = String(account.id || '').trim();
  if (!id) throw new ApiError('ID akun belum tersedia.', 'INVALID_ACCOUNT');
  const existing = await env.DB.prepare('SELECT password_hash FROM ks_users WHERE id = ?').bind(id).first();
  const duplicate = await env.DB.prepare(
    'SELECT id FROM ks_users WHERE username_norm = ? AND id <> ? LIMIT 1'
  ).bind(usernameNorm, id).first();
  if (duplicate) throw new ApiError('Username sudah digunakan. Silakan pilih username lain.', 'USERNAME_TAKEN');

  const plainPassword = String(options.password ?? account.password ?? '');
  const minimumPasswordLength = role === 'admin' ? 3 : 6;
  const passwordMessage = role === 'admin'
    ? 'Password admin harus terdiri dari 3–80 karakter.'
    : 'Password tentor harus terdiri dari 6–80 karakter.';
  if (!existing && (plainPassword.length < minimumPasswordLength || plainPassword.length > 80)) {
    throw new ApiError(passwordMessage, 'INVALID_PASSWORD');
  }
  if (plainPassword && (plainPassword.length < minimumPasswordLength || plainPassword.length > 80)) {
    throw new ApiError(passwordMessage, 'INVALID_PASSWORD');
  }
  const passwordHash = plainPassword ? await hashPassword(plainPassword) : String(existing.password_hash || '');
  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO ks_users(
      id, role, tutor_id, name, username, username_norm, password_hash,
      wa, email, is_main_admin, active, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      tutor_id = excluded.tutor_id,
      name = excluded.name,
      username = excluded.username,
      username_norm = excluded.username_norm,
      password_hash = excluded.password_hash,
      wa = excluded.wa,
      email = excluded.email,
      is_main_admin = excluded.is_main_admin,
      active = excluded.active,
      updated_at = excluded.updated_at`
  ).bind(
    id,
    role,
    role === 'tutor' ? id : '',
    String(account.nama || account.name || (role === 'admin' ? 'Admin' : 'Tentor')),
    username,
    usernameNorm,
    passwordHash,
    String(account.wa || ''),
    String(account.email || ''),
    options.isMainAdmin || account.isMainAdmin || id === 'admin-main' ? 1 : 0,
    options.active === false || account.active === false ? 0 : 1,
    String(account.createdAt || timestamp),
    timestamp
  ).run();
}

export async function getUserByUsername(env, username) {
  const usernameNorm = normalizeUsername(username);
  if (!usernameNorm) return null;
  return env.DB.prepare(
    'SELECT * FROM ks_users WHERE username_norm = ? AND active = 1 LIMIT 1'
  ).bind(usernameNorm).first();
}

export async function getUserById(env, id) {
  return env.DB.prepare('SELECT * FROM ks_users WHERE id = ? LIMIT 1').bind(String(id || '')).first();
}

export async function deleteUser(env, id) {
  await env.DB.prepare('DELETE FROM ks_users WHERE id = ?').bind(String(id || '')).run();
  await env.DB.prepare('DELETE FROM ks_sessions WHERE user_id = ?').bind(String(id || '')).run();
}

export async function saveSession(env, token, user, ttlSeconds) {
  const timestamp = nowIso();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sessionBase = {
    role: String(user.role),
    username: String(user.username || ''),
    nama: String(user.name || ''),
    userId: String(user.id || ''),
    isMainAdmin: truthy(user.is_main_admin),
    loginAt: timestamp
  };
  if (user.role === 'tutor') sessionBase.tutorId = String(user.tutor_id || user.id || '');
  const tokenHash = await sha256(token);
  await env.DB.prepare(
    `INSERT INTO ks_sessions(token_hash, user_id, session_json, expires_at, created_at, last_seen_at)
     VALUES(?, ?, ?, ?, ?, ?)`
  ).bind(tokenHash, String(user.id), JSON.stringify(sessionBase), expiresAt, timestamp, timestamp).run();
  return { ...sessionBase, token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

export async function requireSession(env, token) {
  const clean = String(token || '').trim();
  if (!clean) throw new ApiError('Sesi tidak ditemukan. Silakan login kembali.', 'UNAUTHORIZED', 401);
  const tokenHash = await sha256(clean);
  const row = await env.DB.prepare(
    `SELECT s.session_json, s.expires_at, s.last_seen_at, u.active
     FROM ks_sessions s JOIN ks_users u ON u.id = s.user_id
     WHERE s.token_hash = ? LIMIT 1`
  ).bind(tokenHash).first();
  const now = Math.floor(Date.now() / 1000);
  if (!row || !truthy(row.active) || Number(row.expires_at) <= now) {
    await env.DB.prepare('DELETE FROM ks_sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new ApiError('Sesi sudah habis. Silakan login kembali.', 'UNAUTHORIZED', 401);
  }
  // Jangan menulis ke D1 pada setiap request hanya untuk last_seen. Update
  // maksimal sekali tiap 5 menit per sesi agar read-heavy dashboard tidak
  // berubah menjadi write-heavy dan latency request tetap rendah.
  const lastSeenMs = new Date(String(row.last_seen_at || 0)).getTime() || 0;
  if (Date.now() - lastSeenMs >= 5 * 60 * 1000) {
    await env.DB.prepare('UPDATE ks_sessions SET last_seen_at = ? WHERE token_hash = ?')
      .bind(nowIso(), tokenHash).run();
  }
  return { ...JSON.parse(String(row.session_json || '{}')), token: clean };
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM ks_sessions WHERE token_hash = ?').bind(await sha256(String(token)),).run();
}

export async function rateLimitStatus(env, scope, identity, maxAttempts, windowSeconds) {
  const key = normalizeName(identity || 'unknown').slice(0, 120);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT count, window_start FROM ks_attempts WHERE scope = ? AND identity_key = ?'
  ).bind(scope, key).first();
  if (!row || Number(row.window_start) + windowSeconds <= now) return { key, count: 0, blocked: false };
  return { key, count: Number(row.count || 0), blocked: Number(row.count || 0) >= maxAttempts };
}

export async function recordFailedAttempt(env, scope, identity, windowSeconds) {
  const key = normalizeName(identity || 'unknown').slice(0, 120);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO ks_attempts(scope, identity_key, count, window_start)
     VALUES(?, ?, 1, ?)
     ON CONFLICT(scope, identity_key) DO UPDATE SET
       count = CASE WHEN ks_attempts.window_start + ? <= ? THEN 1 ELSE ks_attempts.count + 1 END,
       window_start = CASE WHEN ks_attempts.window_start + ? <= ? THEN ? ELSE ks_attempts.window_start END`
  ).bind(scope, key, now, windowSeconds, now, windowSeconds, now, now).run();
}

export async function clearAttempts(env, scope, identity) {
  const key = normalizeName(identity || 'unknown').slice(0, 120);
  await env.DB.prepare('DELETE FROM ks_attempts WHERE scope = ? AND identity_key = ?').bind(scope, key).run();
}
