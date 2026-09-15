CREATE TABLE admins(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE,
 password_hash TEXT
);

CREATE TABLE bank_soal(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 jenjang TEXT,
 mapel TEXT,
 soal TEXT,
 opsi_a TEXT,
 opsi_b TEXT,
 opsi_c TEXT,
 opsi_d TEXT,
 opsi_e TEXT,
 jawaban TEXT,
 pembahasan TEXT
);

CREATE TABLE hasil(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 peserta_id INTEGER,
 nilai INTEGER
);
