(() => {
  'use strict';

  const TYPE_LABEL = { in: '出勤', out: '退勤' };

  const loginView = document.getElementById('login-view');
  const adminView = document.getElementById('admin-view');
  const loginForm = document.getElementById('login-form');
  const loginPassword = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  const logoutBtn = document.getElementById('logout-btn');

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = {
    records: document.getElementById('tab-records'),
    staff: document.getElementById('tab-staff'),
  };

  const filterFrom = document.getElementById('filter-from');
  const filterTo = document.getElementById('filter-to');
  const filterStaff = document.getElementById('filter-staff');
  const filterApply = document.getElementById('filter-apply');
  const recordsTbody = document.getElementById('records-tbody');
  const recordAddBtn = document.getElementById('record-add-btn');

  const exportYear = document.getElementById('export-year');
  const exportMonth = document.getElementById('export-month');
  const exportStaff = document.getElementById('export-staff');
  const exportLink = document.getElementById('export-link');

  const staffTbody = document.getElementById('staff-tbody');
  const staffAddBtn = document.getElementById('staff-add-btn');

  const recordDialog = document.getElementById('record-dialog');
  const recordForm = document.getElementById('record-form');
  const recordDialogTitle = document.getElementById('record-dialog-title');
  const recordIdInput = document.getElementById('record-id');
  const recordStaffSelect = document.getElementById('record-staff');
  const recordTypeSelect = document.getElementById('record-type');
  const recordTimestampInput = document.getElementById('record-timestamp');
  const recordNoteInput = document.getElementById('record-note');
  const recordHistoryBox = document.getElementById('record-history');
  const recordCancelBtn = document.getElementById('record-cancel');

  const staffDialog = document.getElementById('staff-dialog');
  const staffForm = document.getElementById('staff-form');
  const staffDialogTitle = document.getElementById('staff-dialog-title');
  const staffIdInput = document.getElementById('staff-id');
  const staffNameInput = document.getElementById('staff-name');
  const staffKanaInput = document.getElementById('staff-kana');
  const staffOrderInput = document.getElementById('staff-order');
  const staffCancelBtn = document.getElementById('staff-cancel');

  let allStaff = [];

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toDatetimeLocal(serverTs) {
    // 'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SS'
    return serverTs ? serverTs.replace(' ', 'T') : '';
  }

  function fromDatetimeLocal(value) {
    // 'YYYY-MM-DDTHH:MM' or with seconds -> 'YYYY-MM-DD HH:MM:SS'
    let v = value.replace('T', ' ');
    if (v.length === 16) v += ':00';
    return v;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      throw new Error((data && data.error) || `エラーが発生しました (${res.status})`);
    }
    return data;
  }

  // ---- auth ----

  async function checkSession() {
    const { authenticated } = await api('/api/admin/session');
    if (authenticated) {
      showAdmin();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginView.classList.remove('hidden');
    adminView.classList.add('hidden');
  }

  async function showAdmin() {
    loginView.classList.add('hidden');
    adminView.classList.remove('hidden');
    await refreshStaff();
    await refreshRecords();
    const now = new Date();
    exportYear.value = now.getFullYear();
    exportMonth.value = now.getMonth() + 1;
    updateExportLink();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: loginPassword.value }),
      });
      loginPassword.value = '';
      await showAdmin();
    } catch (err) {
      loginError.textContent = err.message;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ---- tabs ----

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      Object.entries(tabPanels).forEach(([key, panel]) => {
        panel.classList.toggle('hidden', key !== btn.dataset.tab);
      });
    });
  });

  // ---- staff ----

  async function refreshStaff() {
    allStaff = await api('/api/admin/staff');
    renderStaffTable();
    renderStaffSelects();
  }

  function renderStaffTable() {
    staffTbody.innerHTML = '';
    for (const s of allStaff) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.kana || '')}</td>
        <td>${s.display_order}</td>
        <td><span class="badge ${s.active ? 'badge-active' : 'badge-inactive'}">${s.active ? '在籍' : '退職'}</span></td>
        <td class="row-actions">
          <button type="button" class="btn btn-secondary btn-small" data-action="edit">編集</button>
          <button type="button" class="btn ${s.active ? 'btn-danger' : 'btn-secondary'} btn-small" data-action="toggle">${s.active ? '退職にする' : '在籍に戻す'}</button>
        </td>
      `;
      tr.querySelector('[data-action="edit"]').addEventListener('click', () => openStaffDialog(s));
      tr.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleStaffActive(s));
      staffTbody.appendChild(tr);
    }
  }

  function renderStaffSelects() {
    const active = allStaff.filter((s) => s.active);
    const options = (includeAll, list) => {
      let html = includeAll ? '<option value="">全員</option>' : '';
      html += list.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
      return html;
    };
    filterStaff.innerHTML = options(true, allStaff);
    exportStaff.innerHTML = options(true, allStaff);
    recordStaffSelect.innerHTML = options(false, active);
  }

  async function toggleStaffActive(staff) {
    if (staff.active) {
      if (!confirm(`${staff.name} さんを退職(打刻画面に非表示)にしますか？\n過去の打刻記録は保持されます。`)) return;
      await api(`/api/admin/staff/${staff.id}`, { method: 'DELETE' });
    } else {
      await api(`/api/admin/staff/${staff.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: true }),
      });
    }
    await refreshStaff();
  }

  function openStaffDialog(staff) {
    staffDialogTitle.textContent = staff ? 'スタッフを編集' : 'スタッフを追加';
    staffIdInput.value = staff ? staff.id : '';
    staffNameInput.value = staff ? staff.name : '';
    staffKanaInput.value = staff ? staff.kana || '' : '';
    staffOrderInput.value = staff ? staff.display_order : 0;
    staffDialog.showModal();
  }

  staffAddBtn.addEventListener('click', () => openStaffDialog(null));
  staffCancelBtn.addEventListener('click', () => staffDialog.close());

  staffForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: staffNameInput.value.trim(),
      kana: staffKanaInput.value.trim(),
      displayOrder: Number(staffOrderInput.value) || 0,
    };
    if (!payload.name) return;

    try {
      if (staffIdInput.value) {
        await api(`/api/admin/staff/${staffIdInput.value}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/admin/staff', { method: 'POST', body: JSON.stringify(payload) });
      }
      staffDialog.close();
      await refreshStaff();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---- records ----

  async function refreshRecords() {
    const params = new URLSearchParams();
    if (filterFrom.value) params.set('from', filterFrom.value);
    if (filterTo.value) params.set('to', filterTo.value);
    if (filterStaff.value) params.set('staffId', filterStaff.value);

    const records = await api(`/api/admin/records?${params.toString()}`);
    renderRecordsTable(records);
  }

  function renderRecordsTable(records) {
    recordsTbody.innerHTML = '';
    if (records.length === 0) {
      recordsTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;">該当する記録がありません</td></tr>';
      return;
    }
    for (const r of records) {
      const [date, time] = r.timestamp.split(' ');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${date}</td>
        <td>${time}</td>
        <td>${escapeHtml(r.staffName)}</td>
        <td><span class="badge badge-${r.type}">${TYPE_LABEL[r.type]}</span></td>
        <td>${r.manualFlag ? '<span class="badge badge-manual">手動修正</span>' : ''} ${escapeHtml(r.note || '')}</td>
        <td class="row-actions">
          <button type="button" class="btn btn-secondary btn-small" data-action="edit">編集</button>
          <button type="button" class="btn btn-danger btn-small" data-action="delete">削除</button>
        </td>
      `;
      tr.querySelector('[data-action="edit"]').addEventListener('click', () => openRecordDialog(r));
      tr.querySelector('[data-action="delete"]').addEventListener('click', () => deleteRecord(r));
      recordsTbody.appendChild(tr);
    }
  }

  async function deleteRecord(record) {
    if (!confirm(`${record.staffName} さんの${TYPE_LABEL[record.type]}記録(${record.timestamp})を削除しますか？`)) return;
    await api(`/api/admin/records/${record.id}`, { method: 'DELETE' });
    await refreshRecords();
  }

  async function openRecordDialog(record) {
    recordDialogTitle.textContent = record ? '打刻を編集' : '打刻を追加';
    recordIdInput.value = record ? record.id : '';
    recordStaffSelect.value = record ? record.staffId : (recordStaffSelect.options[0]?.value || '');
    recordTypeSelect.value = record ? record.type : 'in';
    recordTimestampInput.value = record ? toDatetimeLocal(record.timestamp) : toDatetimeLocal(nowString());
    recordNoteInput.value = record ? record.note || '' : '';

    if (record) {
      recordHistoryBox.classList.remove('hidden');
      recordHistoryBox.innerHTML = '読み込み中...';
      try {
        const history = await api(`/api/admin/records/${record.id}/history`);
        recordHistoryBox.innerHTML = history.length
          ? history.map((h) => `<div>${h.editedAt} - ${describeHistory(h)}</div>`).join('')
          : '<div>修正履歴はありません</div>';
      } catch (err) {
        recordHistoryBox.innerHTML = '履歴の取得に失敗しました';
      }
    } else {
      recordHistoryBox.classList.add('hidden');
      recordHistoryBox.innerHTML = '';
    }

    recordDialog.showModal();
  }

  function describeHistory(h) {
    if (h.action === 'create') return '新規追加';
    if (h.action === 'delete') return '削除';
    if (h.action === 'update' && h.before && h.after) {
      return `変更 (${h.before.timestamp} ${TYPE_LABEL[h.before.type]} → ${h.after.timestamp} ${TYPE_LABEL[h.after.type]})`;
    }
    return h.action;
  }

  function nowString() {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  recordAddBtn.addEventListener('click', () => openRecordDialog(null));
  recordCancelBtn.addEventListener('click', () => recordDialog.close());

  recordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      staffId: Number(recordStaffSelect.value),
      type: recordTypeSelect.value,
      timestamp: fromDatetimeLocal(recordTimestampInput.value),
      note: recordNoteInput.value.trim() || null,
    };

    try {
      if (recordIdInput.value) {
        await api(`/api/admin/records/${recordIdInput.value}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/admin/records', { method: 'POST', body: JSON.stringify(payload) });
      }
      recordDialog.close();
      await refreshRecords();
    } catch (err) {
      alert(err.message);
    }
  });

  filterApply.addEventListener('click', refreshRecords);

  // ---- csv export ----

  function updateExportLink() {
    const params = new URLSearchParams({
      year: exportYear.value,
      month: exportMonth.value,
    });
    if (exportStaff.value) params.set('staffId', exportStaff.value);
    exportLink.href = `/api/admin/export.csv?${params.toString()}`;
  }

  [exportYear, exportMonth, exportStaff].forEach((el) => el.addEventListener('change', updateExportLink));

  checkSession();
})();
