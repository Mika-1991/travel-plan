// ============================================================
// 功能模組：天氣穿搭、雨天備案、飯店推薦、美食、分帳、分享
// ============================================================
const Feat = (() => {

  const $ = id => document.getElementById(id);
  const trip = () => Store.get();

  // ================= 天氣 + 穿搭 =================
  function wIcon(code) {
    if (code === 0) return '☀️';
    if (code <= 2) return '🌤️';
    if (code === 3) return '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 67) return '🌧️';
    if (code >= 71 && code <= 77) return '❄️';
    if (code >= 80 && code <= 82) return '🌦️';
    if (code >= 95) return '⛈️';
    return '☁️';
  }

  async function fillWeather() {
    const t = trip();
    if (!t) return;
    const days = Store.days();
    for (let d = 1; d <= days; d++) {
      const el = document.querySelector(`[data-day-weather="${d}"]`);
      if (!el) continue;
      const center = Itin.dayCenter(d) || Itin.startHotel(d);
      if (!center) { el.textContent = ''; continue; }
      const w = await Api.weatherOn(center.lat, center.lng, Store.dateOfDay(d), t.dayStart, t.dayEnd);
      const outfitEl = document.querySelector(`[data-day-outfit="${d}"]`);
      const rainSlot = document.querySelector(`[data-rain-slot="${d}"]`);
      if (!w) { el.textContent = '⚠️ 天氣查詢失敗'; continue; }
      if (w.outOfRange) { el.textContent = '🗓️ 天氣：接近出發日再查看'; continue; }
      el.textContent = `${wIcon(w.code)} ${w.tmin}–${w.tmax}°C｜降雨 ${w.rainProb}%`;
      if (outfitEl) {
        const tips = Logic.outfitAdvice(w);
        outfitEl.textContent = tips.join('　');
      }
      if (rainSlot) renderRainAlert(rainSlot, d, w);
    }
  }

  function renderRainAlert(slot, d, w) {
    const t = trip();
    if (w.rainProb < CONFIG.defaults.rainThreshold && !t.rainActive[d]) { slot.innerHTML = ''; return; }
    const ro = Store.isReadonly();
    if (t.rainActive[d]) {
      slot.innerHTML = `<div class="rain-alert">☔ 這天已使用雨天備案
        ${ro ? '' : `<button data-a="restore">還原原行程</button>`}</div>`;
    } else if (t.rainPlans[d] && t.rainPlans[d].spots.length) {
      slot.innerHTML = `<div class="rain-alert">☔ 降雨機率 ${w.rainProb}%，建議改走雨天備案
        ${ro ? '' : `<button data-a="apply">一鍵切換備案</button>`}</div>`;
    } else {
      slot.innerHTML = `<div class="rain-alert">☔ 降雨機率 ${w.rainProb}%，這天可能下雨
        ${ro ? '' : `<button data-a="setup">設定雨天備案</button>`}</div>`;
    }
    const btn = slot.querySelector('button');
    if (!btn) return;
    btn.onclick = () => {
      const a = btn.dataset.a;
      if (a === 'apply') confirmApplyRain(d);
      else if (a === 'restore') confirmRestoreRain(d);
      else openRainPlan(d);
    };
  }

  // ================= 雨天備案 =================
  function openRainPlan(d) {
    const t = trip();
    if (!t.rainPlans[d]) t.rainPlans[d] = { spots: [] };
    const plan = t.rainPlans[d];

    const body = document.createElement('div');
    const listBox = document.createElement('div');
    const renderList = () => {
      listBox.innerHTML = plan.spots.length
        ? plan.spots.map((s, i) => `
          <div class="result-item">
            <div class="r-name">${UI.esc(s.name)} <span class="star">★ ${s.rating || '-'}</span></div>
            <div class="r-actions"><button data-del="${i}">移除</button></div>
          </div>`).join('')
        : '<p class="hint">備案清單是空的。點下面的按鈕加入室內景點。</p>';
      listBox.querySelectorAll('[data-del]').forEach(b =>
        b.onclick = () => { plan.spots.splice(Number(b.dataset.del), 1); Store.touch(); renderList(); });
    };
    renderList();

    const recBox = document.createElement('div');
    const btnRec = document.createElement('button');
    btnRec.className = 'btn-outline'; btnRec.style.width = '100%'; btnRec.style.marginTop = '10px';
    btnRec.textContent = '🔍 推薦附近室內景點';
    btnRec.onclick = async () => {
      try {
        UI.loading(true, '尋找室內景點…');
        const center = Itin.dayCenter(d) || Itin.startHotel(d) || { lat: 25.04, lng: 121.53 };
        let list = await Api.nearbySearch(center, 'indoor', 5000);
        list = list.filter(p => (p.rating || 0) >= CONFIG.defaults.minRating).slice(0, 8);
        UI.loading(false);
        recBox.innerHTML = list.map((p, i) => `
          <div class="result-item">
            <div class="r-name">${UI.esc(p.name)}</div>
            <div class="r-meta"><span class="star">★ ${p.rating}</span>（${(p.reviews || 0).toLocaleString()} 則）｜約 ${p.distKm ? p.distKm.toFixed(1) : '?'} 公里</div>
            <div class="r-actions"><button class="primary" data-add="${i}">＋ 加入備案</button></div>
          </div>`).join('') || '<p class="hint">附近找不到合適的室內景點</p>';
        recBox.querySelectorAll('[data-add]').forEach(b =>
          b.onclick = () => {
            const p = list[Number(b.dataset.add)];
            if (plan.spots.some(x => x.placeId === p.placeId)) { UI.toast('已在備案清單中'); return; }
            plan.spots.push({ placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, rating: p.rating });
            Store.touch(); renderList(); UI.toast(`已加入「${p.name}」`);
          });
      } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
    };

    // 自訂輸入
    const custom = document.createElement('div');
    custom.className = 'row-add'; custom.style.marginTop = '10px';
    custom.innerHTML = `<input type="text" placeholder="自訂：輸入景點名稱"><button class="btn-small">搜尋加入</button>`;
    const cInp = custom.querySelector('input');
    custom.querySelector('button').onclick = async () => {
      const q = cInp.value.trim();
      if (!q) return;
      try {
        UI.loading(true, '搜尋中…');
        const rs = await Api.searchPlaces(q, 'spot');
        UI.loading(false);
        if (!rs.length) { UI.toast('找不到這個地點'); return; }
        const p = rs[0];
        plan.spots.push({ placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, rating: p.rating });
        cInp.value = '';
        Store.touch(); renderList(); UI.toast(`已加入「${p.name}」`);
      } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
    };

    body.append(listBox, btnRec, recBox, custom);

    const actions = [];
    if (trip().rainActive[d]) actions.push({ label: '↩️ 還原原行程', onClick: () => confirmRestoreRain(d), primary: true });
    else if (!Store.isReadonly()) actions.push({ label: '☔ 套用備案到這天', onClick: () => confirmApplyRain(d), primary: true });
    UI.modal(`第 ${d} 天的雨天備案`, body, actions);
  }

  function confirmApplyRain(d) {
    const t = trip();
    if (!t.rainPlans[d] || !t.rainPlans[d].spots.length) { UI.toast('備案清單還是空的，先加入幾個室內景點吧'); openRainPlan(d); return; }
    UI.confirm('切換為雨天備案？',
      `第 ${d} 天的原行程會先保留，之後隨時可以還原。確定要切換嗎？`, () => {
        t.rainBackup[d] = JSON.parse(JSON.stringify(t.spots.filter(s => s.day === d)));
        t.spots = t.spots.filter(s => s.day !== d);
        t.rainPlans[d].spots.forEach((p, i) => {
          t.spots.push({
            id: Logic.uid(), placeId: p.placeId, name: p.name, address: p.address || '',
            lat: p.lat, lng: p.lng, rating: p.rating || 0,
            stayMin: CONFIG.defaults.stayMin, must: false, note: '', day: d, order: i
          });
        });
        delete t.legsByDay[d];
        t.rainActive[d] = true;
        Store.touch();
        UI.closeModal();
        Itin.render();
        UI.toast(`第 ${d} 天已切換為雨天備案`);
      });
  }

  function confirmRestoreRain(d) {
    const t = trip();
    UI.confirm('還原原行程？', `第 ${d} 天會恢復成切換備案前的行程。`, () => {
      t.spots = t.spots.filter(s => s.day !== d);
      (t.rainBackup[d] || []).forEach(s => t.spots.push(s));
      delete t.rainBackup[d];
      delete t.legsByDay[d];
      t.rainActive[d] = false;
      Store.touch();
      UI.closeModal();
      Itin.render();
      UI.toast(`第 ${d} 天已還原原行程`);
    });
  }

  // ================= 飯店推薦 =================
  async function recommendHotel(d) {
    const t = trip();
    const center = Itin.dayCenter(d);
    if (!center) { UI.alert('先加入景點', '請先把這天的景點加進來，系統才能依景點位置推薦附近飯店。'); return; }
    try {
      UI.loading(true, '尋找附近飯店…');
      let list = await Api.nearbySearch(center, 'lodging', 5000);
      list = list.filter(h => (h.rating || 0) >= CONFIG.defaults.minRating)
        .sort((a, b) => (b.rating - a.rating) || (a.distKm - b.distKm))
        .slice(0, 10);
      UI.loading(false);
      const body = document.createElement('div');
      body.innerHTML = list.length ? list.map((h, i) => `
        <div class="result-item">
          <div class="r-name">${UI.esc(h.name)}</div>
          <div class="r-meta"><span class="star">★ ${h.rating}</span>（${(h.reviews || 0).toLocaleString()} 則）｜約 ${h.distKm ? h.distKm.toFixed(1) : '?'} 公里</div>
          <div class="r-actions">
            <button class="primary" data-i="${i}">選這間</button>
            <a href="${UI.gmapLink(h)}" target="_blank" rel="noopener">📍 地圖</a>
          </div>
        </div>`).join('') : '<p class="hint">附近找不到評分 4.0 以上的飯店，可以改用精靈輸入飯店名稱。</p>';
      body.querySelectorAll('[data-i]').forEach(b =>
        b.onclick = () => {
          const h = list[Number(b.dataset.i)];
          UI.choose(`「${h.name}」要套用到？`, [
            { label: `只有第 ${d} 天這晚`, value: 'one' },
            { label: '整趟旅程每晚都住這間', value: 'all' }
          ], v => {
            const rec = { placeId: h.placeId, name: h.name, address: h.address, rating: h.rating, phone: h.phone || '', lat: h.lat, lng: h.lng };
            const nights = Math.max(Store.days() - 1, 1);
            if (v === 'all') {
              t.hotels = Array.from({ length: nights }, (_, n) => ({ night: n, ...rec }));
            } else {
              t.hotels = t.hotels.filter(x => x.night !== d - 1);
              t.hotels.push({ night: d - 1, ...rec });
            }
            t.legsByDay = {};
            Store.touch();
            UI.closeModal();
            Itin.render();
            UI.toast(`已設定飯店「${h.name}」`);
          });
        });
      UI.modal(`第 ${d} 天附近的推薦飯店`, body, []);
    } catch (e) { UI.loading(false); UI.alert('推薦失敗', e.message); }
  }

  // ================= 美食推薦 =================
  let foodCenters = [];
  function refreshFoodCenters() {
    const t = trip();
    foodCenters = [];
    const sel = $('selFoodCenter');
    if (!t) return;
    for (let d = 1; d <= Store.days(); d++) {
      const c = Itin.dayCenter(d);
      const list = Itin.spotsOfDay(d);
      if (c && list.length) foodCenters.push({ label: `第 ${d} 天景點一帶`, ...c });
    }
    t.spots.forEach(s => foodCenters.push({ label: s.name, lat: s.lat, lng: s.lng }));
    t.hotels.forEach(h => {
      if (!foodCenters.some(c => c.label === '🏨 ' + h.name)) foodCenters.push({ label: '🏨 ' + h.name, lat: h.lat, lng: h.lng });
    });
    sel.innerHTML = foodCenters.length
      ? foodCenters.map((c, i) => `<option value="${i}">${UI.esc(c.label)}</option>`).join('')
      : '<option value="">先加入景點，才能以景點為中心找美食</option>';
  }

  async function searchFood() {
    if (!foodCenters.length) { UI.toast('先在行程頁加入景點吧'); return; }
    const center = foodCenters[Number($('selFoodCenter').value) || 0];
    const radius = Number($('selFoodDist').value);
    const kind = $('inpFoodKind').value.trim();
    try {
      UI.loading(true, '搜尋美食中…');
      let list = await Api.nearbySearch(center, 'restaurant', radius);
      list = list.filter(r => (r.rating || 0) >= CONFIG.defaults.minRating);
      if (kind) list = list.filter(r => (r.name + (r.kind || '')).includes(kind));
      list = list.filter(r => (r.distKm || 0) * 1000 <= radius * 1.2).slice(0, 12);
      UI.loading(false);
      $('foodResults').innerHTML = list.length ? list.map((r, i) => `
        <div class="result-item">
          <div class="r-name">${UI.esc(r.name)}</div>
          <div class="r-meta"><span class="star">★ ${r.rating}</span>（${(r.reviews || 0).toLocaleString()} 則）｜${'$'.repeat(r.price || 1)}｜約 ${(r.distKm * 1000).toFixed(0)} 公尺${r.kind ? '｜' + r.kind : ''}</div>
          <div class="r-actions">
            <a href="${UI.navLink(r)}" target="_blank" rel="noopener">🧭 導航</a>
            ${Store.isReadonly() ? '' : `<button class="primary" data-i="${i}">＋ 加入行程</button>`}
          </div>
        </div>`).join('')
        : `<p class="hint" style="margin-top:10px">這個範圍內找不到符合的餐廳，試著加大距離或換個關鍵字。</p>`;
      $('foodResults').querySelectorAll('[data-i]').forEach(b =>
        b.onclick = () => {
          const r = list[Number(b.dataset.i)];
          const days = Store.days();
          const opts = Array.from({ length: days }, (_, i2) => ({ label: `加到第 ${i2 + 1} 天`, value: i2 + 1 }));
          opts.push({ label: '先放到待排清單', value: 0 });
          UI.choose(`「${r.name}」要加到哪一天？`, opts, v => {
            Itin.addSpot({ ...r }, { day: Number(v) });
            App.switchPage('page-trip');
          });
        });
    } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
  }

  // ================= 分帳 =================
  function initExpense() {
    $('btnAddExp').onclick = addExpense;
    $('btnFoodSearch').onclick = searchFood;
    $('btnCopySettle').onclick = copySettle;
  }

  function renderExpensePage() {
    const t = trip();
    if (!t) return;
    if (!$('expDate').value) $('expDate').value = t.startDate;
    $('expPayer').innerHTML = t.members.map(m => `<option>${UI.esc(m)}</option>`).join('');
    const parts = $('expParts');
    parts.innerHTML = t.members.map(m => `<span class="chip on" data-m="${UI.esc(m)}">${UI.esc(m)}</span>`).join('');
    parts.querySelectorAll('.chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
    // 勾「請客」→ 不用選參與人
    const treat = $('expTreat');
    const syncTreat = () => $('expPartsWrap').style.opacity = treat.checked ? '.35' : '1';
    treat.onchange = syncTreat;
    syncTreat();
    renderExpenseList();
  }

  function addExpense() {
    const t = trip();
    const item = $('expItem').value.trim();
    const amount = Number($('expAmount').value);
    const payer = $('expPayer').value;
    const treat = $('expTreat').checked;
    const participants = treat ? [] : [...$('expParts').querySelectorAll('.chip.on')].map(c => c.dataset.m);
    if (!item) { UI.alert('少了項目名稱', '請輸入這筆支出是什麼，例如「午餐」。'); return; }
    if (!amount || amount <= 0) { UI.alert('金額有誤', '請輸入大於 0 的金額。'); return; }
    if (!treat && !participants.length) { UI.alert('沒有參與人', '請至少勾選一位參與這筆支出的成員。\n（如果是請客，勾選上面的「請客」就不用選人。）'); return; }
    t.expenses.push({
      id: Logic.uid(), date: $('expDate').value || t.startDate,
      item, amount, payer, participants, treat
    });
    $('expItem').value = ''; $('expAmount').value = '';
    $('expTreat').checked = false;
    $('expPartsWrap').style.opacity = '1';
    Store.touch();
    renderExpenseList();
    UI.toast('已記下這筆支出');
  }

  function renderExpenseList() {
    const t = trip();
    const box = $('expList');
    if (!t.expenses.length) {
      box.innerHTML = '<p class="hint">還沒有任何支出</p>';
      $('expSettle').innerHTML = '<p class="hint">加入支出後，這裡會自動算出「誰付給誰多少」</p>';
      $('btnCopySettle').classList.add('hidden');
      return;
    }
    const ro = Store.isReadonly();
    box.innerHTML = [...t.expenses].sort((a, b) => a.date.localeCompare(b.date)).map(e => `
      <div class="exp-item">
        <div class="e-main">
          <div>${UI.esc(e.item)}</div>
          <div class="e-sub">${e.date.slice(5).replace('-', '/')}｜${UI.esc(e.payer)} ${e.treat ? '請客 <span class="treat-badge">🎁 不分帳</span>' : `先付｜${e.participants.length} 人分`}</div>
        </div>
        <span class="exp-amt">$${e.amount.toLocaleString()}</span>
        ${ro ? '' : `<button class="btn-danger-ghost" data-del="${e.id}">✕</button>`}
      </div>`).join('');
    box.querySelectorAll('[data-del]').forEach(b =>
      b.onclick = () => UI.confirm('刪除這筆支出', '確定要刪除嗎？', () => {
        t.expenses = t.expenses.filter(x => x.id !== b.dataset.del);
        Store.touch(); renderExpenseList();
      }));
    renderSettle();
  }

  function renderSettle() {
    const t = trip();
    const r = Logic.settleExpenses(t.expenses, t.members);
    const total = t.expenses.reduce((s, e) => s + e.amount, 0);
    let html = `<p style="margin-bottom:6px">總支出：<b style="color:var(--main)">$${total.toLocaleString()}</b></p>
      <table class="settle-table">
        <tr><th>成員</th><th>已付</th><th>應分攤</th><th>結餘</th></tr>
        ${t.members.map(m => {
          const net = Math.round(r.paid[m] - r.owed[m]);
          return `<tr><td>${UI.esc(m)}</td><td>$${Math.round(r.paid[m]).toLocaleString()}</td>
            <td>$${Math.round(r.owed[m]).toLocaleString()}</td>
            <td style="color:${net >= 0 ? 'var(--ok)' : 'var(--danger)'};font-weight:700">${net >= 0 ? '+' : ''}$${net.toLocaleString()}</td></tr>`;
        }).join('')}
      </table>`;
    if (r.transfers.length) {
      html += `<p style="margin:8px 0 4px;font-weight:700">💸 這樣轉帳最省事（${r.transfers.length} 筆）：</p>` +
        r.transfers.map(tr => `<div class="transfer-line">${UI.esc(tr.from)} ➜ ${UI.esc(tr.to)}<span class="amt">$${tr.amount.toLocaleString()}</span></div>`).join('');
    } else {
      html += `<p class="hint" style="margin-top:8px">目前大家剛好扯平，不需要轉帳 🎉</p>`;
    }
    $('expSettle').innerHTML = html;
    $('btnCopySettle').classList.remove('hidden');
  }

  function copySettle() {
    const t = trip();
    const r = Logic.settleExpenses(t.expenses, t.members);
    const total = t.expenses.reduce((s, e) => s + e.amount, 0);
    let txt = `【${t.name}】分帳結算\n總支出：$${total.toLocaleString()}\n\n`;
    t.members.forEach(m => {
      const net = Math.round(r.paid[m] - r.owed[m]);
      txt += `${m}：已付 $${Math.round(r.paid[m]).toLocaleString()}／應分攤 $${Math.round(r.owed[m]).toLocaleString()}（${net >= 0 ? '應收' : '應付'} $${Math.abs(net).toLocaleString()}）\n`;
    });
    if (r.transfers.length) {
      txt += '\n轉帳方式：\n' + r.transfers.map(tr => `${tr.from} 付給 ${tr.to} $${tr.amount.toLocaleString()}`).join('\n');
    }
    UI.copy(txt, '結算結果已複製，可以貼到群組裡');
  }

  // ================= 分享（雙代碼） =================
  function shareLink(code) {
    const base = location.origin === 'null' || location.protocol === 'file:'
      ? location.href.split('?')[0]
      : location.origin + location.pathname;
    return `${base}?code=${code}`;
  }

  function codesBlock(t) {
    return `
      <p style="margin-bottom:4px"><b>✏️ 編輯代碼</b>（可修改行程，只給要一起排行程的人）</p>
      <div class="code-line"><b>${t.editCode}</b><button data-copy="${t.editCode}">複製代碼</button></div>
      <div class="code-line"><span style="font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shareLink(t.editCode)}</span><button data-copy="${shareLink(t.editCode)}">複製連結</button></div>
      <p style="margin:12px 0 4px"><b>👀 唯讀代碼</b>（只能看、不能改，安心分享）</p>
      <div class="code-line"><b>${t.viewCode}</b><button data-copy="${t.viewCode}">複製代碼</button></div>
      <div class="code-line"><span style="font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shareLink(t.viewCode)}</span><button data-copy="${shareLink(t.viewCode)}">複製連結</button></div>`;
  }

  function bindCopyButtons(root) {
    root.querySelectorAll('[data-copy]').forEach(b =>
      b.onclick = () => UI.copy(b.dataset.copy, '已複製！'));
  }

  function emailBlock(t) {
    const div = document.createElement('div');
    div.innerHTML = `
      <p style="margin:14px 0 4px"><b>📮 把代碼寄到信箱備份</b>（換手機也找得回行程）</p>
      <div class="row-add">
        <input type="email" placeholder="輸入你的 Gmail" value="${UI.esc(t.creatorEmail || '')}">
        <button class="btn-small">寄送</button>
      </div>`;
    const inp = div.querySelector('input');
    div.querySelector('button').onclick = async () => {
      const email = inp.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { UI.toast('Email 格式看起來不對，請再確認'); return; }
      try {
        UI.loading(true, '寄送中…');
        const r = await Api.cloudSendCodes(email, t);
        t.creatorEmail = email;
        Store.touch();
        UI.loading(false);
        UI.toast(r.simulated ? '（模擬模式）正式版上線後會真的寄出唷' : '已寄出！請到信箱收信');
      } catch (e) { UI.loading(false); UI.alert('寄送失敗', e.message); }
    };
    return div;
  }

  function showTripCreated(onDone) {
    const t = trip();
    const body = document.createElement('div');
    body.innerHTML = `
      <p style="margin-bottom:10px">🎉 「${UI.esc(t.name)}」建立成功！<br>
      <b style="color:var(--accent)">請先把代碼存下來</b>，之後在任何裝置輸入代碼就能打開行程。</p>
      ${codesBlock(t)}`;
    body.appendChild(emailBlock(t));
    bindCopyButtons(body);
    UI.modal('行程建立成功', body, [
      { label: '開始規劃 →', primary: true, onClick: () => { UI.closeModal(); onDone && onDone(); } }
    ], { noClose: true });
  }

  function showShare() {
    const t = trip();
    const body = document.createElement('div');
    if (Store.isReadonly()) {
      body.innerHTML = `
        <p style="margin-bottom:4px"><b>👀 唯讀代碼</b>（分享給朋友一起看）</p>
        <div class="code-line"><b>${t.viewCode}</b><button data-copy="${t.viewCode}">複製代碼</button></div>
        <div class="code-line"><span style="font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shareLink(t.viewCode)}</span><button data-copy="${shareLink(t.viewCode)}">複製連結</button></div>
        <p class="hint" style="margin-top:8px">你目前是唯讀模式，看不到編輯代碼。</p>`;
    } else {
      body.innerHTML = codesBlock(t);
      body.appendChild(emailBlock(t));
    }
    bindCopyButtons(body);
    UI.modal('分享行程', body, []);
  }

  return {
    fillWeather, openRainPlan, recommendHotel,
    refreshFoodCenters, renderExpensePage,
    initExpense, showTripCreated, showShare
  };
})();
