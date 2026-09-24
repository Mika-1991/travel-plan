// ============================================================
// 航班（手動輸入版）
// 每天最多 1 班「抵達航班」（放在當天開頭：當天從抵達機場出關後開始）
//          ＋ 1 班「起飛航班」（放在當天結尾：當天要在起飛前到機場報到）。
// 時間一律填「當地時間」；國際線會標註（當地時間），不自動換算時差。
// 資料存在 trip.flights：
//   { id, day, type:'arrive'|'depart', airline, flightNo, intl,
//     depAirport{name,address,lat,lng,placeId}, depTime'HH:MM',
//     arrAirport{…}, arrTime'HH:MM', checkinMin, clearMin,
//     groundMin(手動調整的地面交通分鐘，空＝自動), groundAuto(自動算的，Google 真實車程), note }
// ============================================================
const Flights = (() => {
  const trip = () => Store.get();
  const DEFAULTS = { intl: { checkin: 120, clear: 60 }, dom: { checkin: 60, clear: 20 } };
  const CHECKIN_OPTS = [30, 45, 60, 90, 120, 150, 180, 240];
  const CLEAR_OPTS = [10, 20, 30, 45, 60, 90, 120];

  const all = () => (trip() && trip().flights) || [];
  const of = (day, type) => all().find(f => Number(f.day) === Number(day) && f.type === type) || null;
  const isComplete = f => !!(f && f.depAirport && f.arrAirport && f.depTime && f.arrTime);
  const tz = f => (f && f.intl ? '（當地時間）' : '');
  const mins = v => Number(v) || 0;

  // 有抵達航班：當天出發時間＝抵達＋出關；有起飛航班：當天最晚到機場時間＝起飛－提早報到
  function dayStartMin(day) {
    const f = of(day, 'arrive');
    return isComplete(f) ? Logic.toMin(f.arrTime) + mins(f.clearMin) : null;
  }
  function dayEndMin(day) {
    const f = of(day, 'depart');
    return isComplete(f) ? Logic.toMin(f.depTime) - mins(f.checkinMin) : null;
  }

  // 機場外的地面交通（抵達航班：出發地→出發機場；起飛航班：抵達機場→目的地）
  // 手動調整優先，其次 Google 真實車程，最後直線估算
  function groundMin(f, from, to, mode) {
    if (f.groundMin !== undefined && f.groundMin !== null && f.groundMin !== '') return mins(f.groundMin);
    if (f.groundAuto) return mins(f.groundAuto);
    return from && to ? Logic.travelMinutes(from, to, mode) : 0;
  }
  // 系統預估（不看手動值）：Google 真實車程，沒有就直線估算——手動調整時也一起顯示，方便比對
  function autoGroundMin(f, from, to, mode) {
    if (f.groundAuto) return mins(f.groundAuto);
    return from && to ? Logic.travelMinutes(from, to, mode) : 0;
  }
  const isManualGround = f => f.groundMin !== undefined && f.groundMin !== null && f.groundMin !== '';
  const groundSource = f =>
    (f.groundMin !== undefined && f.groundMin !== null && f.groundMin !== '') ? '手動' : (f.groundAuto ? 'Google' : '估算');

  // 背景抓 Google 真實車程（每班只抓一次，抓到就記在 groundAuto）
  const fetching = new Set();
  function ensureGroundAuto(f, from, to, mode, onDone) {
    if (!f || f.groundAuto || !Logic.hasCoords(from) || !Logic.hasCoords(to)) return;
    const key = f.id + ':' + mode;
    if (fetching.has(key)) return;
    fetching.add(key);
    Api.travelTime(from, to, mode).then(min => {
      if (min && !f.groundAuto) { f.groundAuto = Math.round(min); Store.saveDerived(); onDone && onDone(); }
    }).catch(() => {}).finally(() => fetching.delete(key));
  }

  // 航班卡（行程表、唯讀都看得到；編輯鈕只在可編輯時出現）
  function cardEl(f, onEdit) {
    const div = document.createElement('div');
    div.className = 'flight-card';
    const title = [f.airline, f.flightNo].filter(Boolean).join(' ') || '航班';
    const checkinAt = Logic.toHHMM(Logic.toMin(f.depTime) - mins(f.checkinMin));
    div.innerHTML = `
      <div class="flight-head">✈️ ${UI.esc(title)}<span class="flight-tag">${f.intl ? '國際線' : '國內線'}</span>
        ${onEdit ? '<button class="edit-only flight-edit" type="button" title="編輯航班">✎</button>' : ''}</div>
      <div class="flight-line">🛫 <b>${UI.esc(f.depTime)}</b> ${UI.esc(f.depAirport.name)} 起飛${tz(f)}</div>
      <div class="flight-line">🛬 <b>${UI.esc(f.arrTime)}</b> ${UI.esc(f.arrAirport.name)} 抵達${tz(f)}</div>
      <div class="flight-sub">🧳 ${checkinAt} 前到機場報到（提早 ${Logic.fmtDur(mins(f.checkinMin))}）｜🛂 出關約 ${Logic.fmtDur(mins(f.clearMin))}</div>
      ${f.note ? `<div class="flight-sub">📝 ${UI.esc(f.note)}</div>` : ''}`;
    const btn = div.querySelector('.flight-edit');
    if (btn && onEdit) btn.onclick = onEdit;
    return div;
  }

  // ---------- 編輯 ----------
  // 某一天的航班總覽：已有的可編輯／刪除，沒有的可新增
  function openDay(day, onChanged) {
    if (Store.isReadonly()) { UI.toast('唯讀模式無法修改'); return; }
    const arr = of(day, 'arrive'), dep = of(day, 'depart');
    const opts = [];
    opts.push(arr
      ? { label: `🛬 編輯抵達航班（${arr.flightNo || arr.arrAirport.name} ${arr.arrTime} 抵達）`, value: 'edit-arrive' }
      : { label: '🛬 新增抵達航班（這天搭飛機抵達，出關後開始行程）', value: 'new-arrive' });
    opts.push(dep
      ? { label: `🛫 編輯起飛航班（${dep.flightNo || dep.depAirport.name} ${dep.depTime} 起飛）`, value: 'edit-depart' }
      : { label: '🛫 新增起飛航班（這天行程結束後到機場搭飛機）', value: 'new-depart' });
    UI.choose(`✈️ 第 ${day} 天的航班`, opts, v => {
      const [act, type] = v.split('-');
      openForm(day, type, act === 'edit' ? of(day, type) : null, onChanged);
    });
  }

  function airportPicker(body, prefix, initial, onPick) {
    const wrap = body.querySelector(`#${prefix}Wrap`);
    const chosen = wrap.querySelector('.ap-chosen');
    const results = wrap.querySelector('.ap-results');
    const input = wrap.querySelector('input');
    const show = p => { chosen.innerHTML = p ? `✅ ${UI.esc(p.name)}<div class="hint">${UI.esc(p.address || '')}</div>` : '<span class="hint">還沒選擇機場</span>'; };
    show(initial);
    const search = async () => {
      const q = input.value.trim();
      if (!q) { UI.toast('請輸入機場名稱，例如：桃園機場、成田機場、NRT'); return; }
      results.innerHTML = '<p class="hint">搜尋中…</p>';
      try {
        const list = await Api.searchPlaces(q, 'spot');
        results.innerHTML = '';
        if (!list.length) { results.innerHTML = '<p class="hint">找不到，換個關鍵字試試（例如加上「機場」或機場代碼）</p>'; return; }
        list.slice(0, 5).forEach(p => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'btn-outline ap-item';
          b.innerHTML = `${UI.esc(p.name)}<div class="hint">${UI.esc(p.address || '')}</div>`;
          b.onclick = () => {
            const ap = { name: p.name, address: p.address || '', lat: p.lat, lng: p.lng, placeId: p.placeId || '' };
            onPick(ap); show(ap); results.innerHTML = ''; input.value = '';
          };
          results.appendChild(b);
        });
      } catch (e) { results.innerHTML = ''; UI.alert('搜尋失敗', UI.friendlyError(e)); }
    };
    wrap.querySelector('.ap-search').onclick = search;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  }

  // ---------- v2.1.28 防呆：出發／抵達是不是填反了 ----------
  // 抵達航班：抵達機場應該靠近「當天景點」、出發機場應該靠近「出發地（集合地／前一晚飯店）」；
  // 起飛航班：出發機場應該靠近「當天景點」、抵達機場應該靠近「目的地（解散地／當晚飯店）」。
  // 明顯比較像反過來（近的那個不到遠的 0.6 倍、而且差超過 30 公里）才提醒，避免誤報。
  function looksReversed(day, f) {
    const km = (a, b) => (Logic.hasCoords(a) && Logic.hasCoords(b)) ? Logic.haversineKm(a, b) : null;
    const clearlyCloser = (ref, shouldBeNear, shouldBeFar) => {
      const near = km(ref, shouldBeNear), far = km(ref, shouldBeFar);
      if (near === null || far === null) return null;       // 沒座標 → 無法判斷
      return far < near * 0.6 && near - far > 30;            // true＝看起來反了
    };
    const spots = Itin.spotsOfDay(day).filter(Logic.hasCoords);
    const center = spots.length
      ? { lat: spots.reduce((s, p) => s + Number(p.lat), 0) / spots.length, lng: spots.reduce((s, p) => s + Number(p.lng), 0) / spots.length }
      : null;
    if (f.type === 'arrive') {
      const origin = (Itin.baseStartPoint(day) || {}).p;
      if (center && clearlyCloser(center, f.arrAirport, f.depAirport)) return true;
      if (origin && clearlyCloser(origin, f.depAirport, f.arrAirport)) return true;
    } else {
      const dest = (Itin.baseEndPoint(day) || {}).p;
      if (center && clearlyCloser(center, f.depAirport, f.arrAirport)) return true;
      if (dest && clearlyCloser(dest, f.arrAirport, f.depAirport)) return true;
    }
    return false;
  }
  const sameAirport = f => (f.depAirport.placeId && f.depAirport.placeId === f.arrAirport.placeId) || f.depAirport.name === f.arrAirport.name;

  function openForm(day, type, existing, onChanged) {
    const t = trip();
    const f = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: Logic.uid(), day, type, airline: '', flightNo: '', intl: true,
      depAirport: null, depTime: '', arrAirport: null, arrTime: '',
      checkinMin: DEFAULTS.intl.checkin, clearMin: DEFAULTS.intl.clear, groundMin: null, note: ''
    };
    const isArr = type === 'arrive';
    const sel = (id, opts, cur) => `<select id="${id}">${opts.map(m => `<option value="${m}" ${m === mins(cur) ? 'selected' : ''}>${Logic.fmtDur(m)}</option>`).join('')}</select>`;
    const body = document.createElement('div');
    body.className = 'flight-form';
    body.innerHTML = `
      <p class="hint" style="margin-bottom:8px">${isArr
        ? '🛬 抵達航班：這天會從「抵達機場」出關後開始，當天出發時間自動＝抵達時間＋出關時間。'
        : '🛫 起飛航班：這天最後要到「出發機場」報到，當天結束時間自動＝起飛時間－提早報到時間。'}</p>
      <div style="display:flex;gap:8px">
        <div style="flex:1"><label>航空公司</label><input id="fAirline" type="text" maxlength="30" placeholder="例：長榮" value="${UI.esc(f.airline || '')}"></div>
        <div style="flex:1"><label>航班號碼</label><input id="fNo" type="text" maxlength="12" placeholder="例：BR112" value="${UI.esc(f.flightNo || '')}"></div>
      </div>
      <label class="check-line"><input id="fIntl" type="checkbox" ${f.intl ? 'checked' : ''} style="width:auto;margin:0 6px 0 0">國際線（時間都填當地時間）</label>
      <div id="depWrap" class="ap-box">
        <label>🛫 出發機場</label>
        <div class="ap-chosen"></div>
        <div style="display:flex;gap:8px"><input type="text" placeholder="例：桃園機場、TPE" style="margin-bottom:0"><button class="btn-small ap-search" type="button">搜尋</button></div>
        <div class="ap-results stack" style="margin-top:6px"></div>
      </div>
      <label>🛫 起飛時間（出發地當地時間）</label>
      <input id="fDepTime" type="time" value="${UI.esc(f.depTime || '')}">
      <div id="arrWrap" class="ap-box">
        <label>🛬 抵達機場</label>
        <div class="ap-chosen"></div>
        <div style="display:flex;gap:8px"><input type="text" placeholder="例：青森機場、AOJ" style="margin-bottom:0"><button class="btn-small ap-search" type="button">搜尋</button></div>
        <div class="ap-results stack" style="margin-top:6px"></div>
      </div>
      <label>🛬 抵達時間（抵達地當地時間）</label>
      <input id="fArrTime" type="time" value="${UI.esc(f.arrTime || '')}">
      <div style="display:flex;gap:8px">
        <div style="flex:1"><label>🧳 提早到機場報到</label>${sel('fCheckin', CHECKIN_OPTS, f.checkinMin)}</div>
        <div style="flex:1"><label>🛂 下機出關約</label>${sel('fClear', CLEAR_OPTS, f.clearMin)}</div>
      </div>
      <label>🚗 ${isArr ? '出發地到機場' : '機場到目的地'}的地面交通（分鐘，空白＝自動計算）</label>
      <input id="fGround" type="number" inputmode="numeric" min="0" max="600" step="5" placeholder="自動計算" value="${f.groundMin === null || f.groundMin === undefined ? '' : UI.esc(f.groundMin)}">
      <label>備註</label>
      <input id="fNote" type="text" maxlength="60" placeholder="例：第二航廈、行李 23kg" value="${UI.esc(f.note || '')}">`;
    airportPicker(body, 'dep', f.depAirport, ap => { f.depAirport = ap; });
    airportPicker(body, 'arr', f.arrAirport, ap => { f.arrAirport = ap; });
    // 切換國內／國際線 → 報到與出關時間換成對應預設
    body.querySelector('#fIntl').onchange = e => {
      const d = e.target.checked ? DEFAULTS.intl : DEFAULTS.dom;
      body.querySelector('#fCheckin').value = String(d.checkin);
      body.querySelector('#fClear').value = String(d.clear);
    };
    const save = () => {
      f.airline = body.querySelector('#fAirline').value.trim();
      f.flightNo = body.querySelector('#fNo').value.trim().toUpperCase();
      f.intl = body.querySelector('#fIntl').checked;
      f.depTime = body.querySelector('#fDepTime').value;
      f.arrTime = body.querySelector('#fArrTime').value;
      f.checkinMin = Number(body.querySelector('#fCheckin').value);
      f.clearMin = Number(body.querySelector('#fClear').value);
      const g = body.querySelector('#fGround').value.trim();
      f.groundMin = g === '' ? null : Math.max(0, Math.round(Number(g)));
      f.note = body.querySelector('#fNote').value.trim();
      if (!f.depAirport || !f.arrAirport) { UI.toast('請搜尋並選擇出發機場和抵達機場'); return; }
      if (!f.depTime || !f.arrTime) { UI.toast('請填起飛和抵達時間'); return; }
      if (sameAirport(f)) { UI.toast('出發機場和抵達機場是同一個，請確認是否選錯'); return; }
      if (!f.intl && Logic.toMin(f.arrTime) <= Logic.toMin(f.depTime)) {
        UI.toast('抵達時間要晚於起飛時間（跨日的紅眼航班目前還不支援）'); return;
      }
      // 防呆：看起來出發／抵達填反了 → 先問，可一鍵對調
      if (looksReversed(day, f)) {
        const swapAirports = () => { const a = f.depAirport; f.depAirport = f.arrAirport; f.arrAirport = a; };
        const swapTimes = () => { const x = f.depTime; f.depTime = f.arrTime; f.arrTime = x; };
        UI.modal('⚠️ 出發和抵達可能填反了',
          `${isArr ? '抵達航班的「抵達機場」通常在當天行程附近，「出發機場」在出發地附近' : '起飛航班的「出發機場」通常在當天行程附近，「抵達機場」在目的地附近'}，但你填的看起來剛好相反：\n\n🛫 ${f.depTime} ${f.depAirport.name}\n🛬 ${f.arrTime} ${f.arrAirport.name}\n\n要怎麼處理？`,
          [
            { label: '🔄 機場和時間一起對調', primary: true, onClick: () => { swapAirports(); swapTimes(); UI.closeModal(); commit(); } },
            { label: '🔄 只對調機場（時間沒填錯）', onClick: () => { swapAirports(); UI.closeModal(); commit(); } },
            { label: '沒填錯，直接儲存', onClick: () => { UI.closeModal(); commit(); } }
          ], { stackActions: true });
        return;
      }
      commit();
    };
    const commit = () => {
      // 換了機場 → 自動算的地面交通要重抓
      if (existing && ((existing.depAirport || {}).placeId !== f.depAirport.placeId || (existing.arrAirport || {}).placeId !== f.arrAirport.placeId)) delete f.groundAuto;
      if (!t.flights) t.flights = [];
      t.flights = t.flights.filter(x => x.id !== f.id);
      t.flights.push(f);
      delete t.legsByDay[day]; // 起點／終點換成機場 → 當天車程重算
      Store.touch({ manual: true });
      UI.closeAllModals();
      onChanged && onChanged();
      UI.toast(`✈️ 已${existing ? '更新' : '新增'}第 ${day} 天的${isArr ? '抵達' : '起飛'}航班，時間已重新計算`);
    };
    const actions = [{ label: existing ? '儲存航班' : '新增航班', primary: true, onClick: save }];
    if (existing) actions.push({
      label: '🗑 刪除這個航班', danger: true, onClick: () => {
        UI.confirm('刪除航班？', `確定要刪除第 ${day} 天的${isArr ? '抵達' : '起飛'}航班嗎？（可用「上一步」復原）`, () => {
          t.flights = (t.flights || []).filter(x => x.id !== f.id);
          delete t.legsByDay[day];
          Store.touch({ manual: true });
          UI.closeAllModals();
          onChanged && onChanged();
          UI.toast('已刪除航班');
        });
      }
    });
    UI.modal(`${isArr ? '🛬 抵達航班' : '🛫 起飛航班'}｜第 ${day} 天`, body, actions, { stackActions: true });
  }

  // 改旅遊天數時：超出天數的航班
  const beyond = newDays => all().filter(f => Number(f.day) > newDays);

  return { of, all, isComplete, dayStartMin, dayEndMin, groundMin, groundSource, autoGroundMin, isManualGround, ensureGroundAuto, cardEl, openDay, openForm, beyond, tz };
})();
