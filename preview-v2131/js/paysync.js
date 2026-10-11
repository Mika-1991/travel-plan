// ============================================================
// 💳 付款狀態＋飯店⇄分帳同步（v2.1.35）
// 支出：payStatus 'unpaid'|'part'|'full'|'onsite'（沒填＝full）、paidAmount（part 時已付多少）、
//       hotelLink { key, nights:[0-based] }（對應哪間飯店的哪幾晚）
// 飯店：每晚 h.pay（沿用）。一間飯店連住多晚＝一組＝一筆支出；付款狀態兩邊互相同步，
//       金額／付款人／備註以分帳那筆為準。
// ============================================================
const PaySync = (() => {
  const trip = () => Store.get();
  const STATUS_ORDER = ['unpaid', 'part', 'full', 'onsite'];
  const statusOf = e => (e && e.payStatus) || 'full';
  const keyOf = h => String(h.placeId || h.name || '');
  const nightsText = ns => {
    const s = [...ns].sort((a, b) => a - b);
    return s.length > 1 ? `第 ${s[0] + 1}～${s[s.length - 1] + 1} 晚` : `第 ${s[0] + 1} 晚`;
  };

  // 同一間飯店、連續的晚數合成一組
  function stayGroups() {
    const hs = (trip().hotels || []).slice().sort((a, b) => a.night - b.night);
    const groups = [];
    hs.forEach(h => {
      const g = groups[groups.length - 1];
      if (g && g.key === keyOf(h) && g.nights[g.nights.length - 1] === Number(h.night) - 1) { g.nights.push(Number(h.night)); g.hotels.push(h); }
      else groups.push({ key: keyOf(h), name: h.name, nights: [Number(h.night)], hotels: [h] });
    });
    return groups;
  }
  const groupOfHotel = h => stayGroups().find(g => g.hotels.includes(h)) || null;
  const sameLink = (l, g) => l && g && l.key === g.key && (l.nights || []).some(n => g.nights.includes(n));
  const expenseOf = g => (trip().expenses || []).find(e => sameLink(e.hotelLink, g)) || null;
  const groupOfExpense = e => (e && e.hotelLink ? stayGroups().find(g => sameLink(e.hotelLink, g)) : null);
  const linkFor = g => ({ key: g.key, nights: g.nights.slice() });
  const labelOf = g => `${g.name}（${nightsText(g.nights)}）`;

  // 還要付多少（已刷全額＝0；已刷部分＝總額－已付；未付款／當天現刷＝全額）
  function remainingOf(e) {
    const st = statusOf(e), amt = Number(e.amount) || 0;
    if (st === 'full') return 0;
    if (st === 'part') return Math.max(0, amt - (Number(e.paidAmount) || 0));
    return amt;
  }

  // 飯店改付款狀態 → 同組每一晚＋對應支出
  function setHotelPay(g, status) {
    g.hotels.forEach(h => { if (status) h.pay = status; else delete h.pay; });
    const e = expenseOf(g);
    if (e && status) { e.payStatus = status; if (status !== 'part') delete e.paidAmount; }
    return e;
  }
  // 支出改付款狀態 → 對應飯店的每一晚
  function setExpensePay(e, status) {
    e.payStatus = status;
    if (status !== 'part') delete e.paidAmount;
    const g = groupOfExpense(e);
    if (g) g.hotels.forEach(h => { h.pay = status; });
  }

  // 依住宿日期算房價：平日價×平日晚數＋假日價×週五、週六晚數（沒有房價就回 0）
  function estimatePrice(g) {
    let sum = 0, ok = false;
    g.hotels.forEach(h => {
      const iso = Store.dateOfDay(Number(h.night) + 1);
      const wd = iso ? new Date(iso + 'T00:00:00').getDay() : 1;
      const weekend = wd === 5 || wd === 6;
      const p = Number(weekend ? (h.priceWeekend || h.priceWeekday) : (h.priceWeekday || h.priceWeekend)) || 0;
      if (p) ok = true;
      sum += p;
    });
    return ok ? sum : 0;
  }

  // 舊的「飯店名＋房費」支出 → 自動連到對應的那組飯店（只連結、不新增）
  function autoLink() {
    const t = trip();
    if (!t || Store.isReadonly()) return false;
    let changed = false;
    const groups = stayGroups();
    (t.expenses || []).forEach(e => {
      if (e.hotelLink) return;
      const item = String(e.item || '');
      if (!/房費/.test(item)) return;
      const cand = groups.filter(g => g.name && item.startsWith(g.name) && !expenseOf(g));
      if (cand.length !== 1) return; // 同名飯店住兩次以上 → 不猜，交給使用者手動連
      const g = cand[0];
      e.hotelLink = linkFor(g);
      const pay = (g.hotels.find(h => h.pay) || {}).pay;
      if (pay && !e.payStatus) e.payStatus = pay;
      // 連好之後，同一組的每一晚都跟支出一致
      if (e.payStatus) g.hotels.forEach(h => { h.pay = e.payStatus; });
      changed = true;
    });
    if (changed && Store.saveDerived) Store.saveDerived();
    return changed;
  }

  // 付款狀態選單（給分帳表單、快速記帳、編輯支出共用）
  function fieldsHtml(prefix, status, paid) {
    const st = status || 'full';
    return `
      <label>付款狀態</label>
      <div class="row-2 pay-row">
        <select id="${prefix}Pay">${STATUS_ORDER.map(k => `<option value="${k}" ${st === k ? 'selected' : ''}>${UI.PAY_LABELS[k]}</option>`).join('')}</select>
        <input id="${prefix}Paid" type="number" min="0" inputmode="numeric" placeholder="已付多少" value="${Number(paid) > 0 ? Number(paid) : ''}" class="${st === 'part' ? '' : 'hidden'}">
      </div>`;
  }
  function bindFields(root, prefix) {
    const sel = root.querySelector('#' + prefix + 'Pay'), paid = root.querySelector('#' + prefix + 'Paid');
    if (sel && paid) sel.onchange = () => paid.classList.toggle('hidden', sel.value !== 'part');
  }
  function readFields(root, prefix) {
    const sel = root.querySelector('#' + prefix + 'Pay'), paid = root.querySelector('#' + prefix + 'Paid');
    const status = sel ? sel.value : 'full';
    return { status, paid: status === 'part' ? Math.max(0, Math.round(Number(paid && paid.value) || 0)) : 0 };
  }
  // 支出的狀態標籤（明細／飯店卡片用）
  function badgeHtml(e) {
    const st = statusOf(e);
    if (st === 'full' && !e.hotelLink) return ''; // 一般支出已付清 → 不顯示，畫面乾淨
    const extra = st === 'part' ? `（已付 ${Number(e.paidAmount || 0).toLocaleString()}／剩 ${remainingOf(e).toLocaleString()}）` : '';
    return `<span class="pay-badge pay-${st}">${UI.PAY_LABELS[st]}${extra}</span>`;
  }

  return { stayGroups, groupOfHotel, expenseOf, groupOfExpense, linkFor, labelOf, nightsText, statusOf, remainingOf,
    setHotelPay, setExpensePay, estimatePrice, autoLink, fieldsHtml, bindFields, readFields, badgeHtml, STATUS_ORDER };
})();
