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

  let staffList = [];
  let busy = false; // guards the whole tap -> confirm -> camera -> done flow
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'staff-btn';
      btn.dataset.id = String(s.id);
      btn.innerHTML = `
        <span class="staff-name">${escapeHtml(s.name)}</span>
        <span class="staff-status status-${s.nextType}">${TYPE_LABEL[s.nextType]}</span>
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

  async function loadStaff() {
    try {
      const res = await fetch('/api/staff');
      if (!res.ok) throw new Error('failed');
      staffList = await res.json();
      applyFilter();
    } catch (err) {
      staffGrid.innerHTML = '<p class="loading">読み込みに失敗しました。しばらくして再度お試しください。</p>';
    }
  }

  searchInput.addEventListener('input', applyFilter);

  function onStaffTap(staff) {
    if (busy) return;
    busy = true;
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
    busy = false;
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
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
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
      busy = false;
      await loadStaff();
    }, 3000);
  }

  loadStaff();
  setInterval(loadStaff, 60_000);
})();
