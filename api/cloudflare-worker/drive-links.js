const GOOGLE_DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const MAX_DRIVE_URL_LENGTH = 2048;

function cleanFileId(value) {
  const id = String(value || '').trim();
  return FILE_ID_PATTERN.test(id) ? id : '';
}

function resourceKeyQuery(url) {
  const resourceKey = String(url.searchParams.get('resourcekey') || '').trim();
  if (!resourceKey) return '';
  return `?resourcekey=${encodeURIComponent(resourceKey)}`;
}

/**
 * Convert a supported Google Drive/Docs share URL into a stable read-only
 * preview URL. Only HTTPS links on Google Drive hosts are accepted.
 */
export function normalizeGoogleDriveLink(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Link Google Drive wajib diisi.');
  if (raw.length > MAX_DRIVE_URL_LENGTH) throw new Error('Link Google Drive terlalu panjang.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Link Google Drive tidak valid.');
  }

  if (url.protocol !== 'https:' || !GOOGLE_DRIVE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Gunakan link HTTPS dari Google Drive atau Google Docs.');
  }

  const host = url.hostname.toLowerCase();
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

export function isSupportedGoogleDriveLink(value) {
  try {
    normalizeGoogleDriveLink(value);
    return true;
  } catch {
    return false;
  }
}
