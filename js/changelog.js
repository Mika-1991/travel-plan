// ============================================================
// 修改紀錄：比對「上次存上雲端的版本」和「這次要存的版本」，產生看得懂的中文描述
// （誰、什麼時候、改了什麼）。存檔時附在行程資料的 changeLog（保留最近 100 筆）。
// ============================================================
const ChangeLog = (() => {
  let MAX_ENTRIES = 60;        // 最多保留幾筆：後台是大容量（GAS 17 版分格存）時 100 筆，否則 60 筆（v2.1.38）
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
    // v2.1.36 ⭐ 備選景點進出
    const BA = new Map((a.spots || []).map(s => [s.id, s]));
    (b.spots || []).forEach(s => {
      const o = BA.get(s.id);
      if (o && !!o.backup !== !!s.backup) out.push(s.backup ? `⭐ 移到備選：${s.name}` : `${s.day ? `📅 從備選排到第 ${s.day} 天` : '↩ 放回待排'}：${s.name}`);
    });
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
      const ok = x => (x && x.confirmed && x.fromPoll) ? '（✅ 已確定）' : '';
      if (!o && h) out.push(`${label}設為「${h.name}」${ok(h)}`);
      else if (o && !h) out.push(`${label}移除「${o.name}」`);
      else if ((o.placeId || o.name) !== (h.placeId || h.name)) out.push(`${label}「${o.name}」→「${h.name}」${ok(h)}`);
      else if (!!ok(o) !== !!ok(h)) out.push(`${label}「${h.name}」${ok(h) ? '✅ 確定入住' : '取消已確定'}`);
      else if (!same(o, h)) out.push(`${label}「${h.name}」資料更新（付款／備註／房價）`);
    });
  }

  function diffExpenses(a, b, out) {
    const A = new Map((a.expenses || []).map(e => [e.id, e]));
    const B = new Map((b.expenses || []).map(e => [e.id, e]));
    B.forEach((e, id) => {
      const o = A.get(id);
      if (!o) out.push(`💰 新增記帳「${e.item}」$${e.amount}（${e.payer} 付）`);
      else if (!same(o, e)) {
        const L = { unpaid: '未付款', part: '已刷部分', full: '已刷全額', precharge: '入住前自動扣款', onsite: '當天現刷' };
        const ps = x => x.payStatus || 'full';
        if (ps(o) !== ps(e) || Number(o.paidAmount || 0) !== Number(e.paidAmount || 0)) out.push(`💳 「${e.item}」付款狀態：${L[ps(o)]} → ${L[ps(e)]}${ps(e) === 'part' ? `（已付 ${e.paidAmount || 0}）` : ''}`);
        const CL = { flight: '✈️ 機票', local: '🚗 當地交通', stay: '🏨 住宿', food: '🍽 餐飲', ticket: '🎫 門票活動', shop: '🛍 購物伴手禮', other: '📌 其他' };
        if ((o.cat || '') !== (e.cat || '') && e.cat) out.push(`🏷 「${e.item}」分類改為 ${CL[e.cat] || e.cat}`);
        const rest = x => { const c = Object.assign({}, x); delete c.payStatus; delete c.paidAmount; delete c.hotelLink; delete c.cat; return c; };
        if (!same(rest(o), rest(e))) out.push(`💰 修改記帳「${e.item}」${Number(o.amount) !== Number(e.amount) ? `$${o.amount} → $${e.amount}` : ''}`.trim());
      }
    });
    A.forEach((e, id) => { if (!B.has(id)) out.push(`💰 刪除記帳「${e.item}」$${e.amount}`); });
  }

  // v2.1.27 航班（groundAuto＝自動算的地面交通，不算使用者修改）
  function diffFlights(a, b, out) {
    const clean = f => { const c = Object.assign({}, f); delete c.groundAuto; delete c.groundAutoKey; return c; };
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

  // v2.1.30 飯店投票：候選增刪、確定；同一次存檔的投票合併成一行
  function diffHotelPoll(a, b, out) {
    const nts = ns => (ns || []).map(n => n + 1).join('、');
    const A = new Map(((a.hotelPoll || {}).candidates || []).map(c => [c.id, c]));
    const B = new Map(((b.hotelPoll || {}).candidates || []).map(c => [c.id, c]));
    const voteLines = [];
    B.forEach((c, id) => {
      const o = A.get(id);
      const nm = `「${(c.place || {}).name || '飯店'}」`;
      if (!o) { out.push(`🏨 新增候選飯店${nm}（第 ${nts(c.nights)} 晚）`); return; }
      if (!!o.must !== !!c.must) out.push(`${c.must ? '⭐ 設為必去' : '☆ 取消必去'}${nm}`);
      if (!!o.rec !== !!c.rec) out.push(`${c.rec ? '👍 主揪推薦' : '取消主揪推薦'}${nm}`);
      // 照片網址會自動換新（過期），只比對「選了哪幾張」
      const f = x => JSON.stringify([x.nights, x.price || '', x.priceNum || 0, x.link || '', x.website || '', x.note || '', x.photoIdx || []]);
      if (f(o) !== f(c)) out.push(`🏨 修改候選${nm}`);
      if (JSON.stringify(o.votes || {}) !== JSON.stringify(c.votes || {})) voteLines.push(nm);
    });
    A.forEach((c, id) => { if (!B.has(id)) out.push(`🏨 刪除候選「${(c.place || {}).name || '飯店'}」`); });
    if (voteLines.length) out.push(`👍 投票：${voteLines.join('、')}`);
    if ((a.hotelPoll || {}).owner !== (b.hotelPoll || {}).owner && (b.hotelPoll || {}).owner) out.push(`👑 主揪改為 ${b.hotelPoll.owner}`);
    const bud = p => JSON.stringify([(p || {}).budget || null, (p || {}).budgetByNight || {}]);
    if (bud(a.hotelPoll) !== bud(b.hotelPoll)) out.push('💰 調整住宿預算');
  }

  // 只打開雨天備案看看會建立空的 {spots:[]}，不算修改
  const rainOf = p => { const o = {}; Object.entries(p || {}).forEach(([k, v]) => { if (v && ((v.spots || []).length || Object.keys(v).some(x => x !== 'spots'))) o[k] = v; }); return o; };
  const actOf = r => { const o = {}; Object.entries(r || {}).forEach(([k, v]) => { if (v) o[k] = v; }); return o; };

  // v2.1.32 行前準備：待辦增刪、狀態、指派、截止日／費用；自動項目負責人
  function diffPrep(a, b, out) {
    const A = new Map((((a.prep || {}).tasks) || []).map(x => [x.id, x]));
    const B = new Map((((b.prep || {}).tasks) || []).map(x => [x.id, x]));
    const ST = { todo: '未開始', doing: '進行中', done: '完成' };
    let addedCount = 0;
    B.forEach((x, id) => {
      const o = A.get(id), nm = `「${x.title}」`;
      if (!o) { addedCount++; if (addedCount <= 3) out.push(`📋 新增待辦${nm}`); return; }
      if (x.perPerson) {
        // 每人各自完成：記「誰」勾了／取消
        const oc = o.checks || {}, nc = x.checks || {};
        const who = (x.owners && x.owners.length) ? x.owners : Object.keys(nc);
        const cnt = who.filter(n => nc[n]).length;
        const on = Object.keys(nc).filter(n => nc[n] && !oc[n]), off = Object.keys(oc).filter(n => oc[n] && !nc[n]);
        if (on.length) out.push(`✅ ${on.join('、')} 完成${nm}（${cnt}/${who.length} 人）`);
        if (off.length) out.push(`↩ ${off.join('、')} 取消完成${nm}`);
      } else if (o.status !== x.status) out.push(x.status === 'done' ? `✅ 完成待辦${nm}` : `📋 待辦${nm}改成「${ST[x.status] || x.status}」`);
      if (JSON.stringify(o.owners || []) !== JSON.stringify(x.owners || [])) out.push(`👤 待辦${nm}負責人：${(x.owners || []).join('、') || '（未指派）'}`);
      if ((o.due || '') !== (x.due || '')) out.push(`📅 待辦${nm}截止日：${x.due || '（無）'}`);
      if (o.title !== x.title || (o.note || '') !== (x.note || '') || Number(o.cost || 0) !== Number(x.cost || 0) || o.cat !== x.cat) out.push(`📋 修改待辦${nm}`);
    });
    if (addedCount > 3) out.push(`📋 另外新增 ${addedCount - 3} 項待辦`);
    A.forEach((x, id) => { if (!B.has(id)) out.push(`🗑 刪除待辦「${x.title}」`); });
    if (JSON.stringify((a.prep || {}).autoOwners || {}) !== JSON.stringify((b.prep || {}).autoOwners || {})) out.push('👤 調整自動項目的負責人');
  }

  function diffBasics(a, b, out) {
    if (a.name !== b.name) out.push(`行程名稱改為「${b.name}」`);
    if (a.startDate !== b.startDate || a.endDate !== b.endDate) out.push(`日期改為 ${b.startDate} ~ ${b.endDate}`);
    if (!same(a.members, b.members)) out.push(`成員改為 ${(b.members || []).join('、')}`);
    if ((a.scope || '') !== (b.scope || '') && b.scope) out.push(`行程改為${b.scope === 'abroad' ? '🌏 國外' : '🏠 國內'}旅遊`);
    if (a.transport !== b.transport) out.push(`全程交通方式改為 ${({ driving: '開車', transit: '大眾運輸', walking: '走路' })[b.transport] || b.transport}`);
    const pt = p => (p && p.name) || '（無）';
    if (pt(a.meetPoint) !== pt(b.meetPoint)) out.push(`🚩 集合地改為 ${pt(b.meetPoint)}`);
    if (pt(a.endPoint) !== pt(b.endPoint)) out.push(`🏁 解散地改為 ${pt(b.endPoint)}`);
    if (a.dayStart !== b.dayStart || a.dayEnd !== b.dayEnd || !same(a.dayStartOv, b.dayStartOv) || !same(a.dayEndOv, b.dayEndOv)) out.push('🕘 調整每日出發／結束時間');
    if (!same(a.dayTransportOv, b.dayTransportOv)) out.push('調整某幾天的交通方式');
    // v2.1.35 選路線／冬季封閉道路
    const LA = a.legRoutes || {}, LB = b.legRoutes || {};
    Object.keys(LB).forEach(k => {
      const o = LA[k], n = LB[k];
      if (!o || o.summary !== n.summary || o.min !== n.min) out.push(`🛣 ${n.from || '起點'} → ${n.to || '終點'} 改走「${n.summary || '自訂路線'}」（約 ${n.min} 分）`);
    });
    Object.keys(LA).forEach(k => { if (!LB[k]) out.push(`↩ ${LA[k].from || '起點'} → ${LA[k].to || '終點'} 恢復 Google 預設路線`); });
    const CA = a.closedRoads || [], CB = b.closedRoads || [];
    CB.filter(r => !CA.includes(r)).forEach(r => out.push(`⛔ 標記冬季封閉：${r}`));
    CA.filter(r => !CB.includes(r)).forEach(r => out.push(`取消冬季封閉標記：${r}`));
    const dt = (o, k) => (o[k] || {});
    [...new Set([...Object.keys(dt(a, 'dayTitles')), ...Object.keys(dt(b, 'dayTitles')), ...Object.keys(dt(a, 'dayIcons')), ...Object.keys(dt(b, 'dayIcons'))])].sort((x, y) => x - y).forEach(d => {
      if ((dt(a, 'dayTitles')[d] || '') !== (dt(b, 'dayTitles')[d] || '') || (dt(a, 'dayIcons')[d] || '') !== (dt(b, 'dayIcons')[d] || ''))
        out.push(`✎ 第 ${d} 天主題：${dt(b, 'dayIcons')[d] || ''}${dt(b, 'dayTitles')[d] || '（自動）'}`);
    });
    if (!same(a.stayMeals, b.stayMeals)) out.push('🍽 調整住宿用餐');
    if (!same(rainOf(a.rainPlans), rainOf(b.rainPlans)) || !same(actOf(a.rainActive), actOf(b.rainActive))) out.push('☔ 調整雨天備案');
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
    diffHotelPoll(base, b, out);
    diffPrep(base, b, out);
    // 只有「自動算的地面交通」變了 → 不算修改
    const noAuto = t => { const c = JSON.parse(JSON.stringify(t)); (c.flights || []).forEach(f => { delete f.groundAuto; delete f.groundAutoKey; }); c.rainPlans = rainOf(c.rainPlans); c.rainActive = actOf(c.rainActive); ((c.hotelPoll || {}).candidates || []).forEach(x => { delete x.photos; }); if (c.prep) delete c.prep.templateAsked; return c; };
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
    const cut = s => (s.length > 120 ? s.slice(0, 118) + '…' : s); // v2.1.38 一行最多 120 字（長備註不要整段複製進紀錄）
    return lines.map((text, i) => ({ id: `${now.toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`, t: now, by: by || '（未具名）', text: cut(String(text)) }));
  }

  return { strip, describe, merge, makeEntries, setMax: n => { MAX_ENTRIES = n; }, get MAX_ENTRIES() { return MAX_ENTRIES; } };
})();
