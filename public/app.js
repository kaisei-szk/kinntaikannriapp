(() => {
  'use strict';

  const screenList = document.getElementById('screen-list');
  const staffGrid = document.getElementById('staff-grid');
  const searchInput = document.getElementById('search-input');

  const screenConfirm = document.getElementById('screen-confirm');
  const confirmName = document.getElementById('confirm-name');
  const confirmTypeLabel = document.getElementById('confirm-type-label');
  const confirmToggle = document.getElementById('confirm-toggle');
  const confirmCancel = document.getElementById('confirm-cancel');
  const confirmOk = document.getElementById('confirm-ok');

  const screenCamera = document.getElementById('screen-camera');
  const cameraVideo = document.getElementById('camera-video');
  const cameraFlash = document.getElementById('camera-flash');

  const screenDone = document.getElementById('screen-done');
  const doneCheck = document.getElementById('done-check');
  const doneName = document.getElementById('done-name');
  const doneMessage = document.getElementById('done-message');
  const doneTime = document.getElementById('done-time');

  const TYPE_LABEL = { in: '出勤', out: '退勤' };

  const AVATAR_SVG =
    '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';

  // ---- clock ----
  const clockTime = document.getElementById('clock-time');
  const clockDate = document.getElementById('clock-date');
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function updateClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    clockTime.textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
    clockDate.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
  }
  updateClock();
  setInterval(tick, 1000);

  let staffList = [];
  let busy = false; // guards the whole tap -> confirm -> camera -> done flow
  let busySince = 0; // busy になった時刻。ハングした操作を自動復旧するための目印
  let pending = null; // { id, name, type }
  let mediaStream = null;

  function render(list) {
    staffGrid.innerHTML = '';
    if (list.length === 0) {
      staffGrid.innerHTML = '<p class="loading">該当するスタッフがいません</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of list) {
      // 出勤〜退勤の間だけ「勤務中」を緑で強調。それ以外(未打刻/退勤後)は灰色。
      const working = s.lastType === 'in';
      const state = working ? 'working' : 'left';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `staff-btn state-${state}`;
      btn.dataset.id = String(s.id);
      const kanaHtml = s.kana ? `<span class="staff-kana">${escapeHtml(s.kana)}</span>` : '';
      btn.innerHTML = `
        <span class="staff-avatar">${AVATAR_SVG}</span>
        <span class="staff-name">${escapeHtml(s.name)}</span>
        ${kanaHtml}
        <span class="staff-status status-${state}">勤務中</span>
      `;
      btn.addEventListener('click', () => onStaffTap(s));
      frag.appendChild(btn);
    }
    staffGrid.appendChild(frag);
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function applyFilter() {
    const q = searchInput.value.trim();
    if (!q) {
      render(staffList);
      return;
    }
    const filtered = staffList.filter(
      (s) => s.name.includes(q) || (s.kana && s.kana.includes(q))
    );
    render(filtered);
  }

  const kanaCollator = new Intl.Collator('ja', { sensitivity: 'base' });

  // 出勤中(勤務中)の人を上部に優先表示し、その中では苗字(カナ)の五十音順に並べる。
  // カナ未入力のスタッフは名前で代用する。
  function sortByKana(list) {
    return list.slice().sort((a, b) => {
      const aw = a.lastType === 'in' ? 0 : 1;
      const bw = b.lastType === 'in' ? 0 : 1;
      if (aw !== bw) return aw - bw;
      const ka = (a.kana || a.name || '').trim();
      const kb = (b.kana || b.name || '').trim();
      return kanaCollator.compare(ka, kb);
    });
  }

  async function loadStaff() {
    try {
      const res = await fetch('/api/staff', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      staffList = sortByKana(await res.json());
      applyFilter();
      setOnline(true);
      return true;
    } catch (err) {
      setOnline(false);
      if (staffList.length === 0) {
        staffGrid.innerHTML = '<p class="loading">サーバーに接続できません。自動で再接続しています...</p>';
      }
      return false;
    }
  }

  searchInput.addEventListener('input', applyFilter);

  function onStaffTap(staff) {
    if (busy) return;
    busy = true;
    busySince = Date.now();
    pending = { id: staff.id, name: staff.name, type: staff.nextType };
    openConfirm();
  }

  function openConfirm() {
    confirmName.textContent = `${pending.name} さん`;
    confirmTypeLabel.textContent = TYPE_LABEL[pending.type];
    screenConfirm.classList.remove('hidden');
  }

  function closeConfirm() {
    screenConfirm.classList.add('hidden');
  }

  confirmToggle.addEventListener('click', () => {
    pending.type = pending.type === 'in' ? 'out' : 'in';
    confirmTypeLabel.textContent = TYPE_LABEL[pending.type];
  });

  confirmCancel.addEventListener('click', () => {
    closeConfirm();
    pending = null;
    setIdle();
  });

  confirmOk.addEventListener('click', async () => {
    closeConfirm();
    await runCameraEffect();
    await submitPunch();
  });

  async function runCameraEffect() {
    screenCamera.classList.remove('hidden');
    cameraFlash.classList.remove('flash-active');

    try {
      // 端末が長時間つけっぱなしだとカメラ取得が返ってこないことがあるため、
      // 4秒で見切りをつけて打刻処理へ進む(写真は演出のみで保存しない)。
      mediaStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }),
        wait(4000).then(() => { throw new Error('camera timeout'); }),
      ]);
      cameraVideo.srcObject = mediaStream;
      await cameraVideo.play().catch(() => {});
      await wait(1400);
    } catch (err) {
      // No camera / permission denied - fail open, the photo is a deterrent only, never stored.
      await wait(900);
    }

    cameraFlash.classList.add('flash-active');
    await wait(220);
    stopCamera();
    screenCamera.classList.add('hidden');
  }

  function stopCamera() {
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
    cameraVideo.srcObject = null;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function submitPunch() {
    try {
      const res = await fetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId: pending.id, type: pending.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '打刻に失敗しました');
      showDone(data);
    } catch (err) {
      showDone(null, err.message);
    } finally {
      pending = null;
    }
  }

  function showDone(data, errorMessage) {
    if (data) {
      doneCheck.textContent = '✓';
      doneName.textContent = `${data.name} さん`;
      doneMessage.textContent = `${TYPE_LABEL[data.type]}の打刻が完了しました`;
      doneTime.textContent = data.timestamp;
      screenDone.classList.remove('error');
    } else {
      doneCheck.textContent = '!';
      doneName.textContent = '';
      doneMessage.textContent = errorMessage || '打刻に失敗しました。もう一度お試しください。';
      doneTime.textContent = '';
      screenDone.classList.add('error');
    }
    screenDone.classList.remove('hidden');

    setTimeout(async () => {
      screenDone.classList.add('hidden');
      setIdle();
      await loadStaff();
    }, 3000);
  }

  // ---- キオスク運用の安定化 ----
  // タブレットを置きっぱなしで使うため、(1)画面を消させない (2)固まったら自力で復帰する
  // の2点をアプリ側でも面倒を見る。OS側の設定(常時点灯・アプリ固定)と併用する前提。

  const connBanner = document.getElementById('conn-banner');

  // 画面スリープ抑止。Wake Lock は画面が隠れると解除されるので都度取り直す。
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch (err) {
      wakeLock = null; // 非対応ブラウザ・省電力モードなど。OS設定側で担保する。
    }
  }

  // 操作フローが途中で固まったとき用のリセット。
  function setIdle() {
    busy = false;
    busySince = 0;
  }

  function resetFlow() {
    stopCamera();
    screenConfirm.classList.add('hidden');
    screenCamera.classList.add('hidden');
    screenDone.classList.add('hidden');
    pending = null;
    setIdle();
  }

  // ---- 接続監視 ----
  const OFFLINE_RELOAD_MS = 3 * 60_000; // これ以上落ちていたら復帰時に画面ごと作り直す
  let offlineSince = 0;

  function setOnline(ok) {
    if (ok) {
      const downMs = offlineSince ? Date.now() - offlineSince : 0;
      offlineSince = 0;
      connBanner.classList.add('hidden');
      // サーバー再起動をまたいだ場合は表示が古い可能性が高いので読み直す。
      if (downMs > OFFLINE_RELOAD_MS && !busy) location.reload();
      return;
    }
    if (!offlineSince) offlineSince = Date.now();
    connBanner.textContent = 'サーバーに接続できません。自動で再接続しています…';
    connBanner.classList.remove('hidden');
  }

  async function healthLoop() {
    for (;;) {
      let ok = false;
      try {
        // 応答が返ってくること自体が「サーバーが生きている」証拠。
        // /api/health を持たない旧バージョンが動いていても誤検知しないよう 4xx も生存扱いにする。
        const res = await fetch('/api/health', { cache: 'no-store' });
        ok = res.status < 500;
      } catch (err) {
        ok = false; // 接続そのものが失敗 = サーバーが落ちている
      }
      setOnline(ok);
      await wait(ok ? 20_000 : 3_000); // 落ちている間は短い間隔で復帰を待つ
    }
  }

  // ---- ウォッチドッグ ----
  // 1秒ごとに呼ばれる想定。時計の進みが飛んでいたら端末スリープ/タブ凍結からの復帰とみなす。
  const FREEZE_MS = 60_000;
  const BUSY_TIMEOUT_MS = 120_000;
  let lastTick = Date.now();

  function tick() {
    updateClock();
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;

    if (gap > FREEZE_MS) {
      // 停止していた間に日付や勤務状態が変わっている。作り直すのが一番確実。
      if (!busy) {
        location.reload();
        return;
      }
      resetFlow();
      loadStaff();
    }

    // 打刻フローが固まったまま放置されると誰も打刻できなくなるので強制解除する。
    if (busy && busySince && now - busySince > BUSY_TIMEOUT_MS) {
      resetFlow();
      loadStaff();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    acquireWakeLock();
    loadStaff();
  });
  // 自動取得が弾かれた場合に備え、タッチのたびに取り直しを試みる。
  document.addEventListener('pointerdown', acquireWakeLock, { passive: true });
  window.addEventListener('online', () => loadStaff());

  acquireWakeLock();
  healthLoop();

  loadStaff();
  setInterval(loadStaff, 60_000);
})();
