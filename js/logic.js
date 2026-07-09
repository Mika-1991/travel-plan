// ============================================================
// 純邏輯模組（不碰畫面、不碰網路）：
// 距離/車程估算、路線最佳化、分天、時間軸、分帳結算、穿搭建議、行程代碼
// ============================================================
const Logic = (() => {

  // ---------- 距離與時間 ----------
  function haversineKm(a, b) {
    const R = 6371, rad = d => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // 是否有有效座標（自訂景點/住宿可能沒填座標 → 不列入車程計算）
  const hasCoords = p => !!p &&
    p.lat !== null && p.lat !== undefined && p.lat !== '' &&
    p.lng !== null && p.lng !== undefined && p.lng !== '' &&
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

  // 車程時間顯示：小於 60 分「xx 分鐘」，以上「x 時 x 分」
  function fmtDur(min) {
    min = Math.round(min);
    if (min < 60) return `${min} 分鐘`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} 時 ${m} 分` : `${h} 小時`;
  }

  // 模擬車程估算（正式模式改用 Directions API 回傳值）
  function travelMinutes(a, b, mode) {
    if (!hasCoords(a) || !hasCoords(b)) return 0;
    const km = haversineKm(a, b) * 1.35; // 直線距離換算實際路徑的粗略係數
    let min;
    if (mode === 'walking') min = km / 4.5 * 60;
    else if (mode === 'transit') min = km / 18 * 60 + 8; // 含等車
    else min = km / 28 * 60 + 4;                          // 市區開車含停車
    return Math.max(1, Math.round(min));
  }

  // ---------- 路線最佳化（最近鄰 + 2-opt）----------
  // points: [{lat,lng},...]，start/end 為起終點（可相同）；回傳 points 的索引順序
  function optimizeOrder(points, start, end) {
    if (points.length <= 1) return points.map((_, i) => i);
    const remain = points.map((_, i) => i);
    const order = [];
    let cur = start;
    while (remain.length) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < remain.length; i++) {
        const d = haversineKm(cur, points[remain[i]]);
        if (d < bestD) { bestD = d; best = i; }
      }
      const idx = remain.splice(best, 1)[0];
      order.push(idx);
      cur = points[idx];
    }
    // 2-opt 微調（含起終點成本）
    const D = (i, j) => haversineKm(i === -1 ? start : points[order[i]],
                                    j === order.length ? end : points[order[j]]);
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const before = D(i - 1, i) + D(j, j + 1);
          const after = haversineKm(i - 1 === -1 ? start : points[order[i - 1]], points[order[j]]) +
                        haversineKm(points[order[i]], j + 1 === order.length ? end : points[order[j + 1]]);
          if (after + 1e-9 < before) {
            order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse());
            improved = true;
          }
        }
      }
    }
    return order;
  }

  // ---------- 分天 ----------
  // orderedSpots: 已最佳化的景點陣列（含 stayMin）
  // ctx: { days, dayStartMin, dayEndMin, travelMin(a,b), hotelOfDay(d) → {lat,lng}|null }
  // 回傳 [[spot,...], ...]（長度 = days；超出天數上限的塞最後一天）
  function splitIntoDays(orderedSpots, ctx) {
    const daysArr = Array.from({ length: ctx.days }, () => []);
    let d = 0;
    let clock = ctx.dayStartMin;
    let prev = ctx.hotelOfDay(0);
    for (const spot of orderedSpots) {
      const leg = prev ? ctx.travelMin(prev, spot) : 0;
      const arrive = clock + leg;
      const leave = arrive + (spot.stayMin || 60);
      if (leave > ctx.dayEndMin && daysArr[d].length > 0 && d < ctx.days - 1) {
        d++;
        clock = ctx.dayStartMin;
        prev = ctx.hotelOfDay(d);
        const leg2 = prev ? ctx.travelMin(prev, spot) : 0;
        daysArr[d].push(spot);
        clock = ctx.dayStartMin + leg2 + (spot.stayMin || 60);
      } else {
        daysArr[d].push(spot);
        clock = leave;
      }
      prev = spot;
    }
    return daysArr;
  }

  // 點 p 到線段 a-b 的近似距離（km）；a/b 可為 null
  function distToSeg(p, a, b) {
    if (!a && !b) return Infinity;
    if (!a) return haversineKm(p, b);
    if (!b) return haversineKm(p, a);
    const latRef = (a.lat + b.lat) / 2 * Math.PI / 180;
    const kx = Math.cos(latRef);
    const ax = a.lng * kx, ay = a.lat, bx = b.lng * kx, by = b.lat, px = p.lng * kx, py = p.lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let tp = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    tp = Math.max(0, Math.min(1, tp));
    const cx = ax + tp * dx, cy = ay + tp * dy;
    const dLat = py - cy, dLng = px - cx;
    return Math.sqrt(dLat * dLat + dLng * dLng) * 111;
  }

  // 依每天的起訖錨點（集合地／飯店／解散地）把景點分配到最合適的一天。
  // 每晚飯店會把該天釘在某個城市，因此比「只按時間切天」更符合實際路線。
  // dayAnchors: 長度=days，dayAnchors[d-1] = { start, end }（可為 null）
  // ctx: { days, dayStartMin, dayEndMin, travelMin(a,b), stayMin(s) }
  // 回傳 [[spot,...],...]（長度=days）；若完全沒有錨點則回 null（交給 splitIntoDays）
  function assignDaysByAnchors(spots, dayAnchors, ctx) {
    const days = ctx.days;
    if (!dayAnchors.some(a => a && (a.start || a.end))) return null;
    const daysArr = Array.from({ length: days }, () => []);
    const orderDay = d => {
      const a = dayAnchors[d] || {};
      const list = daysArr[d];
      if (list.length > 1) {
        const s0 = a.start || a.end || list[0];
        const e0 = a.end || a.start || list[list.length - 1];
        const ord = optimizeOrder(list, s0, e0);
        daysArr[d] = ord.map(i => list[i]);
      }
    };
    const dayTime = d => {
      const a = dayAnchors[d] || {}, list = daysArr[d];
      if (!list.length) return 0;
      let prev = a.start || null, t = 0;
      for (const s of list) { t += (prev ? ctx.travelMin(prev, s) : 0) + ctx.stayMin(s); prev = s; }
      if (a.end && prev) t += ctx.travelMin(prev, a.end);
      return t;
    };
    // 1) 每個景點分配到成本最低（離該天路段最近）的一天
    for (const s of spots) {
      let best = 0, bestC = Infinity;
      for (let d = 0; d < days; d++) {
        const a = dayAnchors[d] || {};
        const c = (a.start || a.end) ? distToSeg(s, a.start, a.end) : 1e6 + d;
        if (c < bestC) { bestC = c; best = d; }
      }
      daysArr[best].push(s);
    }
    for (let d = 0; d < days; d++) orderDay(d);
    // 2) 容量調整：把爆量天的景點勻到有空、且離其路段近的天（優先填空天）
    const budget = ctx.dayEndMin - ctx.dayStartMin;
    let guard = 0;
    while (guard++ < spots.length * 3) {
      let over = -1, overBy = 0;
      for (let d = 0; d < days; d++) {
        const ex = dayTime(d) - budget;
        if (daysArr[d].length > 1 && ex > overBy) { overBy = ex; over = d; }
      }
      if (over < 0) break;
      let mv = null;
      for (const s of daysArr[over]) {
        for (let d = 0; d < days; d++) {
          if (d === over) continue;
          const a = dayAnchors[d] || {};
          const cost = (a.start || a.end) ? distToSeg(s, a.start, a.end) : 1e6 + d;
          const spare = budget - dayTime(d);
          const score = cost - (spare > ctx.stayMin(s) ? 1000 : 0);
          if (!mv || score < mv.score) mv = { s, d, score };
        }
      }
      if (!mv) break;
      daysArr[over] = daysArr[over].filter(x => x !== mv.s);
      daysArr[mv.d].push(mv.s);
      orderDay(over); orderDay(mv.d);
    }
    return daysArr;
  }

  // ---------- 時間軸 ----------
  const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const toHHMM = min => {
    min = Math.round(min);
    const h = Math.floor(min / 60) % 24, m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  };

  // daySpots + legs（legs[i] = 抵達第 i 個點前的車程分鐘，含飯店→第一點；
  // legs 長度 = daySpots.length (+1 若含最後回飯店段，回程不影響景點時間軸)）
  function buildTimeline(daySpots, legs, dayStartHHMM) {
    let clock = toMin(dayStartHHMM);
    let totalTravel = 0, totalStay = 0;
    const rows = daySpots.map((s, i) => {
      const leg = legs[i] || 0;
      totalTravel += leg;
      const arrive = clock + leg;
      const stay = s.stayMin || 60;
      totalStay += stay;
      const depart = arrive + stay;
      clock = depart;
      return { spot: s, legMin: leg, arrive: toHHMM(arrive), depart: toHHMM(depart) };
    });
    const backLeg = legs[daySpots.length] || 0; // 最後回飯店
    totalTravel += backLeg;
    return { rows, totalTravel, totalStay, backLeg, endTime: toHHMM(clock + backLeg) };
  }

  // ---------- 分帳（均分 + 最少轉帳筆數）----------
  // expenses: [{amount, payer, participants:[名字]}]
  function settleExpenses(expenses, members) {
    const paid = {}, owed = {};
    members.forEach(m => { paid[m] = 0; owed[m] = 0; });
    for (const e of expenses) {
      if (paid[e.payer] === undefined) continue;
      const amt = Number(e.amount) || 0;
      paid[e.payer] += amt;
      if (e.treat) { owed[e.payer] += amt; continue; } // 請客：自己吸收，不產生別人的分攤
      const ps = (e.participants && e.participants.length) ? e.participants : members;
      const share = amt / ps.length;
      ps.forEach(p => { if (owed[p] !== undefined) owed[p] += share; });
    }
    const net = members.map(m => ({ name: m, net: paid[m] - owed[m] })); // 正=應收
    const creditors = net.filter(x => x.net > 0.5).map(x => ({ ...x })).sort((a, b) => b.net - a.net);
    const debtors = net.filter(x => x.net < -0.5).map(x => ({ ...x, net: -x.net })).sort((a, b) => b.net - a.net);
    const transfers = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const amt = Math.min(creditors[ci].net, debtors[di].net);
      transfers.push({ from: debtors[di].name, to: creditors[ci].name, amount: Math.round(amt) });
      creditors[ci].net -= amt; debtors[di].net -= amt;
      if (creditors[ci].net < 0.5) ci++;
      if (debtors[di].net < 0.5) di++;
    }
    return { paid, owed, net, transfers };
  }

  // ---------- 穿搭建議 ----------
  function outfitAdvice(w) { // {tmax, tmin, rainProb}
    const tips = [];
    if (w.rainProb >= 60) tips.push('☔ 記得帶傘／雨衣');
    if (w.tmin < 15) tips.push('🧥 帶保暖外套');
    if (w.tmax - w.tmin >= 8) tips.push('🌗 早晚溫差大，帶薄外套');
    if (w.tmax >= 32) tips.push('🧢 注意防曬補水，穿透氣衣物');
    return tips;
  }

  // ---------- 行程代碼 ----------
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉易混淆的 I、O
  const CHARS = LETTERS + '23456789';
  const pick = s => s[Math.floor(Math.random() * s.length)];
  function genEditCode() {
    return pick(LETTERS) + pick(LETTERS) + pick(LETTERS) +
      Math.floor(100 + Math.random() * 900);
  }
  function genViewCode(editCode) {
    return editCode + '-' + pick(CHARS) + pick(CHARS) + pick(CHARS) + pick(CHARS);
  }
  const normalizeCode = c => (c || '').trim().toUpperCase();
  const isEditCodeFormat = c => /^[A-Z]{3}\d{3}$/.test(c);
  const isViewCodeFormat = c => /^[A-Z]{3}\d{3}-[A-Z0-9]{4}$/.test(c);

  // ---------- 其他小工具 ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function datesBetween(startISO, endISO) {
    // 注意：不能用 toISOString()（會轉成 UTC，台灣時區日期會少一天）
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const out = [];
    const d = new Date(startISO + 'T00:00:00');
    const end = new Date(endISO + 'T00:00:00');
    while (d <= end) {
      out.push(fmt(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  return {
    haversineKm, travelMinutes, optimizeOrder, splitIntoDays, assignDaysByAnchors, distToSeg, hasCoords, fmtDur,
    toMin, toHHMM, buildTimeline, settleExpenses, outfitAdvice,
    genEditCode, genViewCode, normalizeCode, isEditCodeFormat, isViewCodeFormat,
    uid, datesBetween
  };
})();
