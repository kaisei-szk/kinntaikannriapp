import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'kintai.sqlite3');

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kana TEXT NOT NULL DEFAULT '',
    display_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    type TEXT NOT NULL CHECK(type IN ('in','out')),
    timestamp TEXT NOT NULL,
    manual_flag INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_punches_staff_time ON punches(staff_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_punches_time ON punches(timestamp);

  CREATE TABLE IF NOT EXISTS punch_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    punch_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    edited_at TEXT NOT NULL
  );
`);

// Import the version-controlled staff roster (data/staff.seed.json).
// Idempotent: only names that do not already exist are inserted, so restarts
// and clones stay in sync without creating duplicates or resurrecting deleted staff.
const seedPath = path.join(dataDir, 'staff.seed.json');
if (fs.existsSync(seedPath)) {
  try {
    const roster = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (Array.isArray(roster) && roster.length) {
      const existing = new Set(db.prepare('SELECT name FROM staff').all().map((r) => r.name));
      const insert = db.prepare(
        `INSERT INTO staff (name, kana, display_order, active, created_at)
         VALUES (?, ?, ?, 1, ?)`
      );
      const now = nowLocalString();
      let added = 0;
      for (const s of roster) {
        const name = (s.name || '').trim();
        if (!name || existing.has(name)) continue;
        insert.run(name, (s.kana || '').trim(), Number(s.displayOrder) || 0, now);
        existing.add(name);
        added += 1;
      }
      if (added) console.log(`スタッフ名簿を ${added} 件取り込みました (staff.seed.json)`);
    }
  } catch (err) {
    console.warn('staff.seed.json の読み込みに失敗しました:', err.message);
  }
}

export function nowLocalString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
