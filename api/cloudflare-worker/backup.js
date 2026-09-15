import { TABLES, nowIso, truthy } from './utils.js';
import { getMeta, setMeta } from './db.js';
import { listRecords } from './repository.js';
import { callDriveUploader } from './files.js';

const META = Object.freeze({
  enabled: 'drive_backup_enabled',
  lastAt: 'drive_backup_last_at',
  lastStatus: 'drive_backup_last_status',
  lastFileId: 'drive_backup_last_file_id',
  lastFileUrl: 'drive_backup_last_file_url',
  lastFileName: 'drive_backup_last_file_name',
  lastError: 'drive_backup_last_error',
  lastReason: 'drive_backup_last_reason',
  lastTotal: 'drive_backup_last_total',
  lastSuccessDateWib: 'drive_backup_last_success_date_wib',
  updatedAt: 'drive_backup_setting_updated_at',
  updatedBy: 'drive_backup_setting_updated_by'
});

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function wibDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  const iso = shifted.toISOString();
  return {
    date: iso.slice(0, 10),
    compactDate: iso.slice(0, 10).replace(/-/g, ''),
    compactTime: iso.slice(11, 19).replace(/:/g, ''),
    display: `${iso.slice(0, 10)} ${iso.slice(11, 19)} WIB`
  };
}

async function setManyMeta(env, values) {
  const timestamp = nowIso();
  await Promise.all(Object.entries(values).map(([key, value]) =>
    setMeta(env, key, value == null ? '' : String(value), timestamp)
  ));
}

export async function getDriveBackupSettings(env) {
  const keys = Object.values(META);
  const values = await Promise.all(keys.map(key => getMeta(env, key)));
  const data = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  return {
    enabled: truthy(data[META.enabled]),
    schedule: 'Saat tombol Sinkron pertama ditekan setiap hari',
    cronUtc: '',
    lastAt: data[META.lastAt] || '',
    lastStatus: data[META.lastStatus] || 'never',
    lastFileId: data[META.lastFileId] || '',
    lastFileUrl: data[META.lastFileUrl] || '',
    lastFileName: data[META.lastFileName] || '',
    lastError: data[META.lastError] || '',
    lastReason: data[META.lastReason] || '',
    lastTotal: Number(data[META.lastTotal] || 0),
    updatedAt: data[META.updatedAt] || '',
    updatedBy: data[META.updatedBy] || ''
  };
}

export async function setDriveBackupEnabled(env, enabled, actor = 'Owner') {
  const timestamp = nowIso();
  await setManyMeta(env, {
    [META.enabled]: enabled ? '1' : '0',
    [META.updatedAt]: timestamp,
    [META.updatedBy]: actor
  });
  return getDriveBackupSettings(env);
}

export async function buildDriveBackupPayload(env, reason = 'manual') {
  const data = {};
  const counts = {};
  let totalRecords = 0;

  for (const table of TABLES) {
    const records = await listRecords(env, table, { includePassword: true });
    data[table] = records;
    counts[table] = records.length;
    totalRecords += records.length;
  }

  return {
    format: 'kelas-senja-d1-backup',
    version: 1,
    source: 'Kelas Senja Cloudflare D1',
    exportedAt: nowIso(),
    timezone: 'Asia/Jakarta',
    reason,
    counts,
    totalRecords,
    data
  };
}

export async function runDriveBackup(env, options = {}) {
  const reason = String(options.reason || 'manual');
  const actor = String(options.actor || 'system');
  const force = options.force === true;
  const scheduledAt = options.scheduledTime ? new Date(options.scheduledTime) : new Date();
  const currentWib = wibDateParts(scheduledAt);
  const settings = await getDriveBackupSettings(env);

  const dailyAutomatic = reason === 'scheduled' || reason === 'sync-daily';
  if (dailyAutomatic && !settings.enabled) {
    return { ok: true, skipped: true, reason: 'disabled', backup: settings };
  }

  const lastSuccessDate = await getMeta(env, META.lastSuccessDateWib);
  if (dailyAutomatic && !force && lastSuccessDate === currentWib.date) {
    return { ok: true, skipped: true, reason: 'already-backed-up-today', backup: settings };
  }

  const startedAt = nowIso();
  await setManyMeta(env, {
    [META.lastStatus]: 'running',
    [META.lastAt]: startedAt,
    [META.lastReason]: reason,
    [META.lastError]: ''
  });

  try {
    const payload = await buildDriveBackupPayload(env, reason);
    const filename = `kelas-senja-backup-${currentWib.compactDate}-${currentWib.compactTime}-WIB.json`;
    const content = JSON.stringify(payload, null, 2);
    const result = await callDriveUploader(env, {
      action: 'uploadJsonBackup',
      filename,
      content,
      metadata: {
        exportedAt: payload.exportedAt,
        reason,
        actor,
        totalRecords: payload.totalRecords
      }
    });

    const completedAt = nowIso();
    await setManyMeta(env, {
      [META.lastAt]: completedAt,
      [META.lastStatus]: 'success',
      [META.lastFileId]: result.fileId || '',
      [META.lastFileUrl]: result.viewUrl || '',
      [META.lastFileName]: result.fileName || filename,
      [META.lastError]: '',
      [META.lastReason]: reason,
      [META.lastTotal]: payload.totalRecords,
      [META.lastSuccessDateWib]: currentWib.date
    });

    return {
      ok: true,
      skipped: false,
      file: {
        fileId: String(result.fileId || ''),
        fileName: String(result.fileName || filename),
        viewUrl: String(result.viewUrl || ''),
        size: Number(result.size || content.length)
      },
      totalRecords: payload.totalRecords,
      backup: await getDriveBackupSettings(env)
    };
  } catch (error) {
    await setManyMeta(env, {
      [META.lastAt]: nowIso(),
      [META.lastStatus]: 'failed',
      [META.lastError]: error?.message || 'Backup ke Google Drive gagal.',
      [META.lastReason]: reason
    });
    throw error;
  }
}


export async function runDriveBackupIfDueOnSync(env, options = {}) {
  return runDriveBackup(env, {
    reason: 'sync-daily',
    actor: options.actor || 'Admin',
    force: false,
    scheduledTime: Date.now()
  });
}

export async function handleScheduledDriveBackup(env, controller) {
  const settings = await getDriveBackupSettings(env);
  return {
    ok: true,
    skipped: true,
    reason: 'cron-disabled-use-sync-button',
    backup: settings,
    scheduledTime: controller?.scheduledTime || Date.now()
  };
}
