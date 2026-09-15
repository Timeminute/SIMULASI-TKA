import { ApiError, isDataUrl, safeFileName } from './utils.js';

function decodeBase64(base64) {
  const binary = atob(base64.replace(/\s+/g, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function driveConfig(env) {
  const url = String(env.DRIVE_UPLOAD_URL || '').trim();
  const secret = String(env.DRIVE_UPLOAD_SECRET || '').trim();
  if (!url || url.includes('PASTE_APPS_SCRIPT_WEB_APP_URL')) {
    throw new ApiError('URL Apps Script Google Drive belum diisi di Cloudflare.', 'DRIVE_NOT_CONFIGURED', 503);
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(url)) {
    throw new ApiError('URL Apps Script salah. Gunakan URL deployment yang berakhiran /exec, bukan /dev atau link editor.', 'DRIVE_URL_INVALID', 503);
  }
  if (!secret) {
    throw new ApiError('Kunci upload Google Drive belum diisi.', 'DRIVE_NOT_CONFIGURED', 503);
  }
  return { url, secret };
}

export async function callDriveUploader(env, payload) {
  const { url, secret } = driveConfig(env);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, secret }),
      redirect: 'follow'
    });
  } catch (error) {
    throw new ApiError(`Tidak dapat menghubungi Apps Script Google Drive: ${error?.message || 'koneksi gagal'}`, 'DRIVE_UNREACHABLE', 502);
  }

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const looksLikeHtml = /^\s*</.test(text || '');
    throw new ApiError(
      looksLikeHtml
        ? 'Apps Script mengirim halaman HTML. Pastikan URL berakhiran /exec dan akses Web App diatur ke Anyone.'
        : 'Respons Apps Script Google Drive tidak valid.',
      'DRIVE_INVALID_RESPONSE',
      502
    );
  }

  if (!response.ok || !result?.ok) {
    throw new ApiError(result?.message || `Upload Google Drive gagal (${response.status}).`, result?.code || 'DRIVE_UPLOAD_FAILED', 502);
  }
  return result;
}

export async function uploadDataUrl(env, request, dataUrl, suggestedName = 'gambar') {
  const match = String(dataUrl || '').match(/^data:(image\/(png|jpe?g|webp));base64,(.+)$/is);
  if (!match) throw new ApiError('Format gambar tidak didukung.', 'INVALID_IMAGE');
  const mime = match[1].toLowerCase();
  const bytes = decodeBase64(match[3]);
  const maxBytes = Math.max(1024 * 1024, Number(env.MAX_IMAGE_BYTES || 5 * 1024 * 1024));
  if (!bytes.length) throw new ApiError('Isi gambar tidak valid.', 'INVALID_IMAGE');
  if (bytes.length > maxBytes) throw new ApiError('Ukuran gambar terlalu besar. Maksimal 5 MB.', 'IMAGE_TOO_LARGE');
  const extension = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const filename = `${safeFileName(suggestedName)}.${extension}`;
  const result = await callDriveUploader(env, {
    action: 'uploadDataUrl',
    dataUrl,
    filename
  });

  if (!result.fileId || !(result.directUrl || result.thumbnailUrl || result.viewUrl)) {
    throw new ApiError('Apps Script merespons berhasil, tetapi ID atau URL file tidak dikembalikan.', 'DRIVE_INCOMPLETE_RESPONSE', 502);
  }

  return {
    fileId: String(result.fileId || ''),
    directUrl: String(result.directUrl || result.thumbnailUrl || ''),
    viewUrl: String(result.viewUrl || result.directUrl || ''),
    thumbnailUrl: String(result.thumbnailUrl || result.directUrl || ''),
    mimeType: String(result.mimeType || mime),
    size: Number(result.size || bytes.length)
  };
}

export async function processRecordUploads(env, request, table, record) {
  const item = JSON.parse(JSON.stringify(record || {}));
  if (table === 'tutors' && isDataUrl(item.foto)) {
    const uploaded = await uploadDataUrl(env, request, item.foto, `foto-tutor-${item.nama || item.id}`);
    item.foto = uploaded.directUrl;
    item.fotoViewUrl = uploaded.viewUrl;
    item.fotoFileId = uploaded.fileId;
    item.fotoThumbnailUrl = uploaded.thumbnailUrl;
    item.fotoUpdatedAt = new Date().toISOString();
  }
  if (table === 'gallery' && isDataUrl(item.src)) {
    const uploaded = await uploadDataUrl(env, request, item.src, `galeri-${item.caption || item.id}`);
    item.src = uploaded.directUrl;
    item.viewUrl = uploaded.viewUrl;
    item.thumbnailUrl = uploaded.thumbnailUrl;
    item.fileId = uploaded.fileId;
  }
  if (table === 'laporan' && Array.isArray(item.images)) {
    for (let index = 0; index < item.images.length; index += 1) {
      const image = item.images[index] || {};
      const source = image.data || image.src || '';
      if (!isDataUrl(source)) continue;
      const uploaded = await uploadDataUrl(env, request, source, `laporan-${item.nama || item.id}-${index + 1}`);
      item.images[index] = {
        ...image,
        url: uploaded.directUrl,
        src: uploaded.directUrl,
        viewUrl: uploaded.viewUrl,
        thumbnailUrl: uploaded.thumbnailUrl,
        fileId: uploaded.fileId
      };
      delete item.images[index].data;
    }
  }
  return item;
}

export async function fileAsDataUrl(env, key) {
  const fileId = String(key || '').trim();
  if (!fileId || fileId.startsWith('r2-')) return '';
  const result = await callDriveUploader(env, {
    action: 'readFileBase64',
    fileId
  });
  return String(result.dataUrl || '');
}
