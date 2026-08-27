import { Router } from 'express';
import { db, nowLocalString } from '../db.mjs';

export const staffRouter = Router();

function todayPrefix() {
  const [datePart] = nowLocalString().split(' ');
  return datePart; // YYYY-MM-DD
}

// GET /api/staff - active staff list with today's punch status, for the kiosk screen.
staffRouter.get('/staff', (req, res) => {
  const staff = db
    .prepare(
      `SELECT id, name, kana, display_order FROM staff
       WHERE active = 1
       ORDER BY kana ASC, display_order ASC, id ASC`
    )
    .all();

  const prefix = todayPrefix();
  const lastPunchStmt = db.prepare(
    `SELECT type FROM punches
     WHERE staff_id = ? AND timestamp >= ? AND timestamp < ?
     ORDER BY timestamp DESC, id DESC LIMIT 1`
  );
  const todayStart = `${prefix} 00:00:00`;
  const todayEnd = `${prefix} 23:59:59`;

  const result = staff.map((s) => {
    const last = lastPunchStmt.get(s.id, todayStart, todayEnd);
    const lastType = last ? last.type : null;
    const nextType = lastType === 'in' ? 'out' : 'in';
    return {
      id: s.id,
      name: s.name,
      kana: s.kana,
      lastType,
      nextType,
    };
  });

  res.json(result);
});

const recentPunches = new Map(); // `${staffId}:${type}` -> timestamp(ms), for duplicate-tap protection

// POST /api/punch { staffId, type } - record a punch from the kiosk screen.
staffRouter.post('/punch', (req, res) => {
  const staffId = Number(req.body?.staffId);
  const type = req.body?.type;

  if (!Number.isInteger(staffId) || (type !== 'in' && type !== 'out')) {
    return res.status(400).json({ error: '不正なリクエストです' });
  }

  const staff = db
    .prepare('SELECT id, name FROM staff WHERE id = ? AND active = 1')
    .get(staffId);
  if (!staff) {
    return res.status(404).json({ error: 'スタッフが見つかりません' });
  }

  const dedupeKey = `${staffId}:${type}`;
  const last = recentPunches.get(dedupeKey);
  const now = Date.now();
  if (last && now - last < 10_000) {
    return res.status(429).json({ error: '直前に同じ打刻が行われています' });
  }
  recentPunches.set(dedupeKey, now);

  const timestamp = nowLocalString();
  const info = db
    .prepare(
      `INSERT INTO punches (staff_id, type, timestamp, manual_flag, created_at)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(staffId, type, timestamp, timestamp);

  res.json({
    id: Number(info.lastInsertRowid),
    staffId: staff.id,
    name: staff.name,
    type,
    timestamp,
  });
});
