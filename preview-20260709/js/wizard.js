// ============================================================
// 開站精靈：Step 0 行程選擇 → Step 1 基本資料 → Step 2 飯店
// ============================================================
const Wizard = (() => {

  const $ = id => document.getElementById(id);
  const basic = { name: '', creatorEmail: '', startDate: '', endDate: '', members: [], transport: 'driving', dayStart: '09:00', dayEnd: '21:00', meetPoint: null, endPoint: null };
  let hotelMode = 'skip';      // 'input' | 'recommend' | 'skip'
  let chosenHotels = {};       // {night: hotel}
  let currentNight = 0;
  let nights = 0;

  function show(id) {
    document.querySelectorAll('.w-screen').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  function init() {
    // ---- Step 0 ----
    const local = Store.loadLocal();
    if (local) {
      $('btnResume').classList.remove('hidden');
      $('btnResume').textContent = `⏰ 繼續上次行程（${local.trip.name}）`;
    }
    $('btnResume').onclick = () => {
      const l = Store.loadLocal();
      if (!l) return;
      Store.load(l.trip, l.role);
      App.enterMain();
    };
    $('btnNewTrip').onclick = () => {
      const now = new Date(); // 用本地日期（toISOString 會變成 UTC 日期）
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (!$('inpStart').value) { $('inpStart').value = today; $('inpEnd').value = today; }
      updateDayCount();
      show('w-basic');
    };
    $('btnEnterCode').onclick = () => {
      $('codeBox').classList.toggle('hidden');
      $('codeInput').focus();
    };
    $('btnLoadCode').onclick = loadByCode;
    $('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') loadByCode(); });

    // ---- Step 1 ----
    $('inpStart').addEventListener('change', updateDayCount);
    $('inpEnd').addEventListener('change', updateDayCount);
    $('btnAddMember').onclick = addMember;
    $('inpMember').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } });
    $('segTransport').querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        $('segTransport').querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        basic.transport = b.dataset.v;
      };
    });
    document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show(b.dataset.back));
    $('btnBasicNext').onclick = basicNext;

    // 集合出發地 / 解散地（選填）
    setupPointPicker('inpMeetPoint', 'btnMeetSearch', 'meetResults', 'meetChosen', 'meetPoint', '🚩');
    setupPointPicker('inpEndPoint', 'btnEndSearch', 'endResults', 'endChosen', 'endPoint', '🏁');

    // ---- Step 2 ----
    $('btnHotelYes').onclick = () => {
      hotelMode = 'input';
      $('hotelNoArea').classList.add('hidden');
      $('hotelInputArea').classList.remove('hidden');
      setupNightTabs();
    };
    $('btnHotelNo').onclick = () => {
      hotelMode = 'recommend';
      $('hotelInputArea').classList.add('hidden');
      $('hotelNoArea').classList.remove('hidden');
    };
    $('btnHotelSkip').onclick = () => { hotelMode = 'skip'; finish(); };
    $('btnHotelBack').onclick = () => show('w-basic');
    $('btnHotelBack2').onclick = () => show('w-basic');
    $('btnHotelDone2').onclick = finish;
    $('btnHotelDone').onclick = finish;
    $('btnHotelSearch').onclick = searchHotel;
    $('inpHotelSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchHotel(); });
    $('chkSameHotel').addEventListener('change', renderNightTabs);
    $('btnCustomHotel').onclick = chooseCustomHotel;
  }

  async function loadByCode() {
    const raw = $('codeInput').value.trim();
    if (!raw) { UI.toast('請先輸入行程代碼或 Email'); return; }
    if (raw.includes('@')) { loadByEmail(raw); return; }
    const code = Logic.normalizeCode(raw);
    if (!Logic.isEditCodeFormat(code) && !Logic.isViewCodeFormat(code)) {
      UI.toast('格式看起來不對：代碼像 TPE826 或 TPE826-V3K9，或輸入完整 Email');
      return;
    }
    try {
      UI.loading(true, '正在載入行程…');
      const r = await Api.cloudGetTrip(code);
      Store.load(r.trip, r.role);
      UI.loading(false);
      UI.toast(r.role === 'view' ? '已用唯讀模式開啟行程' : '行程載入成功，可以開始編輯！');
      App.enterMain();
    } catch (e) {
      UI.loading(false);
      UI.alert('載入失敗', e.message + '\n\n請確認代碼有沒有打錯，或請行程建立者再分享一次。');
    }
  }

  // 通用地點選擇器（集合地／解散地）
  function setupPointPicker(inpId, btnId, resId, chosenId, field, icon) {
    const renderChosenChip = () => {
      const p = basic[field];
      $(chosenId).innerHTML = p
        ? `<span class="chip on">${icon} ${UI.esc(p.name)} <span class="x">✕</span></span>` : '';
      const x = $(chosenId).querySelector('.x');
      if (x) x.onclick = () => { basic[field] = null; renderChosenChip(); };
    };
    const search = async () => {
      const q = $(inpId).value.trim();
      if (!q) { UI.toast('請先輸入地點名稱'); return; }
      try {
        UI.loading(true, '搜尋地點中…');
        const rs = await Api.searchPlaces(q, 'spot');
        UI.loading(false);
        if (!rs.length) { $(resId).innerHTML = '<p class="hint">找不到這個地點，請換個關鍵字。</p>'; return; }
        $(resId).innerHTML = rs.slice(0, 5).map((p, i) => `
          <div class="result-item">
            <div class="r-name">${UI.esc(p.name)}</div>
            <div class="r-meta">${UI.esc(p.address || '')}</div>
            <div class="r-actions"><button class="primary" data-i="${i}">選這裡</button></div>
          </div>`).join('');
        $(resId).querySelectorAll('button[data-i]').forEach(b =>
          b.onclick = () => {
            const p = rs[Number(b.dataset.i)];
            basic[field] = { placeId: p.placeId, name: p.name, address: p.address || '', lat: p.lat, lng: p.lng };
            $(resId).innerHTML = ''; $(inpId).value = '';
            renderChosenChip();
          });
      } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
    };
    $(btnId).onclick = search;
    $(inpId).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  }

  // 用 Email 找回行程：寄 6 碼驗證碼 → 驗證 → 列出行程（可開啟／刪除）
  async function loadByEmail(email) {
    email = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { UI.toast('Email 格式看起來不對，請再確認'); return; }
    try {
      UI.loading(true, '寄送驗證碼中…');
      const r = await Api.cloudRequestOtp(email);
      UI.loading(false);
      openOtpModal(email, r);
    } catch (e) {
      UI.loading(false);
      if (/未知的動作/.test(e.message)) {
        UI.alert('後端需要更新',
          '這個功能需要 v2 的後端。\n\n請先部署 v2版本/2.程式/gas/Code.gs（含 OTP 驗證），並重新執行一次 setupSheets，再測試 Email 找回。');
      } else {
        UI.alert('無法寄送驗證碼', e.message);
      }
    }
  }

  // 步驟 2：輸入驗證碼
  function openOtpModal(email, reqResult) {
    const body = document.createElement('div');
    body.innerHTML = `
      <p style="margin-bottom:8px">驗證碼已寄到 <b>${UI.esc(email)}</b>，10 分鐘內有效。</p>
      ${reqResult.simulated ? `<p class="hint">（模擬模式不會真的寄信，請輸入 <b>${reqResult.mockOtp}</b> 測試）</p>` : ''}
      <label>輸入 6 碼驗證碼</label>
      <input id="otpInp" type="text" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" style="letter-spacing:6px;font-size:1.3rem;text-align:center">
      <button id="otpResend" class="btn-ghost" style="width:100%">沒收到？60 秒後可重寄</button>`;

    // 重寄倒數
    let cd = 60;
    const timer = setInterval(() => {
      const btn = document.getElementById('otpResend');
      if (!btn) { clearInterval(timer); return; }
      cd--;
      if (cd <= 0) { btn.textContent = '重新寄送驗證碼'; btn.disabled = false; clearInterval(timer); }
      else { btn.textContent = `沒收到？${cd} 秒後可重寄`; btn.disabled = true; }
    }, 1000);
    body.querySelector('#otpResend').disabled = true;
    body.querySelector('#otpResend').onclick = async () => {
      try {
        UI.loading(true, '重新寄送中…');
        const r = await Api.cloudRequestOtp(email);
        UI.loading(false);
        UI.toast('驗證碼已重新寄出');
        openOtpModal(email, r);
      } catch (e) { UI.loading(false); UI.alert('重寄失敗', e.message); }
    };

    const verify = async () => {
      const otp = document.getElementById('otpInp').value.trim();
      if (!/^\d{6}$/.test(otp)) { UI.toast('請輸入 6 位數驗證碼'); return; }
      try {
        UI.loading(true, '驗證中…');
        const r = await Api.cloudVerifyOtp(email, otp);
        UI.loading(false);
        clearInterval(timer);
        openTripListModal(email, r.sessionToken, r.trips);
      } catch (e) { UI.loading(false); UI.alert('驗證失敗', e.message); }
    };
    body.querySelector('#otpInp').addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
    UI.modal('📮 信箱驗證', body, [{ label: '驗證', primary: true, onClick: verify }]);
    setTimeout(() => document.getElementById('otpInp')?.focus(), 50);
  }

  // 步驟 3：行程清單（開啟／刪除）
  function openTripListModal(email, sessionToken, trips) {
    if (!trips.length) {
      UI.alert('沒有行程', '這個 Email 目前沒有任何行程（可能都已刪除）。');
      return;
    }
    const body = document.createElement('div');
    body.className = 'result-list';
    body.innerHTML = trips.map((t, i) => `
      <div class="result-item">
        <div class="r-name">${UI.esc(t.name)}</div>
        <div class="r-meta">${UI.esc(String(t.startDate))} ～ ${UI.esc(String(t.endDate))}</div>
        <div class="r-actions">
          <button class="primary" data-open="${i}">開啟行程</button>
          <button data-del="${i}" style="border-color:var(--danger);color:var(--danger)">🗑️ 刪除</button>
        </div>
      </div>`).join('');

    body.querySelectorAll('[data-open]').forEach(b =>
      b.onclick = async () => {
        try {
          UI.loading(true, '正在載入行程…');
          const r = await Api.cloudGetTrip(trips[Number(b.dataset.open)].editCode);
          Store.load(r.trip, r.role);
          UI.loading(false);
          UI.closeModal();
          UI.toast('行程載入成功！');
          App.enterMain();
        } catch (e) { UI.loading(false); UI.alert('載入失敗', e.message); }
      });

    body.querySelectorAll('[data-del]').forEach(b =>
      b.onclick = () => {
        const t = trips[Number(b.dataset.del)];
        UI.confirm('刪除行程？',
          `確定要刪除「${t.name}」嗎？\n\n刪除後所有人（包含拿到代碼的親友）都無法再開啟。\n資料會保留一段時間，若誤刪可聯絡 Mika 復原。`, async () => {
            try {
              UI.loading(true, '刪除中…');
              const r = await Api.cloudDeleteTripByEmail(email, sessionToken, t.tripId);
              UI.loading(false);
              UI.toast(`已刪除「${t.name}」`);
              openTripListModal(email, sessionToken, r.trips); // 重新列出剩餘行程
            } catch (e) { UI.loading(false); UI.alert('刪除失敗', e.message); }
          });
      });

    UI.modal('你的行程', body, []);
  }

  function updateDayCount() {
    const s = $('inpStart').value, e = $('inpEnd').value;
    if (s && e && e >= s) {
      const n = Logic.datesBetween(s, e).length;
      $('dayCountHint').textContent = `共 ${n} 天 ${n - 1} 夜`;
    } else $('dayCountHint').textContent = '';
  }

  function addMember() {
    const name = $('inpMember').value.trim();
    if (!name) return;
    if (name === '我') { UI.toast('請輸入實際人名，不要使用「我」'); return; }
    if (name.length < 2) { UI.toast('請輸入至少 2 個字的成員名稱'); return; }
    if (basic.members.includes(name)) { UI.toast('這個暱稱已經加過了'); return; }
    basic.members.push(name);
    $('inpMember').value = '';
    renderMembers();
  }
  function renderMembers() {
    $('memberChips').innerHTML = basic.members.map((m, i) =>
      `<span class="chip">${UI.esc(m)} <span class="x" data-i="${i}">✕</span></span>`).join('');
    $('memberChips').querySelectorAll('.x').forEach(x =>
      x.onclick = () => { basic.members.splice(Number(x.dataset.i), 1); renderMembers(); });
  }

  function basicNext() {
    const s = $('inpStart').value, e = $('inpEnd').value;
    if (!s || !e) { UI.alert('還差一步', '請先選擇旅遊的開始與結束日期。'); return; }
    if (e < s) { UI.alert('日期有誤', '結束日期不能早於開始日期，請重新選擇。'); return; }
    const email = $('inpCreatorEmail').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      UI.alert('Email 必填', '請輸入有效的建立者 Email，之後才能安全找回行程。');
      $('inpCreatorEmail').focus();
      return;
    }
    if (basic.members.length === 0) {
      UI.alert('請加入成員', '請至少加入一位實際人名；不能用「我」當成員。');
      $('inpMember').focus();
      return;
    }
    basic.name = $('inpTripName').value.trim() || '我的旅程';
    basic.creatorEmail = email;
    basic.startDate = s; basic.endDate = e;
    basic.dayStart = $('inpDayStart').value || '09:00';
    basic.dayEnd = $('inpDayEnd').value || '21:00';
    nights = Math.max(Logic.datesBetween(s, e).length - 1, 1);
    chosenHotels = {}; currentNight = 0;
    show('w-hotel');
  }

  // ---- 飯店輸入 ----
  function setupNightTabs() {
    $('chkSameHotel').checked = true;
    renderNightTabs();
  }
  function renderNightTabs() {
    const same = $('chkSameHotel').checked;
    const tabs = $('hotelNightTabs');
    if (same || nights <= 1) {
      tabs.innerHTML = '';
      $('hotelNightHint').textContent = nights > 1 ? `共 ${nights} 晚（每晚同一間）` : '共 1 晚';
      currentNight = 0;
    } else {
      $('hotelNightHint').textContent = `共 ${nights} 晚，點選要設定的晚別：`;
      tabs.innerHTML = Array.from({ length: nights }, (_, i) =>
        `<span class="chip ${i === currentNight ? 'on' : ''}" data-n="${i}">第 ${i + 1} 晚${chosenHotels[i] ? ' ✓' : ''}</span>`).join('');
      tabs.querySelectorAll('.chip').forEach(c =>
        c.onclick = () => { currentNight = Number(c.dataset.n); renderNightTabs(); });
    }
    renderChosen();
  }

  async function searchHotel() {
    const q = $('inpHotelSearch').value.trim();
    if (!q) { UI.toast('請先輸入飯店名稱'); return; }
    try {
      UI.loading(true, '搜尋飯店中…');
      const results = await Api.searchPlaces(q, 'hotel');
      UI.loading(false);
      if (!results.length) {
        $('hotelResults').innerHTML = `<p class="hint">找不到「${UI.esc(q)}」，請換個關鍵字試試。</p>`;
        return;
      }
      const multi = results.length > 1;
      $('hotelResults').innerHTML =
        (multi ? `<p class="hint">找到 ${results.length} 筆，請選擇正確的分館：</p>` : '') +
        results.map((h, i) => `
          <div class="result-item">
            <div class="r-name">${UI.esc(h.name)}</div>
            <div class="r-meta">${UI.esc(h.address)}｜<span class="star">★ ${h.rating}</span>（${(h.reviews || 0).toLocaleString()} 則）</div>
            <div class="r-actions">
              <button class="primary" data-i="${i}">選這間</button>
              <a href="${UI.hotelPriceLink(h.name)}" target="_blank" rel="noopener">💲 查房價</a>
              <a href="${UI.gmapLink(h)}" target="_blank" rel="noopener">📍 地圖</a>
            </div>
          </div>`).join('');
      $('hotelResults').querySelectorAll('button[data-i]').forEach(b =>
        b.onclick = () => chooseHotel(results[Number(b.dataset.i)]));
    } catch (e) {
      UI.loading(false);
      UI.alert('搜尋失敗', e.message);
    }
  }

  function chooseHotel(h) {
    const same = $('chkSameHotel').checked;
    if (same || nights <= 1) {
      for (let i = 0; i < nights; i++) chosenHotels[i] = h;
    } else {
      chosenHotels[currentNight] = h;
      if (currentNight < nights - 1) currentNight++;
    }
    $('hotelResults').innerHTML = '';
    $('inpHotelSearch').value = '';
    renderNightTabs();
    UI.toast(`已選擇「${h.name}」`);
  }

  async function chooseCustomHotel() {
    const name = $('inpCustomHotelName').value.trim();
    const address = $('inpCustomHotelAddress').value.trim();
    const latRaw = $('inpCustomHotelLat').value.trim();
    const lngRaw = $('inpCustomHotelLng').value.trim();
    if (!name) { UI.toast('請輸入自訂住宿名稱'); return; }
    const hasLat = latRaw !== '', hasLng = lngRaw !== '';
    if (hasLat !== hasLng) { UI.toast('座標請同時填緯度與經度，或兩個都空白'); return; }
    let lat = hasLat ? Number(latRaw) : null;
    let lng = hasLng ? Number(lngRaw) : null;
    if (hasLat && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
      UI.toast('座標格式不對，請使用十進制度 DD');
      return;
    }
    let located = hasLat;
    // 沒填座標但有地址 → 用 Google 地圖自動定位，路程就能估算
    if (!hasLat && address) {
      UI.loading(true, '用地址定位中…');
      const geo = await Api.geocodeAddress(address);
      UI.loading(false);
      if (geo) { lat = geo.lat; lng = geo.lng; located = true; UI.toast('已從地址定位，路程可以估算了'); }
    }
    chooseHotel({
      source: 'custom',
      placeId: 'custom-hotel-' + Logic.uid(),
      name, address,
      lat, lng,
      rating: 0,
      reviews: 0,
      phone: '',
      photo: '',
      hasCoords: located,
      estimateWarning: located ? '' : '沒有座標，住宿路程無法精準估算'
    });
    $('inpCustomHotelName').value = '';
    $('inpCustomHotelAddress').value = '';
    $('inpCustomHotelLat').value = '';
    $('inpCustomHotelLng').value = '';
  }

  function renderChosen() {
    const same = $('chkSameHotel').checked;
    const box = $('hotelChosen');
    const entries = same ? (chosenHotels[0] ? [[0, chosenHotels[0]]] : []) : Object.entries(chosenHotels);
    box.innerHTML = entries.map(([n, h]) => `
      <div class="result-item" data-n="${n}">
        <div class="r-name">🏨 ${same && nights > 1 ? '每晚' : `第 ${Number(n) + 1} 晚`}：${UI.esc(h.name)}</div>
        <div class="r-meta">${UI.esc(h.address)}${h.phone ? '｜☎ ' + h.phone : ''}｜<span class="star">★ ${h.rating}</span></div>
        ${Logic.hasCoords(h) ? '' : '<div class="r-meta" style="color:var(--danger)">⚠️ 沒有座標，住宿路程無法精準估算</div>'}
        <input class="h-note" type="text" placeholder="備註（例：訂房編號 BK12345）" maxlength="60" value="${UI.esc(h.note || '')}" style="margin:8px 0 6px">
        <select class="h-pay" aria-label="付款狀態" style="margin-bottom:0">
          <option value="">付款狀態（選填）</option>
          ${Object.entries(UI.PAY_LABELS).map(([v, lb]) =>
            `<option value="${v}" ${h.pay === v ? 'selected' : ''}>${lb}</option>`).join('')}
        </select>
      </div>`).join('');
    box.querySelectorAll('.result-item').forEach(item => {
      const h = chosenHotels[Number(item.dataset.n)];
      item.querySelector('.h-note').addEventListener('input', e => { h.note = e.target.value; });
      item.querySelector('.h-pay').addEventListener('change', e => { h.pay = e.target.value; });
    });
  }

  function finish() {
    if (hotelMode === 'input' && Object.keys(chosenHotels).length === 0) {
      UI.confirm('還沒選飯店', '你選了「已訂飯店」但還沒有選任何一間。要先跳過、稍後再設定嗎？', () => {
        hotelMode = 'skip'; finish();
      });
      return;
    }
    const trip = Store.create(basic);
    trip.hotels = Object.entries(chosenHotels).map(([n, h]) => ({
      night: Number(n), source: h.source || 'google', placeId: h.placeId, name: h.name, address: h.address,
      rating: h.rating, phone: h.phone || '', lat: h.lat, lng: h.lng,
      hasCoords: Logic.hasCoords(h), estimateWarning: Logic.hasCoords(h) ? '' : '沒有座標，住宿路程無法精準估算',
      note: h.note || '', pay: h.pay || '', photo: h.photo || ''
    }));
    trip.hotelMode = hotelMode;
    Store.touch();
    $('wizard').classList.add('hidden');
    Feat.showTripCreated(() => App.enterMain());
  }

  return { init, show };
})();
