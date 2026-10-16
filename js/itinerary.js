// ============================================================
// 行程頁：景點輸入、一鍵最佳路線、行程表（分天＋時間軸）、地圖、雨天備案
// v1.2：真 Google 地圖、集合/解散地、跨天拖曳、每日加景點、上一步/下一步
// ============================================================
const Itin = (() => {

  const $ = id => document.getElementById(id);
  const trip = () => Store.get();
  const DAY_COLORS = ['#006599', '#E07B00', '#0F9D58', '#7C3AED', '#D6336C', '#0891B2'];
  const dayColor = d => DAY_COLORS[(d - 1 + DAY_COLORS.length * 9) % DAY_COLORS.length];
  const WEEK = '日一二三四五六';
  const weekdayOf = iso => WEEK[new Date(iso + 'T00:00:00').getDay()];

  // ---------- v2.1.33 一次看一天：0＝全部、'un'＝待排、1..N＝第幾天 ----------
  let viewDay = null, viewTrip = '', daySwap = '';
  let openRowId = '';          // 時間軸上展開動作列的那一列（一次只開一列）
  const VIEW_KEY = id => 'mika_day:' + id;
  function currentView() {
    const t = trip(), days = Store.days();
    if (viewTrip !== t.tripId) { // 換了行程：重新決定看哪天
      viewTrip = t.tripId; viewDay = null;
      const now = new Date();
      const ti = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      for (let d = 1; d <= days; d++) if (Store.dateOfDay(d) === ti) viewDay = d; // 旅行中 → 今天
      if (viewDay === null) {
        let saved = null;
        try { saved = localStorage.getItem(VIEW_KEY(t.tripId)); } catch {}
        viewDay = saved === 'un' || saved === 'bk' ? saved : saved !== null ? Number(saved) : 1;
      }
    }
    if (viewDay === 'un' && !unassigned().length) viewDay = 1;
    if (viewDay === 'bk' && !backupSpots().length) viewDay = 1;
    if (typeof viewDay === 'number' && (viewDay < 0 || viewDay > days || isNaN(viewDay))) viewDay = 1;
    return viewDay;
  }
  function showDay(d, dir) {
    currentView();
    if (d === viewDay) return;
    daySwap = dir || '';
    viewDay = d;
    try { localStorage.setItem(VIEW_KEY(trip().tripId), String(d)); } catch {}
    openRowId = '';
    render();
    const strip = $('dayStrip');
    if (strip && strip.getBoundingClientRect().top < 0) window.scrollTo(0, Math.max(0, strip.offsetTop - 120));
  }

  // ---------- 每天的起點與終點 ----------
  // 起點：第 1 天優先用「集合出發地」；否則前一晚飯店（第 1 天用當晚）
  // 終點：最後一天優先用「解散地」；否則當晚飯店（最後一晚沒有就不設）
  // v2.1.27 航班：這天有「抵達航班」→ 起點改成抵達機場；有「起飛航班」→ 終點改成出發機場。
  // 原本的集合地／飯店／解散地（base）變成「搭機前從哪裡出發」與「下機後要去哪裡」。
  function baseStartPoint(day) {
    const t = trip();
    if (day === 1 && t.meetPoint) return { p: t.meetPoint, kind: 'meet' };
    const h = Store.hotelOfNight(day - 2) || Store.hotelOfNight(day - 1) || null;
    return h ? { p: h, kind: 'hotel' } : null;
  }
  function baseEndPoint(day) {
    const t = trip();
    if (day === Store.days() && t.endPoint) return { p: t.endPoint, kind: 'end' };
    const h = Store.hotelOfNight(day - 1);
    return h ? { p: h, kind: 'hotel' } : null;
  }
  function startPoint(day) {
    const f = Flights.of(day, 'arrive');
    if (Flights.isComplete(f)) return { p: f.arrAirport, kind: 'airport', flight: f };
    return baseStartPoint(day);
  }
  function endPoint(day) {
    const f = Flights.of(day, 'depart');
    if (Flights.isComplete(f)) return { p: f.depAirport, kind: 'airport', flight: f };
    return baseEndPoint(day);
  }
  // 供其他模組沿用（例如天氣以起點為備援中心）
  const startHotel = day => (startPoint(day) || {}).p || null;
  const endHotel = day => (endPoint(day) || {}).p || null;

  function spotsOfDay(day) {
    return trip().spots.filter(s => s.day === day).sort((a, b) => a.order - b.order);
  }
  function unassigned() {
    return trip().spots.filter(s => (!s.day || s.day === 0) && !s.backup);
  }
  // v2.1.36 ⭐ 備選景點：想去但先不排（自動安排不會動到）
  function backupSpots() {
    return trip().spots.filter(s => s.backup);
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
    if (point.kind === 'airport') return '機場';
    if (point.kind === 'hotel') return `${hotelNightLabel(point.p.night)}住宿`;
    return point.kind === 'meet' ? '集合地' : '解散地';
  }

  // 各路段時間：優先用排路線時存下的，否則即時估算
  // v2.1.35 使用者在「選路線」選定的路段 → 用那條路線的時間
  function legsForDay(day) {
    const legs = baseLegsForDay(day);
    if (!trip().legRoutes || typeof RoutePick === 'undefined') return legs;
    const mode = dayTransportOf(day);
    const seq = [startHotel(day), ...spotsOfDay(day), endHotel(day)];
    return legs.map((min, i) => {
      const r = RoutePick.chosenOf(seq[i], seq[i + 1], mode);
      return r && r.mode === mode ? r.min : min;
    });
  }
  function baseLegsForDay(day) {
    const list = spotsOfDay(day);
    const mode = dayTransportOf(day);
    const cached = trip().legsByDay[day];
    if (cached && cached.length === list.length + 1) {
      // 舊資料防護：異常路段（例如 Google 對到不了的點回傳的怪時間）改用估算
      const seq = [startHotel(day), ...list, endHotel(day)];
      return cached.map((min, i) => {
        if (!seq[i] || !seq[i + 1]) return min;
        const est = Logic.travelMinutes(seq[i], seq[i + 1], mode);
        return min > est * 3 + 60 ? est : min;
      });
    }
    const sp = startHotel(day), ep = endHotel(day);
    const legs = [];
    let prev = sp;
    for (const s of list) {
      legs.push(prev ? Logic.travelMinutes(prev, s, mode) : 0);
      prev = s;
    }
    legs.push(ep && prev ? Logic.travelMinutes(prev, ep, mode) : 0);
    return legs;
  }

  // 每一天實際的出發時間（可個別覆寫，預設用全域設定）
  function dayStartOf(day) {
    const t = trip();
    const fm = Flights.dayStartMin(day); // 有抵達航班：抵達＋出關
    if (fm !== null) return Logic.toHHMM(fm);
    return (t.dayStartOv || {})[day] || t.dayStart;
  }
  // 每一天的結束時間（可個別覆寫，預設用全域 dayEnd）
  function dayEndOf(day) {
    const t = trip();
    const fm = Flights.dayEndMin(day); // 有起飛航班：起飛－提早報到（最晚到機場的時間）
    if (fm !== null) return Logic.toHHMM(Math.max(0, fm));
    return (t.dayEndOv || {})[day] || t.dayEnd;
  }
  const hasFlightDay = day => Flights.isComplete(Flights.of(day, 'arrive')) || Flights.isComplete(Flights.of(day, 'depart'));
  // 每一天的交通方式（可個別覆寫，預設用全域 transport）
  const TRANSPORT_META = { driving: ['🚗', '開車'], transit: ['🚇', '大眾運輸'], walking: ['🚶', '走路'] };
  function dayTransportOf(day) {
    const t = trip();
    return (t.dayTransportOv || {})[day] || t.transport;
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
  // v2.1.36 景點照片網址過期 → 只在這台裝置的記憶體換新（不存回雲端，避免兩台裝置互相觸發存檔）
  const freshSpotPhoto = {}, photoTried = new Set();
  const photoFor = s => (s && (freshSpotPhoto[s.id] !== undefined ? freshSpotPhoto[s.id] : s.photo)) || '';
  async function refreshSpotPhoto(s, imgs) {
    imgs.forEach(img => { img.style.display = 'none'; });
    if (s && freshSpotPhoto[s.id]) { imgs.forEach(img => { if (img.src !== freshSpotPhoto[s.id]) { img.src = freshSpotPhoto[s.id]; img.style.display = ''; } }); return; }
    if (!s || !s.placeId || photoTried.has(s.id) || String(s.placeId).startsWith('custom')) return;
    photoTried.add(s.id);
    try {
      const ex = await Api.placeExtras(s.placeId);
      const url = (ex.photos || [])[0] || '';
      freshSpotPhoto[s.id] = url;
      if (url) imgs.forEach(img => { img.src = url; img.style.display = ''; });
    } catch { freshSpotPhoto[s.id] = ''; }
  }
  window.__mikaPhotoFail = (img, id) => { // 地圖標籤（InfoWindow 的 HTML 字串）用
    const s = trip().spots.find(x => x.id === id);
    refreshSpotPhoto(s, [img]);
  };

  // v2.1.35 行程區域：已加入的景點／住宿／集合地／航班機場的中心與範圍（新行程什麼都沒有時回 null）
  function tripArea() {
    const t = trip();
    const pts = [...(t.spots || []).filter(s => !s.backup), ...(t.hotels || []), t.meetPoint, t.endPoint,
      ...(t.flights || []).flatMap(f => f.type === 'arrive' ? [f.arrAirport] : [f.depAirport])]
      .filter(p => p && Logic.hasCoords(p));
    // 出發地（台灣的集合地、出發機場）不算目的地：有國外點時只用國外點
    const inTW = p => p.lat > 21.7 && p.lat < 26.5 && p.lng > 118 && p.lng < 122.2;
    const abroad = pts.filter(p => !inTW(p));
    const use = abroad.length ? abroad : pts;
    if (!use.length) return null;
    const center = { lat: use.reduce((s, p) => s + p.lat, 0) / use.length, lng: use.reduce((s, p) => s + p.lng, 0) / use.length };
    const far = Math.max(...use.map(p => Logic.haversineKm(center, p)));
    return { center, radiusKm: Math.max(30, Math.min(120, far + 20)) };
  }
  const distTxt = km => km < 1 ? '1 公里內' : `約 ${Math.round(km)} 公里`;

  function initSpotInput() {
    const inp = $('inpSpot'), box = $('spotSuggest');
    inp.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      const q = inp.value.trim();
      if (!q) { box.classList.add('hidden'); return; }
      suggestTimer = setTimeout(async () => {
        try {
          const area = tripArea();
          let results = await Api.searchPlaces(q, 'spot', area);
          // 以行程區域為主：範圍內的排前面（保留 Google 的相關度順序），太遠的排後面並標示
          if (area) {
            results.forEach(r => { r._km = Logic.hasCoords(r) ? Logic.haversineKm(area.center, r) : null; r._far = r._km !== null && r._km > area.radiusKm + 30; });
            results = [...results.filter(r => !r._far), ...results.filter(r => r._far)];
          }
          if (!results.length) {
            box.innerHTML = '<div class="s-item"><span class="s-sub">找不到符合的地點，請換個關鍵字</span></div>';
          } else {
            box.innerHTML = results.map((r, i) => `
              <div class="s-item" data-i="${i}">
                <div>${UI.esc(r.name)} <span class="star">★ ${r.rating}</span>${r._km !== undefined && r._km !== null ? ` <span class="s-dist${r._far ? ' far' : ''}">${r._far ? '⚠️ 離行程區域 ' : '📍 離行程中心 '}${distTxt(r._km)}</span>` : ''}</div>
                <div class="s-sub">${UI.esc(r.address)}</div>
                <div class="s-sub r-hours" data-hours-i="${i}">🕒 查營業時間…</div>
                <button type="button" class="s-bk" data-bki="${i}" title="先收著，不排進行程">⭐ 備選</button>
              </div>`).join('');
            box.querySelectorAll('[data-i]').forEach(el =>
              el.onclick = e => {
                if (e.target.closest('[data-bki]')) return;
                addSpot(results[Number(el.dataset.i)]); inp.value = ''; box.classList.add('hidden');
              });
            box.querySelectorAll('[data-bki]').forEach(b => b.onclick = () => {
              if (addSpot(results[Number(b.dataset.bki)], { backup: true })) { inp.value = ''; box.classList.add('hidden'); }
            });
            // 待排：不知道放哪天 → 顯示每一天（Day1(週幾)…）的營業時間
            UI.fillResultHours(box, results,
              Array.from({ length: Store.days() }, (_, i) => ({ n: i + 1, wd: new Date(Store.dateOfDay(i + 1) + 'T00:00:00').getDay() })));
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
    const isBackup = !!(opt && opt.backup);
    const hasCoords = Logic.hasCoords(place);
    const spot = {
      id: Logic.uid(), placeId, source: place.source || (String(placeId).startsWith('custom-') ? 'custom' : 'google'),
      name: place.name, address: place.address || '',
      lat: place.lat, lng: place.lng, rating: place.rating || 0, photo: place.photo || '',
      hasCoords, estimateWarning: hasCoords ? '' : '沒有座標，路程無法精準估算',
      stayMin: CONFIG.defaults.stayMin, must: false, meal: place.meal || '', note: place.note || '',
      day, order: day ? spotsOfDay(day).length : t.spots.length,
      ...(isBackup ? { backup: true } : {})
    };
    t.spots.push(spot);
    if (day) delete t.legsByDay[day];
    Store.touch(day ? { manual: true } : undefined);
    UI.toast(isBackup ? `⭐ 已加入備選景點「${place.name}」（不會被自動安排）` : hasCoords ? `已加入「${place.name}」${day ? `到第 ${day} 天` : '到待排（按「自動安排」會分到各天）'}` : `已加入「${place.name}」，但沒有座標，路程會略過估算`);
    if (day && viewDay !== 0) viewDay = day;
    render();
    // 加入時抓一次營業時間（真實地點），存起來給行程顯示＋公休日提醒
    if (placeId && !String(placeId).startsWith('custom') && !String(placeId).startsWith('m-')) {
      Api.placeHours(placeId).then(h => {
        if (h) { spot.hoursText = (h.weekdayText || []).join('\n'); spot.closedDays = h.closedDays || []; Store.touch(); render(); }
      }).catch(() => {});
    }
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
          const rs = await Api.searchPlaces(q, 'spot', tripArea());
          res.innerHTML = rs.length ? rs.map((r, i) => `
            <div class="result-item ${r.photo ? 'with-photo' : ''}">
              ${r.photo ? `<img class="thumb" src="${r.photo}" alt="">` : ''}
              <div class="r-body">
                <div class="r-name">${UI.esc(r.name)} <span class="star">★ ${r.rating}</span></div>
                <div class="r-meta">${UI.esc(r.address)}</div>
                <div class="r-hours" data-hours-i="${i}">🕒 查營業時間…</div>
                <div class="r-actions"><button class="primary" data-i="${i}">＋ 加到第 ${d} 天</button></div>
              </div>
            </div>`).join('') : '<p class="hint">找不到符合的地點</p>';
          res.querySelectorAll('button[data-i]').forEach(b =>
            b.onclick = () => { if (addSpot(rs[Number(b.dataset.i)], { day: d })) inp.value = ''; res.innerHTML = ''; });
          UI.fillResultHours(res, rs, [{ n: d, wd: new Date(Store.dateOfDay(d) + 'T00:00:00').getDay() }]);
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

  // ---------- 軟性把餐廳挪到用餐時段（一鍵最佳路線用；順路優先，只在繞路預算內微調） ----------
  const MEAL_TARGET = { breakfast: 8.5 * 60, lunch: 12 * 60, dinner: 18 * 60, snack: 15 * 60 }; // 目標抵達分鐘
  const MEAL_TOL = { breakfast: 60, lunch: 45, dinner: 45, snack: 120 };                        // 容忍分鐘（超出才算 penalty）
  const REORDER_BUDGET = 30; // 全天為了配合用餐，最多多繞的估算車程（分鐘）
  function mealPenalty(spot, arriveMin) {
    const tgt = MEAL_TARGET[spot.meal];
    if (tgt === undefined) return 0;
    return Math.max(0, Math.abs(arriveMin - tgt) - (MEAL_TOL[spot.meal] || 60));
  }
  // 依序（估算車程＋停留）模擬每個景點抵達時間與全天總車程
  function simulateDay(seq, start, end, mode, dayStartMin) {
    const arrivals = [];
    let clock = dayStartMin, prev = start || null, travel = 0;
    for (const s of seq) {
      const leg = prev ? Logic.travelMinutes(prev, s, mode) : 0;
      travel += leg;
      const arrive = clock + leg;
      arrivals.push(arrive);
      clock = arrive + (s.stayMin || 60);
      prev = s;
    }
    if (end && prev) travel += Logic.travelMinutes(prev, end, mode);
    return { arrivals, travel };
  }
  const totalMealPenalty = (seq, arr) => seq.reduce((p, s, i) => p + mealPenalty(s, arr[i]), 0);
  const sameOrderById = (a, b) => a.length === b.length && a.every((s, i) => s.id === b[i].id);
  // 貪婪：把餐別景點搬到能降低用餐 penalty 的位置，但總車程不得超過原本 + 預算（=順路優先）
  function mealAwareReorder(seq, start, end, mode, dayStartMin) {
    if (seq.length < 2 || !seq.some(s => MEAL_TARGET[s.meal] !== undefined)) return seq;
    const base = simulateDay(seq, start, end, mode, dayStartMin);
    const cap = base.travel + REORDER_BUDGET;
    let cur = seq.slice(), curTL = base, curPen = totalMealPenalty(cur, base.arrivals);
    let improved = true, guard = 0;
    while (improved && guard++ < 30) {
      improved = false;
      let best = null;
      for (let i = 0; i < cur.length; i++) {
        if (MEAL_TARGET[cur[i].meal] === undefined) continue; // 只搬餐別景點
        const rest = cur.slice();
        const [sp] = rest.splice(i, 1);
        for (let k = 0; k <= rest.length; k++) {              // 插入到每個位置（含最後一格）
          const cand = rest.slice();
          cand.splice(k, 0, sp);
          if (sameOrderById(cand, cur)) continue;
          const tl = simulateDay(cand, start, end, mode, dayStartMin);
          if (tl.travel > cap) continue;                     // 超出繞路預算 → 放棄（順路優先）
          const pen = totalMealPenalty(cand, tl.arrivals);
          const better = pen < curPen - 0.5 || (Math.abs(pen - curPen) < 0.5 && tl.travel < curTL.travel - 0.5);
          if (!better) continue;
          if (!best || pen < best.pen - 0.5 || (Math.abs(pen - best.pen) < 0.5 && tl.travel < best.tl.travel)) {
            best = { cand, tl, pen };
          }
        }
      }
      if (best) { cur = best.cand; curTL = best.tl; curPen = best.pen; improved = true; }
    }
    return cur;
  }
  // 依既定順序逐段抓真實車程（餐時微調後若順序有變才重抓）
  async function realDayLegs(start, end, ordered, mode) {
    const legs = [];
    let prev = start || null;
    for (const s of ordered) { legs.push(prev ? await routeMinute(prev, s, mode) : 0); prev = s; }
    legs.push(end && prev ? await routeMinute(prev, end, mode) : 0);
    return legs;
  }

  async function runOptimize() {
    const t = trip();
    try {
      UI.progress(0, '正在計算最佳路線…');
      const estDays = []; let unreachable = false; // 車開不到／查詢失敗而改用估算的天
      const all = t.spots.filter(s => !s.backup).sort((a, b) => (a.day || 99) - (b.day || 99) || a.order - b.order); // 備選景點不排
      const routableAll = all.filter(Logic.hasCoords);
      const skipped = all.filter(s => !Logic.hasCoords(s));
      if (routableAll.length < 2) {
        UI.loading(false);
        UI.alert('座標不足', '至少需要 2 個有座標的景點，才能計算最佳路線。\n\n沒有座標的自訂景點會保留在原本天數，但不參與路線排序。');
        return;
      }
      const days = Store.days();
      // 🔒 鎖定景點：保持在原本的天，不參與重新分配（其餘未鎖定的才重排）
      const isLocked = s => s.locked && s.day >= 1 && s.day <= days;
      const lockedSpots = routableAll.filter(isLocked);
      const routable = routableAll.filter(s => !isLocked(s));
      const prevDayOf = {}; routableAll.forEach(s => prevDayOf[s.id] = s.day);
      const o1 = Logic.hasCoords(startHotel(1)) ? startHotel(1) : null;
      const oN = Logic.hasCoords(endHotel(days)) ? endHotel(days) : o1;
      const hc = p => Logic.hasCoords(p) ? p : null;
      const dayAnchors = [];
      for (let d = 1; d <= days; d++) dayAnchors.push({ start: hc(startHotel(d)), end: hc(endHotel(d)) });

      // 1)+2) 只把「未鎖定」的景點排序＋分天
      let dayArrs;
      if (routable.length) {
        UI.progressCreep(12, '步驟 1：把景點分配到各天…');
        const g = await Api.optimizeRoute(o1, oN, routable, t.transport,
          { onProgress: (done, total) => UI.progress(12 * done / total, `步驟 1：把景點分配到各天（${done}/${total}）…`) });
        if (g.unreachable) unreachable = true;
        const ordered = g.order.map(i => routable[i]);
        // v2.1.27：每天依「實際可用時間」分配（個別調過時間、或有航班的天，可用時間比較少）
        const startMinOf = d0 => Logic.toMin(dayStartOf(d0 + 1));
        const endMinOf = d0 => Logic.toMin(dayEndOf(d0 + 1));
        dayArrs = Logic.assignDaysByAnchors(ordered, dayAnchors, {
          days,
          dayStartMin: Logic.toMin(t.dayStart),
          dayEndMin: Logic.toMin(t.dayEnd),
          dayBudget: d0 => endMinOf(d0) - startMinOf(d0),
          travelMin: (a, b) => Logic.travelMinutes(a, b, t.transport),
          stayMin: s => s.stayMin || 60
        });
        if (!dayArrs) dayArrs = Logic.splitIntoDays(ordered, {
          days,
          dayStartMin: Logic.toMin(t.dayStart),
          dayEndMin: Logic.toMin(t.dayEnd),
          dayStartMinOf: startMinOf,
          dayEndMinOf: endMinOf,
          travelMin: (a, b) => Logic.travelMinutes(a, b, t.transport),
          hotelOfDay: d => hc(startHotel(d + 1))
        });
      } else {
        dayArrs = Array.from({ length: days }, () => []);
      }
      // 把鎖定景點放回它們原本的天（一起參與當天順序最佳化，但不會被移到別天）
      lockedSpots.forEach(s => { const di = s.day - 1; if (di >= 0 && di < days) dayArrs[di].push(s); });

      // 3) 每天以起終點（集合地/飯店/解散地）再最佳化；再軟性把餐廳挪到用餐時段
      UI.progress(15);
      t.legsByDay = {};
      const activeDays = dayArrs.filter(a => a.length).length || 1;
      let k = 0;
      for (let d = 1; d <= days; d++) {
        const listD = dayArrs[d - 1];
        if (!listD.length) continue;
        // 步驟 2 佔 15%→95%，每一天平分
        const base = 15 + 80 * k / activeDays, share = 80 / activeDays;
        k++;
        const mode = dayTransportOf(d);
        const start = Logic.hasCoords(startHotel(d)) ? startHotel(d) : null;
        const end = Logic.hasCoords(endHotel(d)) ? endHotel(d) : null;
        UI.progressCreep(base + share * 0.85, `步驟 2：第 ${d} 天，查詢真實車程…`);
        const r = await Api.optimizeRoute(start, end, listD, mode,
          { realLegs: true, onProgress: (done, total) => UI.progress(base + share * 0.85 * done / total, `步驟 2：第 ${d} 天，查詢真實車程 ${done}/${total} 段…`) });
        if (r.estimated) { estDays.push(d); if (r.unreachable) unreachable = true; }
        let ordered = r.order.map(i => listD[i]);
        let legs = r.legs;
        // 軟性：把有餐別的店挪到用餐時段（有繞路預算上限＝順路優先）；只有真的動到順序才重抓車程
        const reordered = mealAwareReorder(ordered, start, end, mode, Logic.toMin(dayStartOf(d)));
        if (!sameOrderById(reordered, ordered)) {
          UI.progressCreep(base + share, `步驟 2：第 ${d} 天，配合用餐時段微調路線…`);
          ordered = reordered;
          legs = await realDayLegs(start, end, ordered, mode);
        }
        ordered.forEach((s, pos) => { s.day = d; s.order = pos; });
        t.legsByDay[d] = legs;
        UI.progress(base + share);
      }
      t.optimizedAt = Date.now();
      Store.clearManualDirty();
      Store.touch();
      await UI.progressDone('完成！');
      $('btnOptimize').classList.remove('glow');
      render();

      const lockNote = lockedSpots.length ? `（🔒 ${lockedSpots.length} 個鎖定景點已保留在原本的天）` : '';
      const estNote = (unreachable || estDays.length)
        ? `\n\n⚠️ 部分地點之間${unreachable ? '開車無法抵達（可能是跨海、離島或在國外，例如集合地在台灣、景點在日本）' : '暫時查不到 Google 路線'}，` +
          `${estDays.length ? `第 ${estDays.join('、')} 天的` : ''}順序與車程改用直線距離估算，請自行確認。`
        : '';
      const pushed = routable.filter(s => s.must && prevDayOf[s.id] > 0 && s.day > prevDayOf[s.id]);
      if (pushed.length) {
        UI.alert('必去景點被移到隔天了',
          `因為一天排不下，這些「必去」景點被移到後面的天數：\n\n` +
          pushed.map(s => `⭐ ${s.name}（第 ${s.day} 天）`).join('\n') +
          `\n\n可以縮短其他景點的停留時間、把它鎖定在想去的那天（🔒），或手動拖回。` + estNote);
      } else if (skipped.length) {
        UI.alert('最佳路線排好了',
          `已排序有座標的景點。${lockNote}\n\n以下 ${skipped.length} 個地點沒有座標，已保留在原本天數，未納入路線計算：\n\n` +
          skipped.map(s => `・${s.name}`).join('\n') + estNote);
      } else if (estNote) {
        UI.alert('最佳路線排好了', `已完成排序。${lockNote}` + estNote);
      } else {
        UI.toast('最佳路線排好了！' + lockNote);
      }
    } catch (e) {
      UI.loading(false);
      const msg = String((e && e.message) || e);
      UI.alert('排路線失敗', /ZERO_RESULTS|NOT_FOUND/.test(msg)
        ? '有地點之間查不到可行的路線（可能跨海、離島或在國外）。\n\n請檢查集合地、飯店、解散地與景點是不是在同一個地區。'
        : '暫時無法計算路線，可能是網路不穩。\n\n請稍後再試一次；若一直失敗，請檢查網路連線。\n\n（技術訊息：' + msg + '）');
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
    bindRouteActions();

    if (showDays) renderSummaryBar();

    const wrap = $('dayList');
    wrap.innerHTML = '';
    const un = unassigned();
    const view = showDays ? currentView() : 0;
    renderDayStrip(showDays, un.length);
    wrap.classList.toggle('single', showDays && view !== 0);
    if (un.length && (view === 0 || view === 'un' || !showDays)) wrap.appendChild(renderUnassignedCard(un));
    for (let d = 1; d <= days; d++) {
      if (!showDays) continue; // 完全沒景點與住宿/集合點時只顯示空狀態引導
      if (view !== 0 && view !== d) continue; // 一次看一天
      wrap.appendChild(renderDayCard(d, spotsOfDay(d)));
    }
    const bk = backupSpots();
    if (bk.length && showDays && (view === 0 || view === 'bk')) wrap.appendChild(renderBackupCard(bk));
    if (daySwap) { wrap.classList.remove('swap-l', 'swap-r'); void wrap.offsetWidth; wrap.classList.add(daySwap === 'next' ? 'swap-l' : 'swap-r'); daySwap = ''; }
    renderMiniMap();
    Feat.fillWeather();
    notifyOverflowDays();
    backfillHours();
    scheduleAutoRoute();  // 變更後背景自動抓真實車程（只更新剛被清掉車程的那幾天）
  }

  // 某一天的行程是否排不進設定時段
  function dayOverflows(d) {
    const list = spotsOfDay(d);
    if (!list.length) return false;
    const tl = Logic.buildTimeline(list, legsForDay(d), dayStartOf(d));
    return (Logic.toMin(dayStartOf(d)) + tl.totalTravel + tl.totalStay) > Logic.toMin(dayEndOf(d));
  }
  // 有天數新變成「排不完」時，底部彈出提醒 3 秒（不重複洗版）
  let lastOverDays = new Set();
  function notifyOverflowDays() {
    const now = new Set();
    for (let d = 1; d <= Store.days(); d++) if (dayOverflows(d)) now.add(d);
    const newly = [...now].filter(d => !lastOverDays.has(d));
    lastOverDays = now;
    if (newly.length && !Store.isReadonly()) {
      UI.toast(`⚠️ 第 ${newly.join('、')} 天可能排不完`);
    }
  }

  const isMobile = () => window.matchMedia('(max-width: 560px)').matches;

  function bindRouteActions() {
    const t = trip();
    const moreBtn = $('btnMoreActions');
    if (moreBtn) moreBtn.onclick = openMoreActions;
    const undoBtn = $('btnUndo');
    if (undoBtn) { undoBtn.disabled = !Store.canUndo(); undoBtn.onclick = doUndo; }
    const shareBtn = $('btnShareBottom');
    if (shareBtn) shareBtn.onclick = () => Feat.showShare();
  }

  function doUndo() { if (Store.undo()) { render(); UI.toast('已復原上一步'); } }

  // 底部「⋯ 更多」：手機把次要動作收在這裡（桌面多按鈕已外露，這裡只補還原）
  function openMoreActions() {
    const opts = [];
    const t = trip();
    // v2.1.47 Mika 指定順序：車程 → 修改紀錄 → 新手導覽 → 還原 → 國內外 → 複製（二合一）→ 其他
    if (t.spots.length || t.meetPoint || t.endPoint || (t.hotels || []).length) {
      opts.push({ label: '🔄 重新計算車程（抓最新實際時間）', value: 'refresh' });
    }
    opts.push({ label: '📝 修改紀錄（誰改了什麼）', value: 'changelog' });
    opts.push({ label: '🧭 新手導覽（重看一次）', value: 'tour' });
    if (Store.canRestoreSaved()) opts.push({ label: `↺ 還原到上次儲存（${savedTimeTxt()}）`, value: 'restore' });
    if (!Store.isReadonly()) {
      const ab = Prep.isAbroad();
      opts.push({ label: `${ab ? '🌏 國外' : '🏠 國內'}旅遊${t.scope ? '' : '（自動判斷）'}：改成${ab ? '國內' : '國外'}`, value: 'scope' });
    }
    opts.push({ label: '📋 複製…', value: 'copymenu' });
    if (isMobile()) {
      if (Store.canUndo()) opts.push({ label: '↩ 上一步（復原）', value: 'undo' });
      opts.push({ label: '💾 儲存目前安排', value: 'save' });
      opts.push({ label: '📤 分享行程', value: 'share' });
    }
    opts.push({ label: '🔎 同步紀錄（出狀況時截圖給 Mika）', value: 'synclog' });
    opts.push({ label: '💬 意見回饋', value: 'feedback' });
    opts.push({ label: '🧹 清除這台裝置的資料', value: 'clear' });
    UI.choose('更多操作', opts, v => {
      if (v === 'undo') doUndo();
      else if (v === 'save') saveCurrentArrangement();
      else if (v === 'restore') confirmRestoreSaved();
      else if (v === 'share') Feat.showShare();
      else if (v === 'refresh') refreshRoutes();
      else if (v === 'copy') Feat.copyTrip();
      else if (v === 'synclog') App.showSyncLog();
      else if (v === 'tour') Tour.start(true);
      else if (v === 'feedback') App.openFeedback();
      else if (v === 'clear') document.getElementById('btnClear').click();
      else if (v === 'changelog') App.showChangeLog();
      else if (v === 'copyto') CopyTo.open();
      else if (v === 'scope') toggleScope();
      else if (v === 'copymenu') setTimeout(() => UI.choose('📋 複製', [
        { label: '📋 複製成我的行程（整份變成新的獨立行程）', value: 'copy' },
        { label: '📋 複製景點／航班到其他行程', value: 'copyto' }
      ], w => { if (w === 'copy') Feat.copyTrip(); else if (w === 'copyto') CopyTo.open(); }), 0);
    });
  }

  // v2.1.41 國內／國外切換（影響「準備」分頁的建議待辦範本）
  function toggleScope() {
    const t = trip(), next = Prep.isAbroad() ? 'home' : 'abroad';
    t.scope = next;
    Store.touch({ manual: true });
    UI.toast(next === 'abroad' ? '🌏 已改成國外旅遊，「準備」分頁按「📋 帶入建議待辦」會用出國的清單' : '🏠 已改成國內旅遊，「準備」分頁按「📋 帶入建議待辦」會用國內的清單');
  }

  function saveCurrentArrangement() {
    // 本機立即建立可還原快照並回饋；雲端同步結果誠實回報（要成功才算真的存上雲端）
    Store.markSaved();
    render();
    UI.toast('已在本機暫存，雲端同步中…');
    Store.cloudSaveNow({ skipIfSaved: true }).then(() => {
      UI.toast('☁️ 已儲存到雲端');
    }).catch(e => {
      console.warn('雲端儲存失敗', e);
      if (e && e.conflict) {
        // v2.1.23：衝突一律交給「其他人剛更新了行程」三選一視窗（Store 已自動跳出），不再默默覆蓋對方
      } else {
        UI.alert('雲端尚未儲存', '你的變更目前只存在這台裝置，還沒上傳到雲端。\n\n可能是網路不穩，請確認連線後，再按一次「儲存」。');
      }
    });
  }

  function savedTimeTxt() {
    const ts = Store.savedSnapAt();
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function confirmRestoreSaved() {
    UI.confirm('還原到上次儲存', `要回到 ${savedTimeTxt()} 儲存的安排嗎？目前的變更會被覆蓋（還原後仍可用「↩ 上一步」救回）。`, () => {
      if (Store.restoreSaved()) {
        render();
        UI.toast('已還原到上次儲存的安排');
      }
    });
  }

  async function routeMinute(a, b, mode) {
    if (!a || !b) return 0;
    mode = mode || trip().transport;
    const chosen = typeof RoutePick !== 'undefined' ? RoutePick.chosenOf(a, b, mode) : null;
    if (chosen && chosen.mode === mode) return chosen.min;
    const live = Logic.hasCoords(a) && Logic.hasCoords(b)
      ? await Api.travelTime(a, b, mode)
      : null;
    return live ?? Logic.travelMinutes(a, b, mode);
  }

  async function refreshRoutes() {
    const t = trip();
    try {
      let updated = 0;
      t.legsByDay = {};
      for (let d = 1; d <= Store.days(); d++) {
        const list = spotsOfDay(d);
        const sp = startHotel(d);
        const ep = endHotel(d);
        if (!list.length && !sp && !ep) continue;
        UI.loading(true, `更新第 ${d} 天車程…`);
        const mode = dayTransportOf(d);
        const legs = [];
        let prev = sp || null;
        for (const s of list) {
          legs.push(prev ? await routeMinute(prev, s, mode) : 0);
          prev = s;
        }
        legs.push(ep && prev ? await routeMinute(prev, ep, mode) : 0);
        t.legsByDay[d] = legs;
        updated++;
      }
      Store.touch();
      UI.loading(false);
      render();
      UI.toast(updated ? '車程已更新' : '目前沒有可更新的車程');
    } catch (e) {
      UI.loading(false);
      UI.alert('更新車程失敗', e.message || String(e));
    }
  }

  // ---------- 車程自動更新（每次變更後，背景抓 Google 真實車程，不擋畫面） ----------
  // 只更新「被清掉車程快取」的那幾天（=剛被變更的天）；帶 generation 防止過期寫入
  let autoRouteTimer = null, routeGen = 0, autoRouteRunning = false;
  function scheduleAutoRoute() {
    if (Store.isReadonly() || Api.isMock()) return; // 模擬模式無真實車程
    clearTimeout(autoRouteTimer);
    autoRouteTimer = setTimeout(autoRefreshRoutes, 1600);
  }
  async function autoRefreshRoutes() {
    const t = trip();
    if (!t || autoRouteRunning) return;
    // 找出缺車程（剛被變更）且值得更新的天
    const targets = [];
    for (let d = 1; d <= Store.days(); d++) {
      if (t.legsByDay[d]) continue;                 // 已有（真實）車程就不重抓
      const list = spotsOfDay(d);
      const sp = startHotel(d), ep = endHotel(d);
      if (!list.length && !sp && !ep) continue;
      targets.push(d);
    }
    if (!targets.length) return;
    autoRouteRunning = true;
    const gen = ++routeGen;
    try {
      let changed = false;
      for (const d of targets) {
        if (gen !== routeGen) break;                // 期間又有新變更 → 放棄，等下一輪
        const list = spotsOfDay(d);
        const sp = startHotel(d), ep = endHotel(d);
        const mode = dayTransportOf(d);
        const legs = [];
        let prev = sp || null;
        for (const s of list) { legs.push(prev ? await routeMinute(prev, s, mode) : 0); prev = s; }
        legs.push(ep && prev ? await routeMinute(prev, ep, mode) : 0);
        if (gen !== routeGen) break;                // 寫入前再確認沒被新變更蓋過
        if (!t.legsByDay[d]) { t.legsByDay[d] = legs; changed = true; }
      }
      if (changed && gen === routeGen) { Store.saveDerived(); render(); }
    } catch (e) {
      console.warn('自動更新車程失敗（維持估算值）', e);
    } finally {
      autoRouteRunning = false;
    }
  }

  // 日期軸：全部｜待排｜每天一個圓點（選中的那天亮起、📍 標示），點了看那一天
  function renderDayStrip(show, unCount) {
    const box = $('dayStrip');
    if (!box) return;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    const days = Store.days(), view = currentView();
    let html = `<button class="ds-all${view === 0 ? ' on' : ''}" data-v="0">全部</button>`;
    if (unCount) html += `<button class="ds-un${view === 'un' ? ' on' : ''}" data-v="un">待排 ${unCount}</button>`;
    const bkCount = backupSpots().length;
    if (bkCount) html += `<button class="ds-bk${view === 'bk' ? ' on' : ''}" data-v="bk">⭐ 備選 ${bkCount}</button>`;
    html += '<div class="ds-days">';
    for (let d = 1; d <= days; d++) {
      const iso = Store.dateOfDay(d);
      const on = view === d;
      html += `<button class="ds-day${on ? ' on' : ''}" data-v="${d}" style="--dc:${dayColor(d)}">
        <span class="ds-dot">${on ? '📍' : ''}</span>
        <b>${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}</b><small>週${weekdayOf(iso)}${hasFlightDay(d) ? ' ✈' : ''}</small></button>`;
    }
    html += '</div>';
    box.innerHTML = html;
    box.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
      const v = b.dataset.v === 'un' || b.dataset.v === 'bk' ? b.dataset.v : Number(b.dataset.v);
      const cur = currentView();
      showDay(v, typeof v === 'number' && typeof cur === 'number' && v > 0 && cur > 0 ? (v > cur ? 'next' : 'prev') : '');
    });
    const on = box.querySelector('.ds-day.on');
    if (on) { const row = box.querySelector('.ds-days'); row.scrollLeft = on.offsetLeft - row.clientWidth / 2 + on.clientWidth / 2; }
  }
  // 左右滑換天（只在看單一天時）
  function initSwipe() {
    const el = $('dayList');
    if (!el) return;
    let x0 = 0, y0 = 0, ok = false;
    el.addEventListener('touchstart', e => {
      const tg = e.target;
      ok = e.touches.length === 1 && !tg.closest('input,select,textarea,.drag-grip,.spot-expand');
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', e => {
      if (!ok) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      const v = currentView();
      if (typeof v !== 'number' || v < 1 || Math.abs(dx) < 70 || Math.abs(dy) > 45) return;
      const nd = dx < 0 ? v + 1 : v - 1;
      if (nd >= 1 && nd <= Store.days()) showDay(nd, dx < 0 ? 'next' : 'prev');
    }, { passive: true });
  }

  // 每天主題：自訂標題／圖示；沒設就用當天前兩個景點
  const THEME_ICONS = ['📍', '♨️', '🏔️', '🛍️', '🌃', '🏯', '🌸', '🍜', '🚗', '✈️', '🏖️', '🎢', '🍁', '❄️'];
  function dayTheme(d) {
    const t = trip();
    const own = String((t.dayTitles || {})[d] || '').trim();
    if (own) return { title: own, auto: false };
    const list = spotsOfDay(d);
    const names = list.slice(0, 2).map(s => s.name);
    return { title: names.length ? names.join('＋') + (list.length > 2 ? '…' : '') : '還沒有景點', auto: true };
  }
  function editDayTheme(d) {
    if (Store.isReadonly()) return;
    const t = trip();
    let icon = (t.dayIcons || {})[d] || '📍';
    const body = document.createElement('div');
    const auto = dayTheme(d);
    body.innerHTML = `
      <label>這天的主題（例如：十和田湖＋奧入瀨）</label>
      <input id="dtTitle" type="text" maxlength="30" placeholder="${UI.esc(auto.auto ? auto.title : '')}" value="${UI.esc((t.dayTitles || {})[d] || '')}">
      <label>圖示</label>
      <div class="dt-icons">${THEME_ICONS.map(i => `<button type="button" class="dt-icon${i === icon ? ' on' : ''}" data-i="${i}">${i}</button>`).join('')}</div>
      <p class="hint">空白＝自動用當天前兩個景點當標題。</p>`;
    body.querySelectorAll('.dt-icon').forEach(b => b.onclick = () => {
      icon = b.dataset.i;
      body.querySelectorAll('.dt-icon').forEach(x => x.classList.toggle('on', x === b));
    });
    UI.modal(`✎ 第 ${d} 天主題`, body, [{ label: '儲存', primary: true, onClick: () => {
      t.dayTitles = t.dayTitles || {}; t.dayIcons = t.dayIcons || {};
      const v = body.querySelector('#dtTitle').value.trim();
      if (v) t.dayTitles[d] = v; else delete t.dayTitles[d];
      if (icon && icon !== '📍') t.dayIcons[d] = icon; else delete t.dayIcons[d];
      Store.touch({ manual: true }); UI.closeModal(); render();
    } }]);
    setTimeout(() => body.querySelector('#dtTitle').focus(), 50);
  }
  // ⋯ 這天設定：原本一整排按鈕收進同一個選單
  function dayMenu(d, list) {
    const t = trip();
    const opts = [
      { label: `🕘 出發／結束時間（${dayStartOf(d)}–${dayEndOf(d)}）`, value: 'time' },
      { label: `${TRANSPORT_META[dayTransportOf(d)][0]} 這天的交通方式（${TRANSPORT_META[dayTransportOf(d)][1]}）`, value: 'trans' },
      { label: '🍜 附近美食', value: 'food' },
      ...(list.length ? [{ label: '🧭 全日導航', value: 'nav' }] : []),
      { label: `☔ 雨天備案${t.rainActive[d] ? '（使用中）' : (t.rainPlans[d] && t.rainPlans[d].spots && t.rainPlans[d].spots.length ? '（已設定）' : '')}`, value: 'rain' },
      { label: `🏨 ${Store.hotelOfNight(d - 1) || Store.hotelOfNight(d - 2) ? '換飯店' : '推薦飯店'}`, value: 'hotel' },
      { label: `✈️ 航班${hasFlightDay(d) ? '（已設定）' : ''}`, value: 'flight' },
      { label: '✎ 這天的主題與圖示', value: 'theme' }
    ];
    if (d === 1) opts.push({ label: `🚩 集合地${t.meetPoint ? '（已設定）' : ''}`, value: 'pts' });
    if (d === Store.days()) opts.push({ label: `🏁 解散地${t.endPoint ? '（已設定）' : ''}`, value: 'pts' });
    UI.choose(`第 ${d} 天設定`, opts, v => {
      if (v === 'time') editDayTime(d);
      else if (v === 'trans') openDayTransport(d);
      else if (v === 'food') Feat.openFood(d);
      else if (v === 'nav') window.open(dayNavLink(d, list), '_blank', 'noopener');
      else if (v === 'rain') Feat.openRainPlan(d);
      else if (v === 'hotel') Feat.recommendHotel(d);
      else if (v === 'flight') Flights.openDay(d, render);
      else if (v === 'theme') editDayTheme(d);
      else if (v === 'pts') Feat.openRoutePoints();
    });
  }
  // 時間軸列：點卡片展開／收合動作列（一次只開一列）
  function bindExpand(div, id) {
    if (id === openRowId) div.classList.add('open');
    div.addEventListener('click', e => {
      if (e.target.closest('button,a,select,input,.spot-thumb,.thumb')) return;
      if (!div.querySelector('.spot-expand')) return;
      const willOpen = !div.classList.contains('open');
      document.querySelectorAll('.spot-row.open').forEach(r => r.classList.remove('open'));
      div.classList.toggle('open', willOpen);
      openRowId = willOpen ? id : '';
    });
  }
  const timeOf = txt => { const m = String(txt || '').match(/(\d{1,2}:\d{2})/); return m ? m[1] : ''; };

  function renderSummaryBar() {
    const t = trip();
    const modeTxt = { driving: '🚗 開車', transit: '🚇 大眾運輸', walking: '🚶 走路' };
    const visitedCount = t.spots.filter(s => s.visited).length;
    const caret = Store.isReadonly() ? '' : ' ▾';
    // v2.1.32 行程大卡＝行程重點＋行前準備進度（主色漸層、放在最上面）
    const days = Store.days();
    const nights = Math.max(days - 1, 0);
    let travel = 0;
    for (let d = 1; d <= days; d++) travel += legsForDay(d).reduce((x, y) => x + (y || 0), 0);
    const dateTxt = iso => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
    const facts = [`${days} 天${nights ? ` ${nights} 夜` : ''}`, `${t.spots.filter(s => !s.backup).length} 個景點${visitedCount ? `（已去 ${visitedCount}）` : ''}${backupSpots().length ? `｜⭐ 備選 ${backupSpots().length}` : ''}`, travel ? `總車程 ${Logic.fmtDur(travel)}` : ''].filter(Boolean);
    $('tripSummaryBar').innerHTML = `
      <div class="sb-top">
        <div><div class="sb-name">${UI.esc(t.name)}</div><div class="sb-count">${UI.esc(Prep.countdown())}</div></div>
        <div class="sb-chips">
          <button id="btnTripDates" class="sb-chip" title="變更旅遊天數">🗓️ ${dateTxt(t.startDate)}–${dateTxt(t.endDate)}${caret}</button>
          <button id="btnSwitchMode" class="sb-chip">${modeTxt[t.transport]}${caret}</button>
        </div>
      </div>
      ${Prep.miniHtml()}
      <p class="sb-facts">${facts.map(UI.esc).join('｜')}</p>
      <p class="sb-note">⏱️ 預估時間僅供參考，實際可能因路線、路況或營業時間而有所不同</p>`;
    Prep.bindMini();
    const dBtn = $('btnTripDates');
    if (Store.isReadonly()) dBtn.style.pointerEvents = 'none';
    else dBtn.onclick = () => Feat.editTripDates();
    const b = $('btnSwitchMode');
    if (Store.isReadonly()) { b.style.pointerEvents = 'none'; return; }
    b.onclick = () => {
      UI.choose('切換交通方式（套用到所有天）', [
        { label: '🚗 開車', value: 'driving' },
        { label: '🚇 大眾運輸', value: 'transit' },
        { label: '🚶 走路', value: 'walking' }
      ], v => {
        t.transport = v;
        t.dayTransportOv = {};   // 全域切換＝套用到每一天，清掉個別天的覆寫
        t.legsByDay = {};
        Store.touch();
        render();
        UI.toast('全部改為「' + { driving: '開車', transit: '大眾運輸', walking: '走路' }[v] + '」，正在重新計算車程…');
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
        <p class="hint">按下方「自動安排最佳路線」自動分天，或按住 ☰ 直接拖到某一天</p>
      </div>`;
    list.forEach(s => card.appendChild(spotRow(s, null, 0)));
    return card;
  }

  // v2.1.36 ⭐ 備選景點卡片：不會被自動安排排進去；可放回待排、排到某天、刪除
  function renderBackupCard(list) {
    const card = document.createElement('div');
    card.className = 'day-card backup-card';
    card.dataset.day = 'bk';
    const area = tripArea();
    card.innerHTML = `
      <div class="day-head">
        <div class="day-head-top"><span class="day-title">⭐ 備選景點（${list.length}）</span></div>
        <p class="hint">這裡的景點不會被「自動安排」排進去。想去的時候再放回待排，或直接指定某一天。</p>
      </div>
      <div class="bk-list">${list.map(s => {
        const km = area && Logic.hasCoords(s) ? Logic.haversineKm(area.center, s) : null;
        const far = km !== null && km > area.radiusKm + 30;
        return `<div class="bk-row" data-id="${UI.esc(s.id)}">
          <div class="bk-main"><b>${UI.esc(s.name)}</b>
            ${km !== null ? `<span class="s-dist${far ? ' far' : ''}">${far ? '⚠️ ' : '📍 '}離行程中心 ${distTxt(km)}</span>` : ''}
            ${s.address ? `<div class="hint addr-line">${UI.esc(s.address)}</div>` : ''}
            ${s.note ? `<div class="hint">📝 ${UI.esc(s.note)}</div>` : ''}</div>
          <div class="bk-acts edit-only">
            <button type="button" class="btn-soft" data-bk="back">放回待排</button>
            <button type="button" class="btn-outline" data-bk="day">排到…</button>
            <button type="button" class="btn-danger-ghost" data-bk="del" aria-label="刪除">✕</button>
          </div>
        </div>`;
      }).join('')}</div>`;
    card.querySelectorAll('.bk-row').forEach(r => {
      const s = trip().spots.find(x => x.id === r.dataset.id);
      r.querySelector('[data-bk="back"]').onclick = () => fromBackup(s, 0);
      r.querySelector('[data-bk="day"]').onclick = () => UI.choose(`「${s.name}」排到哪一天？`,
        Array.from({ length: Store.days() }, (_, i) => ({ label: `📅 第 ${i + 1} 天`, value: i + 1 })), d => fromBackup(s, d));
      r.querySelector('[data-bk="del"]').onclick = () => deleteSpot(s);
    });
    return card;
  }
  function toBackup(s) {
    const t = trip();
    if (s.day) delete t.legsByDay[s.day];
    s.day = 0; s.backup = true; s.locked = false;
    Store.touch({ manual: true }); render();
    UI.toast(`⭐ 「${s.name}」移到備選景點，自動安排不會排它`);
  }
  function fromBackup(s, d) {
    const t = trip();
    s.backup = false; s.day = d || 0;
    s.order = d ? spotsOfDay(d).length : t.spots.length;
    if (d) delete t.legsByDay[d];
    Store.touch({ manual: true });
    if (d && viewDay !== 0) viewDay = d;
    render();
    UI.toast(d ? `已把「${s.name}」排到第 ${d} 天` : `已把「${s.name}」放回待排`);
  }

  function missingCoordNames(list, extraPoints) {
    const all = [...(list || []), ...(extraPoints || [])].filter(Boolean);
    return all.filter(p => !Logic.hasCoords(p)).map(p => p.name || '未命名地點');
  }

  // 每天三餐摘要：已安排顯示 ✓，未安排淡淡提醒「未定」（不硬 show 空列）；有點心才顯示點心
  // 住宿餐別（早餐常在飯店/民宿吃）：以 day + 位置(start/end) 為 key 存進 trip.stayMeals
  const STAY_MEAL_LIST = [['breakfast', '🍳 早餐'], ['lunch', '🍜 午餐'], ['dinner', '🍽 晚餐'], ['snack', '🍡 點心']];
  const MEAL_TAG = { breakfast: '🍳 早餐', lunch: '🍜 午餐', dinner: '🍽 晚餐', snack: '🍡 點心' };
  const stayMealKey = (day, pos) => day + ':' + pos;
  function stayMealsOf(day, pos) { return ((trip() && trip().stayMeals) || {})[stayMealKey(day, pos)] || []; }
  function stayMealsForDay(day) { return [].concat(stayMealsOf(day, 'start'), stayMealsOf(day, 'end')); }
  function openStayMeals(day, pos, name) {
    const t = trip();
    if (!t.stayMeals) t.stayMeals = {};
    const key = stayMealKey(day, pos);
    const cur = new Set(t.stayMeals[key] || []);
    const body = document.createElement('div');
    body.className = 'stack';
    body.innerHTML = `<p class="hint">勾選在「${UI.esc(name)}」吃的餐（例如飯店早餐、民宿晚餐）：</p>` +
      STAY_MEAL_LIST.map(([v, lb]) =>
        `<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;font-size:1rem">
          <input type="checkbox" value="${v}" ${cur.has(v) ? 'checked' : ''} style="width:22px;height:22px">
          <span>${lb}</span></label>`).join('');
    UI.modal('🍽 在住宿用餐', body, [{
      label: '儲存', primary: true, onClick: () => {
        const picked = Array.from(body.querySelectorAll('input:checked')).map(i => i.value);
        if (picked.length) t.stayMeals[key] = picked; else delete t.stayMeals[key];
        Store.touch(); UI.closeModal(); render();
        UI.toast(picked.length ? '已記錄住宿餐別' : '已清除住宿餐別');
      }
    }]);
  }

  function mealSummaryHtml(list, day) {
    const staySet = new Set(stayMealsForDay(day));
    const has = key => staySet.has(key) || list.some(s => s.meal === key);
    const badge = (key, label) => has(key)
      ? `<b style="color:var(--ok)">${label}✓</b>`
      : `<span style="color:var(--text-2)">${label}未定</span>`;
    const snack = has('snack') ? `｜<b style="color:var(--ok)">點心✓</b>` : '';
    return `<p class="hint" style="margin:2px 0 0">🍽 ${badge('breakfast', '早餐')}｜${badge('lunch', '午餐')}｜${badge('dinner', '晚餐')}${snack}</p>`;
  }

  // 依景點當天的星期，從已存的營業時間文字取「今日」那一行（天卡直接顯示，不用進備註）
  const WEEK_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function todayHoursLine(s) {
    if (!s.hoursText || !s.day) return '';
    const wd = new Date(Store.dateOfDay(s.day) + 'T00:00:00').getDay();
    const line = s.hoursText.split('\n').find(l => l.startsWith(WEEK_ZH[wd]));
    if (!line) return '';
    return line.replace(/^[^:：]*[:：]\s*/, '').trim();
  }

  // 既有景點（v2.1.3 之前加入、還沒抓過營業時間）→ 載入後回補一次，天卡才顯示得出來
  const hoursFetching = new Set();
  function backfillHours() {
    const t = trip();
    if (!t || Api.isMock()) return;
    t.spots.forEach(s => {
      if (s.hoursText !== undefined || hoursFetching.has(s.id)) return;
      const pid = s.placeId;
      if (!pid || String(pid).startsWith('custom') || String(pid).startsWith('m-')) { s.hoursText = ''; return; }
      hoursFetching.add(s.id);
      Api.placeHours(pid).then(h => {
        s.hoursText = h ? (h.weekdayText || []).join('\n') : '';
        s.closedDays = h ? (h.closedDays || []) : [];
        render();
      }).catch(() => { s.hoursText = ''; });
    });
  }

  function renderDayCard(d, list) {
    const t = trip();
    const dateISO = Store.dateOfDay(d);
    const sp = startPoint(d), ep = endPoint(d);
    const legs = legsForDay(d);
    const tl = Logic.buildTimeline(list, legs, dayStartOf(d));
    // 用未折疊的原始結束分鐘（endTime 會 %24 折回，跨午夜時會誤判）
    const rawEndMin = Logic.toMin(dayStartOf(d)) + tl.totalTravel + tl.totalStay;
    const overTime = list.length > 0 && rawEndMin > Logic.toMin(dayEndOf(d));
    const departF = Flights.of(d, 'depart'), arriveF = Flights.of(d, 'arrive');
    const overTxt = Flights.isComplete(departF) ? '⚠️ 可能趕不上報到' : '⚠️ 可能排不完';
    const noCoord = missingCoordNames(list, [sp && sp.p, ep && ep.p]);
    const estimateHint = noCoord.length
      ? `<div class="rain-alert" style="border-color:var(--danger);background:#FFF4EF">⚠️ ${noCoord.length} 個地點沒有座標，路程會略過或不精準：${noCoord.map(UI.esc).join('、')}</div>`
      : '';

    const card = document.createElement('div');
    card.className = 'day-card' + (d % 2 === 0 ? ' day-shade' : '');
    card.dataset.day = d;
    card.style.borderLeftColor = dayColor(d);

    const dateTxt = `${Number(dateISO.slice(5, 7))}/${Number(dateISO.slice(8, 10))}`;
    const head = document.createElement('div');
    head.className = 'day-head';
    const theme = dayTheme(d);
    const icon = (t.dayIcons || {})[d] || '📍';
    const stay = d < Store.days() ? Store.hotelOfNight(d - 1) : null;
    const visitedTxt = list.some(s => s.visited) ? `<span class="dh-visited">✅ ${list.filter(s => s.visited).length}/${list.length}</span>` : '';
    const rainSet = t.rainPlans[d] && t.rainPlans[d].spots && t.rainPlans[d].spots.length;
    head.innerHTML = `
      <div class="dh-top">
        <span class="dh-day" style="background:${dayColor(d)}">Day ${d}</span>
        <span class="dh-date">${dateTxt}（${weekdayOf(dateISO)}）</span>${visitedTxt}
        <span class="day-weather" data-day-weather="${d}">☁️ 查天氣中…</span>
      </div>
      <button class="dh-theme" data-theme="${d}" type="button" ${Store.isReadonly() ? 'disabled' : ''}>
        <span class="dh-icon">${icon}</span><span class="dh-title${theme.auto ? ' auto' : ''}">${UI.esc(theme.title)}</span>${Store.isReadonly() ? '' : '<span class="dh-edit">✎</span>'}
      </button>
      ${stay ? `<div class="dh-stay">🏨 住 ${UI.esc(stay.name)}${HotelPoll.isConfirmedHotel(stay) ? ' <span class="hp-tag ok">✅ 已確定</span>' : ''}</div>` : ''}
      <div class="day-outfit" data-day-outfit="${d}"></div>
      ${RoutePick.winterTip(d) ? `<div class="dh-winter">❄️ 冬季部分山路會封閉，出發前請查當地官方道路公告；點交通段（🚗 開車 ›）可以改路線。</div>` : ''}
      ${estimateHint}
      <div data-rain-slot="${d}"></div>
      ${list.length ? `<p class="dh-sum">🚗 車程 ${Logic.fmtDur(tl.totalTravel)}｜⏱ 停留 ${Logic.fmtDur(tl.totalStay)}｜預計 ${tl.endTime} 結束${overTime ? ` <span style="color:var(--danger);font-weight:700">${overTxt}</span>` : ''}</p>` : ''}
      ${list.length ? mealSummaryHtml(list, d) : ''}
      <div class="day-tools">
        <button data-addspot="${d}" class="edit-only dt-add">➕ 加景點</button>
        <button data-daymenu="${d}" class="edit-only">⋯ 這天設定</button>
        ${Store.isReadonly() && list.length ? `<a href="${dayNavLink(d, list)}" target="_blank" rel="noopener">🧭 全日導航</a>` : ''}
        ${Store.isReadonly() && rainSet ? `<button data-rainbtn="${d}">☔ 雨天備案</button>` : ''}
      </div>`;
    card.appendChild(head);
    const tlw = document.createElement('div'); // v2.1.33 時間軸：左邊時間＋虛線＋卡片
    tlw.className = 'tl-wrap';
    card.appendChild(tlw);


    // 搭機前（有抵達航班）：出發地 → 地面交通 → 出發機場 → ✈️ 航班卡
    if (Flights.isComplete(arriveF)) appendPreFlight(tlw, d, arriveF);
    // 起點列
    const startLabel = sp ? ({ meet: '從集合地出發', airport: '出關後從機場出發' }[sp.kind] || '從飯店出發') : '';
    if (sp && list.length) tlw.appendChild(pointRow(sp, `${dayStartOf(d)} ${startLabel}`, d, 'start'));

    // 景點列 + 路段
    const dMode = dayTransportOf(d);
    tl.rows.forEach((row, i) => {
      if (row.legMin > 0) tlw.appendChild(legRow(row.legMin, dMode, i === 0 ? (sp && sp.p) : tl.rows[i - 1].spot, row.spot));
      tlw.appendChild(spotRow(row.spot, row, i + 1, d));
    });
    if (list.length && ep) {
      if (tl.backLeg > 0) tlw.appendChild(legRow(tl.backLeg, dMode, tl.rows.length ? tl.rows[tl.rows.length - 1].spot : (sp && sp.p), ep.p));
      const endLabel = ep.kind === 'end' ? '抵達解散地' : ep.kind === 'airport' ? `抵達機場（${dayEndOf(d)} 前報到）` : '回到飯店';
      tlw.appendChild(pointRow(ep, `${tl.endTime} ${endLabel}`, d, 'end'));
    }
    if (!list.length) {
      if (sp) tlw.appendChild(pointRow(sp, pointEmptyDayText(sp), d, 'start'));
      const shouldShowEmptyLeg = sp && ep && !sameRoutePoint(sp, ep) && legs[0] > 0 && !(sp.kind === 'hotel' && ep.kind === 'hotel');
      if (shouldShowEmptyLeg) tlw.appendChild(legRow(legs[0], dMode, sp.p, ep.p));
      if (ep && !sameRoutePoint(sp, ep)) tlw.appendChild(pointRow(ep, pointEmptyDayText(ep), d, 'end'));
      const p = document.createElement('p');
      p.className = 'hint'; p.style.padding = '0 14px 12px';
      p.textContent = (sp || ep)
        ? '這天還沒有景點，但住宿已列出。按上面的「➕ 加景點」，或按住 ☰ 把景點拖過來。'
        : '這天還沒有景點：按上面的「➕ 加景點」，或按住 ☰ 把景點拖過來。';
      tlw.appendChild(p);
    }
    // 起飛後（有起飛航班）：✈️ 航班卡 → 抵達機場 → 地面交通 → 解散地／當晚飯店
    if (Flights.isComplete(departF)) appendPostFlight(tlw, d, departF);

    const addBtn = head.querySelector(`[data-addspot="${d}"]`);
    if (addBtn) addBtn.onclick = () => openAddSpot(d);
    const menuBtn = head.querySelector(`[data-daymenu="${d}"]`);
    if (menuBtn) menuBtn.onclick = () => dayMenu(d, list);
    const rainBtn = head.querySelector(`[data-rainbtn="${d}"]`);
    if (rainBtn) rainBtn.onclick = () => Feat.openRainPlan(d);
    const themeBtn = head.querySelector(`[data-theme="${d}"]`);
    if (themeBtn) themeBtn.onclick = () => editDayTheme(d);
    return card;
  }

  // ---------- 航班的前後段 ----------
  const minsOf = v => Number(v) || 0;
  // 機場外的地面交通列（可手動調整分鐘數）
  // autoMin：系統預估（Google 或直線估算）。手動調整時兩個都顯示：「約 2 小時（手動）｜預估約 1 時 40 分」
  function groundLegRow(min, mode, f, d, toAirport, autoMin, from, to) {
    const icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[mode || trip().transport];
    const div = document.createElement('div');
    div.className = 'leg-row';
    const autoSrc = Flights.autoSource(f, from, to, mode);
    const autoTxt = Flights.isManualGround(f) ? `｜預估約 ${Logic.fmtDur(autoMin)}（${autoSrc}）` : '';
    div.innerHTML = `<span class="tl-pill">${icon} ${toAirport ? '到機場' : '到目的地'}</span><span>約 ${Logic.fmtDur(min)}（${Flights.groundSource(f, from, to, mode)}）${autoTxt}</span>
      <button class="edit-only ground-edit" type="button" title="手動調整這段時間">✎</button>`;
    div.querySelector('.ground-edit').onclick = () => {
      const body = document.createElement('div');
      body.innerHTML = `<label>${toAirport ? '出發地到機場' : '機場到目的地'}要幾分鐘？（空白＝自動計算）</label>
        <input id="groundInp" type="number" inputmode="numeric" min="0" max="600" step="5" value="${f.groundMin === null || f.groundMin === undefined ? '' : f.groundMin}" placeholder="預估 ${autoMin}">
        <p class="hint">系統預估約 ${Logic.fmtDur(autoMin)}（${autoSrc}）。清空＝改回使用預估。</p>`;
      UI.modal('🚗 調整地面交通時間', body, [{
        label: '套用', primary: true, onClick: () => {
          const v = document.getElementById('groundInp').value.trim();
          f.groundMin = v === '' ? null : Math.max(0, Math.round(Number(v)));
          Store.touch({ manual: true });
          UI.closeModal();
          render();
          UI.toast(v === '' ? '已改回自動計算' : `已改為 ${Logic.fmtDur(f.groundMin)}`);
        }
      }]);
    };
    return div;
  }
  function appendPreFlight(card, d, f) {
    const origin = baseStartPoint(d);
    const mode = dayTransportOf(d);
    const checkinAt = Logic.toMin(f.depTime) - minsOf(f.checkinMin);
    if (origin) {
      const g = Flights.groundMin(f, origin.p, f.depAirport, mode);
      card.appendChild(pointRow(origin, `${Logic.toHHMM(checkinAt - g)} 建議出發前往機場`, d, 'start'));
      card.appendChild(groundLegRow(g, mode, f, d, true, Flights.autoGroundMin(f, origin.p, f.depAirport, mode), origin.p, f.depAirport));
      Flights.ensureGroundAuto(f, origin.p, f.depAirport, mode, render);
    }
    card.appendChild(Flights.cardEl(f, Store.isReadonly() ? null : () => Flights.openForm(d, 'arrive', f, render)));
  }
  function appendPostFlight(card, d, f) {
    card.appendChild(Flights.cardEl(f, Store.isReadonly() ? null : () => Flights.openForm(d, 'depart', f, render)));
    const dest = baseEndPoint(d);
    if (!dest) return;
    const mode = dayTransportOf(d);
    const g = Flights.groundMin(f, f.arrAirport, dest.p, mode);
    card.appendChild(groundLegRow(g, mode, f, d, false, Flights.autoGroundMin(f, f.arrAirport, dest.p, mode), f.arrAirport, dest.p));
    const at = Logic.toHHMM(Logic.toMin(f.arrTime) + minsOf(f.clearMin) + g);
    card.appendChild(pointRow(dest, `約 ${at} 抵達${dest.kind === 'end' ? '解散地' : '飯店'}${Flights.tz(f)}`, d, 'end'));
    Flights.ensureGroundAuto(f, f.arrAirport, dest.p, mode, render);
  }

  // 調整某一天的出發／結束時間（時間軸依停留＋車程重新推算；超時會提醒）
  function editDayTime(d) {
    const t = trip();
    if (hasFlightDay(d)) UI.toast('這天有航班：出發／結束時間以航班為準（要改請按「✈️ 航班」）');
    if (!t.dayStartOv) t.dayStartOv = {};
    if (!t.dayEndOv) t.dayEndOv = {};
    const body = document.createElement('div');
    body.innerHTML = `
      <label>第 ${d} 天出發時間</label>
      <input id="dayStartInp" type="time" value="${dayStartOf(d)}">
      <label style="margin-top:8px">第 ${d} 天結束時間</label>
      <input id="dayEndInp" type="time" value="${dayEndOf(d)}">
      <p class="hint">抵達／出發時間會依停留與車程自動重排。若行程排不進這個時段，會在該天卡片提醒你。全域預設 ${t.dayStart}–${t.dayEnd}。</p>`;
    const actions = [{
      label: '套用', primary: true,
      onClick: () => {
        const s = document.getElementById('dayStartInp').value;
        const e = document.getElementById('dayEndInp').value;
        if (!s || !e) { UI.toast('請選擇時間'); return; }
        if (Logic.toMin(e) <= Logic.toMin(s)) { UI.toast('結束時間要晚於出發時間'); return; }
        t.dayStartOv[d] = s;
        t.dayEndOv[d] = e;
        Store.touch();
        UI.closeModal();
        render();
        UI.toast(`第 ${d} 天改為 ${s}–${e}，時間已重排`);
      }
    }];
    if ((t.dayStartOv[d] || t.dayEndOv[d])) actions.push({
      label: `還原預設 ${t.dayStart}–${t.dayEnd}`,
      onClick: () => {
        delete t.dayStartOv[d];
        delete t.dayEndOv[d];
        Store.touch();
        UI.closeModal();
        render();
        UI.toast(`第 ${d} 天恢復預設 ${t.dayStart}–${t.dayEnd}`);
      }
    });
    UI.modal(`🕘 第 ${d} 天時間`, body, actions);
  }

  // 設定某一天的交通方式（覆寫全域預設；改完清當天車程快取，背景自動重抓真實車程）
  function openDayTransport(d) {
    const t = trip();
    if (Store.isReadonly()) { UI.toast('唯讀模式無法修改'); return; }
    const cur = (t.dayTransportOv || {})[d] || null;
    const opts = [
      { label: `🚗 開車${cur === 'driving' ? ' ✓' : ''}`, value: 'driving' },
      { label: `🚇 大眾運輸${cur === 'transit' ? ' ✓' : ''}`, value: 'transit' },
      { label: `🚶 走路${cur === 'walking' ? ' ✓' : ''}`, value: 'walking' }
    ];
    if (cur) opts.push({ label: `↩ 跟全部一樣（預設 ${TRANSPORT_META[t.transport][1]}）`, value: 'default' });
    UI.choose(`第 ${d} 天的交通方式`, opts, v => {
      if (!t.dayTransportOv) t.dayTransportOv = {};
      if (v === 'default') delete t.dayTransportOv[d];
      else t.dayTransportOv[d] = v;
      delete t.legsByDay[d];
      Store.touch();
      render();
      UI.toast(`第 ${d} 天交通改為「${TRANSPORT_META[dayTransportOf(d)][1]}」，正在重新計算車程…`);
    });
  }

  function legRow(min, mode, from, to) {
    mode = mode || trip().transport;
    const icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[mode];
    const div = document.createElement('div');
    div.className = 'leg-row';
    const name = { driving: '開車', transit: '大眾運輸', walking: '走路' }[mode];
    // v2.1.35 點藥丸選路線（開車／走路）；選過的顯示道路名稱，選到標記封閉的道路會警告
    const pickable = mode !== 'transit' && from && to && Logic.hasCoords(from) && Logic.hasCoords(to);
    const chosen = pickable ? RoutePick.chosenOf(from, to, mode) : null;
    const bad = chosen && RoutePick.isClosed(chosen.summary);
    div.innerHTML = pickable
      ? `<button type="button" class="tl-pill pick${chosen ? ' chosen' : ''}${bad ? ' bad' : ''}" title="${Store.isReadonly() ? '看這段的路線' : '選這段要走的路線'}">${bad ? '⛔' : icon} ${name}${chosen ? `・${UI.esc(chosen.summary || '自訂路線')}` : ''} ›</button><span>約 ${Logic.fmtDur(min)}${bad ? '　<b class="tl-bad">經過你標記冬季封閉的道路，請改路線</b>' : ''}</span>`
      : `<span class="tl-pill">${icon} ${name}</span><span>約 ${Logic.fmtDur(min)}</span>`;
    const b = div.querySelector('.pick');
    if (b) b.onclick = () => RoutePick.open(from, to, mode, () => render());
    return div;
  }

  // 起終點列（飯店 / 集合地 / 解散地）
  function pointRow(spObj, timeTxt, day, pos) {
    const p = spObj.p, kind = spObj.kind;
    const icon = kind === 'meet' ? '🚩' : kind === 'end' ? '🏁' : kind === 'airport' ? '✈️' : '🏨';
    const stayM = (kind === 'hotel' && day) ? stayMealsOf(day, pos) : [];
    const mealTags = stayM.length ? `<div class="spot-times" style="color:var(--ok)">🍽 ${stayM.map(m => MEAL_TAG[m]).join('｜')}（在這裡吃）</div>` : '';
    const div = document.createElement('div');
    div.className = 'spot-row';
    const payTag = (kind === 'hotel' && p.pay ? `<span class="pay-badge pay-${p.pay}">${UI.PAY_LABELS[p.pay] || ''}</span>` : '') +
      (kind === 'hotel' && HotelPoll.isConfirmedHotel(p) ? '<span class="hp-tag ok" title="大家投票、主揪確定的住宿">✅ 已確定</span>' : '');
    const pg = kind === 'hotel' ? PaySync.groupOfHotel(p) : null, pe = pg && PaySync.expenseOf(pg);
    const expTxt = pe ? `<div class="spot-times">💰 NT$${Number(pe.amount).toLocaleString()}（${UI.esc(pe.payer)} 先付）${PaySync.statusOf(pe) === 'part' ? `・已付 ${Number(pe.paidAmount || 0).toLocaleString()}／剩 ${PaySync.remainingOf(pe).toLocaleString()}` : ''}</div>` : '';
    const priceTxt = kind === 'hotel' && (p.priceWeekday || p.priceWeekend)
      ? `<div class="spot-times">💲 ${p.priceWeekday ? `平日 $${Number(p.priceWeekday).toLocaleString()}` : ''}${p.priceWeekday && p.priceWeekend ? '｜' : ''}${p.priceWeekend ? `假日 $${Number(p.priceWeekend).toLocaleString()}` : ''}</div>` : '';
    const coordWarning = Logic.hasCoords(p) ? '' : `<div class="spot-times" style="color:var(--danger)">⚠️ 沒有座標，路程無法精準估算</div>`;
    const mapLink = Logic.hasCoords(p) || p.name ? `<a href="${UI.gmapLink(p)}" target="_blank" rel="noopener" style="padding:6px">📍</a>` : '';
    div.classList.add('pt-row', 'pt-' + kind);
    const ptId = 'pt:' + day + ':' + pos + ':' + kind;
    div.innerHTML = `
      <div class="tl-time">${timeOf(timeTxt)}</div>
      <div class="spot-main">
        <span class="spot-no hotel">${icon}</span>
        <div class="spot-info">
          <div class="spot-name">${kind !== 'hotel' ? icon + ' ' : ''}${UI.esc(p.name)} ${payTag}</div>
          <div class="spot-times">${timeTxt}</div>
          ${p.address ? `<div class="spot-times addr-line">📍 ${UI.esc(p.address)}</div>` : ''}
          ${kind === 'hotel' && p.note ? `<div class="spot-times">📝 ${UI.esc(p.note)}</div>` : ''}
          ${priceTxt}
          ${expTxt}
          ${mealTags}
          ${coordWarning}
        </div>
        ${p.photo ? `<img class="thumb thumb-sm" src="${p.photo}" alt="">` : ''}
        ${kind === 'hotel' ? `<button class="drag-grip edit-only" data-act="hdrag" title="按住拖曳，把住宿移到其他天">☰</button>` : ''}
      </div>
      <div class="spot-expand">
        <div class="spot-actions">
          ${kind === 'hotel' ? `<button class="edit-only" data-act="hmeal" title="在這裡用餐：早／午／晚／點心">🍽</button>
          <button class="edit-only" data-act="hexp" title="記一筆帳">💰</button>
          <button class="edit-only pt-text-btn" data-act="hedit" title="付款狀態（已刷全額／已刷部分／入住前自動扣款／當天現刷）、房價、備註">💳 付款／備註</button>` : ''}
          ${(kind === 'meet' || kind === 'end') ? `<button class="edit-only" data-act="ptmenu" title="更多：更改地點／移除／導航／記帳">⋯</button>` : ''}
          ${kind === 'airport' ? `<button class="edit-only" data-act="apflight" title="編輯航班">✎</button>` : ''}
          ${mapLink}
        </div>
      </div>`;
    bindExpand(div, ptId);
    const thumb = div.querySelector('.thumb');
    if (thumb) thumb.onclick = () => UI.photoZoom(p.photo, p.name);
    const he = div.querySelector('[data-act="hedit"]');
    if (he) he.onclick = () => editHotelInfo(p);
    const hd = div.querySelector('[data-act="hdrag"]');
    if (hd && kind === 'hotel') hd.addEventListener('pointerdown', e => startHotelDrag(e, p, div));
    const hm = div.querySelector('[data-act="hmeal"]');
    if (hm) hm.onclick = () => openStayMeals(day, pos, p.name);
    const hx = div.querySelector('[data-act="hexp"]');
    if (hx) hx.onclick = () => Feat.quickExpense({ item: p.name, date: Store.dateOfDay(day) });
    const af = div.querySelector('[data-act="apflight"]');
    if (af) af.onclick = () => Flights.openDay(day, render);
    const pm = div.querySelector('[data-act="ptmenu"]');
    if (pm) pm.onclick = () => pointMenu(spObj);
    return div;
  }

  // 集合地／解散地的功能選單（比照景點的 ⋯）
  function pointMenu(spObj) {
    const p = spObj.p, isMeet = spObj.kind === 'meet';
    const opts = [
      { label: '✏️ 更改地點', value: 'edit' },
      { label: '💰 記一筆帳（交通）', value: 'exp' }
    ];
    if (Logic.hasCoords(p) || p.name) opts.push({ label: '🧭 導航到這裡', value: 'nav' });
    opts.push({ label: isMeet ? '🗑 移除集合地' : '🗑 移除解散地', value: 'del', danger: true });
    UI.choose(isMeet ? '🚩 集合出發地' : '🏁 解散地', opts, v => {
      const t = trip();
      if (v === 'edit') Feat.openRoutePoints();
      else if (v === 'exp') Feat.quickExpense({ item: p.name, date: isMeet ? t.startDate : Store.dateOfDay(Store.days()) });
      else if (v === 'nav') window.open(UI.navLink(p), '_blank', 'noopener');
      else if (v === 'del') {
        UI.confirm(isMeet ? '移除集合地？' : '移除解散地？',
          `確定要移除「${p.name}」嗎？之後這天會改用飯店當起／終點。`, () => {
            if (isMeet) t.meetPoint = null; else t.endPoint = null;
            delete t.legsByDay[1]; delete t.legsByDay[Store.days()];
            Store.touch();
            render();
            UI.toast(isMeet ? '已移除集合地' : '已移除解散地');
          });
      }
    });
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
      UI.alert('住宿已移動', `「${hotel.name}」已改為${hotelNightLabel(newNight)}入住。\n\n⚠️ 住宿變動會改變路線的起終點，車程已重新估算；建議再按一次「自動安排最佳路線」。`);
    };
    const occupied = hotelAtNightExcept(hotel, newNight);
    if (occupied) {
      UI.confirm('目標晚已有住宿', `${hotelNightLabel(newNight)}已是「${occupied.name}」。要換成「${hotel.name}」嗎？`, doMove);
    } else doMove();
  }

  // 住宿備註（訂房編號）與付款狀態；同一間飯店的多晚一起更新
  // v2.1.35 飯店房費記帳：一間飯店連住多晚＝一筆，金額用房價紀錄估（平日／週五六假日）
  function openHotelExpense(g, pay) {
    if (!g) { UI.toast('找不到這間住宿'); return; }
    Feat.quickExpense({
      item: `${g.name} 房費（${PaySync.nightsText(g.nights)}）`,
      date: Store.dateOfDay(g.nights[0] + 1) || trip().startDate,
      amount: PaySync.estimatePrice(g),
      payer: Store.getEditor() || '',
      payStatus: pay || 'full',
      hotelLink: PaySync.linkFor(g),
      onSaved: () => render()
    });
  }

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
      ${(() => { const g0 = PaySync.groupOfHotel(h), e0 = g0 && PaySync.expenseOf(g0); return e0 ? `<p class="hint">💰 已連到分帳「${UI.esc(e0.item)}」NT$${Number(e0.amount).toLocaleString()}，付款狀態會同步。</p>` : `<p class="hint">選好付款狀態後，可以同時記到分帳（${UI.esc(PaySync.labelOf(g0 || { name: h.name, nights: [Number(h.night)] }))}算一筆）。</p>`; })()}
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
    UI.modal(`🏨 ${h.name.length > 10 ? h.name.slice(0, 10) + '…' : h.name}`, body, [
      {
        label: '記帳', onClick: () => {
          UI.closeModal();
          const g = PaySync.groupOfHotel(h);
          const linked = g && PaySync.expenseOf(g);
          if (linked) { UI.toast('這間飯店已經記過帳了，打開那筆讓你修改'); Feat.editExpense(linked.id); return; }
          openHotelExpense(g, h.pay);
        }
      },
      {
        label: '刪除', danger: true,
        onClick: () => {
          UI.confirm('刪除住宿？', `確定要刪除「${h.name}」這晚住宿嗎？相關天數的路程會重新估算。`, () => {
            const t = trip();
            t.hotels = t.hotels.filter(x => !(x.night === h.night && x.placeId === h.placeId));
            t.legsByDay = {};
            Store.touch({ manual: true });
            UI.closeModal();
            render();
            UI.toast('住宿已刪除；車程已重估，需要精準時間請按下方「🔄 更新車程」');
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
            const payChanged = (h.pay || '') !== pay;
            h.note = note; h.priceWeekday = pw; h.priceWeekend = pe;
            if (night !== h.night) applyHotelNightMove(h, night);
            else { trip().legsByDay = {}; sortHotels(); }
            // v2.1.35 付款狀態：同一間連住的每一晚＋分帳那筆一起改
            const g = PaySync.groupOfHotel(h);
            if (payChanged && g) PaySync.setHotelPay(g, pay); else h.pay = pay;
            Store.touch({ manual: true });
            UI.closeModal();
            render();
            UI.toast(locatedByAddress ? '已從地址定位，住宿資訊已更新' : '住宿資訊已更新');
            if (payChanged && pay && g && !PaySync.expenseOf(g)) {
              setTimeout(() => UI.confirm('要同時記到分帳嗎？', `「${PaySync.labelOf(g)}」還沒有記帳。要記一筆房費嗎？（付款狀態會跟這裡同步）`, () => openHotelExpense(g, pay)), 300);
            }
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
    const hoursLine = todayHoursLine(s);
    const hoursHtml = hoursLine ? `<div class="spot-times">🕒 當天 ${UI.esc(hoursLine)}</div>` : '';
    const closedWarn = (s.closedDays && s.day && s.closedDays.includes(new Date(Store.dateOfDay(s.day) + 'T00:00:00').getDay()))
      ? `<div class="spot-times" style="color:var(--danger);font-weight:700">⚠️ 這天是公休日，出發前請再確認！</div>` : '';
    if (s.visited) div.classList.add('visited');
    div.innerHTML = `
      <div class="tl-time">${tlRow ? tlRow.arrive : ''}</div>
      <div class="spot-main">
        <span class="spot-no" style="background:${s.visited ? 'var(--ok)' : (d ? dayColor(d) : 'var(--text-2)')}">${s.visited ? '✓' : (no || '·')}</span>
        <div class="spot-info">
          <div class="spot-name">${s.locked ? '<span class="lock-badge" title="已鎖定：當天必去，自動安排不會移動它">🔒</span> ' : ''}${UI.esc(s.name)}${s.visited ? ' <span class="visited-badge">已去過</span>' : ''}</div>
          <div class="spot-times">${tlRow ? `停留 ${stayH} → ${tlRow.depart} 出發` : `停留 ${stayH}`}</div>
          ${mealLabel(s.meal) ? `<div class="spot-times spot-meal-tag">${mealLabel(s.meal)}</div>` : ''}
          ${hoursHtml}
          ${noteLine}
          ${coordWarning}
          ${closedWarn}
        </div>
        ${photoFor(s) ? `<img class="spot-thumb" src="${UI.esc(photoFor(s))}" data-spot="${UI.esc(s.id)}" alt="" title="${UI.esc(s.name)}">` : ''}
        <button class="drag-grip edit-only" title="按住拖曳排序（可拖到其他天）">☰</button>
      </div>
      <div class="spot-expand">
        <div class="stay-edit edit-only">
          <span class="hint">停留</span>
          <button data-act="stay-" aria-label="減少停留時間">−</button>
          <select class="stay-sel" data-act="staysel" aria-label="停留時間">${stayOptionsHtml(s.stayMin)}</select>
          <button data-act="stay+" aria-label="增加停留時間">＋</button>
        </div>
        <div class="spot-actions edit-only">
          <button data-act="up" class="mv-btn" title="往上移" aria-label="往上移">▲</button>
          <button data-act="down" class="mv-btn" title="往下移" aria-label="往下移">▼</button>
          <button data-act="lock" title="${s.locked ? '解除鎖定' : '鎖定在這天（自動安排不會移動）'}">${s.locked ? '🔒' : '🔓'}</button>
          <button data-act="meal" title="設定餐別：早餐／午餐／晚餐／點心"${s.meal ? ' class="on"' : ''}>🍽</button>
          <button data-act="exp" title="記一筆帳">💰</button>
          ${Logic.hasCoords(s) ? `<a class="ico-link" href="${UI.navLink(s)}" target="_blank" rel="noopener" title="導航">🧭</a>` : ''}
          <button data-act="menu" title="更多：打卡／備註／必去／移到某天／刪除">⋯</button>
        </div>
        ${Store.isReadonly() ? `<div class="spot-actions"><a class="ico-link" href="${UI.navLink(s)}" target="_blank" rel="noopener">🧭 導航</a></div>` : ''}
      </div>`;
    bindExpand(div, s.id);

    div.querySelector('[data-act="stay-"]').onclick = () => changeStay(s, -15);
    div.querySelector('[data-act="stay+"]').onclick = () => changeStay(s, 15);
    div.querySelector('[data-act="staysel"]').onchange = e => pickStay(s, e.target);
    div.querySelector('[data-act="lock"]').onclick = () => toggleLock(s);
    div.querySelector('[data-act="meal"]').onclick = () => pickMeal(s);
    div.querySelector('[data-act="exp"]').onclick = () =>
      Feat.quickExpense({ item: s.name, date: s.day ? Store.dateOfDay(s.day) : trip().startDate });
    div.querySelector('[data-act="menu"]').onclick = () => spotMenu(s);
    div.querySelector('[data-act="up"]').onclick = () => moveSpot(s, -1);
    div.querySelector('[data-act="down"]').onclick = () => moveSpot(s, 1);
    { const sib = s.day >= 1 ? spotsOfDay(s.day) : unassigned(); const i = sib.findIndex(x => x.id === s.id);
      if (i <= 0) div.querySelector('[data-act="up"]').disabled = true;
      if (i < 0 || i >= sib.length - 1) div.querySelector('[data-act="down"]').disabled = true; }
    const grip = div.querySelector('.drag-grip');
    grip.addEventListener('pointerdown', e => startDrag(e, s, div));
    const thumb = div.querySelector('.spot-thumb');
    if (thumb) {
      thumb.onclick = () => UI.photoZoom(photoFor(s), s.name);
    }
    return div;
  }

  // 停留時間下拉：常用選項＋目前值（若不在清單）＋自訂
  const STAY_PRESETS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600];
  function stayOptionsHtml(cur) {
    const opts = STAY_PRESETS.includes(cur) ? STAY_PRESETS : [...STAY_PRESETS, cur].sort((a, b) => a - b);
    return opts.map(m => `<option value="${m}" ${m === cur ? 'selected' : ''}>${Logic.fmtDur(m)}</option>`).join('') +
      '<option value="custom">自訂…</option>';
  }
  function pickStay(s, sel) {
    if (sel.value !== 'custom') { setStay(s, Number(sel.value)); return; }
    sel.value = String(s.stayMin); // 先還原，等輸入完再更新
    const body = document.createElement('div');
    body.innerHTML = `<label>停留幾分鐘？（15～600）</label>
      <input id="stayCustomInp" type="number" inputmode="numeric" min="15" max="600" step="5" value="${s.stayMin}">`;
    UI.modal(`🕒 ${s.name}`, body, [{
      label: '確定', primary: true, onClick: () => {
        const v = Math.round(Number(document.getElementById('stayCustomInp').value));
        if (!(v >= 15 && v <= 600)) { UI.toast('請輸入 15～600 之間的分鐘數'); return; }
        UI.closeModal();
        setStay(s, v);
      }
    }]);
    setTimeout(() => { const i = document.getElementById('stayCustomInp'); i.focus(); i.select(); }, 50);
  }
  function setStay(s, min) {
    s.stayMin = Math.min(600, Math.max(15, min));
    Store.touch();
    render();
  }

  // 餐別（景點列上的 🍽 鈕；也可在「⋯→備註」改）
  const mealLabel = v => (MEALS.find(m => m[0] === v && v) || [])[1] || '';
  function pickMeal(s) {
    UI.choose(`🍽 ${s.name}：這裡是哪一餐？`,
      MEALS.map(([v, lb]) => ({ value: v, label: (s.meal || '') === v ? `✓ ${lb}` : lb })),
      v => {
        s.meal = v;
        Store.touch({ manual: true });
        render();
        UI.toast(v ? `已標記為${mealLabel(v)}` : '已取消餐別');
      });
  }

  function changeStay(s, delta) {
    s.stayMin = Math.min(600, Math.max(15, s.stayMin + delta));
    Store.touch();
    render();
  }

  // 鎖定景點：自動安排最佳路線不會移動它，除非解鎖
  function toggleLock(s) {
    if (!s.locked && !(s.day >= 1)) { UI.toast('先把景點排到某一天，才能鎖定'); return; }
    s.locked = !s.locked;
    Store.touch();
    render();
    UI.toast(s.locked
      ? `🔒 鎖定=第 ${s.day} 天必去，自動安排不會移動它`
      : `🔓 已解除「${s.name}」的鎖定`);
  }

  const MEALS = [['', '不是正餐'], ['breakfast', '🍳 早餐'], ['lunch', '🍜 午餐'], ['dinner', '🍽 晚餐'], ['snack', '🍡 點心']];
  function editSpotNote(s) {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>餐別（會帶進每日行程的三餐摘要）</label>
      <select id="spotMealInput">
        ${MEALS.map(([v, lb]) => `<option value="${v}" ${(s.meal || '') === v ? 'selected' : ''}>${lb}</option>`).join('')}
      </select>
      <label style="margin-top:8px">景點備註</label>
      <input id="spotNoteInput" type="text" maxlength="120" placeholder="例：必買伴手禮、停車位置、門票提醒" value="${UI.esc(s.note || '')}">
      <label>地址 / 位置備註</label>
      <input id="spotAddressInput" type="text" maxlength="120" placeholder="可補充地址或集合點" value="${UI.esc(s.address || '')}">
      ${s.hoursText ? `<label style="margin-top:8px">🕒 營業時間（Google 提供）</label><p class="hint" style="white-space:pre-line;line-height:1.6">${UI.esc(s.hoursText)}</p>` : ''}
      <p class="hint">備註會顯示在景點卡片上。</p>`;
    UI.modal(`📝 ${s.name}`, body, [{
      label: '儲存', primary: true,
      onClick: () => {
        s.meal = document.getElementById('spotMealInput').value;
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
      UI.toast('已移除；車程已重估，需要精準時間請按下方「🔄 更新車程」');
    });
  }

  function spotMenu(s) {
    const days = Store.days();
    const opts = [
      { label: s.visited ? '☑ 取消「已去過」' : '☐ 標記「已去過」', value: 'visited' },
      { label: '📝 編輯備註', value: 'note' }
    ];
    for (let d = 1; d <= days; d++) {
      if (d !== s.day) opts.push({ label: `📅 移到第 ${d} 天`, value: 'day' + d });
    }
    opts.push(s.backup ? { label: '↩ 放回待排', value: 'unbackup' } : { label: '⭐ 移到備選景點（先收著，不排進行程）', value: 'backup' });
    opts.push({ label: '📋 複製到其他行程', value: 'copyto' });
    opts.push({ label: '🗑 刪除景點', value: 'del', danger: true });
    UI.choose(s.name, opts, v => {
      if (v === 'copyto') { CopyTo.open(s.id); return; }
      if (v === 'backup') { toBackup(s); return; }
      if (v === 'unbackup') { fromBackup(s, 0); return; }
      if (v === 'visited') {
        s.visited = !s.visited; Store.touch(); render();
        if (s.visited) UI.toast(`✅ 「${s.name}」打卡完成！`);
      } else if (v === 'note') {
        editSpotNote(s);
      } else if (v === 'del') {
        deleteSpot(s);
      } else if (v.startsWith('day')) {
        const d = Number(v.slice(3));
        const t = trip();
        delete t.legsByDay[s.day]; delete t.legsByDay[d];
        s.day = d; s.backup = false;
        s.order = spotsOfDay(d).length;
        Store.touch({ manual: true }); render();
        UI.toast(`已把「${s.name}」移到第 ${d} 天`);
      }
    });
  }

  // v2.1.47 ▲▼ 上下移一格（同一天內；手機拖曳不順時用）。移完保持展開，可以連按
  function moveSpot(s, dir) {
    const t = trip();
    const list = s.day >= 1 ? spotsOfDay(s.day) : unassigned();
    const i = list.findIndex(x => x.id === s.id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => { x.order = k; });
    if (s.day >= 1) delete t.legsByDay[s.day];
    openRowId = s.id;
    Store.touch({ manual: true });
    render();
    const row = document.querySelector(`#dayList .spot-row[data-spot-id="${CSS.escape(s.id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
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
    if (e.clientY < 90) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 14);
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
    const mode = { driving: 'driving', transit: 'transit', walking: 'walking' }[dayTransportOf(d)];
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

  function renderMiniMap() { if ($('miniMap')) drawMap($('miniMap'), null); } // v2.1.33 行程頁不放地圖（路線分頁有）
  function renderFullMap(selDay) {
    drawMap($('fullMap'), selDay || null);
    const days = Store.days();
    const chips = $('mapDayChips');
    const items = ['全部', ...Array.from({ length: days }, (_, i) => `第${i + 1}天`)];
    chips.innerHTML = items.map((tt, i) =>
      `<span class="chip ${((selDay || 0) === i) ? 'on' : ''}" data-d="${i}" style="cursor:pointer;${(selDay || 0) === i ? '' : 'background:var(--white)'};${i > 0 ? `border-color:${dayColor(i)};${(selDay || 0) === i ? `background:${dayColor(i)}` : `color:${dayColor(i)}`}` : ''}">${tt}</span>`).join('');
    chips.querySelectorAll('.chip').forEach(c =>
      c.onclick = () => renderFullMap(Number(c.dataset.d)));
    renderMapDaySummary(selDay);
  }

  // 路線頁：每日預估總車程
  // v2.1.36 每日車程：第一層＝每天總計；第二層（縮排）＝每一段（含機場前後的地面交通）
  let mdsOpen = null;            // 面板展開／收合（手機預設收合）
  const mdsDays = new Set();     // 「全部」時展開了哪幾天
  function daySegments(d) {
    const t = trip(), mode = dayTransportOf(d), icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[mode];
    const segs = [];
    const arr = Flights.of(d, 'arrive'), dep = Flights.of(d, 'depart');
    if (Flights.isComplete(arr)) {
      const o = baseStartPoint(d);
      if (o) segs.push({ a: o.p.name, b: arr.depAirport.name, min: Flights.groundMin(arr, o.p, arr.depAirport, mode), icon, note: '搭機前' });
    }
    const list = spotsOfDay(d), legs = legsForDay(d);
    const seq = [startHotel(d), ...list, endHotel(d)];
    for (let i = 0; i < seq.length - 1; i++) {
      if (!seq[i] || !seq[i + 1] || !(legs[i] > 0)) continue;
      if (!list.length && i > 0) break;
      const ch = typeof RoutePick !== 'undefined' ? RoutePick.chosenOf(seq[i], seq[i + 1], mode) : null;
      segs.push({ a: seq[i].name, b: seq[i + 1].name, min: legs[i], icon, route: ch ? (ch.summary || '自訂路線') : '', bad: ch && RoutePick.isClosed(ch.summary) });
    }
    if (Flights.isComplete(dep)) {
      const dest = baseEndPoint(d);
      if (dest) segs.push({ a: dep.arrAirport.name, b: dest.p.name, min: Flights.groundMin(dep, dep.arrAirport, dest.p, mode), icon, note: '下機後' });
    }
    return segs;
  }
  function renderMapDaySummary(selDay) {
    const box = $('mapDaySummary');
    if (!box) return;
    if (mdsOpen === null) { try { const v = localStorage.getItem('mika_mds_open'); mdsOpen = v === null ? !window.matchMedia('(max-width: 560px)').matches : v === '1'; } catch { mdsOpen = true; } }
    const days = Store.days();
    let total = 0;
    const blocks = [];
    for (let d = 1; d <= days; d++) {
      if (selDay && d !== selDay) continue;
      const segs = daySegments(d);
      const mins = segs.reduce((s, x) => s + (x.min || 0), 0);
      total += mins;
      const open = !!selDay || mdsDays.has(d);
      blocks.push(`<div class="mds-day">
        <div class="mds-row${selDay ? '' : ' tap'}" data-d="${d}"><span class="mds-dot" style="background:${dayColor(d)}"></span>第 ${d} 天<b>${Logic.fmtDur(mins)}</b>${selDay ? '' : `<span class="mds-car">${open ? '▾' : '▸'}</span>`}</div>
        ${open ? `<div class="mds-segs">${segs.length ? segs.map(x => `<div class="mds-seg${x.bad ? ' bad' : ''}">
            <span class="mds-path">${UI.esc(x.a)} → ${UI.esc(x.b)}${x.note ? `<small>（${x.note}）</small>` : ''}${x.route ? `<small>🛣 ${UI.esc(x.route)}${x.bad ? '（⛔ 封閉）' : ''}</small>` : ''}</span>
            <span class="mds-min">${x.icon} ${Logic.fmtDur(x.min)}</span></div>`).join('') : '<div class="mds-seg"><span class="mds-path">這天沒有移動</span></div>'}</div>` : ''}
      </div>`);
    }
    box.innerHTML = `<div class="mds-head" role="button">🚗 ${selDay ? `第 ${selDay} 天總車程` : '總車程'}<b>${Logic.fmtDur(total)}</b><span class="mds-car">${mdsOpen ? '▴' : '▾'}</span></div>
      ${mdsOpen ? `<div class="mds-body">${blocks.join('')}${!selDay ? '<p class="mds-hint">點某一天可以看每一段；選上面的「第 N 天」可以在地圖上點路線改路</p>' : (Store.isReadonly() ? '' : '<p class="mds-hint">👆 點地圖上的路線可以改走別條路</p>')}</div>` : ''}`;
    box.querySelector('.mds-head').onclick = () => {
      mdsOpen = !mdsOpen;
      try { localStorage.setItem('mika_mds_open', mdsOpen ? '1' : '0'); } catch {}
      renderMapDaySummary(selDay);
    };
    box.querySelectorAll('.mds-row.tap').forEach(r => r.onclick = () => {
      const d = Number(r.dataset.d);
      if (mdsDays.has(d)) mdsDays.delete(d); else mdsDays.add(d);
      renderMapDaySummary(selDay);
    });
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
      const color = g.d ? dayColor(g.d) : '#617587';
      const seq = [];
      if (g.sp) seq.push(g.sp);
      seq.push(...g.list);
      if (g.ep && g.ep !== g.sp) seq.push(g.ep);
      if (seq.length > 1) {
        // 先畫直線當備援，再用 Google Directions 取實際路線替換
        const poly = new google.maps.Polyline({
          map: el._gmap, path: seq.map(p => ({ lat: p.lat, lng: p.lng })),
          strokeColor: color, strokeOpacity: .85, strokeWeight: 4
        });
        add(poly);
        const gMode = dayTransportOf(g.d);
        // v2.1.39 線只有 4 像素、手機很難點：看單一天時疊一條看不見的粗線當感應區（跟著實際路線一起更新）
        let hitLine = null;
        if (selDay && gMode !== 'transit' && !Store.isReadonly()) {
          hitLine = new google.maps.Polyline({ map: el._gmap, path: poly.getPath(), strokeColor: '#000000', strokeOpacity: 0.01, strokeWeight: 34, zIndex: 5 });
          add(hitLine);
          const rawSet = poly.setPath.bind(poly);
          poly.setPath = p => { rawSet(p); hitLine.setPath(p); };
        }
        if (gMode === 'transit') {
          // 大眾運輸不支援途經點 → 逐段抓真實路線再串起來（某段抓不到就那段用直線）
          (async () => {
            const full = [{ lat: seq[0].lat, lng: seq[0].lng }];
            for (let i = 0; i < seq.length - 1; i++) {
              const legPath = await Api.routeLegPath(seq[i], seq[i + 1], 'transit');
              if (legPath && legPath.length > 1) full.push(...legPath.slice(1));
              else full.push({ lat: seq[i + 1].lat, lng: seq[i + 1].lng });
            }
            if (full.length > 1) poly.setPath(full);
          })();
        } else if (seq.some((p, i) => i < seq.length - 1 && RoutePick.chosenOf(p, seq[i + 1], gMode))) {
          // v2.1.35 有使用者選定的路段 → 逐段串：選定的用存下來的路線，其他段抓 Google 單段路線
          (async () => {
            const full = [{ lat: seq[0].lat, lng: seq[0].lng }];
            for (let i = 0; i < seq.length - 1; i++) {
              const ch = RoutePick.chosenOf(seq[i], seq[i + 1], gMode);
              const cp = ch ? RoutePick.pathOf(ch) : null;
              const legPath = cp && cp.length > 1 ? cp : await Api.routeLegPath(seq[i], seq[i + 1], gMode);
              if (legPath && legPath.length > 1) full.push(...legPath.slice(1));
              else full.push({ lat: seq[i + 1].lat, lng: seq[i + 1].lng });
            }
            if (full.length > 1) poly.setPath(full);
          })();
        } else {
          Api.routePath(seq, gMode).then(path => {
            if (path && path.length > 1) poly.setPath(path);
          });
        }
        // v2.1.35 看單一天時：點路線 → 找最近的那一段 → 選路線
        if (hitLine) {
          const onPick = ev => {
            const c = { lat: ev.latLng.lat(), lng: ev.latLng.lng() };
            const distSeg = (p, a, b) => { // 點到線段的近似距離（經緯度平面）
              const dx = b.lng - a.lng, dy = b.lat - a.lat, L = dx * dx + dy * dy || 1e-12;
              const tt = Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / L));
              return Math.hypot(p.lng - (a.lng + tt * dx), p.lat - (a.lat + tt * dy));
            };
            let best = 0, bd = Infinity;
            for (let i = 0; i < seq.length - 1; i++) {
              const ch = RoutePick.chosenOf(seq[i], seq[i + 1], gMode);
              const cpp = ch ? RoutePick.pathOf(ch) : [];
              const pts = cpp.length > 1 ? cpp : [seq[i], seq[i + 1]];
              for (let k = 0; k < pts.length - 1; k++) { const dd = distSeg(c, pts[k], pts[k + 1]); if (dd < bd) { bd = dd; best = i; } }
            }
            RoutePick.open(seq[best], seq[best + 1], gMode, () => { render(); renderFullMap(selDay); });
          };
          poly.addListener('click', onPick);
          hitLine.addListener('click', onPick);
        }
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
            `<div class="map-poi">${photoFor(s) ? `<img src="${UI.esc(photoFor(s))}" data-spot="${UI.esc(s.id)}" alt="">` : ''}<span>${i + 1}. ${UI.esc(s.name)}</span></div>`, -16);
        });
        const legs = legsForDay(g.d);
        const icon = { driving: '🚗', transit: '🚇', walking: '🚶' }[dayTransportOf(g.d)] || '🚗';
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
    // v2.1.36 「全部」時用灰色小點標出備選景點（不連線），點了可以放回待排
    if (!selDay) {
      const area = tripArea();
      backupSpots().filter(Logic.hasCoords).forEach(s => {
        const mk = new google.maps.Marker({
          map: el._gmap, position: { lat: s.lat, lng: s.lng }, title: '⭐ 備選：' + s.name, zIndex: 1,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#94A3B8', fillOpacity: .9, strokeColor: '#FFFFFF', strokeWeight: 2 }
        });
        mk.addListener('click', () => {
          const km = area ? Logic.haversineKm(area.center, s) : null;
          const box = document.createElement('div');
          box.className = 'map-bk';
          box.innerHTML = `<b>⭐ ${UI.esc(s.name)}</b>${km !== null ? `<div>離行程中心 ${distTxt(km)}</div>` : ''}${Store.isReadonly() ? '' : '<button type="button">放回待排</button>'}`;
          const iw = new google.maps.InfoWindow({ content: box });
          const b = box.querySelector('button');
          if (b) b.onclick = () => { iw.close(); fromBackup(s, 0); renderFullMap(0); };
          iw.open({ map: el._gmap, anchor: mk });
          add(iw);
        });
        add(mk);
      });
    }
    el._gmap.fitBounds(bounds, 46);
  }

  // ---- 示意 SVG 地圖（模擬模式） ----
  function drawSvgMap(el, selDay) {
    const groups = mapGroups(selDay);
    if (!groups.length) {
      el.innerHTML = `<svg class="mock-map" viewBox="0 0 400 300">
        <text x="200" y="150" text-anchor="middle" fill="#617587" font-size="15">加入景點後，路線會畫在這裡</text>
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
        svg += `<polyline class="road" style="stroke:${g.d ? dayColor(g.d) : '#617587'}" points="${seq.map(p => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')}"/>`;
      }
    }
    for (const g of groups) {
      const color = g.d ? dayColor(g.d) : '#617587';
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
    if (!handle) return; // v2.1.33 行程頁已拿掉地圖與把手
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
    initSwipe();
  }

  return {
    init, render, renderFullMap, addSpot, openAddSpot,
    spotsOfDay, unassigned, dayCenter, startHotel, endHotel, legsForDay, dayTransportOf, stayMealsOf,
    saveCurrentArrangement, baseStartPoint, baseEndPoint, dayStartOf, dayEndOf, showDay, dayTheme, tripArea
  };
})();
