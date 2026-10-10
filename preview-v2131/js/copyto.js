// ============================================================
// 複製到其他行程（v2.1.29）
// 把「勾選的景點」和／或「一班航班」複製到另一份行程（要有對方的編輯代碼）。
// 流程：① 勾選要複製的東西＋輸入對方編輯代碼 → ② 選放在對方第幾天
//      → ③ 有重複（對方已有同一個地點／同一天已有同類航班）就列出來讓使用者勾選要不要照樣複製 → ④ 寫入
// 對方行程的修改紀錄會記一筆「📋 從「來源行程」複製…」。
// ============================================================
const CopyTo = (() => {
  const trip = () => Store.get();
  const $q = (root, sel) => root.querySelector(sel);
  const dayLabel = (t, d) => {
    if (!(d >= 1)) return '待排景點';
    const iso = Logic.datesBetween(t.startDate, t.endDate)[d - 1] || '';
    return `第 ${d} 天${iso ? `（${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}）` : ''}`;
  };
  const samePlace = (a, b) => (a.placeId && b.placeId) ? a.placeId === b.placeId : (a.name || '').trim() === (b.name || '').trim();

  // ---------- ① 勾選 ----------
  function open(preselectSpotId) {
    if (Store.isReadonly()) { UI.toast('唯讀模式無法使用這個功能'); return; }
    const t = trip();
    const byDay = new Map();
    t.spots.forEach(s => { const d = s.day >= 1 ? s.day : 0; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(s); });
    const dayKeys = [...byDay.keys()].sort((a, b) => (a || 99) - (b || 99));
    const flights = (t.flights || []).filter(Flights.isComplete);
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="hint">勾選要複製的景點（可以跨天），也可以選一班航班，複製到另一份行程。</p>
      <div class="copy-list">
        ${dayKeys.map(d => `
          <div class="copy-day">${UI.esc(dayLabel(t, d))}</div>
          ${byDay.get(d).sort((a, b) => a.order - b.order).map(s => `
            <label class="copy-item"><input type="checkbox" data-spot="${UI.esc(s.id)}" ${s.id === preselectSpotId ? 'checked' : ''}>${UI.esc(s.name)}</label>`).join('')}`).join('')}
        ${flights.length ? `<div class="copy-day">✈️ 航班（最多選一班）</div>
          <label class="copy-item"><input type="radio" name="copyFlight" value="" checked>不複製航班</label>
          ${flights.map(f => `<label class="copy-item"><input type="radio" name="copyFlight" value="${UI.esc(f.id)}">第 ${f.day} 天 ${f.type === 'arrive' ? '🛬 抵達' : '🛫 起飛'} ${UI.esc([f.airline, f.flightNo].filter(Boolean).join(' '))}｜${UI.esc(f.depTime)} ${UI.esc(f.depAirport.name)} → ${UI.esc(f.arrTime)} ${UI.esc(f.arrAirport.name)}</label>`).join('')}` : ''}
      </div>
      <label style="margin-top:10px">對方行程的「編輯代碼」</label>
      <input id="copyCode" type="text" maxlength="12" placeholder="例：ZZN102（唯讀代碼不能寫入）" style="text-transform:uppercase">`;
    UI.modal('📋 複製到其他行程', body, [{
      label: '下一步', primary: true, onClick: async () => {
        const spotIds = [...body.querySelectorAll('[data-spot]:checked')].map(x => x.dataset.spot);
        const fid = (body.querySelector('[name="copyFlight"]:checked') || {}).value || '';
        const spots = t.spots.filter(s => spotIds.includes(s.id));
        const flight = fid ? flights.find(f => f.id === fid) : null;
        if (!spots.length && !flight) { UI.toast('請至少勾選一個景點或一班航班'); return; }
        const code = Logic.normalizeCode($q(body, '#copyCode').value);
        if (!code) { UI.toast('請輸入對方行程的編輯代碼'); return; }
        if (code === Logic.normalizeCode(t.editCode)) { UI.toast('這是目前這份行程的代碼：同一份行程請直接拖曳或用「移到第幾天」'); return; }
        try {
          UI.progress(0, '讀取對方行程…'); UI.progressCreep(90);
          const r = await Api.cloudGetTrip(code);
          await UI.progressDone('讀取完成');
          if (r.role !== 'edit') { UI.alert('需要編輯代碼', '這是唯讀代碼，不能寫入對方的行程。\n\n請跟對方要「編輯代碼」（例如 ABC123，不含 -XXXX 的那一組）。'); return; }
          if (r.trip.tripId === t.tripId) { UI.toast('這是同一份行程'); return; }
          UI.closeModal();
          chooseDay(code, r.trip, spots, flight);
        } catch (e) { UI.loading(false); UI.alert('找不到對方的行程', UI.friendlyError(e)); }
      }
    }], { stackActions: true });
  }

  // ---------- ② 選第幾天 ----------
  function chooseDay(code, target, spots, flight) {
    const days = Logic.datesBetween(target.startDate, target.endDate).length;
    const body = document.createElement('div');
    body.innerHTML = `
      <p>要複製到「<b>${UI.esc(target.name)}</b>」（${UI.esc(target.startDate)} ~ ${UI.esc(target.endDate)}，共 ${days} 天）</p>
      <p class="hint">${spots.length ? `📍 景點 ${spots.length} 個` : ''}${spots.length && flight ? '＋' : ''}${flight ? '✈️ 航班 1 班' : ''}</p>
      <label>放在對方的</label>
      <select id="copyDay">
        ${flight ? '' : '<option value="0">待排景點（之後再排）</option>'}
        ${Array.from({ length: days }, (_, i) => `<option value="${i + 1}">${UI.esc(dayLabel(target, i + 1))}</option>`).join('')}
      </select>
      ${flight ? '<p class="hint">有航班時要指定是第幾天。</p>' : ''}`;
    UI.modal('📋 放到第幾天？', body, [{
      label: '下一步', primary: true, onClick: () => {
        const day = Number($q(body, '#copyDay').value);
        UI.closeModal();
        checkDuplicates(code, target, spots, flight, day);
      }
    }]);
  }

  // ---------- ③ 重複檢查：列出來讓使用者決定哪些照樣複製 ----------
  function checkDuplicates(code, target, spots, flight, day) {
    const dupSpots = spots.map(s => ({ s, hit: (target.spots || []).find(x => samePlace(x, s)) })).filter(x => x.hit);
    const dupFlight = flight ? (target.flights || []).find(f => Number(f.day) === day && f.type === flight.type) : null;
    if (!dupSpots.length && !dupFlight) { doCopy(code, spots, flight, day, false); return; }
    const body = document.createElement('div');
    body.innerHTML = `
      <p>以下項目對方的行程裡已經有了。<b>勾選的會照樣複製</b>，沒勾的就跳過：</p>
      <div class="copy-list">
        ${dupSpots.map(({ s, hit }) => `<label class="copy-item"><input type="checkbox" data-dup="${UI.esc(s.id)}">${UI.esc(s.name)}<span class="hint">（對方${UI.esc(dayLabel(target, hit.day))}已有）</span></label>`).join('')}
        ${dupFlight ? `<label class="copy-item"><input type="checkbox" id="dupFlight">✈️ 取代對方第 ${day} 天的${dupFlight.type === 'arrive' ? '抵達' : '起飛'}航班<span class="hint">（目前是 ${UI.esc([dupFlight.airline, dupFlight.flightNo].filter(Boolean).join(' ') || dupFlight.depAirport.name)}）</span></label>` : ''}
      </div>`;
    UI.modal('⚠️ 對方已有一樣的行程', body, [{
      label: '確定複製', primary: true, onClick: () => {
        const keep = new Set([...body.querySelectorAll('[data-dup]:checked')].map(x => x.dataset.dup));
        const dupIds = new Set(dupSpots.map(x => x.s.id));
        const finalSpots = spots.filter(s => !dupIds.has(s.id) || keep.has(s.id));
        const replaceFlight = !!(dupFlight && $q(body, '#dupFlight') && $q(body, '#dupFlight').checked);
        const finalFlight = flight && (!dupFlight || replaceFlight) ? flight : null;
        UI.closeModal();
        if (!finalSpots.length && !finalFlight) { UI.toast('沒有要複製的項目（都跳過了）'); return; }
        doCopy(code, finalSpots, finalFlight, day, replaceFlight);
      }
    }], { stackActions: true });
  }

  // ---------- ④ 寫入對方行程（遇到版本衝突就重新讀取再套用一次） ----------
  function applyTo(target, spots, flight, day, replaceFlight) {
    const t = trip();
    target.spots = target.spots || [];
    target.flights = target.flights || [];
    target.legsByDay = target.legsByDay || {};
    let order = target.spots.filter(s => (s.day || 0) === day).length;
    spots.forEach(s => {
      const c = JSON.parse(JSON.stringify(s));
      c.id = Logic.uid(); c.day = day; c.order = order++;
      delete c.visited; delete c.locked;
      target.spots.push(c);
    });
    if (flight) {
      if (replaceFlight) target.flights = target.flights.filter(f => !(Number(f.day) === day && f.type === flight.type));
      const c = JSON.parse(JSON.stringify(flight));
      c.id = Logic.uid(); c.day = day;
      delete c.groundAuto; delete c.groundAutoKey; c.groundMin = null; // 地面交通跟對方的出發地有關 → 重新計算
      target.flights.push(c);
    }
    if (day >= 1) delete target.legsByDay[day];
    const what = [spots.length ? `景點 ${spots.map(s => s.name).join('、')}` : '', flight ? `航班 ${[flight.airline, flight.flightNo].filter(Boolean).join(' ') || flight.depAirport.name}` : ''].filter(Boolean).join('＋');
    const entry = ChangeLog.makeEntries([`📋 從「${t.name}」複製 ${what}（到${dayLabel(target, day)}）`], Store.getEditor());
    target.changeLog = ChangeLog.merge(target.changeLog, entry);
    target._saveSession = 'copy-' + Store.getSessionId();
    target._saveBy = Store.getEditor() || '';
    return target;
  }
  async function doCopy(code, spots, flight, day, replaceFlight) {
    try {
      UI.progress(0, '複製中…'); UI.progressCreep(90);
      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = (await Api.cloudGetTrip(code)).trip; // 用最新版套用，避免蓋掉對方剛存的內容
        try {
          await Api.cloudSaveTrip(applyTo(fresh, spots, flight, day, replaceFlight), code);
          await UI.progressDone('複製完成！');
          UI.alert('✅ 複製完成', `已複製到「${fresh.name}」${dayLabel(fresh, day)}：\n\n${spots.map(s => '📍 ' + s.name).join('\n')}${flight ? `\n✈️ ${[flight.airline, flight.flightNo].filter(Boolean).join(' ')} ${flight.depTime} ${flight.depAirport.name} → ${flight.arrTime} ${flight.arrAirport.name}` : ''}\n\n對方打開行程就會看到（修改紀錄也會記一筆）。`);
          return;
        } catch (e) {
          if (!(e && e.conflict) || attempt === 1) throw e; // 對方剛好也在存 → 重新讀取再試一次
        }
      }
    } catch (e) { UI.loading(false); UI.alert('複製失敗', UI.friendlyError(e)); }
  }

  return { open };
})();
