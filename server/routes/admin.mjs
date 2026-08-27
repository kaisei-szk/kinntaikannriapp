import { Router } from 'express';
import { db, nowLocalString } from '../db.mjs';
import { verifyPassword, isLocked, recordFailure, clearFailures, requireAdmin } from '../auth.mjs';
import { toCsv } from '../csv.mjs';

export const adminRouter = Router();

// ---- auth ----

adminRouter.post('/login', async (req, res) => {
  const ip = req.ip;
  if (isLocked(ip)) {
    return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってから再度お試しください' });
  }

  const password = req.body?.password;
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'パスワードを入力してください' });
  }

  const ok = await verifyPassword(password);
  if (!ok) {
    recordFailure(ip);
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  clearFailures(ip);
  req.session.isAdmin = true;
  res.json({ ok: true });
});

adminRouter.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

adminRouter.get('/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

// Everything below requires an authenticated admin session.
adminRouter.use(requireAdmin);

// ---- staff management ----

adminRouter.get('/staff', (req, res) => {
  const staff = db
    .prepare(
      `SELECT id, name, kana, display_order, active FROM staff
       ORDER BY active DESC, kana ASC, display_order ASC, id ASC`
    )
    .all();
  res.json(staff);
});

adminRouter.post('/staff', (req, res) => {
  const name = (req.body?.name || '').trim();
  const kana = (req.body?.kana || '').trim();
  const displayOrder = Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : 0;

  if (!name) {
    return res.status(400).json({ error: '名前を入力してください' });
  }

  const now = nowLocalString();
  const info = db
    .prepare(
      `INSERT INTO staff (name, kana, display_order, active, created_at)
       VALUES (?, ?, ?, 1, ?)`
    )
    .run(name, kana, displayOrder, now);

  res.status(201).json({ id: Number(info.lastInsertRowid), name, kana, displayOrder, active: 1 });
});

adminRouter.put('/staff/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'スタッフが見つかりません' });
  }

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  const kana = req.body?.kana !== undefined ? String(req.body.kana).trim() : existing.kana;
  const displayOrder = Number.isInteger(req.body?.displayOrder)
    ? req.body.displayOrder
    : existing.display_order;
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;

  if (!name) {
    return res.status(400).json({ error: '名前を入力してください' });
  }

  db.prepare(
    `UPDATE staff SET name = ?, kana = ?, display_order = ?, active = ? WHERE id = ?`
  ).run(name, kana, displayOrder, active, id);

  res.json({ id, name, kana, displayOrder, active });
});

// Logical delete only - punch history must be preserved.
adminRouter.delete('/staff/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'スタッフが見つかりません' });
  }
  db.prepare('UPDATE staff SET active = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- attendance records ----

adminRouter.get('/records', (req, res) => {
  const { from, to, staffId } = req.query;
  const clauses = [];
  const params = [];

  if (from) {
    clauses.push('p.timestamp >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    clauses.push('p.timestamp <= ?');
    params.push(`${to} 23:59:59`);
  }
  if (staffId) {
    clauses.push('p.staff_id = ?');
    params.push(Number(staffId));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT p.id, p.staff_id AS staffId, s.name AS staffName, p.type, p.timestamp,
              p.manual_flag AS manualFlag, p.note
       FROM punches p
       JOIN staff s ON s.id = p.staff_id
       ${where}
       ORDER BY p.timestamp DESC, p.id DESC
       LIMIT 5000`
    )
    .all(...params);

  res.json(rows);
});

function logEdit(punchId, action, before, after) {
  db.prepare(
    `INSERT INTO punch_edits (punch_id, action, before_json, after_json, edited_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(punchId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, nowLocalString());
}

// Manual add (e.g. forgotten punch).
adminRouter.post('/records', (req, res) => {
  const staffId = Number(req.body?.staffId);
  const type = req.body?.type;
  const timestamp = req.body?.timestamp;

  if (!Number.isInteger(staffId) || (type !== 'in' && type !== 'out') || !timestamp) {
    return res.status(400).json({ error: '不正なリクエストです' });
  }

  const staff = db.prepare('SELECT id FROM staff WHERE id = ?').get(staffId);
  if (!staff) {
    return res.status(404).json({ error: 'スタッフが見つかりません' });
  }

  const now = nowLocalString();
  const info = db
    .prepare(
      `INSERT INTO punches (staff_id, type, timestamp, manual_flag, note, created_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    )
    .run(staffId, type, timestamp, req.body?.note || null, now);

  const record = { id: Number(info.lastInsertRowid), staffId, type, timestamp };
  logEdit(record.id, 'create', null, record);
  res.status(201).json(record);
});

adminRouter.put('/records/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM punches WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: '打刻記録が見つかりません' });
  }

  const type = req.body?.type === 'in' || req.body?.type === 'out' ? req.body.type : existing.type;
  const timestamp = req.body?.timestamp || existing.timestamp;
  const note = req.body?.note !== undefined ? req.body.note : existing.note;

  const now = nowLocalString();
  db.prepare(
    `UPDATE punches SET type = ?, timestamp = ?, note = ?, manual_flag = 1, updated_at = ? WHERE id = ?`
  ).run(type, timestamp, note, now, id);

  const after = { id, type, timestamp, note };
  logEdit(id, 'update', existing, after);
  res.json(after);
});

adminRouter.delete('/records/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM punches WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: '打刻記録が見つかりません' });
  }
  db.prepare('DELETE FROM punches WHERE id = ?').run(id);
  logEdit(id, 'delete', existing, null);
  res.json({ ok: true });
});

adminRouter.get('/records/:id/history', (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, action, before_json AS beforeJson, after_json AS afterJson, edited_at AS editedAt
       FROM punch_edits WHERE punch_id = ? ORDER BY id ASC`
    )
    .all(id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      before: r.beforeJson ? JSON.parse(r.beforeJson) : null,
      after: r.afterJson ? JSON.parse(r.afterJson) : null,
      editedAt: r.editedAt,
    }))
  );
});

// ---- CSV export ----

adminRouter.get('/export.csv', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 1-12
  const staffId = req.query.staffId ? Number(req.query.staffId) : null;

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month を指定してください' });
  }

  const pad = (n) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01 00:00:00`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)} 23:59:59`;

  const clauses = ['p.timestamp >= ?', 'p.timestamp <= ?'];
  const params = [from, to];
  if (staffId) {
    clauses.push('p.staff_id = ?');
    params.push(staffId);
  }

  const rows = db
    .prepare(
      `SELECT s.name AS staffName, p.type, p.timestamp, p.manual_flag AS manualFlag
       FROM punches p
       JOIN staff s ON s.id = p.staff_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY p.timestamp ASC, p.id ASC`
    )
    .all(...params);

  const csvRows = rows.map((r) => {
    const [date, time] = r.timestamp.split(' ');
    return {
      date,
      name: r.staffName,
      type: r.type === 'in' ? '出勤' : '退勤',
      time,
      manual: r.manualFlag ? '手動修正' : '',
    };
  });

  const csv = toCsv(csvRows, [
    { key: 'date', label: '日付' },
    { key: 'name', label: 'スタッフ名' },
    { key: 'type', label: '種別' },
    { key: 'time', label: '時刻' },
    { key: 'manual', label: '備考' },
  ]);

  const filename = `kintai_${year}${pad(month)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});
