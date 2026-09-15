let initialized = false;
let initializationPromise = null;
const SCHEMA_VERSION_KEY = 'schema_version';
const SCHEMA_VERSION = '2026-08-31-incremental-sync-v3';

async function getSchemaVersion(env) {
  const metaTable = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ks_meta' LIMIT 1"
  ).first();
  if (!metaTable) return '';
  const row = await env.DB.prepare('SELECT value FROM ks_meta WHERE key = ? LIMIT 1')
    .bind(SCHEMA_VERSION_KEY).first();
  return String(row?.value || '');
}

function isoNow() {
  return new Date().toISOString();
}

export async function ensureSchema(env) {
  if (initialized) return;
  if (initializationPromise) return initializationPromise;
  if (!env.DB) throw new Error('Binding D1 DB belum dipasang.');

  initializationPromise = (async () => {
    // Pada cold start Worker, cukup satu-dua query ringan untuk memastikan
    // skema sudah versi terbaru. Upgrade dari performance-v1 hanya membutuhkan
    // dua index baru, sehingga request pertama setelah deploy tetap aman pada
    // batas query D1 Free.
    const schemaVersion = await getSchemaVersion(env);
    if (schemaVersion === SCHEMA_VERSION) {
      initialized = true;
      return;
    }
    if (schemaVersion === '2026-08-29-performance-v1' || schemaVersion === '2026-08-29-performance-v2') {
      const upgradeStatements = [];
      if (schemaVersion === '2026-08-29-performance-v1') {
        upgradeStatements.push(
          env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ks_records_table_tutor_updated ON ks_records(table_name, tutor_id, updated_at)'),
          env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ks_records_table_student_updated ON ks_records(table_name, student_id, updated_at)')
        );
      }
      upgradeStatements.push(
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS ks_deleted_records (
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          tutor_id TEXT NOT NULL DEFAULT '',
          student_id TEXT NOT NULL DEFAULT '',
          deleted_at TEXT NOT NULL,
          PRIMARY KEY (table_name, record_id)
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ks_deleted_table_time ON ks_deleted_records(table_name, deleted_at, record_id)'),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ks_deleted_table_tutor_time ON ks_deleted_records(table_name, tutor_id, deleted_at, record_id)'),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_ks_records_deleted
          AFTER DELETE ON ks_records BEGIN
            INSERT OR REPLACE INTO ks_deleted_records(table_name, record_id, tutor_id, student_id, deleted_at)
            VALUES(OLD.table_name, OLD.record_id, OLD.tutor_id, OLD.student_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
          END`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_ks_records_restored_insert
          AFTER INSERT ON ks_records BEGIN
            DELETE FROM ks_deleted_records WHERE table_name = NEW.table_name AND record_id = NEW.record_id;
          END`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_ks_records_restored_update
          AFTER UPDATE ON ks_records BEGIN
            DELETE FROM ks_deleted_records WHERE table_name = NEW.table_name AND record_id = NEW.record_id;
          END`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_laporan_deleted
          AFTER DELETE ON laporan_harian BEGIN
            INSERT OR REPLACE INTO ks_deleted_records(table_name, record_id, tutor_id, student_id, deleted_at)
            VALUES('laporan', OLD.id, OLD.tutor_id, OLD.siswa_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
          END`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_laporan_restored_insert
          AFTER INSERT ON laporan_harian BEGIN
            DELETE FROM ks_deleted_records WHERE table_name = 'laporan' AND record_id = NEW.id;
          END`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_laporan_restored_update
          AFTER UPDATE ON laporan_harian BEGIN
            DELETE FROM ks_deleted_records WHERE table_name = 'laporan' AND record_id = NEW.id;
          END`)
      );
      await env.DB.batch(upgradeStatements);
      await env.DB.prepare(
        `INSERT INTO ks_meta(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(SCHEMA_VERSION_KEY, SCHEMA_VERSION, isoNow()).run();
      initialized = true;
      return;
    }

    const statements = [
    `CREATE TABLE IF NOT EXISTS ks_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ks_records (
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      tutor_id TEXT NOT NULL DEFAULT '',
      student_id TEXT NOT NULL DEFAULT '',
      schedule_id TEXT NOT NULL DEFAULT '',
      attendance_id TEXT NOT NULL DEFAULT '',
      username_norm TEXT NOT NULL DEFAULT '',
      period_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (table_name, record_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ks_records_table ON ks_records(table_name, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ks_records_tutor ON ks_records(table_name, tutor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ks_records_student ON ks_records(table_name, student_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ks_records_table_tutor_updated ON ks_records(table_name, tutor_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ks_records_table_student_updated ON ks_records(table_name, student_id, updated_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_ks_student_username
      ON ks_records(username_norm) WHERE table_name = 'siswa' AND username_norm <> ''`,
    `DROP INDEX IF EXISTS ux_ks_attendance_schedule`,
    `DROP INDEX IF EXISTS ux_ks_attendance_schedule_student`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_ks_attendance_occurrence
      ON ks_records(period_key)
      WHERE table_name = 'absensi' AND period_key <> ''`,
    // Laporan baru tidak lagi disimpan di ks_records. Index lama tetap dihapus
    // setelah migrasi supaya tidak menghalangi data kompatibilitas lama.
    `DROP INDEX IF EXISTS ux_ks_report_schedule`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_ks_invoice_period
      ON ks_records(period_key) WHERE table_name = 'invoice' AND period_key <> ''`,
    `CREATE TABLE IF NOT EXISTS laporan_harian (
      id TEXT PRIMARY KEY,
      tanggal TEXT NOT NULL DEFAULT '',
      kelompok_id TEXT NOT NULL DEFAULT '',
      tutor_id TEXT NOT NULL DEFAULT '',
      materi TEXT NOT NULL DEFAULT '',
      aktivitas TEXT NOT NULL DEFAULT '',
      jadwal_id TEXT NOT NULL DEFAULT '',
      absensi_id TEXT NOT NULL DEFAULT '',
      tutor_nama TEXT NOT NULL DEFAULT '',
      siswa_id TEXT NOT NULL DEFAULT '',
      nama TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      group_type TEXT NOT NULL DEFAULT '',
      mulai TEXT NOT NULL DEFAULT '',
      selesai TEXT NOT NULL DEFAULT '',
      kelas TEXT NOT NULL DEFAULT '',
      mapel TEXT NOT NULL DEFAULT '',
      kehadiran TEXT NOT NULL DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      absensi_ids_json TEXT NOT NULL DEFAULT '[]',
      group_member_ids_json TEXT NOT NULL DEFAULT '[]',
      group_member_names_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_laporan_harian_jadwal
      ON laporan_harian(jadwal_id) WHERE jadwal_id <> ''`,
    `CREATE INDEX IF NOT EXISTS idx_laporan_harian_tutor
      ON laporan_harian(tutor_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_laporan_harian_tanggal
      ON laporan_harian(tanggal, updated_at)`,
    `CREATE TABLE IF NOT EXISTS laporan_harian_detail (
      id TEXT PRIMARY KEY,
      laporan_id TEXT NOT NULL,
      murid_id TEXT NOT NULL DEFAULT '',
      murid_nama TEXT NOT NULL DEFAULT '',
      nilai INTEGER,
      rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
      pr TEXT NOT NULL DEFAULT '',
      catatan TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(laporan_id) REFERENCES laporan_harian(id) ON DELETE CASCADE,
      UNIQUE(laporan_id, murid_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_laporan_detail_laporan
      ON laporan_harian_detail(laporan_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_laporan_detail_murid
      ON laporan_harian_detail(murid_id, updated_at)`,
    `CREATE TABLE IF NOT EXISTS laporan_harian_mark (
      laporan_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(laporan_id) REFERENCES laporan_harian(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_laporan_mark_updated
      ON laporan_harian_mark(updated_at)`,
    `CREATE TABLE IF NOT EXISTS ks_deleted_records (
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      tutor_id TEXT NOT NULL DEFAULT '',
      student_id TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (table_name, record_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ks_deleted_table_time
      ON ks_deleted_records(table_name, deleted_at, record_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ks_deleted_table_tutor_time
      ON ks_deleted_records(table_name, tutor_id, deleted_at, record_id)`,
    `CREATE TRIGGER IF NOT EXISTS trg_ks_records_deleted
      AFTER DELETE ON ks_records BEGIN
        INSERT OR REPLACE INTO ks_deleted_records(table_name, record_id, tutor_id, student_id, deleted_at)
        VALUES(OLD.table_name, OLD.record_id, OLD.tutor_id, OLD.student_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END`,
    `CREATE TRIGGER IF NOT EXISTS trg_ks_records_restored_insert
      AFTER INSERT ON ks_records BEGIN
        DELETE FROM ks_deleted_records WHERE table_name = NEW.table_name AND record_id = NEW.record_id;
      END`,
    `CREATE TRIGGER IF NOT EXISTS trg_ks_records_restored_update
      AFTER UPDATE ON ks_records BEGIN
        DELETE FROM ks_deleted_records WHERE table_name = NEW.table_name AND record_id = NEW.record_id;
      END`,
    `CREATE TRIGGER IF NOT EXISTS trg_laporan_deleted
      AFTER DELETE ON laporan_harian BEGIN
        INSERT OR REPLACE INTO ks_deleted_records(table_name, record_id, tutor_id, student_id, deleted_at)
        VALUES('laporan', OLD.id, OLD.tutor_id, OLD.siswa_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END`,
    `CREATE TRIGGER IF NOT EXISTS trg_laporan_restored_insert
      AFTER INSERT ON laporan_harian BEGIN
        DELETE FROM ks_deleted_records WHERE table_name = 'laporan' AND record_id = NEW.id;
      END`,
    `CREATE TRIGGER IF NOT EXISTS trg_laporan_restored_update
      AFTER UPDATE ON laporan_harian BEGIN
        DELETE FROM ks_deleted_records WHERE table_name = 'laporan' AND record_id = NEW.id;
      END`,
    `CREATE TABLE IF NOT EXISTS ks_users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('admin','tutor')),
      tutor_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      username_norm TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      wa TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      is_main_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ks_users_role ON ks_users(role, active)`,
    `CREATE TABLE IF NOT EXISTS ks_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ks_sessions_expiry ON ks_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS ks_parent_sessions (
      token_hash TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ks_parent_sessions_expiry ON ks_parent_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS ks_attempts (
      scope TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      PRIMARY KEY(scope, identity_key)
    )`
    ];
    await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));
    // Migrasi isi data tidak boleh menjadi bagian dari cold start/schema init.
    // Database lama tetap dapat dibaca lewat fallback repository dan migrasi
    // data dilakukan bertahap melalui endpoint khusus/importer.
    await env.DB.prepare(
      `INSERT INTO ks_meta(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(SCHEMA_VERSION_KEY, SCHEMA_VERSION, isoNow()).run();
    initialized = true;
  })();

  try {
    await initializationPromise;
  } finally {
    if (!initialized) initializationPromise = null;
  }
}

export async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM ks_meta WHERE key = ?').bind(key).first();
  return row ? String(row.value) : '';
}

export async function setMeta(env, key, value, updatedAt) {
  await env.DB.prepare(
    `INSERT INTO ks_meta(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value), updatedAt).run();
}
