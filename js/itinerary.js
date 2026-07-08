// ============================================================
// 行程頁：景點輸入、一鍵最佳路線、行程表（分天＋時間軸）、地圖、雨天備案
// v1.2：真 Google 地圖、集合/解散地、跨天拖曳、每日加景點、上一步/下一步
// ============================================================
const Itin = (() => {

  const $ = id => document.getElementById(id);
  const trip = () => Store.get();
  const DAY_COLORS = ['#A9805B', '#D98E4A', '#6C9A5B', '#5B7FA9', '#A95B8F', '#7F6BA9'];
  const dayColor = d => DAY_COLORS[(d - 1 + DAY_COLORS.length * 9) % DAY_COLORS.length];

  // ---------- 每天的起點與終點 ----------
  // 起點：第 1 天優先用「集合出發地」；否則前一晚飯店（第 1 天用當晚）
  // 終點：最後一天優先用「解散地」；否則當晚飯店（最後一晚沒有就不設）
  function startPoint(day) {
    const t = trip();
    if (day === 1 && t.meetPoint) return { p: t.meetPoint, kind: 'meet' };
    const h = Store.hotelOfNight(day - 2) || Store.hotelOfNight(day - 1) || null;
    return h ? { p: h, kind: 'hotel' } : null;
  }
  function endPoint(day) {
    const t = trip();
    if (day === Store.days() && t.endPoint) return { p: t.endPoint, kind: 'end' };
    const h = Store.hotelOfNight(day - 1);
    return h ? { p: h, kind: 'hotel' } : null;
  }
  // 供其他模組沿用（例如天氣以起點為備援中心）
  const startHotel = day => (startPoint(day) || {}).p || null;
  const endHotel = day => (endPoint(day) || {}).p || null;

  function spotsOfDay(day) {
    return trip().spots.filter(s => s.day === day).sort((a, b) => a.order - b.order);
  }
  function unassigned() {
    return trip().spots.filter(s => !s.day || s.day === 0);
  }

  // 各路段時間：優先用排路線時存下的，否則即時估算
  function legsForDay(day) {
    const list = spotsOfDay(day);
    const cached = trip().legsByDay[day];
    if (cached && cached.length === list.length + 1) {
      // 舊資料防護：異常路段（例如 Google 對到不了的點回傳的怪時間）改用估算
      const seq = [startHotel(day), ...list, endHotel(day)];
      return cached.map((min, i) => {
        if (!seq[i] || !seq[i + 1]) return min;
        const est = Logic.travelMinutes(seq[i], seq[i + 1], trip().transport);
        return min > est * 3 + 60 ? est : min;
      });
    }
    const sp = startHotel(day), ep = endHotel(day);
    const legs = [];
    let prev = sp;
    for (const s of list) {
      legs.push(prev ? Logic.travelMinutes(prev, s, trip().transport) : 0);
      prev = s;
    }
    legs.push(ep && prev ? Logic.travelMinutes(prev, ep, trip().transport) : 0);
    return legs;
  }

  // 每一天實際的出發時間（可個別覆寫，預設用全域設定）
  function dayStartOf(day) {
    const t = trip();
    return (t.dayStartOv || {})[day] || t.dayStart;
  }

  function dayCenter(day) {
    const list = spotsOfDay(day);
    const pool = list.length ? list : trip().spots;
    if (!pool.length) return null;
    return {
      lat: pool.reduce((s, p) => s + p.lat, 0) / pool.length,
      lng: pool.reduce((s, p) => s + p.lng, 0) / pool.length
    };
  }

  // ================= 景點搜尋與加入 =================
  let suggestTimer = null;
  function initSpotInput() {
    const inp = $('inpSpot'), box = $('spotSuggest');
    inp.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      const q = inp.value.trim();
      if (!q) { box.classList.add('hidden'); return; }
      suggestTimer = setTimeout(async () => {
        try {
          const results = await Api.searchPlaces(q, 'spot');
          if (!results.length) {
            box.innerHTML = '<div class="s-item"><span class="s-sub">找不到符合的地點，請換個關鍵字</span></div>';
          } else {
            box.innerHTML = results.map((r, i) => `
              <div class="s-item" data-i="${i}">
                <div>${UI.esc(r.name)} <span class="star">★ ${r.rating}</span></div>
                <div class="s-sub">${UI.esc(r.address)}</div>
              </div>`).join('');
            box.querySelectorAll('[data-i]').forEach(el =>
              el.onclick = () => { addSpot(results[Number(el.dataset.i)]); inp.value = ''; box.classList.add('hidden'); });
          }
          box.classList.remove('hidden');
        } catch (e) { console.warn(e); }
      }, 250);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.add-spot-row')) box.classList.add('hidden');
    });
  }

  function addSpot(place, opt) {
    const t = trip();
    if (t.spots.some(s => s.placeId === place.placeId)) { UI.toast('這個景點已經在清單裡囉'); return false; }
    const day = (opt && opt.day) || 0;
    t.spots.push({
      id: Logic.uid(), placeId: place.placeId, name: place.name, address: place.address || '',
      lat: place.lat, lng: place.lng, rating: place.rating || 0, photo: place.photo || '',
      stayMin: CONFIG.defaults.stayMin, must: false, note: '',
      day, order: day ? spotsOfDay(day).length : t.spots.length
    });
    if (day) delete t.legsByDay[day];
    Store.touch(day ? { manual: true } : undefined);
    UI.toast(`已加入「${place.name}」${day ? `到第 ${day} 天` : ''}`);
    render();
    return true;
  }

  // 針對某一天加景點（每日卡片上的 ➕）
  function openAddSpot(d) {
    const body = document.createElement('div');
    body.innerHTML = `
      <input type="text" id="addSpotInp" placeholder="輸入景點名稱，例如：鵝鑾鼻燈塔" autocomplete="off">
      <div class="result-list" id="addSpotRes"></div>`;
    const inp = body.querySelector('#addSpotInp');
    const res = body.querySelector('#addSpotRes');
    let timer = null;
    inp.addEventListener('input', () => {
      clearTimeout(timer);
      const q = inp.value.trim();
      if (!q) { res.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const rs = await Api.searchPlaces(q, 'spot');
          res.innerHTML = rs.length ? rs.map((r, i) => `
            <div class="result-item ${r.photo ? 'with-photo' : ''}">
              ${r.photo ? `<img class="thumb" src="${r.photo}" alt="">` : ''}
              <div class="r-body">
                <div class="r-name">${UI.esc(r.name)} <span class="star">★ ${r.rating}</span></div>
                <div class="r-meta">${UI.esc(r.address)}</div>
                <div class="r-actions"><button class="primary" data-i="${i}">＋ 加到第 ${d} 天</button></div>
              </div>
            </div>`).join('') : '<p class="hint">找不到符合的地點</p>';
          res.querySelectorAll('button[data-i]').forEach(b =>
            b.onclick = () => { if (addSpot(rs[Number(b.dataset.i)], { day: d })) inp.value = ''; res.innerHTML = ''; });
        } catch (e) { console.warn(e); }
      }, 250);
    });
    UI.modal(`第 ${d} 天加景點`, body, []);
    setTimeout(() => inp.focus(), 50);
  }

  // ================= 一鍵最佳路線 =================
  function initOptimize() {
    $('btnOptimize').onclick = () => {
      const n = trip().spots.length;
      if (n < 2) { UI.toast('先加入至少 2 個景點，才能排路線喔'); return; }
      if (Store.isManualDirty() && trip().optimizedAt) {
        UI.confirm('重新排最佳路線？',
          '你之前手動調整過景點安排，重新排路線會覆蓋你調整的結果（可用「上一步」復原）。確定要繼續嗎？',
          runOptimize);
      } else {
        runOptimize();
      }
    };
  }

  async function runOptimize() {
    const t = trip();
    try {
      UI.loading(true, '正在計算最佳路線…');
      const all = [...t.spots].sort((a, b) => (a.day || 99) - (b.day || 99) || a.order - b.order);
      const prevDayOf = {}; all.forEach(s => prevDayOf[s.id] = s.day);
      const days = Store.days();
      const o1 = startHotel(1);
      const oN = endHotel(days) || o1;

      // 1) 全體排序
      const g = await Api.optimizeRoute(o1, oN, all, t.transport);
      const ordered = g.order.map(i => all[i]);

      // 2) 依每日活動時間切天
      const dayArrs = Logic.splitIntoDays(ordered, {
        days,
        dayStartMin: Logic.toMin(t.dayStart),
        dayEndMin: Logic.toMin(t.dayEnd),
        travelMin: (a, b) => Logic.travelMinutes(a, b, t.transport),
        hotelOfDay: d => startHotel(d + 1)
      });

      // 3) 每天以起終點（集合地/飯店/解散地）再最佳化
      t.legsByDay = {};
      for (let d = 1; d <= days; d++) {
        const listD = dayArrs[d - 1];
        if (!listD.length) continue;
        const r = await Api.optimizeRoute(startHotel(d), endHotel(d), listD, t.transport);
        r.order.forEach((idx, pos) => {
          const s = listD[idx];
          s.day = d; s.order = pos;
        });
        t.legsByDay[d] = r.legs;
      }
      t.optimizedAt = Date.now();
      Store.clearManualDirty();
      Store.touch();
      UI.loading(false);
      $('btnOptimize').classList.remove('glow');
      render();

      const pushed = t.spots.filter(s => s.must && prevDayOf[s.id] > 0 && s.day > prevDayOf[s.id]);
      if (pushed.length) {
        UI.alert('必去景點被移到隔天了',
          `因為一天排不下，這些「必去」景點被移到後面的天數：\n\n` +
          pushed.map(s => `⭐ ${s.name}（第 ${s.day} 天）`).join('\n') +
          `\n\n可以縮短其他景點的停留時間，或手動把它拖回想去的那天。`);
      } else {
        UI.toast('最佳路線排好了！');
      }
    } catch (e) {
      UI.loading(false);
      UI.alert('排路線失敗', e.message + '\n\n請稍後再試一次；若一直失敗，請檢查網路連線。');
    }
  }

  // ================= 行程表渲染 =================
  function render() {
    const t = trip();
    if (!t) return;
    const days = Store.days();
    const anySpot = t.spots.length > 0;
    $('tripEmpty').classList.toggle('hidden', anySpot);
    $('tripSummaryBar').classList.toggle('hidden', !anySpot);

    const fab = $('btnOptimize');
    fab.disabled = t.spots.length < 2;
    fab.classList.toggle('glow', t.spots.length >= 2 && !t.optimizedAt);

    if (anySpot) renderSummaryBar();

    const wrap = $('dayList');
    wrap.innerHTML = '';
    const un = unassigned();
    if (un.length) wrap.appendChild(renderUnassignedCard(un));
    for (let d = 1; d <= days; d++) {
      if (!anySpot) continue; // 完全沒景點時只顯示空狀態引導
      wrap.appendChild(renderDayCard(d, spotsOfDay(d)));
    }
    renderMiniMap();
    Feat.fillWeather();
  }

  function renderSummaryBar() {
    const t = trip();
    const modeTxt = { driving: '🚗 開車', transit: '🚇 大眾運輸', walking: '🚶 走路' };
    $('tripSummaryBar').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${UI.esc(t.name)}｜${t.startDate.slice(5).replace('-', '/')}–${t.endDate.slice(5).replace('-', '/')}｜${t.spots.length} 個景點</span>
        <span style="display:flex;gap:6px;align-items:center">
          <span class="undo-btns edit-only">
            <button id="btnUndo" ${Store.canUndo() ? '' : 'disabled'}>↩ 上一步</button>
            <button id="btnRedo" ${Store.canRedo() ? '' : 'disabled'}>↪ 下一步</button>
          </span>
          <button id="btnSwitchMode" class="chip" style="cursor:pointer">${modeTxt[t.transport]} ▾</button>
        </span>
      </div>`;
    $('btnUndo').onclick = () => { if (Store.undo()) { render(); UI.toast('已復原上一步'); } };
    $('btnRedo').onclick = () => { if (Store.redo()) { render(); UI.toast('已重做下一步'); } };
    const b = $('btnSwitchMode');
    if (Store.isReadonly()) { b.style.pointerEvents = 'none'; return; }
    b.onclick = () => {
      UI.choose('切換交通方式', [
        { label: '🚗 開車', value: 'driving' },
        { label: '🚇 大眾運輸', value: 'transit' },
        { label: '🚶 走路', value: 'walking' }
      ], v => {
        t.transport = v;
        t.legsByDay = {};
        Store.touch();
        render();
        UI.toast('已切換為「' + { driving: '開車', transit: '大眾運輸', walking: '走路' }[v] + '」，時間已重新計算');
      });
    };
  }

  function renderUnassignedCard(list) {
    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.day = '0';
    card.innerHTML = `
      <div class="day-head">
        <div class="day-head-top">
          <span class="day-title">🧺 待排景點（${list.length}）</span>
        </div>
        <p class="hint">按下方「一鍵排最佳路線」自動分天，或按住 ☰ 直接拖到某一天</p>
      </div>`;
    list.forEach(s => card.appendChild(spotRow(s, null, 0)));
    return card;
  }

  function renderDayCard(d, list) {
    const t = trip();
    const dateISO = Store.dateOfDay(d);
    const sp = startPoint(d), ep = endPoint(d);
    const legs = legsForDay(d);
    const tl = Logic.buildTimeline(list, legs, dayStartOf(d));

    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.day = d;

    const dateTxt = `${Number(dateISO.slice(5, 7))}/${Number(dateISO.slice(8, 10))}`;
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `
      <div class="day-head-top">
        <span class="day-title" style="color:${dayColor(d)}">第 ${d} 天 <span style="font-weight:400;color:var(--text-2);font-size:.95rem">${dateTxt}</span></span>
        <span class="day-weather" data-day-weather="${d}">☁️ 查天氣中…</span>
      </div>
      <div class="day-outfit" data-day-outfit="${d}"></div>
      <div data-rain-slot="${d}"></div>
      ${list.length ? `<p class="hint" style="margin-top:4px">車程 ${tl.totalTravel} 分｜停留 ${Math.round(tl.totalStay / 60 * 10) / 10} 小時｜預計 ${tl.endTime} 結束</p>` : ''}
      <div class="day-tools">
        <button data-daytime="${d}" class="edit-only">🕘 ${dayStartOf(d)} 出發${(t.dayStartOv || {})[d] ? '＊' : ''}</button>
        <button data-addspot="${d}" class="edit-only">➕ 加景點</button>
        <button data-food="${d}" class="edit-only">🍜 附近美食</button>
        ${list.length ? `<a href="${dayNavLink(d, list)}" target="_blank" rel="noopener">🧭 全日導航</a>` : ''}
        <button data-rainbtn="${d}" class="edit-only-inline">☔ 雨天備案${t.rainActive[d] ? '（使用中）' : (t.rainPlans[d]?.spots?.length ? '（已設定）' : '')}</button>
        <button data-hotelrec="${d}" class="edit-only">🏨 ${Store.hotelOfNight(d - 1) || Store.hotelOfNight(d - 2) ? '換飯店' : '推薦飯店'}</button>
        ${d === 1 ? `<button data-routepts="${d}" class="edit-only">🚩 集合地${t.meetPoint ? ' ✓' : ''}</button>` : ''}
        ${d === Store.days() ? `<button data-routepts="${d}" class="edit-only">🏁 解散地${t.endPoint ? ' ✓' : ''}</button>` : ''}
      </div>`;
    card.appendChild(head);

    if (Store.isReadonly()) head.querySelectorAll('.edit-only-inline').forEach(b => {
      if (b.dataset.rainbtn && !(t.rainPlans[d]?.spots?.length)) b.remove();
    });

    // 起點列
    if (sp && list.length) card.appendChild(pointRow(sp, `${dayStartOf(d)} ${sp.kind === 'meet' ? '從集合地出發' : '從飯店出發'}`));

    // 景點列 + 路段
    tl.rows.forEach((row, i) => {
      if (row.legMin > 0) card.appendChild(legRow(row.legMin));
      card.appendChild(spotRow(row.spot, row, i + 1, d));
    });
    if (list.length && ep) {
      if (tl.backLeg > 0) card.appendChild(legRow(tl.backLeg));
      card.appendChild(pointRow(ep, `${tl.endTime} ${ep.kind === 'end' ? '抵達解散地' : '回到飯店'}`));
    }
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'hint'; p.style.padding = '0 14px 12px';
      p.textContent = '這天還沒有景點：按上面的「➕ 加景點」，或按住 ☰ 把景點拖過來。';
      card.appendChild(p);
    }

    const timeBtn = head.querySelector(`[data-daytime="${d}"]`);
    if (timeBtn) timeBtn.onclick = () => editDayStart(d);
    const addBtn = head.querySelector(`[data-addspot="${d}"]`);
    if (addBtn) addBtn.onclick = () => openAddSpot(d);
    const foodBtn = head.querySelector(`[data-food="${d}"]`);
    if (foodBtn) foodBtn.onclick = () => Feat.openFood(d);
    const rainBtn = head.querySelector(`[data-rainbtn="${d}"]`);
    if (rainBtn) rainBtn.onclick = () => Feat.openRainPlan(d);
    const hotelRec = head.querySelector(`[data-hotelrec="${d}"]`);
    if (hotelRec) hotelRec.onclick = () => Feat.recommendHotel(d);
    head.querySelectorAll(`[data-routepts]`).forEach(b => b.onclick = () => Feat.openRoutePoints());
    return card;
  }

  // 調整某一天的出發時間（時間軸依停留＋車程重新推算）
  function editDayStart(d) {
    const t = trip();
    if (!t.dayStartOv) t.dayStartOv = {};
    const body = document.createElement('div');
    body.innerHTML = `
      <label>第 ${d} 天幾點出發？</label>
      <input id="dayStartInp" type="time" value="${dayStartOf(d)}">
      <p class="hint">改了之後，這一天的抵達／出發時間會依停留時間與車程自動重排。全域預設是 ${t.dayStart}。</p>`;
    const actions = [{
      label: '套用', primary: true,
      onClick: () => {
        const v = document.getElementById('dayStartInp').value;
        if (!v) { UI.toast('請選擇時間'); return; }
        t.dayStartOv[d] = v;
        Store.touch();
        UI.closeModal();
        render();
        UI.toast(`第 ${d} 天改為 ${v} 出發，時間已重排`);
      }
    }];
    if (t.dayStartOv[d]) actions.push({
      label: `還原預設 ${t.dayStart}`,
      onClick: () => {
        delete t.dayStartOv[d];
        Store.touch();
        UI.closeModal();
        render();
        UI.toast(`第 ${d} 天恢復 ${t.dayStart} 出發`);
      }
    });
    UI.modal(`🕘 第 ${d} 天出發時間`, body, actions);
  }

  function legRow(min) {
    const t = trip();
    const icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[t.transport];
    const div = document.createElement('div');
    div.className = 'leg-row';
    div.innerHTML = `↓ ${icon} 車程約 ${min} 分鐘`;
    return div;
  }

  // 起終點列（飯店 / 集合地 / 解散地）
  function pointRow(spObj, timeTxt) {
    const p = spObj.p, kind = spObj.kind;
    const icon = kind === 'meet' ? '🚩' : kind === 'end' ? '🏁' : '🏨';
    const div = document.createElement('div');
    div.className = 'spot-row';
    const payTag = kind === 'hotel' && p.pay ? `<span class="pay-badge pay-${p.pay}">${UI.PAY_LABELS[p.pay] || ''}</span>` : '';
    const priceTxt = kind === 'hotel' && (p.priceWeekday || p.priceWeekend)
      ? `<div class="spot-times">💲 ${p.priceWeekday ? `平日 $${Number(p.priceWeekday).toLocaleString()}` : ''}${p.priceWeekday && p.priceWeekend ? '｜' : ''}${p.priceWeekend ? `假日 $${Number(p.priceWeekend).toLocaleString()}` : ''}</div>` : '';
    div.innerHTML = `
      <div class="spot-main">
        ${p.photo ? `<img class="thumb thumb-sm" src="${p.photo}" alt="">` : `<span class="spot-no hotel">${icon}</span>`}
        <div class="spot-info">
          <div class="spot-name">${kind !== 'hotel' ? icon + ' ' : ''}${UI.esc(p.name)} ${payTag}</div>
          <div class="spot-times">${timeTxt}</div>
          ${kind === 'hotel' && p.note ? `<div class="spot-times">📝 ${UI.esc(p.note)}</div>` : ''}
          ${priceTxt}
        </div>
        <div class="spot-actions">
          ${kind === 'hotel' ? `<button class="edit-only" data-act="hedit" title="編輯住宿備註">✎</button>` : ''}
          <a href="${UI.gmapLink(p)}" target="_blank" rel="noopener" style="padding:6px">📍</a>
        </div>
      </div>`;
    const thumb = div.querySelector('.thumb');
    if (thumb) thumb.onclick = () => UI.photoZoom(p.photo, p.name);
    const he = div.querySelector('[data-act="hedit"]');
    if (he) he.onclick = () => editHotelInfo(p);
    return div;
  }

  // 住宿備註（訂房編號）與付款狀態；同一間飯店的多晚一起更新
  function editHotelInfo(h) {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>備註（訂房編號、入住資訊等）</label>
      <input id="hEditNote" type="text" maxlength="60" placeholder="例：訂房編號 BK12345" value="${UI.esc(h.note || '')}">
      <label>付款狀態</label>
      <select id="hEditPay">
        <option value="">未設定</option>
        ${Object.entries(UI.PAY_LABELS).map(([v, lb]) =>
          `<option value="${v}" ${h.pay === v ? 'selected' : ''}>${lb}</option>`).join('')}
      </select>
      <label>房價紀錄（選填，會顯示在行程上）</label>
      <div class="row-2">
        <input id="hEditPw" type="number" min="0" inputmode="numeric" placeholder="平日價" value="${h.priceWeekday || ''}">
        <input id="hEditPe" type="number" min="0" inputmode="numeric" placeholder="假日價" value="${h.priceWeekend || ''}">
      </div>
      <a class="btn-outline" style="display:block;text-align:center;text-decoration:none;margin-top:4px"
         href="${UI.hotelPriceLink(h.name)}" target="_blank" rel="noopener">💲 查即時房價（可切平日／假日）</a>
      <p class="hint" style="margin-top:4px">房價由訂房網站提供，查到後可回來記在上面兩格。</p>`;
    UI.modal(`🏨 ${h.name}`, body, [
      {
        label: '💰 記房費到分帳', onClick: () => {
          UI.closeModal();
          Feat.quickExpense({ item: `${h.name} 房費`, date: trip().startDate });
        }
      },
      {
        label: '儲存', primary: true,
        onClick: () => {
          const note = document.getElementById('hEditNote').value.trim();
          const pay = document.getElementById('hEditPay').value;
          const pw = Number(document.getElementById('hEditPw').value) || '';
          const pe = Number(document.getElementById('hEditPe').value) || '';
          trip().hotels.filter(x => x.placeId === h.placeId).forEach(x => {
            x.note = note; x.pay = pay; x.priceWeekday = pw; x.priceWeekend = pe;
          });
          Store.touch();
          UI.closeModal();
          render();
          UI.toast('住宿資訊已更新');
        }
      }
    ]);
  }

  function spotRow(s, tlRow, no, d) {
    const div = document.createElement('div');
    div.className = 'spot-row';
    div.dataset.spotId = s.id;
    const stayH = s.stayMin >= 60 ? `${Math.floor(s.stayMin / 60)} 小時${s.stayMin % 60 ? ' ' + s.stayMin % 60 + ' 分' : ''}` : `${s.stayMin} 分鐘`;
    div.innerHTML = `
      <div class="spot-main">
        <span class="spot-no" style="background:${d ? dayColor(d) : 'var(--text-2)'}">${no || '·'}</span>
        <div class="spot-info">
          <div class="spot-name">${s.must ? '<span class="must">⭐</span> ' : ''}${UI.esc(s.name)}</div>
          <div class="spot-times">${tlRow ? `${tlRow.arrive} 抵達（停留 ${stayH}）→ ${tlRow.depart} 出發` : `停留 ${stayH}`}</div>
          <div class="stay-edit edit-only">
            <button data-act="stay-" aria-label="減少停留時間">−</button>
            <span class="stay-val">${stayH}</span>
            <button data-act="stay+" aria-label="增加停留時間">＋</button>
            <a href="${UI.navLink(s)}" target="_blank" rel="noopener" style="margin-left:auto;color:var(--main);font-weight:700;text-decoration:none">🧭 導航</a>
          </div>
        </div>
        <div class="spot-actions edit-only">
          <button class="drag-grip" title="按住拖曳排序（可拖到其他天）">☰</button>
          <button data-act="menu" title="更多選項">⋯</button>
        </div>
        ${Store.isReadonly() ? `<div class="spot-actions"><a href="${UI.navLink(s)}" target="_blank" rel="noopener" style="padding:6px">🧭</a></div>` : ''}
      </div>`;

    div.querySelector('[data-act="stay-"]').onclick = () => changeStay(s, -15);
    div.querySelector('[data-act="stay+"]').onclick = () => changeStay(s, 15);
    div.querySelector('[data-act="menu"]').onclick = () => spotMenu(s);
    const grip = div.querySelector('.drag-grip');
    grip.addEventListener('pointerdown', e => startDrag(e, s, div));
    return div;
  }

  function changeStay(s, delta) {
    s.stayMin = Math.min(600, Math.max(15, s.stayMin + delta));
    Store.touch();
    render();
  }

  function spotMenu(s) {
    const days = Store.days();
    const opts = [
      { label: s.must ? '取消「必去」標記' : '⭐ 標記為必去', value: 'must' },
      { label: '💰 記一筆帳（自動帶入名稱日期）', value: 'exp' }
    ];
    for (let d = 1; d <= days; d++) {
      if (d !== s.day) opts.push({ label: `📅 移到第 ${d} 天`, value: 'day' + d });
    }
    opts.push({ label: '🗑️ 從行程移除', value: 'del', danger: true });
    UI.choose(s.name, opts, v => {
      if (v === 'must') { s.must = !s.must; Store.touch(); render(); }
      else if (v === 'exp') {
        Feat.quickExpense({ item: s.name, date: s.day ? Store.dateOfDay(s.day) : trip().startDate });
      }
      else if (v === 'del') {
        UI.confirm('移除景點', `確定要把「${s.name}」從行程中移除嗎？（可用「上一步」復原）`, () => {
          const t = trip();
          t.spots = t.spots.filter(x => x.id !== s.id);
          delete t.legsByDay[s.day];
          Store.touch({ manual: true }); render();
        });
      } else if (v.startsWith('day')) {
        const d = Number(v.slice(3));
        const t = trip();
        delete t.legsByDay[s.day]; delete t.legsByDay[d];
        s.day = d;
        s.order = spotsOfDay(d).length;
        Store.touch({ manual: true }); render();
        UI.toast(`已把「${s.name}」移到第 ${d} 天`);
      }
    });
  }

  // ---------- 拖曳排序（可跨天） ----------
  let drag = null;
  function startDrag(e, spot, rowEl) {
    if (Store.isReadonly()) return;
    e.preventDefault();
    rowEl.classList.add('dragging');
    drag = { spot, rowEl, fromDay: spot.day || 0 };
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
  }
  function onDragMove(e) {
    if (!drag) return;
    // 先看有沒有落在其他景點列上（跨卡片也算）
    const rows = [...document.querySelectorAll('#dayList .spot-row[data-spot-id]')];
    for (const r of rows) {
      if (r === drag.rowEl) continue;
      const rect = r.getBoundingClientRect();
      if (e.clientY > rect.top && e.clientY < rect.bottom) {
        if (e.clientY < rect.top + rect.height / 2) r.before(drag.rowEl);
        else r.after(drag.rowEl);
        return;
      }
    }
    // 沒有列可對齊 → 若落在某張（空的）天卡片內，就放進該卡片
    for (const card of document.querySelectorAll('#dayList .day-card')) {
      const rect = card.getBoundingClientRect();
      if (e.clientY > rect.top && e.clientY < rect.bottom &&
          !card.contains(drag.rowEl) &&
          card.querySelectorAll('.spot-row[data-spot-id]').length === 0) {
        card.appendChild(drag.rowEl);
        return;
      }
    }
  }
  function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    if (!drag) return;
    const t = trip();
    const affected = new Set([drag.fromDay]);
    // 依照 DOM 目前位置，重新指定每張卡片內的 day 與順序
    document.querySelectorAll('#dayList .day-card').forEach(card => {
      const d = Number(card.dataset.day || 0);
      [...card.querySelectorAll('.spot-row[data-spot-id]')].forEach((r, i) => {
        const s = t.spots.find(x => x.id === r.dataset.spotId);
        if (!s) return;
        if (s.day !== d) { affected.add(s.day || 0); affected.add(d); }
        s.day = d; s.order = i;
      });
    });
    affected.forEach(d => delete t.legsByDay[d]);
    drag.rowEl.classList.remove('dragging');
    const moved = drag.spot.day !== drag.fromDay;
    drag = null;
    Store.touch({ manual: true });
    render();
    if (moved) UI.toast('已移到另一天');
  }

  // ---------- 導航連結 ----------
  function dayNavLink(d, list) {
    const sp = startHotel(d), ep = endHotel(d);
    const pts = list.map(s => `${s.lat},${s.lng}`);
    const origin = sp ? `${sp.lat},${sp.lng}` : pts.shift();
    // 只有 1 個景點又沒設飯店時，終點退回用起點，避免產生壞掉的導航連結
    const dest = ep ? `${ep.lat},${ep.lng}` : (pts.length ? pts.pop() : origin);
    const mode = { driving: 'driving', transit: 'transit', walking: 'walking' }[trip().transport];
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${mode}`;
    if (pts.length) url += `&waypoints=${pts.join('|')}`;
    return url;
  }

  // ================= 地圖 =================
  function mapGroups(selDay) {
    const days = Store.days();
    const groups = [];
    for (let d = 1; d <= days; d++) {
      if (selDay && d !== selDay) continue;
      const list = spotsOfDay(d);
      if (list.length) groups.push({ d, list, sp: startHotel(d), ep: endHotel(d) });
    }
    if (!groups.length && unassigned().length) {
      groups.push({ d: 0, list: unassigned(), sp: null, ep: null });
    }
    return groups;
  }

  function renderMiniMap() { drawMap($('miniMap'), null); }
  function renderFullMap(selDay) {
    drawMap($('fullMap'), selDay || null);
    const days = Store.days();
    const chips = $('mapDayChips');
    const items = ['全部', ...Array.from({ length: days }, (_, i) => `第${i + 1}天`)];
    chips.innerHTML = items.map((tt, i) =>
      `<span class="chip ${((selDay || 0) === i) ? 'on' : ''}" data-d="${i}" style="cursor:pointer;${(selDay || 0) === i ? '' : 'background:var(--white)'};${i > 0 ? `border-color:${dayColor(i)};${(selDay || 0) === i ? `background:${dayColor(i)}` : `color:${dayColor(i)}`}` : ''}">${tt}</span>`).join('');
    chips.querySelectorAll('.chip').forEach(c =>
      c.onclick = () => renderFullMap(Number(c.dataset.d)));
  }

  async function drawMap(el, selDay) {
    if (!trip()) return;
    if (Api.isMock()) { drawSvgMap(el, selDay); return; }
    try {
      await Api.loadGoogleMaps();
      drawGoogleMap(el, selDay);
    } catch (e) {
      console.warn('Google 地圖載入失敗，改用示意圖', e);
      drawSvgMap(el, selDay);
    }
  }

  // ---- 真 Google 地圖（正式模式） ----
  function drawGoogleMap(el, selDay) {
    if (!el._gmap) {
      el.innerHTML = '<div class="gmap"></div>';
      el._gmap = new google.maps.Map(el.querySelector('.gmap'), {
        center: { lat: 23.7, lng: 121 }, zoom: 8,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
        gestureHandling: 'greedy'
      });
      el._gitems = [];
    }
    el._gitems.forEach(o => o.setMap(null));
    el._gitems = [];
    const groups = mapGroups(selDay);
    if (!groups.length) return;
    const bounds = new google.maps.LatLngBounds();
    const add = o => { el._gitems.push(o); };

    for (const g of groups) {
      const color = g.d ? dayColor(g.d) : '#8C7B6B';
      const seq = [];
      if (g.sp) seq.push(g.sp);
      seq.push(...g.list);
      if (g.ep && g.ep !== g.sp) seq.push(g.ep);
      if (seq.length > 1) {
        add(new google.maps.Polyline({
          map: el._gmap, path: seq.map(p => ({ lat: p.lat, lng: p.lng })),
          strokeColor: color, strokeOpacity: .85, strokeWeight: 4
        }));
      }
      const boundaryMarker = (p, label) => add(new google.maps.Marker({
        map: el._gmap, position: { lat: p.lat, lng: p.lng }, title: p.name,
        label: { text: label, fontSize: '16px' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE, scale: 13,
          fillColor: '#FFFFFF', fillOpacity: 1, strokeColor: color, strokeWeight: 2.5
        }
      }));
      if (g.sp) boundaryMarker(g.sp, g.d === 1 && trip().meetPoint ? '🚩' : '🏨');
      g.list.forEach((s, i) => {
        add(new google.maps.Marker({
          map: el._gmap, position: { lat: s.lat, lng: s.lng }, title: s.name,
          label: { text: String(i + 1), color: '#FFFFFF', fontWeight: '700' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE, scale: 13,
            fillColor: color, fillOpacity: 1, strokeColor: '#FFFFFF', strokeWeight: 2
          }
        }));
        bounds.extend({ lat: s.lat, lng: s.lng });
      });
      if (g.ep && g.ep !== g.sp) boundaryMarker(g.ep, g.d === Store.days() && trip().endPoint ? '🏁' : '🏨');
      if (g.sp) bounds.extend({ lat: g.sp.lat, lng: g.sp.lng });
      if (g.ep) bounds.extend({ lat: g.ep.lat, lng: g.ep.lng });
    }
    el._gmap.fitBounds(bounds, 46);
  }

  // ---- 示意 SVG 地圖（模擬模式） ----
  function drawSvgMap(el, selDay) {
    const groups = mapGroups(selDay);
    if (!groups.length) {
      el.innerHTML = `<svg class="mock-map" viewBox="0 0 400 300">
        <text x="200" y="150" text-anchor="middle" fill="#8C7B6B" font-size="15">加入景點後，路線會畫在這裡</text>
      </svg>`;
      return;
    }
    const pts = [];
    groups.forEach(g => {
      g.list.forEach(s => pts.push(s));
      if (g.sp) pts.push(g.sp);
      if (g.ep) pts.push(g.ep);
    });
    const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats);
    const minLo = Math.min(...lngs), maxLo = Math.max(...lngs);
    const pad = 38, W = 400, H = 300;
    const X = p => pad + (maxLo === minLo ? .5 : (p.lng - minLo) / (maxLo - minLo)) * (W - pad * 2);
    const Y = p => pad + (maxLa === minLa ? .5 : (maxLa - p.lat) / (maxLa - minLa)) * (H - pad * 2);

    let svg = `<svg class="mock-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
    for (const g of groups) {
      const seq = [];
      if (g.sp) seq.push(g.sp);
      seq.push(...g.list);
      if (g.ep && g.ep !== g.sp) seq.push(g.ep);
      if (seq.length > 1) {
        svg += `<polyline class="road" style="stroke:${g.d ? dayColor(g.d) : '#8C7B6B'}" points="${seq.map(p => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')}"/>`;
      }
    }
    for (const g of groups) {
      const color = g.d ? dayColor(g.d) : '#8C7B6B';
      if (g.sp) svg += `<text x="${X(g.sp)}" y="${Y(g.sp) + 5}" text-anchor="middle" font-size="16">${g.d === 1 && trip().meetPoint ? '🚩' : '🏨'}</text>`;
      g.list.forEach((s, i) => {
        const short = s.name.length > 6 ? s.name.slice(0, 6) + '…' : s.name;
        svg += `<circle cx="${X(s)}" cy="${Y(s)}" r="11" fill="${color}"/>
          <text class="marker-t" x="${X(s)}" y="${Y(s) + 4.5}">${i + 1}</text>
          <text class="marker-label" x="${X(s)}" y="${Y(s) + 24}">${UI.esc(short)}</text>`;
      });
      if (g.ep && g.ep !== g.sp) svg += `<text x="${X(g.ep)}" y="${Y(g.ep) + 5}" text-anchor="middle" font-size="16">${g.d === Store.days() && trip().endPoint ? '🏁' : '🏨'}</text>`;
    }
    svg += `</svg>`;
    el.innerHTML = svg + `<div class="map-badge">示意地圖（正式版為 Google 地圖）</div>`;
  }

  // ---------- 地圖高度拖曳把手 ----------
  function initDragHandle() {
    const handle = $('dragHandle');
    handle.addEventListener('pointerdown', e => {
      const startY = e.clientY;
      const startH = $('mapPane').getBoundingClientRect().height;
      const move = ev => {
        const h = Math.min(window.innerHeight * .6, Math.max(90, startH + ev.clientY - startY));
        document.documentElement.style.setProperty('--map-h', h + 'px');
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        const mini = $('miniMap');
        if (mini._gmap) google.maps.event.trigger(mini._gmap, 'resize');
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  function init() {
    initSpotInput();
    initOptimize();
    initDragHandle();
  }

  return {
    init, render, renderFullMap, addSpot, openAddSpot,
    spotsOfDay, unassigned, dayCenter, startHotel, endHotel, legsForDay
  };
})();
