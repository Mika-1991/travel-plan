// ============================================================
// 行程頁：景點輸入、一鍵最佳路線、行程表（分天＋時間軸）、地圖、雨天備案
// ============================================================
const Itin = (() => {

  const $ = id => document.getElementById(id);
  const trip = () => Store.get();

  // ---------- 起終點飯店 ----------
  // day: 1-based。起點＝前一晚飯店（第1天用當晚）；終點＝當晚飯店（最後一天不回飯店）
  function startHotel(day) {
    return Store.hotelOfNight(day - 2) || Store.hotelOfNight(day - 1) || null;
  }
  function endHotel(day) {
    return Store.hotelOfNight(day - 1) || null;
  }

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
    if (cached && cached.length === list.length + 1) return cached;
    const sh = startHotel(day), eh = endHotel(day);
    const legs = [];
    let prev = sh;
    for (const s of list) {
      legs.push(prev ? Logic.travelMinutes(prev, s, trip().transport) : 0);
      prev = s;
    }
    legs.push(eh && prev ? Logic.travelMinutes(prev, eh, trip().transport) : 0);
    return legs;
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
    if (t.spots.some(s => s.placeId === place.placeId)) { UI.toast('這個景點已經在清單裡囉'); return; }
    t.spots.push({
      id: Logic.uid(), placeId: place.placeId, name: place.name, address: place.address || '',
      lat: place.lat, lng: place.lng, rating: place.rating || 0,
      stayMin: CONFIG.defaults.stayMin, must: false, note: '',
      day: (opt && opt.day) || 0,
      order: t.spots.length
    });
    Store.touch();
    UI.toast(`已加入「${place.name}」`);
    render();
  }

  // ================= 一鍵最佳路線 =================
  function initOptimize() {
    $('btnOptimize').onclick = () => {
      const n = trip().spots.length;
      if (n < 2) { UI.toast('先加入至少 2 個景點，才能排路線喔'); return; }
      if (Store.isManualDirty() && trip().optimizedAt) {
        UI.confirm('重新排最佳路線？',
          '你之前手動調整過景點順序，重新排路線會覆蓋你調整的結果。確定要繼續嗎?'.replace('嗎?', '嗎？'),
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

      // 3) 每天以飯店為起終點再最佳化
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

      // 必去被擠到後面的提醒
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

    // 主按鈕狀態（空狀態引導：滿 2 個景點開始發亮）
    const fab = $('btnOptimize');
    fab.disabled = t.spots.length < 2;
    fab.classList.toggle('glow', t.spots.length >= 2 && !t.optimizedAt);

    if (anySpot) renderSummaryBar();

    const wrap = $('dayList');
    wrap.innerHTML = '';
    const un = unassigned();
    if (un.length) wrap.appendChild(renderUnassignedCard(un));
    for (let d = 1; d <= days; d++) {
      const list = spotsOfDay(d);
      if (!list.length && !un.length && days === 1) continue;
      if (!list.length && !t.optimizedAt) continue; // 還沒排過就不show空的天
      wrap.appendChild(renderDayCard(d, list));
    }
    renderMiniMap();
    Feat.fillWeather(); // 非同步補上天氣
  }

  function renderSummaryBar() {
    const t = trip();
    const modeTxt = { driving: '🚗 開車', transit: '🚇 大眾運輸', walking: '🚶 走路' };
    $('tripSummaryBar').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${UI.esc(t.name)}｜${t.startDate.slice(5).replace('-', '/')}–${t.endDate.slice(5).replace('-', '/')}｜${t.spots.length} 個景點</span>
        <button id="btnSwitchMode" class="chip" style="cursor:pointer">${modeTxt[t.transport]} ▾</button>
      </div>`;
    const b = document.getElementById('btnSwitchMode');
    if (Store.isReadonly()) { b.style.pointerEvents = 'none'; return; }
    b.onclick = () => {
      UI.choose('切換交通方式', [
        { label: '🚗 開車', value: 'driving' },
        { label: '🚇 大眾運輸', value: 'transit' },
        { label: '🚶 走路', value: 'walking' }
      ], v => {
        t.transport = v;
        t.legsByDay = {}; // 車程全部重估
        Store.touch();
        render();
        UI.toast('已切換為「' + { driving: '開車', transit: '大眾運輸', walking: '走路' }[v] + '」，時間已重新計算');
      });
    };
  }

  function renderUnassignedCard(list) {
    const card = document.createElement('div');
    card.className = 'day-card';
    card.innerHTML = `
      <div class="day-head">
        <div class="day-head-top">
          <span class="day-title">🧺 待排景點（${list.length}）</span>
        </div>
        <p class="hint">按下方「一鍵排最佳路線」自動分天，或用 ⋯ 選單手動移到某一天</p>
      </div>`;
    list.forEach(s => card.appendChild(spotRow(s, null, 0)));
    return card;
  }

  function renderDayCard(d, list) {
    const t = trip();
    const dateISO = Store.dateOfDay(d);
    const sh = startHotel(d), eh = endHotel(d);
    const legs = legsForDay(d);
    const tl = Logic.buildTimeline(list, legs, t.dayStart);

    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.day = d;

    const dateTxt = `${Number(dateISO.slice(5, 7))}/${Number(dateISO.slice(8, 10))}`;
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `
      <div class="day-head-top">
        <span class="day-title">第 ${d} 天 <span style="font-weight:400;color:var(--text-2);font-size:.95rem">${dateTxt}</span></span>
        <span class="day-weather" data-day-weather="${d}">☁️ 查天氣中…</span>
      </div>
      <div class="day-outfit" data-day-outfit="${d}"></div>
      <div data-rain-slot="${d}"></div>
      ${list.length ? `<p class="hint" style="margin-top:4px">車程 ${tl.totalTravel} 分｜停留 ${Math.round(tl.totalStay / 60 * 10) / 10} 小時｜預計 ${tl.endTime} 結束</p>` : ''}
      <div class="day-tools">
        ${list.length ? `<a href="${dayNavLink(d, list)}" target="_blank" rel="noopener">🧭 全日導航</a>` : ''}
        <button data-rainbtn="${d}" class="edit-only-inline">☔ 雨天備案${t.rainActive[d] ? '（使用中）' : (t.rainPlans[d]?.spots?.length ? '（已設定）' : '')}</button>
        ${!eh && !sh ? `<button data-hotelrec="${d}" class="edit-only-inline">🏨 推薦飯店</button>` : ''}
      </div>`;
    card.appendChild(head);

    if (Store.isReadonly()) head.querySelectorAll('.edit-only-inline').forEach(b => {
      if (b.dataset.rainbtn && !(t.rainPlans[d]?.spots?.length)) b.remove();
    });

    // 起點飯店
    if (sh && list.length) card.appendChild(hotelRow(sh, `${t.dayStart} 從飯店出發`));

    // 景點列 + 路段
    tl.rows.forEach((row, i) => {
      if (row.legMin > 0) card.appendChild(legRow(row.legMin));
      card.appendChild(spotRow(row.spot, row, i + 1));
    });
    if (list.length && eh) {
      if (tl.backLeg > 0) card.appendChild(legRow(tl.backLeg));
      card.appendChild(hotelRow(eh, `${tl.endTime} 回到飯店`));
    }
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'hint'; p.style.padding = '0 14px 12px';
      p.textContent = '這天還沒有景點，可以從其他天用 ⋯ 選單移過來。';
      card.appendChild(p);
    }

    // 事件
    const rainBtn = head.querySelector(`[data-rainbtn="${d}"]`);
    if (rainBtn) rainBtn.onclick = () => Feat.openRainPlan(d);
    const hotelRec = head.querySelector(`[data-hotelrec="${d}"]`);
    if (hotelRec) hotelRec.onclick = () => Feat.recommendHotel(d);
    return card;
  }

  function legRow(min) {
    const t = trip();
    const icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[t.transport];
    const div = document.createElement('div');
    div.className = 'leg-row';
    div.innerHTML = `↓ ${icon} 車程約 ${min} 分鐘`;
    return div;
  }

  function hotelRow(h, timeTxt) {
    const div = document.createElement('div');
    div.className = 'spot-row';
    const payTag = h.pay ? `<span class="pay-badge pay-${h.pay}">${UI.PAY_LABELS[h.pay] || ''}</span>` : '';
    div.innerHTML = `
      <div class="spot-main">
        <span class="spot-no hotel">🏨</span>
        <div class="spot-info">
          <div class="spot-name">${UI.esc(h.name)} ${payTag}</div>
          <div class="spot-times">${timeTxt}</div>
          ${h.note ? `<div class="spot-times">📝 ${UI.esc(h.note)}</div>` : ''}
        </div>
        <div class="spot-actions">
          <button class="edit-only" data-act="hedit" title="編輯住宿備註">✎</button>
          <a href="${UI.gmapLink(h)}" target="_blank" rel="noopener" style="padding:6px">📍</a>
        </div>
      </div>`;
    div.querySelector('[data-act="hedit"]').onclick = () => editHotelInfo(h);
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
      </select>`;
    UI.modal(`🏨 ${h.name}`, body, [{
      label: '儲存', primary: true,
      onClick: () => {
        const note = document.getElementById('hEditNote').value.trim();
        const pay = document.getElementById('hEditPay').value;
        trip().hotels.filter(x => x.placeId === h.placeId).forEach(x => { x.note = note; x.pay = pay; });
        Store.touch();
        UI.closeModal();
        render();
        UI.toast('住宿備註已更新');
      }
    }]);
  }

  function spotRow(s, tlRow, no) {
    const div = document.createElement('div');
    div.className = 'spot-row';
    div.dataset.spotId = s.id;
    const stayH = s.stayMin >= 60 ? `${Math.floor(s.stayMin / 60)} 小時${s.stayMin % 60 ? ' ' + s.stayMin % 60 + ' 分' : ''}` : `${s.stayMin} 分鐘`;
    div.innerHTML = `
      <div class="spot-main">
        <span class="spot-no">${no || '·'}</span>
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
          <button class="drag-grip" title="按住拖曳排序">☰</button>
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
      { label: s.must ? '取消「必去」標記' : '⭐ 標記為必去', value: 'must' }
    ];
    for (let d = 1; d <= days; d++) {
      if (d !== s.day) opts.push({ label: `📅 移到第 ${d} 天`, value: 'day' + d });
    }
    opts.push({ label: '🗑️ 從行程移除', value: 'del', danger: true });
    UI.choose(s.name, opts, v => {
      if (v === 'must') { s.must = !s.must; Store.touch(); render(); }
      else if (v === 'del') {
        UI.confirm('移除景點', `確定要把「${s.name}」從行程中移除嗎？`, () => {
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

  // ---------- 拖曳排序（同一天內） ----------
  let drag = null;
  function startDrag(e, spot, rowEl) {
    if (Store.isReadonly()) return;
    e.preventDefault();
    rowEl.classList.add('dragging');
    drag = { spot, rowEl, card: rowEl.closest('.day-card') };
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
  }
  function onDragMove(e) {
    if (!drag) return;
    const rows = [...drag.card.querySelectorAll('.spot-row[data-spot-id]')];
    for (const r of rows) {
      if (r === drag.rowEl) continue;
      const rect = r.getBoundingClientRect();
      if (e.clientY > rect.top && e.clientY < rect.bottom) {
        if (e.clientY < rect.top + rect.height / 2) r.before(drag.rowEl);
        else r.after(drag.rowEl);
      }
    }
  }
  function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    if (!drag) return;
    const t = trip();
    const ids = [...drag.card.querySelectorAll('.spot-row[data-spot-id]')].map(r => r.dataset.spotId);
    ids.forEach((id, i) => {
      const s = t.spots.find(x => x.id === id);
      if (s) s.order = i;
    });
    const d = drag.spot.day;
    if (d) delete t.legsByDay[d]; // 順序變了 → 車程重新估
    drag.rowEl.classList.remove('dragging');
    drag = null;
    Store.touch({ manual: true });
    render();
  }

  // ---------- 導航連結 ----------
  function dayNavLink(d, list) {
    const sh = startHotel(d), eh = endHotel(d);
    const pts = list.map(s => `${s.lat},${s.lng}`);
    const origin = sh ? `${sh.lat},${sh.lng}` : pts.shift();
    const dest = eh ? `${eh.lat},${eh.lng}` : pts.pop();
    const mode = { driving: 'driving', transit: 'transit', walking: 'walking' }[trip().transport];
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${mode}`;
    if (pts.length) url += `&waypoints=${pts.join('|')}`;
    return url;
  }

  // ================= 地圖（模擬 SVG / 正式 Google Map） =================
  function renderMiniMap() { drawMap($('miniMap'), null); }
  function renderFullMap(selDay) {
    drawMap($('fullMap'), selDay || null);
    const days = Store.days();
    const chips = $('mapDayChips');
    const items = ['全部', ...Array.from({ length: days }, (_, i) => `第${i + 1}天`)];
    chips.innerHTML = items.map((tt, i) =>
      `<span class="chip ${((selDay || 0) === i) ? 'on' : ''}" data-d="${i}" style="cursor:pointer;background:${(selDay || 0) === i ? '' : 'var(--white)'}">${tt}</span>`).join('');
    chips.querySelectorAll('.chip').forEach(c =>
      c.onclick = () => renderFullMap(Number(c.dataset.d)));
  }

  function drawMap(el, selDay) {
    const t = trip();
    if (!t) return;
    const days = Store.days();
    const groups = [];
    for (let d = 1; d <= days; d++) {
      if (selDay && d !== selDay) continue;
      const list = spotsOfDay(d);
      if (list.length) groups.push({ d, list, sh: startHotel(d), eh: endHotel(d) });
    }
    if (!groups.length && unassigned().length) {
      groups.push({ d: 0, list: unassigned(), sh: null, eh: null });
    }
    if (!groups.length) {
      el.innerHTML = `<svg class="mock-map" viewBox="0 0 400 300">
        <text x="200" y="150" text-anchor="middle" fill="#8C7B6B" font-size="15">加入景點後，路線會畫在這裡</text>
      </svg>`;
      return;
    }
    const pts = [];
    groups.forEach(g => {
      g.list.forEach(s => pts.push(s));
      if (g.sh) pts.push(g.sh);
      if (g.eh) pts.push(g.eh);
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
      if (g.sh) seq.push(g.sh);
      seq.push(...g.list);
      if (g.eh) seq.push(g.eh);
      if (seq.length > 1) {
        svg += `<polyline class="road" points="${seq.map(p => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')}"/>`;
      }
    }
    for (const g of groups) {
      if (g.sh) svg += marker(X(g.sh), Y(g.sh), '🏨', true);
      g.list.forEach((s, i) => {
        svg += marker(X(s), Y(s), String(i + 1), false, s.name);
      });
      if (g.eh && g.eh !== g.sh) svg += marker(X(g.eh), Y(g.eh), '🏨', true);
    }
    svg += `</svg>`;
    el.innerHTML = svg + `<div class="map-badge">${Api.isMock() ? '示意地圖（正式版為 Google 地圖）' : ''}</div>`;
  }
  function marker(x, y, label, isHotel, name) {
    const short = name ? (name.length > 6 ? name.slice(0, 6) + '…' : name) : '';
    return (isHotel
      ? `<text x="${x}" y="${y + 5}" text-anchor="middle" font-size="16">🏨</text>`
      : `<circle class="marker-c" cx="${x}" cy="${y}" r="11"/><text class="marker-t" x="${x}" y="${y + 4.5}">${label}</text>`) +
      (short ? `<text class="marker-label" x="${x}" y="${y + 24}">${UI.esc(short)}</text>` : '');
  }

  // ---------- 地圖高度拖曳把手 ----------
  function initDragHandle() {
    const handle = $('dragHandle');
    let startY = 0, startH = 0;
    handle.addEventListener('pointerdown', e => {
      startY = e.clientY;
      startH = $('mapPane').getBoundingClientRect().height;
      const move = ev => {
        const h = Math.min(window.innerHeight * .6, Math.max(90, startH + ev.clientY - startY));
        document.documentElement.style.setProperty('--map-h', h + 'px');
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
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

  return { init, render, renderFullMap, addSpot, spotsOfDay, unassigned, dayCenter, startHotel, endHotel, legsForDay };
})();
