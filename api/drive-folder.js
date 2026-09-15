import { ApiError } from './utils.js';

const GOOGLE_DRIVE_HOST = 'drive.google.com';
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const MAX_DRIVE_URL_LENGTH = 2048;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BOOK_MIME_TYPES = new Set([PDF_MIME, DOCX_MIME]);
const MAX_FOLDER_DEPTH = 6;
const MAX_FOLDER_VISITS = 120;
const MAX_BOOKS = 1000;

function cleanFileId(value) {
  const id = String(value || '').trim();
  return FILE_ID_PATTERN.test(id) ? id : '';
}

function cleanResourceKey(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 300);
}

export function normalizeGoogleDriveFolderLink(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Link folder Google Drive wajib diisi.');
  if (raw.length > MAX_DRIVE_URL_LENGTH) throw new Error('Link folder Google Drive terlalu panjang.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Link folder Google Drive tidak valid.');
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== GOOGLE_DRIVE_HOST) {
    throw new Error('Gunakan link HTTPS folder dari Google Drive.');
  }

  const path = url.pathname.replace(/\/+$/, '');
  const match = path.match(/^\/drive\/(?:u\/\d+\/)?folders\/([^/]+)$/i)
    || path.match(/^\/folders\/([^/]+)$/i);
  const folderId = cleanFileId(match?.[1]);
  if (!folderId) throw new Error('Link harus menuju satu folder Google Drive, bukan file.');

  const resourceKey = cleanResourceKey(url.searchParams.get('resourcekey'));
  const resourceQuery = resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : '';
  return {
    folderId,
    resourceKey,
    sourceUrl: `https://drive.google.com/drive/folders/${folderId}${resourceQuery}`
  };
}

export function isSupportedGoogleDriveFolderLink(value) {
  try {
    normalizeGoogleDriveFolderLink(value);
    return true;
  } catch {
    return false;
  }
}

function googleApiKey(env) {
  const key = String(env.GOOGLE_DRIVE_API_KEY || '').trim();
  if (!key) {
    throw new ApiError(
      'Google Drive API Key belum dipasang di Cloudflare. Pasang secret GOOGLE_DRIVE_API_KEY terlebih dahulu.',
      'DRIVE_API_NOT_CONFIGURED',
      503
    );
  }
  return key;
}

function apiErrorMessage(payload, fallback) {
  const message = String(payload?.error?.message || payload?.message || '').trim();
  return message || fallback;
}

async function driveJson(url, resourceKeys = []) {
  const headers = { Accept: 'application/json' };
  const keyHeader = (Array.isArray(resourceKeys) ? resourceKeys : [])
    .map(item => {
      const id = cleanFileId(item?.id);
      const key = cleanResourceKey(item?.resourceKey);
      return id && key ? `${id}/${key}` : '';
    })
    .filter(Boolean)
    .join(',');
  if (keyHeader) headers['X-Goog-Drive-Resource-Keys'] = keyHeader;

  let response;
  try {
    response = await fetch(url, {
      headers,
      cf: { cacheTtl: 60, cacheEverything: true }
    });
  } catch (error) {
    throw new ApiError(`Tidak dapat menghubungi Google Drive API: ${error?.message || 'koneksi gagal'}`, 'DRIVE_API_UNREACHABLE', 502);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 403 ? 403 : 502;
    const code = response.status === 404 ? 'DRIVE_FOLDER_NOT_FOUND' : response.status === 403 ? 'DRIVE_FOLDER_FORBIDDEN' : 'DRIVE_API_FAILED';
    throw new ApiError(apiErrorMessage(payload, `Google Drive API gagal (${response.status}).`), code, status);
  }
  return payload;
}

function resourceQuery(resourceKey) {
  const key = cleanResourceKey(resourceKey);
  return key ? `?resourcekey=${encodeURIComponent(key)}` : '';
}

function bookType(mimeType) {
  return mimeType === PDF_MIME ? 'PDF' : mimeType === DOCX_MIME ? 'DOCX' : '';
}

function previewUrl(file) {
  return `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview${resourceQuery(file.resourceKey)}`;
}

function sourceUrl(file) {
  return `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view${resourceQuery(file.resourceKey)}`;
}

async function getFolderMetadata(apiKey, folderId, resourceKey = '') {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,resourceKey',
    supportsAllDrives: 'true',
    key: apiKey
  });
  const payload = await driveJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${params}`,
    [{ id: folderId, resourceKey }]
  );
  if (payload.mimeType !== FOLDER_MIME) {
    throw new ApiError('Link yang dipilih bukan folder Google Drive.', 'INVALID_DRIVE_FOLDER', 400);
  }
  return payload;
}

async function listFolderChildren(apiKey, folderId, folderResourceKey = '') {
  const files = [];
  let pageToken = '';
  do {
    const q = `'${String(folderId).replace(/'/g, "\\'")}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or mimeType = '${PDF_MIME}' or mimeType = '${DOCX_MIME}')`;
    const params = new URLSearchParams({
      q,
      pageSize: '1000',
      orderBy: 'name_natural',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,resourceKey)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey
    });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await driveJson(`https://www.googleapis.com/drive/v3/files?${params}`, [{ id: folderId, resourceKey: folderResourceKey }]);
    files.push(...(Array.isArray(payload.files) ? payload.files : []));
    pageToken = String(payload.nextPageToken || '');
  } while (pageToken && files.length < MAX_BOOKS + MAX_FOLDER_VISITS);
  return files;
}

export async function listPelatihanFolder(env, folderUrl) {
  const normalized = normalizeGoogleDriveFolderLink(folderUrl);
  const apiKey = googleApiKey(env);
  const root = await getFolderMetadata(apiKey, normalized.folderId, normalized.resourceKey);
  const rootName = String(root.name || 'Pelatihan').trim() || 'Pelatihan';

  const queue = [{
    id: normalized.folderId,
    name: rootName,
    path: rootName,
    depth: 0,
    resourceKey: normalized.resourceKey || String(root.resourceKey || '')
  }];
  const visited = new Set();
  const books = [];
  const folders = [];

  while (queue.length && visited.size < MAX_FOLDER_VISITS && books.length < MAX_BOOKS) {
    const folder = queue.shift();
    if (!folder || visited.has(folder.id)) continue;
    visited.add(folder.id);
    folders.push({ id: folder.id, name: folder.name, path: folder.path, depth: folder.depth });

    const children = await listFolderChildren(apiKey, folder.id, folder.resourceKey || '');
    for (const child of children) {
      const id = cleanFileId(child?.id);
      if (!id) continue;
      const mimeType = String(child.mimeType || '');
      const name = String(child.name || '').trim() || 'Tanpa nama';

      if (mimeType === FOLDER_MIME) {
        if (folder.depth < MAX_FOLDER_DEPTH) {
          queue.push({
            id,
            name,
            path: `${folder.path} / ${name}`,
            depth: folder.depth + 1,
            resourceKey: cleanResourceKey(child.resourceKey)
          });
        }
        continue;
      }

      if (!BOOK_MIME_TYPES.has(mimeType)) continue;
      books.push({
        id,
        name,
        mimeType,
        type: bookType(mimeType),
        modifiedTime: String(child.modifiedTime || ''),
        size: Number(child.size || 0),
        resourceKey: cleanResourceKey(child.resourceKey),
        folderId: folder.id,
        folderName: folder.name,
        folderPath: folder.path,
        previewUrl: previewUrl({ id, resourceKey: child.resourceKey }),
        sourceUrl: sourceUrl({ id, resourceKey: child.resourceKey })
      });
      if (books.length >= MAX_BOOKS) break;
    }
  }

  books.sort((a, b) => a.folderPath.localeCompare(b.folderPath, 'id', { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name, 'id', { numeric: true, sensitivity: 'base' }));

  return {
    folder: {
      id: normalized.folderId,
      name: rootName,
      sourceUrl: normalized.sourceUrl,
      resourceKey: normalized.resourceKey
    },
    folders,
    books,
    truncated: Boolean(queue.length || books.length >= MAX_BOOKS || visited.size >= MAX_FOLDER_VISITS),
    limits: { maxDepth: MAX_FOLDER_DEPTH, maxFolders: MAX_FOLDER_VISITS, maxBooks: MAX_BOOKS }
  };
}
