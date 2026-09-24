// ============================================================
// 修改紀錄：比對「上次存上雲端的版本」和「這次要存的版本」，產生看得懂的中文描述
// （誰、什麼時候、改了什麼）。存檔時附在行程資料的 changeLog（保留最近 100 筆）。
// ============================================================
const ChangeLog = (() => {
  const MAX_ENTRIES = 100;     // 最多保留幾筆
  const MAX_LINES_PER_SAVE = 8; // 一次存檔最多列幾行，其餘合併成「…等 N 項」
  // 不算「使用者修改」的欄位：同步用的時間戳、自動算的車程、紀錄本身
  const IGNORE = ['updatedAt', 'baseUpdatedAt', '_saveSession', '_saveBy', 'changeLog', 'legsByDay', 'createdAt', 'codesAutoSent', 'optimizedAt'];
  const MEAL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '點心' };
  const mealTxt = v => MEAL[v] || '無';
  const dayTxt = d => (d >= 1 ? `第 ${d} 天` : '待排');
  const dur = m => Logic.fmtDur(Number(m) || 0);
  const nm = s => `「${(s && s.name) || '未命名'}」`;

  // 去掉不比對的欄位，回傳可比較的純資料
  function strip(t) {
    if (!t) return null;
    const c = JSON.parse(JSON.stringify(t));
    IGNORE.forEach(k => delete c[k]);
    return c;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function diffSpots(a, b, out) {
    const A = new Map((a.spots || []).map(s => [s.id, s]));
    const B = new Map((b.spots || []).map(s => [s.id, s]));
    B.forEach((s, id) => {
      const o = A.get(id);
      if (!o) { out.push(`新增景點${nm(s)}（${dayTxt(s.day)}）`); return; }
      if ((o.day || 0) !== (s.day || 0)) out.push(`${nm(s)}從${dayTxt(o.day)}移到${dayTxt(s.day)}`);
      if (Number(o.stayMin) !== Number(s.stayMin)) out.push(`${nm(s)}停留 ${dur(o.stayMin)} → ${dur(s.stayMin)}`);
      if ((o.meal || '') !== (s.meal || '')) out.push(`${nm(s)}餐別 ${mealTxt(o.meal)} → ${mealTxt(s.meal)}`);
      if ((o.note || '') !== (s.note || '')) out.push(`${nm(s)}備註改為「${s.note || '（清空）'}」`);
      if (!!o.locked !== !!s.locked) out.push(`${s.locked ? '🔒 鎖定' : '🔓 解除鎖定'}${nm(s)}`);
      if (!!o.must !== !!s.must) out.push(`${nm(s)}${s.must ? '設為必去' : '取消必去'}`);
      if (!!o.visited !== !!s.visited) out.push(`${nm(s)}${s.visited ? '標記已去過' : '取消已去過'}`);
    });
    A.forEach((s, id) => { if (!B.has(id)) out.push(`移除景點${nm(s)}`); });
    // 同一天內的順序調整（不含新增／移除／換天的景點）
    const days = new Set([...(b.spots || []).map(s => s.day)].filter(d => d >= 1));
    days.forEach(d => {
      const seq = arr => arr.filter(s => s.day === d && A.has(s.id) && B.has(s.id) && (A.get(s.id).day === B.get(s.id).day))
        .sort((x, y) => (x.order || 0) - (y.order || 0)).map(s => s.id).join(',');
      const before = seq([...A.values()]), after = seq([...B.values()]);
      if (before && before !== after) out.push(`調整${dayTxt(d)}的景點順序`);
    });
  }

  function diffHotels(a, b, out) {
    const key = h => Number(h.night);
    const A = new Map((a.hotels || []).map(h => [key(h), h]));
    const B = new Map((b.hotels || []).map(h => [key(h), h]));
    const nights = new Set([...A.keys(), ...B.keys()]);
    [...nights].sort((x, y) => x - y).forEach(n => {
      const o = A.get(n), h = B.get(n);
      const label = `第 ${n + 1} 晚住宿`;
      if (!o && h) out.push(`${label}設為「${h.name}」`);
      else if (o && !h) out.push(`${label}移除「${o.name}」`);
      else if ((o.placeId || o.name) !== (h.placeId || h.name)) out.push(`${label}「${o.name}」→「${h.name}」`);
      else if (!same(o, h)) out.push(`${label}「${h.name}」資料更新（付款／備註／房價）`);
    });
  }

  function diffExpenses(a, b, out) {
    const A = new Map((a.expenses || []).map(e => [e.id, e]));
    const B = new Map((b.expenses || []).map(e => [e.id, e]));
    B.forEach((e, id) => {
      const o = A.get(id);
      if (!o) out.push(`💰 新增記帳「${e.item}」$${e.amount}（${e.payer} 付）`);
      else if (!same(o, e)) out.push(`💰 修改記帳「${e.item}」${Number(o.amount) !== Number(e.amount) ? `$${o.amount} → $${e.amount}` : ''}`.trim());
    });
    A.forEach((e, id) => { if (!B.has(id)) out.push(`💰 刪除記帳「${e.item}」$${e.amount}`); });
  }

  // v2.1.27 航班（groundAuto＝自動算的地面交通，不算使用者修改）
  function diffFlights(a, b, out) {
    const clean = f => { const c = Object.assign({}, f); delete c.groundAuto; return c; };
    const label = f => `第 ${f.day} 天${f.type === 'arrive' ? '抵達' : '起飛'}航班${f.flightNo ? ' ' + f.flightNo : ''}`;
    const A = new Map((a.flights || []).map(f => [f.id, f]));
    const B = new Map((b.flights || []).map(f => [f.id, f]));
    B.forEach((f, id) => {
      const o = A.get(id);
      if (!o) out.push(`✈️ 新增${label(f)}（${f.depTime} ${(f.depAirport || {}).name || ''} → ${f.arrTime} ${(f.arrAirport || {}).name || ''}）`);
      else if (!same(clean(o), clean(f))) out.push(`✈️ 修改${label(f)}`);
    });
    A.forEach((f, id) => { if (!B.has(id)) out.push(`✈️ 刪除${label(f)}`); });
  }

  function diffBasics(a, b, out) {
    if (a.name !== b.name) out.push(`行程名稱改為「${b.name}」`);
    if (a.startDate !== b.startDate || a.endDate !== b.endDate) out.push(`日期改為 ${b.startDate} ~ ${b.endDate}`);
    if (!same(a.members, b.members)) out.push(`成員改為 ${(b.members || []).join('、')}`);
    if (a.transport !== b.transport) out.push(`全程交通方式改為 ${({ driving: '開車', transit: '大眾運輸', walking: '走路' })[b.transport] || b.transport}`);
    const pt = p => (p && p.name) || '（無）';
    if (pt(a.meetPoint) !== pt(b.meetPoint)) out.push(`🚩 集合地改為 ${pt(b.meetPoint)}`);
    if (pt(a.endPoint) !== pt(b.endPoint)) out.push(`🏁 解散地改為 ${pt(b.endPoint)}`);
    if (a.dayStart !== b.dayStart || a.dayEnd !== b.dayEnd || !same(a.dayStartOv, b.dayStartOv) || !same(a.dayEndOv, b.dayEndOv)) out.push('🕘 調整每日出發／結束時間');
    if (!same(a.dayTransportOv, b.dayTransportOv)) out.push('調整某幾天的交通方式');
    if (!same(a.stayMeals, b.stayMeals)) out.push('🍽 調整住宿用餐');
    if (!same(a.rainPlans, b.rainPlans) || !same(a.rainActive, b.rainActive)) out.push('☔ 調整雨天備案');
  }

  // base：上次存上雲端的版本（strip 過）；'NEW'＝全新行程；null＝不知道雲端版本（例如離線修改後重開）
  function describe(base, next) {
    const b = strip(next);
    if (base === 'NEW') return ['建立行程'];
    if (!base) return ['更新了行程（包含離線時的修改）'];
    if (same(base, b)) return [];
    const out = [];
    diffBasics(base, b, out);
    diffSpots(base, b, out);
    diffHotels(base, b, out);
    diffExpenses(base, b, out);
    diffFlights(base, b, out);
    // 只有「自動算的地面交通」變了 → 不算修改
    const noAuto = t => { const c = JSON.parse(JSON.stringify(t)); (c.flights || []).forEach(f => delete f.groundAuto); return c; };
    if (!out.length && same(noAuto(base), noAuto(b))) return [];
    if (!out.length) out.push('更新了行程設定');
    if (out.length > MAX_LINES_PER_SAVE) {
      const rest = out.length - (MAX_LINES_PER_SAVE - 1);
      return out.slice(0, MAX_LINES_PER_SAVE - 1).concat(`…等另外 ${rest} 項修改`);
    }
    return out;
  }

  // 把新的紀錄加到既有紀錄後面（依 id 去重、依時間排序、只留最近 100 筆）
  function merge(...lists) {
    const map = new Map();
    lists.forEach(l => (l || []).forEach(e => { if (e && e.id) map.set(e.id, e); }));
    return [...map.values()].sort((x, y) => x.t - y.t).slice(-MAX_ENTRIES);
  }

  function makeEntries(lines, by) {
    const now = Date.now();
    return lines.map((text, i) => ({ id: `${now.toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`, t: now, by: by || '（未具名）', text }));
  }

  return { strip, describe, merge, makeEntries, MAX_ENTRIES };
})();
