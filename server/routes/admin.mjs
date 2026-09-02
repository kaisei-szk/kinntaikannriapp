import { Router } from 'express';
import { db, nowLocalString } from '../db.mjs';
import { verifyPassword, isLocked, recordFailure, clearFailures, requireAdmin } from '../auth.mjs';
import { toCsv, toCsvBody, csvLine } from '../csv.mjs';
import { buildXlsx, colLetter } from '../xlsx.mjs';

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

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function parseTs(ts) {
  return new Date(ts.replace(' ', 'T'));
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Pair each 出勤(in) with the next 退勤(out) chronologically.
// includeUnclosed = true のときは、退勤が無いまま次の出勤が来た分と
// 期間末時点で勤務中の分を minutes: null のセッションとして残す(打刻漏れの可視化)。
function buildSessions(punches, { includeUnclosed = false } = {}) {
  const sessions = [];
  let open = null;
  for (const p of punches) {
    if (p.type === 'in') {
      if (open && includeUnclosed) sessions.push({ in: open, out: null, minutes: null });
      open = p;
    } else if (p.type === 'out' && open) {
      const minutes = Math.round((parseTs(p.timestamp) - parseTs(open.timestamp)) / 60000);
      if (minutes >= 0) {
        sessions.push({ in: open, out: p, minutes });
      }
      open = null;
    }
  }
  if (open && includeUnclosed) sessions.push({ in: open, out: null, minutes: null });
  return { sessions, open };
}

// Compute punch sessions + monthly cumulative worked time for one staff.
// Returns null if the staff does not exist.
function computeStaffSummary(id) {
  const staff = db.prepare('SELECT id, name, kana, active FROM staff WHERE id = ?').get(id);
  if (!staff) return null;

  const punches = db
    .prepare(
      `SELECT type, timestamp FROM punches
       WHERE staff_id = ? ORDER BY timestamp ASC, id ASC`
    )
    .all(id);

  const paired = buildSessions(punches);
  const open = paired.open;
  const sessions = paired.sessions.map((s) => ({
    in: s.in.timestamp,
    out: s.out.timestamp,
    minutes: s.minutes,
  }));

  // Cumulative worked time per month, attributed to the 出勤 month.
  const monthMap = new Map();
  for (const s of sessions) {
    const month = s.in.slice(0, 7); // YYYY-MM
    const cur = monthMap.get(month) || { month, totalMinutes: 0, sessions: 0 };
    cur.totalMinutes += s.minutes;
    cur.sessions += 1;
    monthMap.set(month, cur);
  }
  const monthlyTotals = [...monthMap.values()].sort((a, b) => b.month.localeCompare(a.month));

  return {
    staff,
    monthlyTotals,
    sessions: sessions.reverse(), // newest first
    openSession: open ? open.timestamp : null,
  };
}

function formatDurationHm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

adminRouter.get('/staff/:id/summary', (req, res) => {
  const summary = computeStaffSummary(Number(req.params.id));
  if (!summary) {
    return res.status(404).json({ error: 'スタッフが見つかりません' });
  }
  res.json(summary);
});

adminRouter.get('/staff/:id/summary.csv', (req, res) => {
  const summary = computeStaffSummary(Number(req.params.id));
  if (!summary) {
    return res.status(404).json({ error: 'スタッフが見つかりません' });
  }

  // Session detail (oldest first for readability), then monthly totals.
  const detailRows = [...summary.sessions].reverse().map((s) => ({
    month: s.in.slice(0, 7),
    in: s.in,
    out: s.out,
    duration: formatDurationHm(s.minutes),
    minutes: s.minutes,
  }));

  let csv = toCsv(detailRows, [
    { key: 'month', label: '月' },
    { key: 'in', label: '出勤' },
    { key: 'out', label: '退勤' },
    { key: 'duration', label: '勤務時間(時:分)' },
    { key: 'minutes', label: '勤務分' },
  ]);

  const esc = (v) => {
    const str = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const monthlyLines = [
    '',
    '月別累計',
    '月,勤務回数,累計勤務時間(時:分),累計勤務分',
    ...summary.monthlyTotals.map((m) =>
      [esc(m.month), `${m.sessions}回`, formatDurationHm(m.totalMinutes), m.totalMinutes].join(',')
    ),
  ];
  csv += monthlyLines.join('\r\n') + '\r\n';

  const safeName = summary.staff.name.replace(/[^\p{L}\p{N}_-]/gu, '_');
  const filename = `summary_${summary.staff.id}_${safeName}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="summary_${summary.staff.id}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(csv);
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

// ---- 月次集計(CSV / Excel 共通) ----

// 対象月の「スタッフ -> 勤務セッション」を組み立てる。
// 月をまたぐ勤務(前月末に出勤して当月1日に退勤 / 月末に出勤して翌月1日に退勤)も
// 正しくペアにするため前後1日を含めて取得し、出勤日が対象月のものだけを残す。
function collectMonthlySessions({ year, month, staffId }) {
  const pad = (n) => String(n).padStart(2, '0');
  const monthKey = `${year}-${pad(month)}`;
  const fetchFrom = `${fmtDate(new Date(year, month - 1, 0))} 00:00:00`;
  const fetchTo = `${fmtDate(new Date(year, month, 1))} 23:59:59`;

  const clauses = ['p.timestamp >= ?', 'p.timestamp <= ?'];
  const params = [fetchFrom, fetchTo];
  if (staffId) {
    clauses.push('p.staff_id = ?');
    params.push(staffId);
  }

  const punches = db
    .prepare(
      `SELECT p.staff_id AS staffId, s.name AS staffName, s.kana AS staffKana,
              p.type, p.timestamp, p.manual_flag AS manualFlag
       FROM punches p
       JOIN staff s ON s.id = p.staff_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY p.staff_id ASC, p.timestamp ASC, p.id ASC`
    )
    .all(...params);

  const byStaff = new Map();
  for (const p of punches) {
    let entry = byStaff.get(p.staffId);
    if (!entry) {
      entry = { id: p.staffId, name: p.staffName, kana: p.staffKana || '', punches: [] };
      byStaff.set(p.staffId, entry);
    }
    entry.punches.push(p);
  }

  const collator = new Intl.Collator('ja', { sensitivity: 'base' });
  return [...byStaff.values()]
    .map((entry) => {
      const { sessions } = buildSessions(entry.punches, { includeUnclosed: true });
      return {
        ...entry,
        sessions: sessions.filter((x) => x.in.timestamp.slice(0, 7) === monthKey),
      };
    })
    .filter((entry) => entry.sessions.length > 0)
    .sort((a, b) => collator.compare(a.kana || a.name, b.kana || b.name));
}

// 小数の勤務時間。8:30 -> 8.5、2:45 -> 2.75。
function toHours(minutes) {
  return Number((minutes / 60).toFixed(2));
}

// ---- CSV export ----

// 月次CSV: 「誰が・何日に・何時から何時まで働いたか」の日別明細と、
// その月の合計勤務時間を1ファイルにまとめて出力する。
adminRouter.get('/export.csv', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 1-12
  const staffId = req.query.staffId ? Number(req.query.staffId) : null;

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month を指定してください' });
  }

  const pad = (n) => String(n).padStart(2, '0');
  const staffEntries = collectMonthlySessions({ year, month, staffId });

  const detailRows = [];
  const totalRows = [];
  const grand = { days: 0, count: 0, minutes: 0, unclosed: 0 };

  for (const entry of staffEntries) {
    const workDays = new Set();
    let totalMinutes = 0;
    let count = 0;
    let unclosed = 0;

    for (const s of entry.sessions) {
      const [inDate, inTime] = s.in.timestamp.split(' ');
      const outParts = s.out ? s.out.timestamp.split(' ') : null;
      const notes = [];
      if (!s.out) notes.push('退勤打刻なし');
      else if (outParts[0] !== inDate) notes.push('翌日退勤');
      if (s.in.manualFlag || (s.out && s.out.manualFlag)) notes.push('手動修正');

      workDays.add(inDate);
      if (s.out) {
        totalMinutes += s.minutes;
        count += 1;
      } else {
        unclosed += 1;
      }

      detailRows.push({
        name: entry.name,
        date: inDate,
        weekday: WEEKDAY_LABELS[parseTs(s.in.timestamp).getDay()],
        in: inTime.slice(0, 5),
        out: outParts ? outParts[1].slice(0, 5) : '',
        duration: s.out ? formatDurationHm(s.minutes) : '',
        hours: s.out ? toHours(s.minutes).toFixed(2) : '',
        note: notes.join(' / '),
      });
    }

    totalRows.push({
      name: entry.name,
      days: workDays.size,
      count,
      duration: formatDurationHm(totalMinutes),
      hours: toHours(totalMinutes).toFixed(2),
      unclosed: unclosed ? `${unclosed}件` : '',
    });

    grand.days += workDays.size;
    grand.count += count;
    grand.minutes += totalMinutes;
    grand.unclosed += unclosed;
  }

  const detailColumns = [
    { key: 'name', label: 'スタッフ名' },
    { key: 'date', label: '日付' },
    { key: 'weekday', label: '曜日' },
    { key: 'in', label: '出勤' },
    { key: 'out', label: '退勤' },
    { key: 'duration', label: '勤務時間(時:分)' },
    { key: 'hours', label: '勤務時間(時間)' },
    { key: 'note', label: '備考' },
  ];
  const totalColumns = [
    { key: 'name', label: 'スタッフ名' },
    { key: 'days', label: '勤務日数' },
    { key: 'count', label: '勤務回数' },
    { key: 'duration', label: '合計勤務時間(時:分)' },
    { key: 'hours', label: '合計勤務時間(時間)' },
    { key: 'unclosed', label: '退勤打刻なし' },
  ];

  const title = `${year}年${month}月`;
  const blocks = [
    csvLine([`【日別勤務明細】${title}`]),
    detailRows.length
      ? toCsvBody(detailRows, detailColumns)
      : toCsvBody([], detailColumns) + '\r\n' + csvLine(['この月の打刻記録はありません']),
    '',
    csvLine([`【月合計】${title}`]),
    toCsvBody(totalRows, totalColumns),
  ];

  if (!staffId && totalRows.length > 1) {
    blocks.push(
      csvLine([
        '全員合計',
        grand.days,
        grand.count,
        formatDurationHm(grand.minutes),
        toHours(grand.minutes).toFixed(2),
        grand.unclosed ? `${grand.unclosed}件` : '',
      ])
    );
  }

  // Prepend a UTF-8 BOM so Excel on Windows/Mac opens Japanese text correctly.
  const csv = '﻿' + blocks.join('\r\n') + '\r\n';

  const staffLabel = staffId && staffEntries.length === 1 ? `_${staffEntries[0].name}` : '';
  const filename = `kintai_${year}${pad(month)}${staffLabel}.csv`;
  // 非ASCIIを含まないフォールバック名(旧ブラウザ向け)。実際の名前は filename* が使われる。
  const safeFilename = `kintai_${year}${pad(month)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(csv);
});

// ---- Excel export ----

const DEFAULT_HOURLY_WAGE = 1800;

// 月次Excel: 縦に日付・横にスタッフのマトリクスを2シートで出力する。
//   シート1「勤務時間帯」 各セルに「9:00-18:00 (9h)」
//   シート2「勤務時間」   各セルに時間の数値。合計・給与・総計を数式付きで持つ
adminRouter.get('/export.xlsx', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 1-12
  const staffId = req.query.staffId ? Number(req.query.staffId) : null;
  const wage = req.query.wage !== undefined ? Number(req.query.wage) : DEFAULT_HOURLY_WAGE;

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month を指定してください' });
  }
  if (!Number.isFinite(wage) || wage < 0) {
    return res.status(400).json({ error: '時給の指定が不正です' });
  }

  const pad = (n) => String(n).padStart(2, '0');
  const staffEntries = collectMonthlySessions({ year, month, staffId });
  const lastDay = new Date(year, month, 0).getDate();

  // 日付 x スタッフ のマス目を作る。1日に複数回勤務した場合は同じマスにまとめる。
  const cells = new Map(); // `${staffId}|${YYYY-MM-DD}` -> { minutes, ranges[], unclosed }
  for (const entry of staffEntries) {
    for (const s of entry.sessions) {
      const [inDate, inTime] = s.in.timestamp.split(' ');
      const key = `${entry.id}|${inDate}`;
      const cell = cells.get(key) || { minutes: 0, ranges: [], unclosed: false };
      if (s.out) {
        cell.minutes += s.minutes;
        cell.ranges.push(`${inTime.slice(0, 5)}-${s.out.timestamp.split(' ')[1].slice(0, 5)}`);
      } else {
        cell.unclosed = true;
        cell.ranges.push(`${inTime.slice(0, 5)}-未打刻`);
      }
      cells.set(key, cell);
    }
  }

  const names = staffEntries.map((e) => e.name);
  const firstCol = 2; // A列は日付なのでスタッフはB列から
  const lastStaffCol = firstCol + names.length - 1;
  const totalCol = names.length ? lastStaffCol + 1 : firstCol; // 「総計」列

  // ---- シート1: 勤務時間帯 ----
  const rangeRows = [
    [{ v: `${year}年${month}月 勤務時間帯`, bold: true }],
    [{ v: '日付', bold: true }, ...names.map((n) => ({ v: n, bold: true }))],
  ];
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const weekday = WEEKDAY_LABELS[new Date(year, month - 1, day).getDay()];
    const row = [`${month}/${day}(${weekday})`];
    for (const entry of staffEntries) {
      const cell = cells.get(`${entry.id}|${date}`);
      if (!cell) {
        row.push(null);
        continue;
      }
      const hours = toHours(cell.minutes);
      const label = cell.minutes > 0 ? `${cell.ranges.join(', ')} (${hours}h)` : cell.ranges.join(', ');
      row.push(label);
    }
    rangeRows.push(row);
  }

  // ---- シート2: 勤務時間(数値) ----
  const HEADER_ROW = 2;
  const FIRST_DATA_ROW = 3;
  const lastDataRow = FIRST_DATA_ROW + lastDay - 1;

  const hourRows = [
    // A1 の時給を書き換えると給与行が再計算される(元の Excel と同じ作り)。
    [{ v: wage, bold: true }, '← 時給(この数字を変えると給与が再計算されます)'],
    [{ v: '日付', bold: true }, ...names.map((n) => ({ v: n, bold: true })), { v: '総計', bold: true }],
  ];

  const staffTotals = names.map(() => 0);
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const weekday = WEEKDAY_LABELS[new Date(year, month - 1, day).getDay()];
    const row = [`${month}/${day}(${weekday})`];
    let dayMinutes = 0;
    staffEntries.forEach((entry, i) => {
      const cell = cells.get(`${entry.id}|${date}`);
      if (!cell || cell.minutes === 0) {
        row.push(null);
        return;
      }
      staffTotals[i] += cell.minutes;
      dayMinutes += cell.minutes;
      row.push(toHours(cell.minutes));
    });
    const r = FIRST_DATA_ROW + day - 1;
    // 誰も働いていない日は空欄のままにする(0 が並ぶと見づらいため)。
    row.push(
      names.length && dayMinutes > 0
        ? { v: toHours(dayMinutes), f: `SUM(${colLetter(firstCol)}${r}:${colLetter(lastStaffCol)}${r})` }
        : null
    );
    hourRows.push(row);
  }

  const totalRow = FIRST_DATA_ROW + lastDay;
  const wageRow = totalRow + 1;
  const grandMinutes = staffTotals.reduce((a, b) => a + b, 0);

  hourRows.push([
    { v: '合計勤務時間', bold: true },
    ...staffTotals.map((minutes, i) => {
      const col = colLetter(firstCol + i);
      return {
        v: toHours(minutes),
        bold: true,
        f: `SUM(${col}${FIRST_DATA_ROW}:${col}${lastDataRow})`,
      };
    }),
    {
      v: toHours(grandMinutes),
      bold: true,
      f: names.length
        ? `SUM(${colLetter(firstCol)}${totalRow}:${colLetter(lastStaffCol)}${totalRow})`
        : undefined,
    },
  ]);

  hourRows.push([
    { v: `給与(時給×時間)`, bold: true },
    ...staffTotals.map((minutes, i) => {
      const col = colLetter(firstCol + i);
      return {
        v: Math.round(toHours(minutes) * wage),
        numFmt: 'yen',
        f: `${col}${totalRow}*$A$1`,
      };
    }),
    {
      v: staffTotals.reduce((sum, minutes) => sum + Math.round(toHours(minutes) * wage), 0),
      bold: true,
      numFmt: 'yen',
      f: names.length
        ? `SUM(${colLetter(firstCol)}${wageRow}:${colLetter(lastStaffCol)}${wageRow})`
        : undefined,
    },
  ]);

  const staffColWidths = (width) => names.map(() => ({ width }));
  const xlsx = buildXlsx([
    {
      name: '勤務時間帯',
      rows: rangeRows,
      cols: [{ width: 11 }, ...staffColWidths(22)],
      freeze: { rows: HEADER_ROW, cols: 1 },
    },
    {
      name: '勤務時間',
      rows: hourRows,
      cols: [{ width: 18 }, ...staffColWidths(11), { width: 11 }],
      freeze: { rows: HEADER_ROW, cols: 1 },
    },
  ]);

  const staffLabel = staffId && staffEntries.length === 1 ? `_${staffEntries[0].name}` : '';
  const filename = `勤務時間_${year}年${month}月${staffLabel}.xlsx`;
  const safeFilename = `kintai_${year}${pad(month)}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(xlsx);
});
