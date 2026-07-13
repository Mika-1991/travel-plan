// ============================================================
// 功能模組：天氣穿搭、雨天備案、飯店推薦、美食（每日彈窗）、分帳、分享
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
      if (outfitEl) outfitEl.textContent = Logic.outfitAdvice(w).join('　');
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
    const ro = Store.isReadonly();
    if (!t.rainPlans[d]) {
      if (ro) { UI.toast('這天還沒有雨天備案'); return; }
      t.rainPlans[d] = { spots: [] };
    }
    const plan = t.rainPlans[d];

    const body = document.createElement('div');
    const listBox = document.createElement('div');
    const renderList = () => {
      listBox.innerHTML = plan.spots.length
        ? plan.spots.map((s, i) => `
          <div class="result-item">
            <div class="r-name">${UI.esc(s.name)} <span class="star">★ ${s.rating || '-'}</span></div>
            ${ro ? '' : `<div class="r-actions"><button data-del="${i}">移除</button></div>`}
          </div>`).join('')
        : '<p class="hint">備案清單是空的。點下面的按鈕加入室內景點。</p>';
      listBox.querySelectorAll('[data-del]').forEach(b =>
        b.onclick = () => { plan.spots.splice(Number(b.dataset.del), 1); Store.touch(); renderList(); });
    };
    renderList();

    // 唯讀：只給看清單，不給任何編輯操作
    if (ro) {
      body.appendChild(listBox);
      UI.modal(`第 ${d} 天的雨天備案`, body, []);
      return;
    }

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
          <div class="result-item ${p.photo ? 'with-photo' : ''}">
            ${p.photo ? `<img class="thumb" src="${p.photo}" alt="">` : ''}
            <div class="r-body">
              <div class="r-name">${UI.esc(p.name)}</div>
              <div class="r-meta"><span class="star">★ ${p.rating}</span>（${(p.reviews || 0).toLocaleString()} 則）｜約 ${p.distKm ? p.distKm.toFixed(1) : '?'} 公里</div>
              <div class="r-actions"><button class="primary" data-add="${i}">＋ 加入備案</button></div>
            </div>
          </div>`).join('') || '<p class="hint">附近找不到合適的室內景點</p>';
        recBox.querySelectorAll('[data-add]').forEach(b =>
          b.onclick = () => {
            const p = list[Number(b.dataset.add)];
            if (plan.spots.some(x => x.placeId === p.placeId)) { UI.toast('已在備案清單中'); return; }
            plan.spots.push({ placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, rating: p.rating, photo: p.photo || '' });
            Store.touch(); renderList(); UI.toast(`已加入「${p.name}」`);
          });
      } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
    };

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
        plan.spots.push({ placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, rating: p.rating, photo: p.photo || '' });
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
            lat: p.lat, lng: p.lng, rating: p.rating || 0, photo: p.photo || '',
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
    try {
      let list = [];
      if (center) {
        UI.loading(true, '尋找附近飯店…');
        list = await Api.nearbySearch(center, 'lodging', 5000);
        list = list.filter(h => (h.rating || 0) >= CONFIG.defaults.minRating)
          .sort((a, b) => (b.rating - a.rating) || (a.distKm - b.distKm))
          .slice(0, 10);
        UI.loading(false);
      }
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="card" style="background:var(--white);margin-bottom:12px">
          <label>🔍 搜尋飯店名稱（Google）</label>
          <div class="row-add">
            <input id="recHotelSearchInp" type="text" placeholder="例如：福容大飯店">
            <button id="btnRecHotelSearch" class="btn-small">搜尋</button>
          </div>
          <div class="result-list" id="recHotelSearchRes"></div>
        </div>
        <div class="card" style="background:var(--white);margin-bottom:12px">
          <label>自訂住宿</label>
          <input id="recCustomHotelName" type="text" placeholder="例如：朋友家、親戚家、民宿暫名">
          <input id="recCustomHotelAddress" type="text" placeholder="地址或位置備註，可空白">
          <div class="row-2">
            <input id="recCustomHotelLat" type="number" step="any" placeholder="緯度 DD，可空白">
            <input id="recCustomHotelLng" type="number" step="any" placeholder="經度 DD，可空白">
          </div>
          <p class="hint">座標可空白；未填座標時，住宿路程會顯示無法精準估算。</p>
          <button id="btnRecCustomHotel" class="btn-outline" style="width:100%">使用自訂住宿</button>
        </div>` + (list.length ? list.map((h, i) => `
        <div class="result-item ${h.photo ? 'with-photo' : ''}">
          ${h.photo ? `<img class="thumb" src="${h.photo}" alt="" data-zoom="${i}">` : ''}
          <div class="r-body">
            <div class="r-name">${UI.esc(h.name)}</div>
            <div class="r-meta"><span class="star">★ ${h.rating}</span>（${(h.reviews || 0).toLocaleString()} 則）｜約 ${h.distKm ? h.distKm.toFixed(1) : '?'} 公里</div>
            <div class="r-actions">
              <button class="primary" data-i="${i}">選這間</button>
              <a href="${UI.hotelPriceLink(h.name)}" target="_blank" rel="noopener">💲 查房價</a>
              <a href="${UI.gmapLink(h)}" target="_blank" rel="noopener">📍 地圖</a>
            </div>
          </div>
        </div>`).join('') : `<p class="hint">${center ? '附近找不到評分 4.0 以上的飯店' : '這天沒有可定位的景點，無法推薦附近飯店'}，可以使用上方自訂住宿。</p>`);
      const applyHotel = (rec, mode) => {
        const nights = Math.max(Store.days() - 1, 1);
        if (mode === 'all') {
          t.hotels = Array.from({ length: nights }, (_, n) => ({ night: n, ...rec }));
        } else {
          t.hotels = t.hotels.filter(x => Number(x.night) !== d - 1);
          t.hotels.push({ night: d - 1, ...rec });
        }
        t.legsByDay = {};
        Store.touch({ manual: true });
        UI.closeModal();
        Itin.render();
        UI.toast(`已設定住宿「${rec.name}」`);
      };
      // Google 名稱搜尋（刪除住宿後也能隨時搜尋加回）
      const doHotelSearch = async () => {
        const q = body.querySelector('#recHotelSearchInp').value.trim();
        if (!q) { UI.toast('請先輸入飯店名稱'); return; }
        try {
          UI.loading(true, '搜尋飯店中…');
          const rs = await Api.searchPlaces(q, 'hotel');
          UI.loading(false);
          const res = body.querySelector('#recHotelSearchRes');
          res.innerHTML = rs.length ? rs.slice(0, 6).map((h, i) => `
            <div class="result-item ${h.photo ? 'with-photo' : ''}">
              ${h.photo ? `<img class="thumb" src="${h.photo}" alt="">` : ''}
              <div class="r-body">
                <div class="r-name">${UI.esc(h.name)}</div>
                <div class="r-meta">${UI.esc(h.address || '')}｜<span class="star">★ ${h.rating || '-'}</span></div>
                <div class="r-actions">
                  <button class="primary" data-si="${i}">選這間</button>
                  <a href="${UI.hotelPriceLink(h.name)}" target="_blank" rel="noopener">💲 查房價</a>
                </div>
              </div>
            </div>`).join('') : '<p class="hint">找不到這個飯店，請換個關鍵字，或改用下方自訂住宿。</p>';
          res.querySelectorAll('[data-si]').forEach(b =>
            b.onclick = () => {
              const h = rs[Number(b.dataset.si)];
              UI.choose(`「${h.name}」要套用到？`, [
                { label: `只有第 ${d} 天這晚`, value: 'one' },
                { label: '整趟旅程每晚都住這間', value: 'all' }
              ], v => applyHotel({ source: 'google', placeId: h.placeId, name: h.name, address: h.address, rating: h.rating, phone: h.phone || '', lat: h.lat, lng: h.lng, hasCoords: true, note: '', pay: '', photo: h.photo || '' }, v));
            });
        } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
      };
      body.querySelector('#btnRecHotelSearch').onclick = doHotelSearch;
      body.querySelector('#recHotelSearchInp').addEventListener('keydown', e => { if (e.key === 'Enter') doHotelSearch(); });

      body.querySelector('#btnRecCustomHotel').onclick = async () => {
        const name = body.querySelector('#recCustomHotelName').value.trim();
        const address = body.querySelector('#recCustomHotelAddress').value.trim();
        const latRaw = body.querySelector('#recCustomHotelLat').value.trim();
        const lngRaw = body.querySelector('#recCustomHotelLng').value.trim();
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
        const rec = {
          source: 'custom', placeId: 'custom-hotel-' + Logic.uid(), name, address,
          rating: 0, phone: '', lat, lng, hasCoords: located,
          estimateWarning: located ? '' : '沒有座標，住宿路程無法精準估算',
          note: '', pay: '', photo: ''
        };
        UI.choose(`「${name}」要套用到？`, [
          { label: `只有第 ${d} 天這晚`, value: 'one' },
          { label: '整趟旅程每晚都住這裡', value: 'all' }
        ], v => applyHotel(rec, v));
      };
      body.querySelectorAll('[data-zoom]').forEach(img =>
        img.onclick = () => UI.photoZoom(list[Number(img.dataset.zoom)].photo, list[Number(img.dataset.zoom)].name));
      body.querySelectorAll('[data-i]').forEach(b =>
        b.onclick = () => {
          const h = list[Number(b.dataset.i)];
          UI.choose(`「${h.name}」要套用到？`, [
            { label: `只有第 ${d} 天這晚`, value: 'one' },
            { label: '整趟旅程每晚都住這間', value: 'all' }
          ], v => {
            const rec = { source: 'google', placeId: h.placeId, name: h.name, address: h.address, rating: h.rating, phone: h.phone || '', lat: h.lat, lng: h.lng, hasCoords: true, note: '', pay: '', photo: h.photo || '' };
            applyHotel(rec, v);
          });
        });
      UI.modal(`第 ${d} 天附近的推薦飯店`, body, []);
    } catch (e) { UI.loading(false); UI.alert('推薦失敗', e.message); }
  }

  // ================= 旅遊日期／天數變更 =================
  function editTripDates() {
    const t = trip();
    if (Store.isReadonly()) { UI.toast('唯讀模式無法修改'); return; }
    const body = document.createElement('div');
    body.innerHTML = `
      <label>旅遊日期（改日期就能新增或刪除天數）</label>
      <div class="row-2">
        <input id="tdStart" type="date" value="${t.startDate}">
        <input id="tdEnd" type="date" value="${t.endDate}">
      </div>
      <p class="hint" id="tdHint"></p>
      <p class="hint">天數變少時：超出天數的景點會移到最後一天、超出的住宿會移除（會先告訴你）。</p>`;
    const upd = () => {
      const s = body.querySelector('#tdStart').value, e = body.querySelector('#tdEnd').value;
      if (s && e && e >= s) {
        const n = Logic.datesBetween(s, e).length;
        body.querySelector('#tdHint').textContent = `共 ${n} 天 ${n - 1} 夜（目前 ${Store.days()} 天）`;
      } else body.querySelector('#tdHint').textContent = '';
    };
    body.querySelector('#tdStart').addEventListener('change', upd);
    body.querySelector('#tdEnd').addEventListener('change', upd);
    upd();
    UI.modal('🗓️ 變更旅遊天數', body, [{
      label: '套用', primary: true,
      onClick: () => {
        const s = body.querySelector('#tdStart').value, e = body.querySelector('#tdEnd').value;
        if (!s || !e) { UI.toast('請選擇開始與結束日期'); return; }
        if (e < s) { UI.toast('結束日期不能早於開始日期'); return; }
        const newDays = Logic.datesBetween(s, e).length;
        const maxNight = Math.max(newDays - 1, 1);
        const movedSpots = t.spots.filter(sp => sp.day > newDays);
        const removedHotels = t.hotels.filter(h => h.night >= maxNight);
        const apply = () => {
          t.startDate = s; t.endDate = e;
          movedSpots.forEach(sp => { sp.day = newDays; });
          t.hotels = t.hotels.filter(h => h.night < maxNight);
          // 清掉超出天數的每日設定
          [t.dayStartOv, t.dayEndOv, t.dayTransportOv, t.rainPlans, t.rainActive, t.rainBackup].forEach(obj => {
            if (obj) Object.keys(obj).forEach(k => { if (Number(k) > newDays) delete obj[k]; });
          });
          t.legsByDay = {};
          Store.touch({ manual: true });
          UI.closeModal();
          Itin.render();
          UI.toast(`已改為 ${newDays} 天，時間重新計算`);
        };
        if (movedSpots.length || removedHotels.length) {
          UI.confirm('天數變少了，要繼續嗎？',
            (movedSpots.length ? `這些景點會移到第 ${newDays} 天：\n${movedSpots.map(x => '・' + x.name).join('\n')}\n\n` : '') +
            (removedHotels.length ? `這些住宿會被移除：\n${removedHotels.map(x => `・第 ${x.night + 1} 晚 ${x.name}`).join('\n')}\n\n` : '') +
            '（可用「上一步」復原）', apply);
        } else apply();
      }
    }]);
  }

  // ================= 集合出發地 / 解散地（行程內隨時可調） =================
  function openRoutePoints() {
    const t = trip();
    if (Store.isReadonly()) { UI.toast('唯讀模式無法修改'); return; }
    const body = document.createElement('div');

    const section = (field, icon, title, hint) => {
      const box = document.createElement('div');
      box.style.marginBottom = '14px';
      const renderState = () => {
        box.innerHTML = `
          <label>${icon} ${title}</label>
          <div class="chips" data-chip></div>
          <div class="row-add">
            <input type="text" placeholder="${hint}">
            <button class="btn-small">搜尋</button>
          </div>
          <div class="result-list" data-res></div>`;
        const chipBox = box.querySelector('[data-chip]');
        chipBox.innerHTML = t[field]
          ? `<span class="chip on">${icon} ${UI.esc(t[field].name)} <span class="x">✕</span></span>`
          : `<span class="hint">未設定（用飯店當起終點）</span>`;
        const x = chipBox.querySelector('.x');
        if (x) x.onclick = () => { t[field] = null; applyChange(); renderState(); };
        const inp = box.querySelector('input');
        const search = async () => {
          const q = inp.value.trim();
          if (!q) { UI.toast('請先輸入地點名稱'); return; }
          try {
            UI.loading(true, '搜尋地點中…');
            const rs = await Api.searchPlaces(q, 'spot');
            UI.loading(false);
            const res = box.querySelector('[data-res]');
            res.innerHTML = rs.length ? rs.slice(0, 5).map((p, i) => `
              <div class="result-item">
                <div class="r-name">${UI.esc(p.name)}</div>
                <div class="r-meta">${UI.esc(p.address || '')}</div>
                <div class="r-actions"><button class="primary" data-i="${i}">選這裡</button></div>
              </div>`).join('') : '<p class="hint">找不到這個地點，請換個關鍵字。</p>';
            res.querySelectorAll('button[data-i]').forEach(b =>
              b.onclick = () => {
                const p = rs[Number(b.dataset.i)];
                t[field] = { placeId: p.placeId, name: p.name, address: p.address || '', lat: p.lat, lng: p.lng };
                applyChange();
                renderState();
              });
          } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
        };
        box.querySelector('.btn-small').onclick = search;
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      };
      renderState();
      return box;
    };

    function applyChange() {
      delete t.legsByDay[1];
      delete t.legsByDay[Store.days()];
      Store.touch();
      Itin.render();
      UI.toast('起終點已更新，車程時間重新計算');
    }

    body.appendChild(section('meetPoint', '🚩', '集合出發地（第一天從這裡出發）', '例如：台中火車站'));
    body.appendChild(section('endPoint', '🏁', '解散地（最後一天在這裡結束）', '例如：台中火車站'));
    UI.modal('集合地／解散地', body, []);
  }

  // ================= 附近美食（每日彈窗，直接加進該天） =================
  function foodRadiusByMinutes(min, mode) {
    const metersPerMin = mode === 'walking' ? 85 : mode === 'transit' ? 520 : 800;
    return Math.min(50000, Math.max(1200, min * metersPerMin));
  }
  // 加入美食時自動猜餐別（午→晚→早→點心；使用者可在「📝 備註」改）
  function guessMeal(d) {
    const have = Itin.spotsOfDay(d).map(s => s.meal).filter(Boolean);
    if (!have.includes('lunch')) return 'lunch';
    if (!have.includes('dinner')) return 'dinner';
    if (!have.includes('breakfast')) return 'breakfast';
    return 'snack';
  }
  function addFoodSpot(p, d) {
    const ok = Itin.addSpot({
      ...p,
      source: p.source || 'restaurant',
      placeId: p.placeId || ('custom-food-' + Logic.uid()),
      rating: p.rating || 0,
      photo: p.photo || '',
      meal: p.meal || guessMeal(d),
      note: p.note || '美食'
    }, { day: d });
    if (ok !== false) UI.toast(`已加入第 ${d} 天：「${p.name}」`);
  }
  function openFood(d) {
    const t = trip();
    // 中心點選項：該天景點一帶、該天各景點、飯店
    const centers = [];
    const c = Itin.dayCenter(d);
    if (c && Itin.spotsOfDay(d).length) centers.push({ label: `第 ${d} 天景點一帶`, ...c });
    Itin.spotsOfDay(d).filter(Logic.hasCoords).forEach(s => centers.push({ label: s.name, lat: s.lat, lng: s.lng }));
    const sh = Itin.startHotel(d);
    if (Logic.hasCoords(sh)) centers.push({ label: '🏨 ' + sh.name, lat: sh.lat, lng: sh.lng });
    const eh = Itin.endHotel(d);
    if (Logic.hasCoords(eh) && !centers.some(x => x.lat === eh.lat && x.lng === eh.lng)) {
      centers.push({ label: '🏨 ' + eh.name, lat: eh.lat, lng: eh.lng });
    }

    const body = document.createElement('div');
    body.innerHTML = `
      ${centers.length ? '' : `<div class="rain-alert" style="margin-bottom:10px">這天沒有可定位的景點或住宿；可先用下方「自訂餐廳」輸入地址加入路線。</div>`}
      <label>以哪裡為中心？</label>
      <select id="foodCenter" ${centers.length ? '' : 'disabled'}>${centers.map((x, i) => `<option value="${i}">${UI.esc(x.label)}</option>`).join('')}</select>
      <div class="row-2">
        <div>
          <label>路程時間上限</label>
          <select id="foodMaxMin" ${centers.length ? '' : 'disabled'}>
            <option value="15">15 分鐘內</option>
            <option value="30" selected>30 分鐘內</option>
            <option value="45">45 分鐘內</option>
            <option value="60">1 小時內</option>
            <option value="0">不設限</option>
          </select>
        </div>
        <div>
          <label>想吃什麼？（品項或餐廳名稱，可留空）</label>
          <input id="foodKind" type="text" placeholder="例如：牛肉麵、咖啡、阿霞飯店" ${centers.length ? '' : 'disabled'}>
        </div>
      </div>
      <button id="foodGo" class="btn-primary" style="width:100%" ${centers.length ? '' : 'disabled'}>找美食</button>
      <div class="result-list" id="foodRes"></div>`;

    const custom = document.createElement('div');
    custom.className = 'card';
    custom.style.background = 'var(--white)';
    custom.style.marginTop = '12px';
    custom.innerHTML = `
      <details class="collapse">
        <summary>➕ 自訂餐廳（找不到才用，點開）</summary>
        <div style="margin-top:10px">
          <input id="customFoodName" type="text" placeholder="餐廳名稱，例如：阿霞飯店">
          <input id="customFoodAddr" type="text" placeholder="餐廳地址，會用 Google 定位後加入路線">
          <div class="row-2" style="margin-top:8px">
            <button id="btnCustomFoodMap" class="btn-outline" type="button">Google 搜尋</button>
            <button id="btnCustomFoodAdd" class="btn-primary" type="button">定位並加到第 ${d} 天</button>
          </div>
          <p class="hint">自訂餐廳一定要填地址；定位成功後才會參與一鍵最佳路線。</p>
        </div>
      </details>`;
    body.appendChild(custom);

    const dMode = Itin.dayTransportOf(d);
    body.querySelector('#foodGo').onclick = async () => {
      const center = centers[Number(body.querySelector('#foodCenter').value) || 0];
      const rawMaxMin = Number(body.querySelector('#foodMaxMin').value);
      const noLimit = rawMaxMin === 0;
      const maxMin = noLimit ? Infinity : Math.min(60, rawMaxMin || 30);
      const radius = foodRadiusByMinutes(maxMin, dMode);
      const kind = body.querySelector('#foodKind').value.trim();
      const res = body.querySelector('#foodRes');
      try {
        UI.loading(true, '搜尋美食與路程時間…');
        let list = kind ? await Api.searchFood(kind, center, radius) : await Api.nearbySearch(center, 'restaurant', radius);
        if (!kind) list = list.filter(r => (r.rating || 0) >= CONFIG.defaults.minRating);
        list = list.filter(Logic.hasCoords).slice(0, 18);
        const timed = [];
        for (const r of list) {
          const travelMin = await Api.travelTime(center, r, dMode);
          if (travelMin !== null && (noLimit || travelMin <= maxMin)) timed.push({ ...r, travelMin });
        }
        list = timed.sort((a, b) => (a.travelMin - b.travelMin) || ((b.rating || 0) - (a.rating || 0))).slice(0, 12);
        UI.loading(false);
        res.innerHTML = list.length ? list.map((r, i) => `
          <div class="result-item ${r.photo ? 'with-photo' : ''}">
            ${r.photo ? `<img class="thumb" src="${r.photo}" alt="" data-zoom="${i}">` : ''}
            <div class="r-body">
              <div class="r-name">${UI.esc(r.name)}</div>
              <div class="r-meta"><span class="star">★ ${r.rating}</span>（${(r.reviews || 0).toLocaleString()} 則）｜路程約 ${Logic.fmtDur(r.travelMin)}｜直線約 ${r.distKm ? r.distKm.toFixed(1) : '?'} 公里${r.kind ? '｜' + r.kind : ''}</div>
              <div class="r-hours" data-hours-i="${i}">🕒 查營業時間…</div>
              <div class="r-actions">
                <a href="${UI.gmapLink(r)}" target="_blank" rel="noopener">📍 Google</a>
                <a href="${UI.navLink(r)}" target="_blank" rel="noopener">🧭 導航</a>
                ${Store.isReadonly() ? '' : `<button class="primary" data-i="${i}">＋ 加到第 ${d} 天</button>`}
              </div>
            </div>
          </div>`).join('')
          : `<p class="hint" style="margin-top:10px">${noLimit ? '找不到符合的餐廳，請換關鍵字。' : `${Logic.fmtDur(maxMin)}內找不到符合餐廳，請改成不設限或換關鍵字。`}</p>`;
        UI.fillResultHours(res, list);
        res.querySelectorAll('[data-zoom]').forEach(img =>
          img.onclick = () => UI.photoZoom(list[Number(img.dataset.zoom)].photo, list[Number(img.dataset.zoom)].name));
        res.querySelectorAll('button[data-i]').forEach(b =>
          b.onclick = () => {
            if (b.disabled) return;
            addFoodSpot(list[Number(b.dataset.i)], d);
            b.textContent = '已加入 ✓';
            b.disabled = true;
            UI.toast('已加入！可繼續加其他家，按「關閉」結束');
          });
      } catch (e) { UI.loading(false); UI.alert('搜尋失敗', e.message); }
    };
    body.querySelector('#foodKind')?.addEventListener('keydown', e => { if (e.key === 'Enter') body.querySelector('#foodGo').click(); });
    body.querySelector('#btnCustomFoodMap').onclick = () => {
      const name = body.querySelector('#customFoodName').value.trim();
      const address = body.querySelector('#customFoodAddr').value.trim();
      if (!name && !address) { UI.toast('請先輸入餐廳名稱或地址'); return; }
      window.open(UI.gmapLink({ name, address }), '_blank', 'noopener');
    };
    body.querySelector('#btnCustomFoodAdd').onclick = async () => {
      const name = body.querySelector('#customFoodName').value.trim();
      const address = body.querySelector('#customFoodAddr').value.trim();
      if (!name) { UI.toast('請輸入餐廳名稱'); return; }
      if (!address) { UI.toast('請輸入餐廳地址，才能定位加入路線'); return; }
      try {
        UI.loading(true, '用地址定位餐廳…');
        const geo = await Api.geocodeAddress(address);
        UI.loading(false);
        if (!geo) { UI.toast('地址定位失敗，請先按 Google 搜尋確認地址'); return; }
        addFoodSpot({
          source: 'custom-food',
          placeId: 'custom-food-' + Logic.uid(),
          name, address, lat: geo.lat, lng: geo.lng,
          rating: 0, photo: '', note: '自訂美食'
        }, d);
        UI.closeModal();
      } catch (e) { UI.loading(false); UI.alert('定位失敗', e.message); }
    };
    UI.modal(`第 ${d} 天附近美食`, body, []);
  }

  // ================= 分帳 =================
  function initExpense() {
    $('btnAddExp').onclick = addExpense;
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
    // 快速選項：常用項目 + 已訂飯店名稱
    const quick = ['早餐', '午餐', '晚餐', '點心', '交通', '門票'];
    [...new Set(t.hotels.map(h => h.name))].forEach(n => quick.push(n + ' 房費'));
    $('expQuick').innerHTML = quick.map(q => `<span class="chip" style="cursor:pointer">${UI.esc(q)}</span>`).join('');
    $('expQuick').querySelectorAll('.chip').forEach(c =>
      c.onclick = () => { $('expItem').value = c.textContent; $('expAmount').focus(); });
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

  // 快速記帳（從景點/飯店帶入名稱與日期）
  function quickExpense(preset) {
    const t = trip();
    if (Store.isReadonly()) { UI.toast('唯讀模式無法記帳'); return; }
    const body = document.createElement('div');
    body.innerHTML = `
      <label>項目</label>
      <input id="qeItem" type="text" maxlength="30" value="${UI.esc(preset.item || '')}">
      <div class="row-2">
        <div><label>日期</label><input id="qeDate" type="date" value="${preset.date || t.startDate}"></div>
        <div><label>金額</label><input id="qeAmt" type="number" min="1" inputmode="numeric" placeholder="金額"></div>
      </div>
      <label>誰先付的？</label>
      <select id="qePayer">${t.members.map(m => `<option>${UI.esc(m)}</option>`).join('')}</select>
      <label class="check-row" style="margin:4px 0 8px"><input type="checkbox" id="qeTreat"> 🎁 這筆是請客，不用分帳</label>
      <div id="qePartsWrap">
        <label>誰參與（預設全員）</label>
        <div class="chips" id="qeParts">${t.members.map(m => `<span class="chip on" data-m="${UI.esc(m)}">${UI.esc(m)}</span>`).join('')}</div>
      </div>`;
    body.querySelectorAll('#qeParts .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
    body.querySelector('#qeTreat').onchange = e =>
      body.querySelector('#qePartsWrap').style.opacity = e.target.checked ? '.35' : '1';
    UI.modal('💰 記一筆帳', body, [{
      label: '記下來', primary: true,
      onClick: () => {
        const item = body.querySelector('#qeItem').value.trim();
        const amount = Number(body.querySelector('#qeAmt').value);
        const treat = body.querySelector('#qeTreat').checked;
        const participants = treat ? [] : [...body.querySelectorAll('#qeParts .chip.on')].map(c => c.dataset.m);
        if (!item) { UI.toast('請輸入項目名稱'); return; }
        if (!amount || amount <= 0) { UI.toast('請輸入大於 0 的金額'); return; }
        if (!treat && !participants.length) { UI.toast('請至少選一位參與人，或勾「請客」'); return; }
        t.expenses.push({
          id: Logic.uid(), date: body.querySelector('#qeDate').value || t.startDate,
          item, amount, payer: body.querySelector('#qePayer').value, participants, treat
        });
        Store.touch();
        UI.closeModal();
        UI.toast(`已記到分帳：「${item}」$${amount.toLocaleString()}`);
      }
    }]);
    setTimeout(() => body.querySelector('#qeAmt').focus(), 50);
  }

  function editExpense(expenseId) {
    const t = trip();
    const e = t.expenses.find(x => x.id === expenseId);
    if (!e) { UI.toast('找不到這筆支出'); return; }
    const body = document.createElement('div');
    body.innerHTML = `
      <label>項目</label>
      <input id="editExpItem" type="text" maxlength="30" value="${UI.esc(e.item || '')}">
      <div class="row-2">
        <div><label>日期</label><input id="editExpDate" type="date" value="${e.date || t.startDate}"></div>
        <div><label>金額</label><input id="editExpAmount" type="number" min="1" inputmode="numeric" value="${Number(e.amount) || ''}"></div>
      </div>
      <label>誰先付的？</label>
      <select id="editExpPayer">${t.members.map(m => `<option ${e.payer === m ? 'selected' : ''}>${UI.esc(m)}</option>`).join('')}</select>
      <label class="check-row" style="margin:4px 0 8px"><input type="checkbox" id="editExpTreat" ${e.treat ? 'checked' : ''}> 🎁 這筆是請客，不用分帳</label>
      <div id="editExpPartsWrap">
        <label>誰參與</label>
        <div class="chips" id="editExpParts">${t.members.map(m => {
          const on = e.treat || !e.participants?.length || e.participants.includes(m);
          return `<span class="chip ${on ? 'on' : ''}" data-m="${UI.esc(m)}">${UI.esc(m)}</span>`;
        }).join('')}</div>
      </div>`;
    body.querySelectorAll('#editExpParts .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
    const treat = body.querySelector('#editExpTreat');
    const partsWrap = body.querySelector('#editExpPartsWrap');
    const syncTreat = () => { partsWrap.style.opacity = treat.checked ? '.35' : '1'; };
    treat.onchange = syncTreat;
    syncTreat();
    UI.modal('編輯支出', body, [{
      label: '儲存修改', primary: true,
      onClick: () => {
        const item = body.querySelector('#editExpItem').value.trim();
        const amount = Number(body.querySelector('#editExpAmount').value);
        const isTreat = body.querySelector('#editExpTreat').checked;
        const participants = isTreat ? [] : [...body.querySelectorAll('#editExpParts .chip.on')].map(c => c.dataset.m);
        if (!item) { UI.toast('請輸入項目名稱'); return; }
        if (!amount || amount <= 0) { UI.toast('請輸入大於 0 的金額'); return; }
        if (!isTreat && !participants.length) { UI.toast('請至少選一位參與人，或勾「請客」'); return; }
        e.item = item;
        e.date = body.querySelector('#editExpDate').value || t.startDate;
        e.amount = amount;
        e.payer = body.querySelector('#editExpPayer').value;
        e.treat = isTreat;
        e.participants = participants;
        Store.touch();
        UI.closeModal();
        renderExpenseList();
        UI.toast('支出已更新');
      }
    }]);
  }

  function renderExpenseList() {
    const t = trip();
    const box = $('expList');
    if (!t.expenses.length) {
      box.innerHTML = '<p class="hint">還沒有任何支出。小技巧：行程頁景點的 ⋯ 選單可以直接「記一筆帳」。</p>';
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
        ${ro ? '' : `<button class="btn-outline mini-action" data-edit="${e.id}">✎</button><button class="btn-danger-ghost mini-action" data-del="${e.id}">✕</button>`}
      </div>`).join('');
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editExpense(b.dataset.edit));
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

  // ================= 下載資源 =================
  // 依「分裝袋」分類整理（貼身防盜包／隨身包／託運…），出國旅遊通用版
  const packingTemplate = [
    { cat: '🛂 重要證件（貼身防盜包）', items: ['護照（效期 6 個月以上）', '身分證／健保卡', '國內外駕照（自駕用）', '機票／電子登機證', '簽證／ESTA（如需要）', '旅遊保險投保證明（英文）', '訂房與票券憑證（紙本＋截圖）', '大頭照數張（備用）', '緊急聯絡人與住宿地址清單'] },
    { cat: '💳 錢包', items: ['信用卡（2 張以上分開放）', '當地現金與零錢', '台幣現鈔', '悠遊卡／交通卡'] },
    { cat: '🔌 3C 電子（隨身包）', items: ['手機', '充電線＋充電器', '行動電源（隨身，不可託運）', '萬用轉接插頭', '延長線', '相機＋電池＋記憶卡', '耳機／無線耳機', '車用手機架（自駕用）'] },
    { cat: '📱 手機 App（出發前先裝好）', items: ['離線地圖／導航', '訂房 App（Booking／Airbnb）', '叫車 App（Uber 等）', '當地大眾運輸／票務 App', '翻譯 App', '航空公司 App（線上 Check-in）'] },
    { cat: '👕 一般衣物', items: ['上衣', '褲子／裙子', '外套／防風外套', '羽絨／保暖衣（看天氣）', '正式服裝（拍照／餐廳）', '睡衣'] },
    { cat: '🩲 貼身衣物', items: ['內衣褲', '免洗內褲', '襪子', '泳衣（溫泉／泳池）'] },
    { cat: '🧴 盥洗保養', items: ['牙刷牙膏', '洗面乳', '洗髮精／潤髮乳', '沐浴乳', '身體乳液', '卸妝用品', '化妝棉／棉花棒', '毛巾／浴巾', '梳子'] },
    { cat: '💄 化妝／防曬', items: ['防曬乳', '隔離／底妝', '護唇膏', '凡士林（乾燥氣候）', '面膜', '個人彩妝'] },
    { cat: '💊 藥品包', items: ['個人常用藥', '感冒藥', '止痛藥（普拿疼）', '暈車藥', '腸胃藥', '過敏藥', 'OK 繃／外傷藥', '眼藥水／人工淚液', '防蚊液'] },
    { cat: '🧻 衛生用品', items: ['衛生棉／棉條', '面紙／濕紙巾', '口罩', '環保餐具', '牙線', '乾洗手'] },
    { cat: '🧳 生活用品', items: ['洗衣粉／洗衣片', '衣架／曬衣夾', '真空壓縮袋', '密封夾鏈袋（分裝／防水）', '小型行李秤', '折疊購物袋／行李袋', '剪刀／指甲刀（託運）', '針線包'] },
    { cat: '✈️ 機上好眠包', items: ['頸枕', '眼罩', '耳塞', '拖鞋', '保濕（護唇膏／乳液）', '薄外套／圍巾'] },
    { cat: '🌦️ 雨天／保暖', items: ['摺疊傘／晴雨傘', '輕便雨衣', '帽子／登山帽', '圍巾／手套', '厚襪／褲襪'] },
    { cat: '🎒 其他常用', items: ['保溫瓶／水壺', '太陽眼鏡', '自拍腳架', '暖暖包', '小零食', '空塑膠袋／橡皮筋'] },
    { cat: '👶 親子／長輩（視需要）', items: ['奶粉／副食品', '尿布／濕紙巾', '兒童常用藥', '推車／揹巾', '安撫玩具', '長輩慢性病藥（足量）'] }
  ];

  const xmlEsc = v => String(v ?? '').replace(/[<>&"']/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const textEsc = v => UI.esc(v ?? '');
  const dateLabel = iso => iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '';
  const transportLabel = v => ({ driving: '開車', transit: '大眾運輸', walking: '走路' }[v] || v || '');
  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    downloadBlob(filename, blob);
  }
  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const MEAL_LABELS = { breakfast: '🍳 早餐', lunch: '🍜 午餐', dinner: '🍽 晚餐', snack: '🍡 點心' };
  const dayTransportText = d => ({ driving: '🚗 開車', transit: '🚇 大眾運輸', walking: '🚶 走路' }[Itin.dayTransportOf(d)] || '');
  function dayRows(d) {
    const t = trip();
    const rows = [];
    const list = Itin.spotsOfDay(d);
    const sp = Itin.startHotel(d);
    const ep = Itin.endHotel(d);
    const legs = Itin.legsForDay(d);
    const mode = dayTransportText(d);
    const legName = min => `${mode}｜車程約 ${Logic.fmtDur(min)}`;
    if (d === 1 && t.meetPoint) rows.push({ type: '集合地', name: t.meetPoint.name, address: t.meetPoint.address || '', note: '', photo: t.meetPoint.photo || '' });
    else if (sp) rows.push({ type: '住宿出發', name: sp.name, address: sp.address || '', note: '', photo: sp.photo || '' });
    const shouldShowEmptyLeg = !list.length && sp && ep && sp !== ep && legs[0] > 0 &&
      ((d === 1 && t.meetPoint) || (d === Store.days() && t.endPoint));
    if (shouldShowEmptyLeg) rows.push({ type: '路程', name: legName(legs[0]), address: '', note: '' });
    list.forEach((s, i) => {
      if (legs[i] > 0) rows.push({ type: '路程', name: legName(legs[i]), address: '', note: '' });
      const mealLbl = MEAL_LABELS[s.meal];
      const rowType = mealLbl || (s.source === 'restaurant' || s.source === 'custom-food' ? '美食' : '景點');
      rows.push({ type: rowType, name: s.name, address: s.address || '', note: s.note || '', photo: s.photo || '' });
    });
    if (list.length && ep) {
      if (legs[list.length] > 0) rows.push({ type: '路程', name: legName(legs[list.length]), address: '', note: '' });
      rows.push({ type: ep === t.endPoint ? '解散地' : '住宿', name: ep.name, address: ep.address || '', note: ep.note || '', photo: ep.photo || '' });
    } else if (!list.length && ep && ep !== sp) {
      rows.push({ type: ep === t.endPoint ? '解散地' : '住宿', name: ep.name, address: ep.address || '', note: ep.note || '', photo: ep.photo || '' });
    }
    return rows;
  }
  function sheetXml(name, rows) {
    const body = rows.map(row => `<Row>${row.map(v =>
      `<Cell><Data ss:Type="${typeof v === 'number' ? 'Number' : 'String'}">${xmlEsc(v)}</Data></Cell>`).join('')}</Row>`).join('');
    return `<Worksheet ss:Name="${xmlEsc(name)}"><Table>${body}</Table></Worksheet>`;
  }
  function excelWorkbook() {
    const t = trip();
    const days = Store.days();
    const overview = [
      ['項目', '內容'],
      ['行程名稱', t.name],
      ['日期', `${t.startDate} ~ ${t.endDate}`],
      ['天數', `${days} 天 ${Math.max(days - 1, 0)} 夜`],
      ['交通方式', transportLabel(t.transport)],
      ['每日時間', `${t.dayStart} ~ ${t.dayEnd}`],
      ['建立者 Email', t.creatorEmail || '']
    ];
    const itinerary = [['天數', '日期', '類型', '名稱', '地址', '備註']];
    for (let d = 1; d <= days; d++) {
      dayRows(d).forEach(r => itinerary.push([`第 ${d} 天`, Store.dateOfDay(d), r.type, r.name, r.address, r.note]));
    }
    const hotels = [['晚別', '名稱', '地址', '付款狀態', '備註', '平日價', '假日價']];
    (t.hotels || []).sort((a, b) => Number(a.night) - Number(b.night)).forEach(h =>
      hotels.push([`第 ${Number(h.night) + 1} 晚`, h.name, h.address || '', UI.PAY_LABELS[h.pay] || '', h.note || '', h.priceWeekday || '', h.priceWeekend || '']));
    const spots = [['天數', '順序', '名稱', '地址', '停留分鐘', '必去', '備註']];
    (t.spots || []).sort((a, b) => (a.day || 0) - (b.day || 0) || (a.order || 0) - (b.order || 0)).forEach(s =>
      spots.push([s.day ? `第 ${s.day} 天` : '未排', Number(s.order) + 1, s.name, s.address || '', s.stayMin || '', s.must ? '是' : '', s.note || '']));
    const expenses = [['日期', '項目', '金額', '付款人', '請客', '參與人']];
    (t.expenses || []).forEach(e => expenses.push([e.date, e.item, Number(e.amount) || 0, e.payer, e.treat ? '是' : '', (e.participants || []).join('、')]));
    const settle = [['成員', '已付', '應分攤', '結餘']];
    const sr = Logic.settleExpenses(t.expenses || [], t.members || []);
    (t.members || []).forEach(m => settle.push([m, Math.round(sr.paid[m] || 0), Math.round(sr.owed[m] || 0), Math.round((sr.paid[m] || 0) - (sr.owed[m] || 0))]));
    settle.push([]);
    settle.push(['轉出人', '收款人', '金額']);
    sr.transfers.forEach(x => settle.push([x.from, x.to, x.amount]));
    const packing = [['分類', '物品', '已準備']];
    packingTemplate.forEach(g => g.items.forEach(i => packing.push([g.cat, i, '□'])));
    return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheetXml('行程總覽', overview)}
${sheetXml('每日行程', itinerary)}
${sheetXml('住宿資訊', hotels)}
${sheetXml('景點清單', spots)}
${sheetXml('支出明細', expenses)}
${sheetXml('分帳結算', settle)}
${sheetXml('攜帶清單', packing)}
</Workbook>`;
  }
  function excelSheets() {
    const t = trip();
    const days = Store.days();
    const overview = [
      ['欄位', '內容'],
      ['行程名稱', t.name],
      ['日期', `${t.startDate} ~ ${t.endDate}`],
      ['天數', `${days} 天 ${Math.max(days - 1, 0)} 晚`],
      ['交通方式', transportLabel(t.transport)],
      ['每日時間', `${t.dayStart} ~ ${t.dayEnd}`],
      ['建立者 Email', t.creatorEmail || '']
    ];
    const itinerary = [['天數', '日期', '類型', '名稱', '地址', '備註']];
    for (let d = 1; d <= days; d++) {
      dayRows(d).forEach(r => itinerary.push([`第 ${d} 天`, Store.dateOfDay(d), r.type, r.name, r.address, r.note]));
    }
    const hotels = [['夜晚', '名稱', '地址', '付款狀態', '備註', '平日價格', '假日價格']];
    (t.hotels || []).slice().sort((a, b) => Number(a.night) - Number(b.night)).forEach(h =>
      hotels.push([`第 ${Number(h.night) + 1} 晚`, h.name, h.address || '', UI.PAY_LABELS[h.pay] || '', h.note || '', Number(h.priceWeekday) || '', Number(h.priceWeekend) || '']));
    const spots = [['天數', '順序', '名稱', '餐別', '地址', '停留分鐘', '必去', '備註']];
    (t.spots || []).slice().sort((a, b) => (a.day || 0) - (b.day || 0) || (a.order || 0) - (b.order || 0)).forEach(s =>
      spots.push([s.day ? `第 ${s.day} 天` : '未排', Number(s.order) + 1, s.name, MEAL_LABELS[s.meal] || '', s.address || '', Number(s.stayMin) || '', s.must ? '是' : '', s.note || '']));
    const expenses = [['日期', '項目', '金額', '付款人', '不分帳', '分帳成員']];
    (t.expenses || []).forEach(e => expenses.push([e.date, e.item, Number(e.amount) || 0, e.payer, e.treat ? '是' : '', (e.participants || []).join('、')]));
    const settle = [['成員', '已付', '應付', '餘額']];
    const sr = Logic.settleExpenses(t.expenses || [], t.members || []);
    (t.members || []).forEach(m => settle.push([m, Math.round(sr.paid[m] || 0), Math.round(sr.owed[m] || 0), Math.round((sr.paid[m] || 0) - (sr.owed[m] || 0))]));
    settle.push([]);
    settle.push(['付款人', '收款人', '金額']);
    sr.transfers.forEach(x => settle.push([x.from, x.to, x.amount]));
    const packing = [['分類', '物品', '確認']];
    packingTemplate.forEach(g => g.items.forEach(i => packing.push([g.cat, i, '□'])));
    return [
      { name: '行程總覽', rows: overview },
      { name: '每日行程', rows: itinerary },
      { name: '住宿資訊', rows: hotels },
      { name: '景點清單', rows: spots },
      { name: '支出明細', rows: expenses },
      { name: '結算表', rows: settle },
      { name: '攜帶清單', rows: packing }
    ];
  }
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const enc = new TextEncoder();
  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();
  function bytes(s) { return enc.encode(String(s)); }
  function u16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
  function u32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
  function concatBytes(parts) {
    const len = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(len);
    let pos = 0;
    parts.forEach(p => { out.set(p, pos); pos += p.length; });
    return out;
  }
  function crc32Bytes(data) {
    let crc = 0xFFFFFFFF;
    for (const b of data) crc = CRC32_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function dosStamp(d = new Date()) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }
  function zipStore(files, type) {
    const localParts = [];
    const centralParts = [];
    const stamp = dosStamp();
    let offset = 0;
    files.forEach(file => {
      const nameBytes = bytes(file.name.replace(/\\/g, '/'));
      const dataBytes = bytes(file.data);
      const crc = crc32Bytes(dataBytes);
      const local = concatBytes([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.date),
        u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length), u16(0),
        nameBytes, dataBytes
      ]);
      const central = concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.date),
        u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
      ]);
      localParts.push(local);
      centralParts.push(central);
      offset += local.length;
    });
    const centralOffset = offset;
    const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
    const end = concatBytes([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralSize), u32(centralOffset), u16(0)
    ]);
    return new Blob([...localParts, ...centralParts, end], { type });
  }
  function colName(n) {
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function visibleLen(v) {
    return String(v ?? '').split('').reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  }
  function worksheetXml(rows) {
    const cols = Math.max(1, ...rows.map(r => r.length));
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.min(48, Math.max(10, Math.max(...rows.map(r => visibleLen(r[c]))) + 2)));
    const colsXml = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
    const body = rows.map((row, rIdx) => `<row r="${rIdx + 1}">` + row.map((v, cIdx) => {
      const ref = `${colName(cIdx + 1)}${rIdx + 1}`;
      const style = rIdx === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEsc(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${body}</sheetData></worksheet>`;
  }
  function xlsxBlob() {
    const sheets = excelSheets();
    const sheetOverrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
    const workbookSheets = sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
    const sheetRels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft JhengHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft JhengHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFA9805B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>` },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(s.rows) }))
    ];
    return zipStore(files, XLSX_MIME);
  }
  function printableHtml() {
    const t = trip();
    const daySections = Array.from({ length: Store.days() }, (_, i) => {
      const d = i + 1;
      const rows = dayRows(d).map(r => `
        <tr>
          <td class="type">${textEsc(r.type)}</td>
          <td><b>${textEsc(r.name)}</b>${r.address ? `<div class="addr">${textEsc(r.address)}</div>` : ''}${r.note ? `<div class="note">${textEsc(r.note)}</div>` : ''}</td>
        </tr>`).join('');
      return `<section class="day"><h2>第 ${d} 天 ${dateLabel(Store.dateOfDay(d))}</h2><table>${rows || '<tr><td colspan="2">尚無安排</td></tr>'}</table></section>`;
    }).join('');
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>${textEsc(t.name)} 每日行程</title>
<style>
body{font-family:"Microsoft JhengHei",sans-serif;color:#4A3B2E;background:#FAF6F0;margin:0;padding:24px}
h1{margin:0 0 8px;color:#8f6a49}.meta{color:#8C7B6B;margin-bottom:18px}.day{page-break-inside:avoid;background:#fff;border-radius:12px;padding:16px;margin:0 0 16px;box-shadow:0 2px 10px #e1d4c4}
h2{margin:0 0 10px;color:#A9805B}table{width:100%;border-collapse:collapse}td{border-top:1px solid #eadccd;padding:10px;vertical-align:top}.type{width:90px;color:#A9805B;font-weight:700}.addr,.note{color:#8C7B6B;font-size:14px;margin-top:3px}
@media print{body{background:#fff;padding:0}.day{box-shadow:none;border:1px solid #ddd}}
</style></head><body><h1>${textEsc(t.name)}</h1><div class="meta">${t.startDate} ~ ${t.endDate}｜${transportLabel(t.transport)}</div>${daySections}</body></html>`;
  }
  function printableDailyHtml() {
    const t = trip();
    const daySections = Array.from({ length: Store.days() }, (_, i) => {
      const d = i + 1;
      const rows = dayRows(d).map(r => `
        <tr>
          <td class="type">${textEsc(r.type)}</td>
          <td><b>${textEsc(r.name)}</b>${r.address ? `<div class="addr">${textEsc(r.address)}</div>` : ''}${r.note ? `<div class="note">${textEsc(r.note)}</div>` : ''}</td>
          <td class="pic">${r.photo ? `<img src="${textEsc(r.photo)}" alt="">` : ''}</td>
        </tr>`).join('');
      return `<section class="day"><h2>第 ${d} 天 ${dateLabel(Store.dateOfDay(d))} <span style="font-weight:400;color:#8C7B6B;font-size:15px">・${textEsc(dayTransportText(d))}</span></h2><table>${rows || '<tr><td colspan="3">尚未安排內容</td></tr>'}</table></section>`;
    }).join('');
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=800, initial-scale=1, minimum-scale=0.2, maximum-scale=5, user-scalable=yes"><title>${textEsc(t.name)} 每日行程 PDF</title>
<style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:"Microsoft JhengHei",sans-serif;color:#4A3B2E;background:#F4EFE7;margin:0}.sheet{width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:12mm}
@media screen and (max-width:820px){.sheet{width:100%;min-height:0;padding:14px}}
h1{margin:0 0 8px;color:#8f6a49;font-size:24px}.meta{color:#8C7B6B;margin-bottom:14px}.day{page-break-inside:avoid;border:1px solid #eadccd;border-radius:8px;padding:12px;margin:0 0 12px}
h2{margin:0 0 8px;color:#A9805B;font-size:18px}table{width:100%;border-collapse:collapse}td{border-top:1px solid #eadccd;padding:8px;vertical-align:top}.type{width:86px;color:#A9805B;font-weight:700}.addr,.note{color:#8C7B6B;font-size:13px;margin-top:3px}.pic{width:64px;text-align:right}.pic img{width:60px;height:60px;object-fit:cover;border-radius:6px}
@media print{body{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0}.day{break-inside:avoid}}
</style></head><body><main class="sheet"><h1>${textEsc(t.name)}</h1><div class="meta">${t.startDate} ~ ${t.endDate}｜${transportLabel(t.transport)}</div>${daySections}</main></body></html>`;
  }
  function packingHtml() {
    const t = trip();
    const groups = packingTemplate.map(g => `<section class="group"><h2>${textEsc(g.cat)}</h2><ul>${g.items.map(i => `<li><span>□</span>${textEsc(i)}</li>`).join('')}</ul></section>`).join('');
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=800, initial-scale=1, minimum-scale=0.2, maximum-scale=5, user-scalable=yes"><title>${textEsc(t.name)} 攜帶物品清單</title>
<style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:"Microsoft JhengHei",sans-serif;color:#4A3B2E;background:#F4EFE7;margin:0}.sheet{width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:12mm}
@media screen and (max-width:820px){.sheet{width:100%;min-height:0;padding:14px}}
h1{margin:0 0 8px;color:#8f6a49;font-size:24px}.meta{color:#8C7B6B;margin-bottom:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.group{break-inside:avoid;border:1px solid #eadccd;border-radius:8px;padding:10px}
h2{margin:0 0 6px;color:#A9805B;font-size:16px}ul{list-style:none;margin:0;padding:0;display:grid;gap:5px}li{display:flex;gap:7px;align-items:flex-start;font-size:14px}li span{color:#A9805B;font-weight:700}
@media print{body{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0}.group{break-inside:avoid}}
</style></head><body><main class="sheet"><h1>${textEsc(t.name)} 攜帶物品清單</h1><div class="meta">${t.startDate} ~ ${t.endDate}</div><div class="grid">${groups}</div></main></body></html>`;
  }
  // app 內全螢幕預覽（手機也能用返回鍵/返回按鈕退出）：iframe 裝列印頁＋「列印／存 PDF」
  function openPreview(html, title, autoPrint) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-wrap';
    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.title = title;
    wrap.appendChild(frame);
    const doPrint = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch (e) { UI.toast('列印失敗，請用瀏覽器選單列印'); }
    };
    frame.onload = () => { if (autoPrint) setTimeout(doPrint, 300); };
    UI.modal(title, wrap, [{ label: '🖨 列印／存 PDF', primary: true, onClick: doPrint }], { fullscreen: true });
    frame.srcdoc = html;   // 掛進 DOM 後再載入內容
  }
  function renderPackingList() {
    const box = $('packingListBox');
    if (!box) return;
    box.innerHTML = packingTemplate.map(g => `<div class="packing-group"><b>${UI.esc(g.cat)}</b><ul>${g.items.map(i => `<li class="packing-line"><span class="print-check">□</span><span>${UI.esc(i)}</span></li>`).join('')}</ul></div>`).join('');
  }
  function renderResourcePage() {
    if (!$('page-res') || $('page-res').dataset.ready === '1') {
      renderPackingList();
      return;
    }
    $('page-res').dataset.ready = '1';
    $('btnExportExcel').onclick = () => downloadBlob(`${trip().name || '旅遊行程'}-資料匯出.xlsx`, xlsxBlob());
    $('btnPreviewPrint').onclick = () => openPreview(printableDailyHtml(), '每日行程 PDF', false);
    $('btnPackingPreview').onclick = () => openPreview(packingHtml(), '攜帶物品清單', false);
    renderPackingList();
  }

  // ================= 分享（雙代碼） =================
  function shareLink(code) {
    const base = location.origin === 'null' || location.protocol === 'file:'
      ? location.href.split('?')[0]
      : location.origin + location.pathname;
    return `${base}?code=${code}`;
  }

  // 依 Mika 定案順序：Email → 唯讀連結 → 編輯連結 → 編輯代碼 → 唯讀代碼
  function codesBlock(t) {
    return `
      <div class="stack" style="margin-top:10px">
        <button class="btn-primary" data-copy="${shareLink(t.viewCode)}">👀 複製唯讀連結（親友只能看）</button>
        <button class="btn-outline" data-copy="${shareLink(t.editCode)}">✏️ 複製編輯連結（可修改行程）</button>
        <button class="btn-outline" data-copy="${t.editCode}">複製編輯代碼｜${t.editCode}</button>
        <button class="btn-outline" data-copy="${t.viewCode}">複製唯讀代碼｜${t.viewCode}</button>
      </div>`;
  }

  function bindCopyButtons(root) {
    root.querySelectorAll('[data-copy]').forEach(b =>
      b.onclick = () => UI.copy(b.dataset.copy, '已複製！'));
  }

  function emailBlock(t) {
    const div = document.createElement('div');
    div.innerHTML = `
      <p style="margin:4px 0 4px"><b>📮 輸入電子郵件</b>（寄代碼備份；之後在首頁輸入這個 Email 就能直接找回行程）</p>
      <div class="row-add">
        <input type="email" placeholder="輸入你的 Email" value="${UI.esc(t.creatorEmail || '')}">
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
    // 建立完成即自動把兩組代碼寄到建立者 Email（背景執行，不擋畫面）
    let autoSentLine = '';
    if (t.creatorEmail && !t.codesAutoSent) {
      if (Api.isMock()) {
        autoSentLine = `<p class="hint">（模擬模式）正式版會自動把代碼寄到 ${UI.esc(t.creatorEmail)}</p>`;
      } else {
        autoSentLine = `<p class="hint">📮 代碼已自動寄到 ${UI.esc(t.creatorEmail)}（沒收到請查垃圾郵件）</p>`;
        Api.cloudSendCodes(t.creatorEmail, t)
          .then(() => { t.codesAutoSent = true; Store.touch(); })
          .catch(e => { console.warn('自動寄送失敗', e); UI.toast('自動寄送代碼失敗，可稍後在分享畫面手動寄送'); });
      }
    }
    const body = document.createElement('div');
    body.innerHTML = `
      <p style="margin-bottom:10px">🎉 「${UI.esc(t.name)}」建立成功！<br>
      <b style="color:var(--accent)">請先留下 Email 或存下連結</b>，之後在任何裝置都能打開行程。</p>
      ${autoSentLine}`;
    body.appendChild(emailBlock(t));
    const codes = document.createElement('div');
    codes.innerHTML = codesBlock(t);
    body.appendChild(codes);
    bindCopyButtons(body);
    UI.modal('行程建立成功', body, [
      { label: '開始規劃 →', primary: true, onClick: () => { UI.closeModal(); onDone && onDone(); } }
    ], { noClose: true });
  }

  // 每晚飯店 / 集合地 / 解散地當作每天起訖
  function dayAnchors(t, d, totalDays) {
    const hotelNight = n => (t.hotels || []).find(h => Number(h.night) === n) || null;
    const start = (d === 1 && t.meetPoint) ? t.meetPoint : (hotelNight(d - 2) || hotelNight(d - 1) || null);
    const end = (d === totalDays && t.endPoint) ? t.endPoint : hotelNight(d - 1);
    return { start, end };
  }

  // 組出「每日行程」HTML（寄信用）
  function itineraryRowsHtml(t) {
    const days = Logic.datesBetween(t.startDate, t.endDate);
    return days.map((dateISO, i) => {
      const d = i + 1;
      const list = t.spots.filter(s => Number(s.day) === d).sort((a, b) => a.order - b.order);
      const { start, end } = dayAnchors(t, d, days.length);
      const items = [];
      if (start) items.push(`<li style="color:#8C7B6B">🏁 出發：${UI.esc(start.name)}</li>`);
      list.forEach((s, idx) => items.push(
        `<li style="margin:2px 0"><b>${idx + 1}. ${UI.esc(s.name)}</b>` +
        (s.address ? `<br><span style="color:#8C7B6B;font-size:13px">${UI.esc(s.address)}</span>` : '') + `</li>`));
      if (end) items.push(`<li style="color:#8C7B6B">🏨 住宿：${UI.esc(end.name)}</li>`);
      const dTxt = `${Number(dateISO.slice(5, 7))}/${Number(dateISO.slice(8, 10))}`;
      return `<div style="margin:14px 0"><h3 style="color:#A9805B;margin:0 0 6px;font-size:17px">第 ${d} 天 <span style="font-weight:400;color:#8C7B6B;font-size:14px">${dTxt}</span></h3>` +
        `<ul style="margin:0;padding-left:18px;line-height:1.7">${items.join('') || '<li style="color:#8C7B6B">尚未安排景點</li>'}</ul></div>`;
    }).join('');
  }

  function fullItineraryEmailHtml(t, viewUrl) {
    const dTxt = t.startDate.slice(5).replace('-', '/') + '–' + t.endDate.slice(5).replace('-', '/');
    return '<div style="font-family:sans-serif;color:#4A3B2E;max-width:640px">' +
      `<h2 style="color:#A9805B;margin:0 0 4px">🧋 ${UI.esc(t.name)}</h2>` +
      `<p style="color:#8C7B6B;margin:0 0 12px">${dTxt}</p>` +
      `<p><a href="${viewUrl}" style="display:inline-block;background:#A9805B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">👀 打開完整行程（可看地圖、天氣）</a></p>` +
      `<hr style="border:none;border-top:1px solid #E8DDCD;margin:14px 0">` +
      `<h3 style="color:#4A3B2E">📅 每日行程</h3>` + itineraryRowsHtml(t) +
      `<p style="color:#8C7B6B;font-size:13px;margin-top:16px">⏱️ 預估時間僅供參考，實際可能因路線、路況或營業時間而有所不同。</p>` +
      '</div>';
  }

  // 主要：寄送完整行程（唯讀連結＋每日行程）；支援多位收件人
  function itineraryEmailBlock(t) {
    const div = document.createElement('div');
    div.innerHTML = `
      <p style="margin:2px 0 4px"><b style="color:var(--accent)">📧 寄送完整行程</b></p>
      <div class="row-add">
        <input type="email" placeholder="收件人 Email（多位用逗號分隔）" value="${UI.esc(t.creatorEmail || '')}">
        <button class="btn-small">寄送</button>
      </div>`;
    const inp = div.querySelector('input');
    div.querySelector('button').onclick = async () => {
      const list = inp.value.split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
      if (!list.length) { UI.toast('請輸入至少一個 Email'); return; }
      const bad = list.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad.length) { UI.toast(`這些 Email 格式怪怪的：${bad.join('、')}`); return; }
      try {
        UI.loading(true, `寄送中…（${list.length} 位）`);
        const html = fullItineraryEmailHtml(t, shareLink(t.viewCode));
        const r = await Api.cloudSendItinerary(list.join(','), `【Mika 旅遊路線規劃】${t.name} 完整行程`, html, t.editCode);
        UI.loading(false);
        UI.toast(r.simulated ? '（模擬模式）正式版上線後會真的寄出唷' : `已寄出完整行程給 ${list.length} 位！`);
      } catch (e) { UI.loading(false); UI.alert('寄送失敗', e.message); }
    };
    return div;
  }

  // 複製行程寄出的信：含編輯連結、網站入口連結、唯讀連結與代碼備份
  function copyEmailHtml(t, editUrl, viewUrl, siteUrl) {
    const dTxt = t.startDate.slice(5).replace('-', '/') + '–' + t.endDate.slice(5).replace('-', '/');
    return '<div style="font-family:sans-serif;color:#4A3B2E;max-width:640px">' +
      `<h2 style="color:#A9805B;margin:0 0 4px">🧋 ${UI.esc(t.name)}</h2>` +
      `<p style="color:#8C7B6B;margin:0 0 12px">${dTxt}</p>` +
      `<p>這是你複製的專屬行程，可以自由編輯、儲存。點下面的連結就能直接開啟：</p>` +
      `<p><a href="${editUrl}" style="display:inline-block;background:#A9805B;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700">✏️ 開啟並編輯我的行程</a></p>` +
      `<p><a href="${viewUrl}" style="display:inline-block;background:#D98E4A;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-weight:700">👀 唯讀連結（分享給親友看）</a></p>` +
      `<p style="margin:14px 0 4px">🏠 網站入口：<a href="${siteUrl}" style="color:#A9805B">${siteUrl}</a></p>` +
      `<hr style="border:none;border-top:1px solid #E8DDCD;margin:14px 0">` +
      `<p style="color:#8C7B6B;font-size:14px;margin:0">代碼備份（在網站首頁「輸入代碼」也能開啟）：<br>` +
      `✏️ 編輯代碼 <b style="color:#A9805B;letter-spacing:1px">${t.editCode}</b>　｜　👀 唯讀代碼 <b style="color:#D98E4A;letter-spacing:1px">${t.viewCode}</b></p>` +
      `<p style="color:#8C7B6B;font-size:13px;margin-top:14px">⏱️ 預估時間僅供參考，實際可能因路線、路況或營業時間而有所不同。</p>` +
      '</div>';
  }

  // 複製此份行程 → 產生一份「自己的」新行程（新代碼、可編輯保存、寄到自己 Email）
  function copyTrip() {
    const t = trip();
    if (!t) return;
    const body = document.createElement('div');
    body.innerHTML = `
      <p style="margin-bottom:8px">會複製「${UI.esc(t.name)}」的完整行程（景點、住宿、備註…），變成一份<b style="color:var(--accent)">你自己的新行程</b>，可以自由編輯、儲存，並用你的 Email 找回。<br>
      <span class="hint">原行程不受影響。</span></p>
      <label>新行程名稱</label>
      <input id="copyName" type="text" maxlength="30" value="${UI.esc(t.name + '（我的複本）')}">
      <label>你的 Email（用來找回這份複本）</label>
      <input id="copyEmail" type="email" placeholder="例如：you@gmail.com">`;
    UI.modal('📋 複製成我的行程', body, [{
      label: '建立我的複本', primary: true,
      onClick: async () => {
        const name = body.querySelector('#copyName').value.trim() || (t.name + '（複本）');
        const email = body.querySelector('#copyEmail').value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { UI.toast('Email 格式看起來不對，請再確認'); return; }
        try {
          UI.loading(true, '建立你的複本中…');
          const copy = Store.cloneAsNew(t, name, email);
          copy.codesAutoSent = true; // 這裡自己寄，避免 showTripCreated 又寄一次
          Store.load(copy, 'edit');
          await Store.cloudSaveNow();       // 建立到雲端（sendItinerary 會用編輯代碼找這份行程）
          const editUrl = shareLink(copy.editCode);
          const viewUrl = shareLink(copy.viewCode);
          const siteUrl = shareLink('').replace(/\?code=$/, ''); // 網站入口（去掉 ?code=）
          const html = copyEmailHtml(copy, editUrl, viewUrl, siteUrl);
          try {
            await Api.cloudSendItinerary(email, `【Mika 旅遊路線規劃】${copy.name}`, html, copy.editCode);
          } catch (e) { console.warn('複本寄送失敗', e); }
          UI.loading(false);
          UI.closeAllModals();
          App.enterMain();
          UI.toast(Api.isMock() ? '已複製成你的行程！（模擬模式不會真的寄信）' : '已複製成你的行程！編輯連結已寄到你的信箱');
        } catch (e) { UI.loading(false); UI.alert('複製失敗', e.message || String(e)); }
      }
    }]);
  }

  function showShare() {
    const t = trip();
    const body = document.createElement('div');
    if (Store.isReadonly()) {
      body.innerHTML = `
        <div class="stack">
          <button class="btn-primary" data-copy="${shareLink(t.viewCode)}">👀 複製唯讀連結（分享給朋友一起看）</button>
        </div>
        <p class="hint" style="margin-top:8px">你目前是唯讀模式，看不到編輯代碼。</p>`;
    } else {
      // 順序：複製唯讀連結 → 複製編輯連結 → 寄送完整行程（代碼建立時已寄給本人，這裡不再列）
      const links = document.createElement('div');
      links.className = 'stack';
      links.innerHTML = `
        <button class="btn-primary" data-copy="${shareLink(t.viewCode)}">👀 複製唯讀連結（親友只能看）</button>
        <button class="btn-outline" data-copy="${shareLink(t.editCode)}">✏️ 複製編輯連結（可修改行程）</button>`;
      body.appendChild(links);
      const mailWrap = document.createElement('div');
      mailWrap.style.marginTop = '12px';
      mailWrap.appendChild(itineraryEmailBlock(t));
      body.appendChild(mailWrap);
    }
    bindCopyButtons(body);
    UI.modal('📤 分享行程', body, []);
  }

  return {
    fillWeather, openRainPlan, recommendHotel, openRoutePoints, editTripDates,
    openFood, renderExpensePage, quickExpense, renderResourcePage,
    initExpense, showTripCreated, showShare, copyTrip
  };
})();
