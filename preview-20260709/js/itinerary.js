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

  function sameRoutePoint(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    const ap = a.p || {}, bp = b.p || {};
    if (ap === bp) return true;
    if (a.kind === 'hotel') return String(ap.placeId || '') === String(bp.placeId || '') &&
      Number(ap.night) === Number(bp.night);
    return String(ap.placeId || ap.name || '') === String(bp.placeId || bp.name || '');
  }

  function pointEmptyDayText(point) {
    if (point.kind === 'hotel') return `${hotelNightLabel(point.p.night)}住宿`;
    return point.kind === 'meet' ? '集合地' : '解散地';
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
    const list = spotsOfDay(day).filter(Logic.hasCoords);
    const pool = list.length ? list : trip().spots.filter(Logic.hasCoords);
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
    const placeId = place.placeId || ('custom-' + Logic.uid());
    if (t.spots.some(s => s.placeId === placeId)) { UI.toast('這個景點已經在清單裡囉'); return false; }
    const day = (opt && opt.day) || 0;
    const hasCoords = Logic.hasCoords(place);
    t.spots.push({
      id: Logic.uid(), placeId, source: place.source || (String(placeId).startsWith('custom-') ? 'custom' : 'google'),
      name: place.name, address: place.address || '',
      lat: place.lat, lng: place.lng, rating: place.rating || 0, photo: place.photo || '',
      hasCoords, estimateWarning: hasCoords ? '' : '沒有座標，路程無法精準估算',
      stayMin: CONFIG.defaults.stayMin, must: false, note: place.note || '',
      day, order: day ? spotsOfDay(day).length : t.spots.length
    });
    if (day) delete t.legsByDay[day];
    Store.touch(day ? { manual: true } : undefined);
    UI.toast(hasCoords ? `已加入「${place.name}」${day ? `到第 ${day} 天` : ''}` : `已加入「${place.name}」，但沒有座標，路程會略過估算`);
    render();
    return true;
  }

  // 針對某一天加景點（每日卡片上的 ➕）
  function openAddSpot(d) {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>從 Google 搜尋景點</label>
      <input type="text" id="addSpotInp" placeholder="輸入景點名稱，例如：鵝鑾鼻燈塔" autocomplete="off">
      <div class="result-list" id="addSpotRes"></div>
      <div class="card" style="margin-top:12px;background:var(--white)">
        <label>找不到時，改用自訂景點</label>
        <input type="text" id="customSpotName" placeholder="景點名稱，例如：朋友推薦小店">
        <input type="text" id="customSpotAddress" placeholder="地址或備註位置，可空白">
        <div class="row-2">
          <input type="number" step="any" id="customSpotLat" placeholder="緯度 DD，可空白">
          <input type="number" step="any" id="customSpotLng" placeholder="經度 DD，可空白">
        </div>
        <input type="text" id="customSpotNote" placeholder="使用者備註，可空白" maxlength="80">
        <p class="hint">座標可以不填，但未填座標時不會納入精準路程估算。</p>
        <button id="btnAddCustomSpot" class="btn-outline" style="width:100%">加入自訂景點</button>
      </div>`;
    const inp = body.querySelector('#addSpotInp');
    const res = body.querySelector('#addSpotRes');
    body.querySelector('#btnAddCustomSpot').onclick = () => {
      const name = body.querySelector('#customSpotName').value.trim();
      const address = body.querySelector('#customSpotAddress').value.trim();
      const latRaw = body.querySelector('#customSpotLat').value.trim();
      const lngRaw = body.querySelector('#customSpotLng').value.trim();
      const note = body.querySelector('#customSpotNote').value.trim();
      if (!name) { UI.toast('請輸入自訂景點名稱'); return; }
      const hasLat = latRaw !== '', hasLng = lngRaw !== '';
      if (hasLat !== hasLng) { UI.toast('座標請同時填緯度與經度，或兩個都空白'); return; }
      const lat = hasLat ? Number(latRaw) : null;
      const lng = hasLng ? Number(lngRaw) : null;
      if (hasLat && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
        UI.toast('座標格式不對，請使用十進制度 DD');
        return;
      }
      addSpot({ source: 'custom', name, address, lat, lng, note }, { day: d });
      UI.closeModal();
    };
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
      const routable = all.filter(Logic.hasCoords);
      const skipped = all.filter(s => !Logic.hasCoords(s));
      if (routable.length < 2) {
        UI.loading(false);
        UI.alert('座標不足', '至少需要 2 個有座標的景點，才能計算最佳路線。\n\n沒有座標的自訂景點會保留在原本天數，但不參與路線排序。');
        return;
      }
      const prevDayOf = {}; routable.forEach(s => prevDayOf[s.id] = s.day);
      const days = Store.days();
      const o1 = Logic.hasCoords(startHotel(1)) ? startHotel(1) : null;
      const oN = Logic.hasCoords(endHotel(days)) ? endHotel(days) : o1;

      // 1) 全體排序
      const g = await Api.optimizeRoute(o1, oN, routable, t.transport);
      const ordered = g.order.map(i => routable[i]);

      // 2) 依每日活動時間切天
      const dayArrs = Logic.splitIntoDays(ordered, {
        days,
        dayStartMin: Logic.toMin(t.dayStart),
        dayEndMin: Logic.toMin(t.dayEnd),
        travelMin: (a, b) => Logic.travelMinutes(a, b, t.transport),
        hotelOfDay: d => {
          const h = startHotel(d + 1);
          return Logic.hasCoords(h) ? h : null;
        }
      });

      // 3) 每天以起終點（集合地/飯店/解散地）再最佳化
      t.legsByDay = {};
      for (let d = 1; d <= days; d++) {
        const listD = dayArrs[d - 1];
        if (!listD.length) continue;
        const r = await Api.optimizeRoute(
          Logic.hasCoords(startHotel(d)) ? startHotel(d) : null,
          Logic.hasCoords(endHotel(d)) ? endHotel(d) : null,
          listD,
          t.transport,
          { onProgress: (done, total) => UI.loading(true, `第 ${d} 天：查詢真實車程 ${done}/${total} 段…`) }
        );
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

      const pushed = routable.filter(s => s.must && prevDayOf[s.id] > 0 && s.day > prevDayOf[s.id]);
      if (pushed.length) {
        UI.alert('必去景點被移到隔天了',
          `因為一天排不下，這些「必去」景點被移到後面的天數：\n\n` +
          pushed.map(s => `⭐ ${s.name}（第 ${s.day} 天）`).join('\n') +
          `\n\n可以縮短其他景點的停留時間，或手動把它拖回想去的那天。`);
      } else if (skipped.length) {
        UI.alert('最佳路線排好了',
          `已排序有座標的景點。\n\n以下 ${skipped.length} 個地點沒有座標，已保留在原本天數，未納入路線計算：\n\n` +
          skipped.map(s => `・${s.name}`).join('\n'));
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
    const hasRoutePlan = Boolean(t.meetPoint || t.endPoint || (t.hotels || []).length);
    const showDays = anySpot || hasRoutePlan;
    $('tripEmpty').classList.toggle('hidden', showDays);
    $('tripSummaryBar').classList.toggle('hidden', !showDays);

    const fab = $('btnOptimize');
    fab.disabled = t.spots.length < 2;
    fab.classList.toggle('glow', t.spots.length >= 2 && !t.optimizedAt);

    if (showDays) renderSummaryBar();

    const wrap = $('dayList');
    wrap.innerHTML = '';
    const un = unassigned();
    if (un.length) wrap.appendChild(renderUnassignedCard(un));
    for (let d = 1; d <= days; d++) {
      if (!showDays) continue; // 完全沒景點與住宿/集合點時只顯示空狀態引導
      wrap.appendChild(renderDayCard(d, spotsOfDay(d)));
    }
    renderMiniMap();
    Feat.fillWeather();
  }

  function renderSummaryBar() {
    const t = trip();
    const modeTxt = { driving: '🚗 開車', transit: '🚇 大眾運輸', walking: '🚶 走路' };
    const visitedCount = t.spots.filter(s => s.visited).length;
    $('tripSummaryBar').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${UI.esc(t.name)}｜<button id="btnTripDates" class="chip" style="cursor:pointer" title="變更旅遊天數">🗓️ ${t.startDate.slice(5).replace('-', '/')}–${t.endDate.slice(5).replace('-', '/')} ▾</button>｜${t.spots.length} 個景點${visitedCount ? `｜✅ 已去 ${visitedCount}/${t.spots.length}` : ''}</span>
        <span style="display:flex;gap:6px;align-items:center">
          <span class="undo-btns edit-only">
            <button id="btnUndo" ${Store.canUndo() ? '' : 'disabled'}>↩ 上一步</button>
            <button id="btnRedo" ${Store.canRedo() ? '' : 'disabled'}>↪ 下一步</button>
            <button id="btnManualSave">💾 儲存目前安排</button>
          </span>
          <button id="btnSwitchMode" class="chip" style="cursor:pointer">${modeTxt[t.transport]} ▾</button>
        </span>
      </div>
      <p class="hint" style="margin:6px 0 0">⏱️ 預估時間僅供參考，實際可能因路線、路況或營業時間而有所不同</p>`;
    $('btnUndo').onclick = () => { if (Store.undo()) { render(); UI.toast('已復原上一步'); } };
    $('btnRedo').onclick = () => { if (Store.redo()) { render(); UI.toast('已重做下一步'); } };
    $('btnManualSave').onclick = async () => {
      try {
        UI.loading(true, '儲存目前安排…');
        await Store.cloudSaveNow();
        UI.loading(false);
        UI.toast('目前手動安排已儲存');
      } catch (e) {
        UI.loading(false);
        UI.alert('儲存失敗', e.message || String(e));
      }
    };
    const dBtn = $('btnTripDates');
    if (Store.isReadonly()) dBtn.style.pointerEvents = 'none';
    else dBtn.onclick = () => Feat.editTripDates();
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

  function missingCoordNames(list, extraPoints) {
    const all = [...(list || []), ...(extraPoints || [])].filter(Boolean);
    return all.filter(p => !Logic.hasCoords(p)).map(p => p.name || '未命名地點');
  }

  function renderDayCard(d, list) {
    const t = trip();
    const dateISO = Store.dateOfDay(d);
    const sp = startPoint(d), ep = endPoint(d);
    const legs = legsForDay(d);
    const tl = Logic.buildTimeline(list, legs, dayStartOf(d));
    const noCoord = missingCoordNames(list, [sp && sp.p, ep && ep.p]);
    const estimateHint = noCoord.length
      ? `<div class="rain-alert" style="border-color:var(--danger);background:#FFF4EF">⚠️ ${noCoord.length} 個地點沒有座標，路程會略過或不精準：${noCoord.map(UI.esc).join('、')}</div>`
      : '';

    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.day = d;

    const dateTxt = `${Number(dateISO.slice(5, 7))}/${Number(dateISO.slice(8, 10))}`;
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `
      <div class="day-head-top">
        <span class="day-title" style="color:${dayColor(d)}">第 ${d} 天 <span style="font-weight:400;color:var(--text-2);font-size:.95rem">${dateTxt}</span>${list.some(s => s.visited) ? ` <span style="font-size:.9rem;color:var(--ok)">✅ ${list.filter(s => s.visited).length}/${list.length}</span>` : ''}</span>
        <span class="day-weather" data-day-weather="${d}">☁️ 查天氣中…</span>
      </div>
      <div class="day-outfit" data-day-outfit="${d}"></div>
      ${estimateHint}
      <div data-rain-slot="${d}"></div>
      ${list.length ? `<p class="hint" style="margin-top:4px">車程 ${Logic.fmtDur(tl.totalTravel)}｜停留 ${Logic.fmtDur(tl.totalStay)}｜預計 ${tl.endTime} 結束</p>` : ''}
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
      if (sp) card.appendChild(pointRow(sp, pointEmptyDayText(sp)));
      const shouldShowEmptyLeg = sp && ep && !sameRoutePoint(sp, ep) && legs[0] > 0 && !(sp.kind === 'hotel' && ep.kind === 'hotel');
      if (shouldShowEmptyLeg) card.appendChild(legRow(legs[0]));
      if (ep && !sameRoutePoint(sp, ep)) card.appendChild(pointRow(ep, pointEmptyDayText(ep)));
      const p = document.createElement('p');
      p.className = 'hint'; p.style.padding = '0 14px 12px';
      p.textContent = (sp || ep)
        ? '這天還沒有景點，但住宿已列出。按上面的「➕ 加景點」，或按住 ☰ 把景點拖過來。'
        : '這天還沒有景點：按上面的「➕ 加景點」，或按住 ☰ 把景點拖過來。';
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
    div.innerHTML = `↓ ${icon} 車程約 ${Logic.fmtDur(min)}`;
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
    const coordWarning = Logic.hasCoords(p) ? '' : `<div class="spot-times" style="color:var(--danger)">⚠️ 沒有座標，路程無法精準估算</div>`;
    const mapLink = Logic.hasCoords(p) || p.name ? `<a href="${UI.gmapLink(p)}" target="_blank" rel="noopener" style="padding:6px">📍</a>` : '';
    div.innerHTML = `
      <div class="spot-main">
        ${p.photo ? `<img class="thumb thumb-sm" src="${p.photo}" alt="">` : `<span class="spot-no hotel">${icon}</span>`}
        <div class="spot-info">
          <div class="spot-name">${kind !== 'hotel' ? icon + ' ' : ''}${UI.esc(p.name)} ${payTag}</div>
          <div class="spot-times">${timeTxt}</div>
          ${p.address ? `<div class="spot-times addr-line">📍 ${UI.esc(p.address)}</div>` : ''}
          ${kind === 'hotel' && p.note ? `<div class="spot-times">📝 ${UI.esc(p.note)}</div>` : ''}
          ${priceTxt}
          ${coordWarning}
        </div>
        <div class="spot-actions">
          ${kind === 'hotel' ? `<button class="drag-grip edit-only" data-act="hdrag" title="按住拖曳，把住宿移到其他天">☰</button>
          <button class="edit-only" data-act="hedit" title="編輯住宿備註">✎</button>` : ''}
          ${mapLink}
        </div>
      </div>`;
    const thumb = div.querySelector('.thumb');
    if (thumb) thumb.onclick = () => UI.photoZoom(p.photo, p.name);
    const he = div.querySelector('[data-act="hedit"]');
    if (he) he.onclick = () => editHotelInfo(p);
    const hd = div.querySelector('[data-act="hdrag"]');
    if (hd && kind === 'hotel') hd.addEventListener('pointerdown', e => startHotelDrag(e, p, div));
    return div;
  }

  // ---------- 住宿拖曳到其他天（獨立於景點拖曳：住宿是「晚」不是「日間景點」） ----------
  let hotelDrag = null;
  function hotelNightLabel(night) {
    return `第 ${Number(night) + 1} 晚`;
  }
  function sortHotels() {
    trip().hotels.sort((a, b) =>
      (Number(a.night) || 0) - (Number(b.night) || 0) ||
      String(a.name || '').localeCompare(String(b.name || '')));
  }
  function hotelAtNightExcept(hotel, night) {
    return trip().hotels.find(x => x !== hotel && Number(x.night) === Number(night)) || null;
  }
  function applyHotelNightMove(hotel, newNight) {
    const t = trip();
    t.hotels = t.hotels.filter(x => x !== hotel && Number(x.night) !== Number(newNight));
    hotel.night = Number(newNight);
    t.hotels.push(hotel);
    sortHotels();
    t.legsByDay = {};
  }
  function hotelDropTargetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const card = el && el.closest ? el.closest('#dayList .day-card') : null;
    return card && Number(card.dataset.day) > 0 ? card : null;
  }
  function markHotelDropTarget(target) {
    document.querySelectorAll('#dayList .day-card').forEach(card =>
      card.classList.toggle('drop-target', card === target));
  }
  function startHotelDrag(e, hotel, rowEl) {
    if (Store.isReadonly()) return;
    e.preventDefault();
    rowEl.classList.add('dragging');
    hotelDrag = { hotel, rowEl };
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onHotelDragMove);
    document.addEventListener('pointerup', onHotelDragEnd, { once: true });
  }
  function onHotelDragMove(e) {
    if (!hotelDrag) return;
    markHotelDropTarget(hotelDropTargetAt(e.clientX, e.clientY));
  }
  function onHotelDragEnd(e) {
    document.removeEventListener('pointermove', onHotelDragMove);
    if (!hotelDrag) return;
    const { hotel, rowEl } = hotelDrag;
    hotelDrag = null;
    rowEl.classList.remove('dragging');
    const target = hotelDropTargetAt(e.clientX, e.clientY) ||
      [...document.querySelectorAll('#dayList .day-card.drop-target')][0];
    document.querySelectorAll('#dayList .day-card').forEach(c => c.classList.remove('drop-target'));
    if (!target) return;
    const d = Number(target.dataset.day);
    const t = trip();
    const maxNight = Math.max(Store.days() - 1, 1);
    const newNight = d - 1; // 拖到第 d 天 = 第 d 天晚上入住
    if (newNight >= maxNight) { UI.toast(`第 ${d} 天是最後一天，沒有過夜，住宿無法移過去`); return; }
    if (newNight === hotel.night) return;
    const doMove = () => {
      applyHotelNightMove(hotel, newNight);
      Store.touch({ manual: true });
      render();
      UI.alert('住宿已移動', `「${hotel.name}」已改為${hotelNightLabel(newNight)}入住。\n\n⚠️ 住宿變動會改變路線的起終點，車程已重新估算；建議再按一次「一鍵排最佳路線」。`);
    };
    const occupied = hotelAtNightExcept(hotel, newNight);
    if (occupied) {
      UI.confirm('目標晚已有住宿', `${hotelNightLabel(newNight)}已是「${occupied.name}」。要換成「${hotel.name}」嗎？`, doMove);
    } else doMove();
  }

  // 住宿備註（訂房編號）與付款狀態；同一間飯店的多晚一起更新
  function editHotelInfo(h) {
    const isCustom = h.source === 'custom' || String(h.placeId || '').startsWith('custom');
    const body = document.createElement('div');
    body.innerHTML = `
      <label>地址</label>
      <input id="hEditAddr" type="text" maxlength="80" placeholder="輸入或修改地址" value="${UI.esc(h.address || '')}">
      ${isCustom ? `
      <label>座標（十進制度 DD，選填）</label>
      <div class="row-2">
        <input id="hEditLat" type="number" step="any" placeholder="緯度，例 25.0339" value="${Logic.hasCoords(h) ? h.lat : ''}">
        <input id="hEditLng" type="number" step="any" placeholder="經度，例 121.5645" value="${Logic.hasCoords(h) ? h.lng : ''}">
      </div>
      <p class="hint">補上座標後，路程就能精準估算。</p>` : ''}
      <label>備註（訂房編號、入住資訊等）</label>
      <input id="hEditNote" type="text" maxlength="60" placeholder="例：訂房編號 BK12345" value="${UI.esc(h.note || '')}">
      <label>付款狀態</label>
      <select id="hEditPay">
        <option value="">未設定</option>
        ${Object.entries(UI.PAY_LABELS).map(([v, lb]) =>
          `<option value="${v}" ${h.pay === v ? 'selected' : ''}>${lb}</option>`).join('')}
      </select>
      <label>住宿夜晚（第 1 晚 = 第 1 天晚上）</label>
      <select id="hEditNight">
        ${Array.from({ length: Math.max(Store.days() - 1, 1) }, (_, i) =>
          `<option value="${i}" ${Number(h.night) === i ? 'selected' : ''}>第 ${i + 1} 晚</option>`).join('')}
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
        label: '刪除這晚住宿', danger: true,
        onClick: () => {
          UI.confirm('刪除住宿？', `確定要刪除「${h.name}」這晚住宿嗎？相關天數的路程會重新估算。`, () => {
            const t = trip();
            t.hotels = t.hotels.filter(x => !(x.night === h.night && x.placeId === h.placeId));
            t.legsByDay = {};
            Store.touch({ manual: true });
            UI.closeModal();
            render();
            UI.toast('住宿已刪除');
          });
        }
      },
      {
        label: '儲存', primary: true,
        onClick: async () => {
          const note = document.getElementById('hEditNote').value.trim();
          const pay = document.getElementById('hEditPay').value;
          const night = Number(document.getElementById('hEditNight').value);
          const pw = Number(document.getElementById('hEditPw').value) || '';
          const pe = Number(document.getElementById('hEditPe').value) || '';
          const addr = document.getElementById('hEditAddr').value.trim();
          let nextLat = h.lat;
          let nextLng = h.lng;
          let nextHasCoords = h.hasCoords;
          let nextEstimateWarning = h.estimateWarning || '';
          let locatedByAddress = false;
          if (isCustom) {
            const latRaw = document.getElementById('hEditLat').value.trim();
            const lngRaw = document.getElementById('hEditLng').value.trim();
            if ((latRaw !== '') !== (lngRaw !== '')) { UI.toast('座標請同時填緯度與經度，或兩個都空白'); return; }
            if (latRaw !== '') {
              const lat = Number(latRaw), lng = Number(lngRaw);
              if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                UI.toast('座標格式不對，請使用十進制度 DD'); return;
              }
              nextLat = lat; nextLng = lng; nextHasCoords = true; nextEstimateWarning = '';
            } else if (addr) {
              // 沒填座標但有地址 → 用 Google 地圖自動定位
              UI.loading(true, '用地址定位中…');
              const geo = await Api.geocodeAddress(addr);
              UI.loading(false);
              if (geo) {
                nextLat = geo.lat; nextLng = geo.lng; nextHasCoords = true; nextEstimateWarning = '';
                locatedByAddress = true;
              } else {
                nextLat = null; nextLng = null; nextHasCoords = false;
                nextEstimateWarning = '沒有座標，住宿路程無法精準估算';
              }
            } else {
              nextLat = null; nextLng = null; nextHasCoords = false;
              nextEstimateWarning = '沒有座標，住宿路程無法精準估算';
            }
          }
          const applySave = () => {
            h.address = addr;
            if (isCustom) {
              h.lat = nextLat; h.lng = nextLng; h.hasCoords = nextHasCoords; h.estimateWarning = nextEstimateWarning;
            }
            h.note = note; h.pay = pay; h.priceWeekday = pw; h.priceWeekend = pe;
            if (night !== h.night) applyHotelNightMove(h, night);
            else { trip().legsByDay = {}; sortHotels(); }
            Store.touch({ manual: true });
            UI.closeModal();
            render();
            UI.toast(locatedByAddress ? '已從地址定位，住宿資訊已更新' : '住宿資訊已更新');
          };
          const occupied = night !== h.night ? hotelAtNightExcept(h, night) : null;
          if (occupied) {
            UI.confirm('目標晚已有住宿', `${hotelNightLabel(night)}已是「${occupied.name}」。要換成「${h.name}」嗎？`, applySave);
          } else applySave();
        }
      }
    ]);
  }

  function spotRow(s, tlRow, no, d) {
    const div = document.createElement('div');
    div.className = 'spot-row';
    div.dataset.spotId = s.id;
    const stayH = Logic.fmtDur(s.stayMin);
    const coordWarning = Logic.hasCoords(s) ? '' : `<div class="spot-times" style="color:var(--danger)">⚠️ 沒有座標，路程無法精準估算</div>`;
    const noteLine = s.note ? `<div class="spot-times">備註：${UI.esc(s.note)}</div>` : '';
    const navAction = Logic.hasCoords(s)
      ? `<a href="${UI.navLink(s)}" target="_blank" rel="noopener" style="margin-left:auto;color:var(--main);font-weight:700;text-decoration:none">🧭 導航</a>`
      : `<span class="hint" style="margin-left:auto">無座標不可導航</span>`;
    if (s.visited) div.classList.add('visited');
    div.innerHTML = `
      <div class="spot-main">
        <span class="spot-no" style="background:${s.visited ? 'var(--ok)' : (d ? dayColor(d) : 'var(--text-2)')}">${s.visited ? '✓' : (no || '·')}</span>
        <div class="spot-info">
          <div class="spot-name">${s.must ? '<span class="must">⭐</span> ' : ''}${UI.esc(s.name)}${s.visited ? ' <span class="visited-badge">已去過</span>' : ''}</div>
          <div class="spot-times">${tlRow ? `${tlRow.arrive} 抵達（停留 ${stayH}）→ ${tlRow.depart} 出發` : `停留 ${stayH}`}</div>
          ${noteLine}
          ${coordWarning}
          <div class="stay-edit edit-only">
            <button data-act="stay-" aria-label="減少停留時間">−</button>
            <span class="stay-val">${stayH}</span>
            <button data-act="stay+" aria-label="增加停留時間">＋</button>
            ${navAction}
          </div>
        </div>
        <div class="spot-actions edit-only">
          <button class="drag-grip" title="按住拖曳排序（可拖到其他天）">☰</button>
          <button data-act="visited" title="${s.visited ? '取消已去過' : '標記已去過'}">${s.visited ? '☑' : '☐'}</button>
          <button data-act="note" title="編輯備註">📝</button>
          <button data-act="must" title="標記必去">${s.must ? '★' : '☆'}</button>
          <button data-act="exp" title="記一筆帳">💰</button>
          <button data-act="del" title="刪除景點">🗑</button>
          <button data-act="menu" title="更多選項">⋯</button>
        </div>
        ${Store.isReadonly() ? `<div class="spot-actions"><a href="${UI.navLink(s)}" target="_blank" rel="noopener" style="padding:6px">🧭</a></div>` : ''}
      </div>`;

    div.querySelector('[data-act="stay-"]').onclick = () => changeStay(s, -15);
    div.querySelector('[data-act="stay+"]').onclick = () => changeStay(s, 15);
    div.querySelector('[data-act="visited"]').onclick = () => {
      s.visited = !s.visited;
      Store.touch();
      render();
      if (s.visited) UI.toast(`✅ 「${s.name}」打卡完成！`);
    };
    div.querySelector('[data-act="note"]').onclick = () => editSpotNote(s);
    div.querySelector('[data-act="must"]').onclick = () => { s.must = !s.must; Store.touch(); render(); };
    div.querySelector('[data-act="exp"]').onclick = () =>
      Feat.quickExpense({ item: s.name, date: s.day ? Store.dateOfDay(s.day) : trip().startDate });
    div.querySelector('[data-act="del"]').onclick = () => deleteSpot(s);
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

  function editSpotNote(s) {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>景點備註</label>
      <input id="spotNoteInput" type="text" maxlength="120" placeholder="例：必買伴手禮、停車位置、門票提醒" value="${UI.esc(s.note || '')}">
      <label>地址 / 位置備註</label>
      <input id="spotAddressInput" type="text" maxlength="120" placeholder="可補充地址或集合點" value="${UI.esc(s.address || '')}">
      <p class="hint">備註會顯示在景點卡片上。</p>`;
    UI.modal(`📝 ${s.name}`, body, [{
      label: '儲存', primary: true,
      onClick: () => {
        s.note = document.getElementById('spotNoteInput').value.trim();
        s.address = document.getElementById('spotAddressInput').value.trim();
        Store.touch({ manual: true });
        UI.closeModal();
        render();
        UI.toast('景點備註已更新');
      }
    }]);
    setTimeout(() => document.getElementById('spotNoteInput').focus(), 50);
  }

  function deleteSpot(s) {
    UI.confirm('移除景點', `確定要把「${s.name}」從行程中移除嗎？（可用「上一步」復原）`, () => {
      const t = trip();
      t.spots = t.spots.filter(x => x.id !== s.id);
      delete t.legsByDay[s.day];
      Store.touch({ manual: true });
      render();
    });
  }

  function spotMenu(s) {
    const days = Store.days();
    const opts = [];
    for (let d = 1; d <= days; d++) {
      if (d !== s.day) opts.push({ label: `📅 移到第 ${d} 天`, value: 'day' + d });
    }
    if (!opts.length) { UI.toast('沒有其他天可移動'); return; }
    UI.choose(s.name, opts, v => {
      if (v.startsWith('day')) {
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
    const pts = list.filter(Logic.hasCoords).map(s => `${s.lat},${s.lng}`);
    if (!pts.length && !Logic.hasCoords(sp) && !Logic.hasCoords(ep)) return 'https://www.google.com/maps';
    const origin = Logic.hasCoords(sp) ? `${sp.lat},${sp.lng}` : pts.shift();
    // 只有 1 個景點又沒設飯店時，終點退回用起點，避免產生壞掉的導航連結
    const dest = Logic.hasCoords(ep) ? `${ep.lat},${ep.lng}` : (pts.length ? pts.pop() : origin);
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
      const list = spotsOfDay(d).filter(Logic.hasCoords);
      const sp = startHotel(d), ep = endHotel(d);
      if (list.length) groups.push({ d, list, sp: Logic.hasCoords(sp) ? sp : null, ep: Logic.hasCoords(ep) ? ep : null });
    }
    const unassignedWithCoords = unassigned().filter(Logic.hasCoords);
    if (!groups.length && unassignedWithCoords.length) {
      groups.push({ d: 0, list: unassignedWithCoords, sp: null, ep: null });
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
    el._gitems.forEach(o => o.setMap ? o.setMap(null) : o.close()); // InfoWindow 用 close()
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

      // 選了單一天：地圖上直接顯示景點名稱＋照片，以及每段路程時間
      if (selDay > 0 && g.d === selDay) {
        const openIw = (position, content, offsetY) => {
          const iw = new google.maps.InfoWindow({
            position, content, disableAutoPan: true, headerDisabled: true,
            pixelOffset: new google.maps.Size(0, offsetY || 0)
          });
          iw.open({ map: el._gmap });
          add(iw);
        };
        g.list.forEach((s, i) => {
          openIw({ lat: s.lat, lng: s.lng },
            `<div class="map-poi">${s.photo ? `<img src="${s.photo}" alt="">` : ''}<span>${i + 1}. ${UI.esc(s.name)}</span></div>`, -16);
        });
        const legs = legsForDay(g.d);
        const icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[trip().transport] || '🚗';
        let prev = g.sp;
        const pairs = [];
        g.list.forEach((s, i) => { if (prev && legs[i] > 0) pairs.push([prev, s, legs[i]]); prev = s; });
        if (g.ep && legs[g.list.length] > 0 && prev) pairs.push([prev, g.ep, legs[g.list.length]]);
        pairs.forEach(([a, b, min]) => {
          openIw({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 },
            `<div class="map-leg">${icon} ${Logic.fmtDur(min)}</div>`);
        });
      }
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

      // 選了單一天：路段上顯示車程時間
      if (selDay > 0 && g.d === selDay) {
        const legs = legsForDay(g.d);
        let prev = g.sp;
        const pairs = [];
        g.list.forEach((s, i) => { if (prev && legs[i] > 0) pairs.push([prev, s, legs[i]]); prev = s; });
        if (g.ep && legs[g.list.length] > 0 && prev) pairs.push([prev, g.ep, legs[g.list.length]]);
        pairs.forEach(([a, b, min]) => {
          svg += `<text class="leg-label" x="${((X(a) + X(b)) / 2).toFixed(1)}" y="${((Y(a) + Y(b)) / 2 - 4).toFixed(1)}">${Logic.fmtDur(min)}</text>`;
        });
      }
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
