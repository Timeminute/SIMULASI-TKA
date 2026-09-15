export const TABLES = new Set([
  'admins', 'tutors', 'siswa', 'jadwal', 'laporan', 'absensi',
  'invoice', 'note', 'gallery', 'pendaftar', 'gaji', 'tarif', 'bank_soal', 'pelatihan', 'theme'
]);

export class ApiError extends Error {
  constructor(message, code = 'REQUEST_FAILED', status = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      ...extraHeaders
    }
  });
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function nowIso() {
  return new Date().toISOString();
}

export function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function makeId(prefix = 'data') {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now()}-${random}`;
}

export function normalizeText(value) {
  return String(value ?? '').trim();
}

export function normalizeName(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeIdentity(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9@.+_-]/g, '');
}

export function normalizeUsername(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
}

export function usernameCandidates(name) {
  const parts = normalizeText(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .map(part => part.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  if (!parts.length) return ['siswa'];
  const values = [];
  const add = value => {
    const clean = normalizeUsername(value);
    if (clean && !values.includes(clean)) values.push(clean);
  };
  parts.forEach(add);
  if (parts.length > 1) {
    add(parts[0] + parts[1]);
    add(parts[0] + parts.at(-1));
    add(parts.join(''));
    add(parts.at(-1) + parts[0]);
    add(parts[0] + parts.slice(1).map(part => part[0]).join(''));
  }
  return values;
}

export function normalizeDate(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const id = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (id) return `${id[3]}-${id[2].padStart(2, '0')}-${id[1].padStart(2, '0')}`;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

export function normalizeTime(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const match = raw.match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return raw.slice(0, 5);
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true' || Number(value) === 1;
}

export function safeFileName(name) {
  return normalizeText(name || 'file')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'file';
}

export function isDataUrl(value) {
  return /^data:image\/(png|jpe?g|webp);base64,/i.test(String(value || ''));
}

export function stripStudentPin(student) {
  const safe = clone(student || {});
  delete safe.pin;
  return safe;
}

export function recordBelongsToStudentIdentity(record, student, students = [], nameField = 'nama') {
  const item = record || {};
  const target = student || {};
  const studentId = String(target.id || '').trim();
  const recordStudentId = String(item.siswaId || '').trim();

  if (studentId && recordStudentId === studentId) return true;

  const studentName = normalizeName(target.nama || '');
  const recordName = normalizeName(item[nameField] || '');
  if (!studentName || recordName !== studentName) return false;

  const roster = Array.isArray(students) ? students : [];
  const matchingStudents = roster.filter(row => normalizeName(row && row.nama || '') === studentName);
  const uniqueNameOwner = matchingStudents.length === 1 && String(matchingStudents[0].id || '').trim() === studentId;
  if (!uniqueNameOwner) return false;

  if (!recordStudentId) return true;
  const activeStudentIds = new Set(roster.map(row => String(row && row.id || '').trim()).filter(Boolean));
  return !activeStudentIds.has(recordStudentId);
}


function uniqueIdentityValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function studentNameIsUniqueOwner(name, student, students = []) {
  const normalized = normalizeName(name || '');
  const studentId = String(student?.id || '').trim();
  if (!normalized || !studentId) return false;
  const matches = (Array.isArray(students) ? students : [])
    .filter(row => normalizeName(row?.nama || '') === normalized);
  return matches.length === 1 && String(matches[0]?.id || '').trim() === studentId;
}

function identityPairBelongsToStudent(id, name, student, students = []) {
  const candidateId = String(id || '').trim();
  const studentId = String(student?.id || '').trim();
  if (studentId && candidateId === studentId) return true;
  if (!studentNameIsUniqueOwner(name, student, students)) return false;
  if (!candidateId) return true;
  const activeIds = new Set((Array.isArray(students) ? students : [])
    .map(row => String(row?.id || '').trim())
    .filter(Boolean));
  return !activeIds.has(candidateId);
}

export function invoiceBelongsToStudentIdentity(invoice, student, students = []) {
  const item = invoice || {};
  const studentId = String(student?.id || '').trim();
  const activeIds = new Set((Array.isArray(students) ? students : [])
    .map(row => String(row?.id || '').trim())
    .filter(Boolean));

  const directIds = uniqueIdentityValues([
    item.siswaId, item.studentId, item.muridId, item.student_id,
    item.legacyGroupMemberId
  ]);
  if (studentId && directIds.includes(studentId)) return true;

  const directNames = uniqueIdentityValues([
    item.namaSiswa, item.studentName, item.muridNama, item.nama,
    item.legacyGroupMemberName
  ]);
  const hasConflictingActiveDirectId = directIds.some(id => id !== studentId && activeIds.has(id));
  if (!hasConflictingActiveDirectId && directNames.some(name => studentNameIsUniqueOwner(name, student, students))) {
    return true;
  }

  const memberIdentitySources = [
    [item.groupMemberIds, item.groupMemberNames],
    [item.memberIds, item.memberNames],
    [item.studentIds, item.studentNames]
  ];
  for (const [rawIds, rawNames] of memberIdentitySources) {
    const ids = Array.isArray(rawIds) ? rawIds.map(value => String(value || '').trim()) : [];
    const names = Array.isArray(rawNames) ? rawNames.map(value => String(value || '').trim()) : [];
    if (studentId && ids.includes(studentId)) return true;
    const length = Math.max(ids.length, names.length);
    for (let index = 0; index < length; index += 1) {
      if (identityPairBelongsToStudent(ids[index] || '', names[index] || '', student, students)) return true;
    }
  }
  return false;
}

export function sanitizeInvoiceForParent(invoice) {
  const safe = clone(invoice || {});
  delete safe.catatanAdmin;
  delete safe.adminNote;
  return safe;
}
