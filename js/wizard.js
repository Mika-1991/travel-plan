// ============================================================
// 開站精靈：Step 0 行程選擇 → Step 1 基本資料 → Step 2 飯店
// ============================================================
const Wizard = (() => {

  const $ = id => document.getElementById(id);
  const basic = { name: '', startDate: '', endDate: '', members: [], transport: 'driving', dayStart: '09:00', dayEnd: '21:00', meetPoint: null, endPoint: null };
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

  // 用 Email 找回行程（多筆時讓使用者選）
  async function loadByEmail(email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { UI.toast('Email 格式看起來不對，請再確認'); return; }
    try {
      UI.loading(true, '正在尋找你的行程…');
      const list = await Api.cloudFindByEmail(email);
      UI.loading(false);
      if (!list.length) {
        UI.alert('找不到行程',
          '這個 Email 沒有綁定任何行程。\n\n小提醒：建立行程後，要在分享畫面用這個 Email「寄送代碼」過一次，Email 才會綁定。\n\n也可以直接輸入行程代碼載入。');
        return;
      }
      const openByCode = async code => {
        UI.loading(true, '正在載入行程…');
        const r = await Api.cloudGetTrip(code);
        Store.load(r.trip, r.role);
        UI.loading(false);
        UI.toast('行程載入成功！');
        App.enterMain();
      };
      if (list.length === 1) { await openByCode(list[0].editCode); return; }
      UI.choose('找到多個行程，要開哪一個？',
        list.map(x => ({
          label: `${x.name}（${String(x.startDate).slice(5)}～${String(x.endDate).slice(5)}）`,
          value: x.editCode
        })),
        code => openByCode(code).catch(e => { UI.loading(false); UI.alert('載入失敗', e.message); }));
    } catch (e) {
      UI.loading(false);
      UI.alert('尋找失敗', e.message);
    }
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
    basic.name = $('inpTripName').value.trim() || '我的旅程';
    basic.startDate = s; basic.endDate = e;
    basic.dayStart = $('inpDayStart').value || '09:00';
    basic.dayEnd = $('inpDayEnd').value || '21:00';
    if (basic.members.length === 0) basic.members = ['我'];
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

  function renderChosen() {
    const same = $('chkSameHotel').checked;
    const box = $('hotelChosen');
    const entries = same ? (chosenHotels[0] ? [[0, chosenHotels[0]]] : []) : Object.entries(chosenHotels);
    box.innerHTML = entries.map(([n, h]) => `
      <div class="result-item" data-n="${n}">
        <div class="r-name">🏨 ${same && nights > 1 ? '每晚' : `第 ${Number(n) + 1} 晚`}：${UI.esc(h.name)}</div>
        <div class="r-meta">${UI.esc(h.address)}${h.phone ? '｜☎ ' + h.phone : ''}｜<span class="star">★ ${h.rating}</span></div>
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
      night: Number(n), placeId: h.placeId, name: h.name, address: h.address,
      rating: h.rating, phone: h.phone || '', lat: h.lat, lng: h.lng,
      note: h.note || '', pay: h.pay || '', photo: h.photo || ''
    }));
    trip.hotelMode = hotelMode;
    Store.touch();
    $('wizard').classList.add('hidden');
    Feat.showTripCreated(() => App.enterMain());
  }

  return { init, show };
})();
