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
  // ctx: { days, dayStartMin, dayEndMin, travelMin(a,b), hotelOfDay(d) → {lat,lng}|null,
  //        dayStartMinOf(d)?, dayEndMinOf(d)?（d 為 0-based；有給就用每天各自的時間，例如有航班的天）}
  // 回傳 [[spot,...], ...]（長度 = days；超出天數上限的塞最後一天）
  function splitIntoDays(orderedSpots, ctx) {
    const startOf = d => ctx.dayStartMinOf ? ctx.dayStartMinOf(d) : ctx.dayStartMin;
    const endOf = d => ctx.dayEndMinOf ? ctx.dayEndMinOf(d) : ctx.dayEndMin;
    const daysArr = Array.from({ length: ctx.days }, () => []);
    let d = 0;
    let clock = startOf(0);
    let prev = ctx.hotelOfDay(0);
    for (const spot of orderedSpots) {
      const leg = prev ? ctx.travelMin(prev, spot) : 0;
      const arrive = clock + leg;
      const leave = arrive + (spot.stayMin || 60);
      if (leave > endOf(d) && daysArr[d].length > 0 && d < ctx.days - 1) {
        d++;
        clock = startOf(d);
        prev = ctx.hotelOfDay(d);
        const leg2 = prev ? ctx.travelMin(prev, spot) : 0;
        daysArr[d].push(spot);
        clock = startOf(d) + leg2 + (spot.stayMin || 60);
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
  // ctx: { days, dayStartMin, dayEndMin, travelMin(a,b), stayMin(s), dayBudget(d)? }
  //      dayBudget(d)（d 為 0-based）＝那天實際可用的分鐘數；沒給就每天都用 dayEndMin－dayStartMin
  //      （v2.1.27：個別調過時間、或有航班的天，可用時間不一樣）
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
    // 景點到某天路段的距離成本。沒有錨點（沒住宿、沒航班）的天：改用前後最近一天的錨點估算
    // （每隔一天多加 5km，讓有錨點的天優先）。v2.1.27 前這種天成本是無限大，永遠分不到景點。
    const anchorCost = (s, d) => {
      const a = dayAnchors[d] || {};
      if (a.start || a.end) return distToSeg(s, a.start, a.end);
      for (let k = 1; k < days; k++) {
        let best = Infinity;
        [d - k, d + k].forEach(dd => {
          const b = dayAnchors[dd];
          if (b && (b.start || b.end)) best = Math.min(best, distToSeg(s, b.start, b.end) + k * 5);
        });
        if (best < Infinity) return best;
      }
      return 1e6 + d;
    };
    // 1) 每個景點分配到成本最低（離該天路段最近）的一天
    for (const s of spots) {
      let best = 0, bestC = Infinity;
      for (let d = 0; d < days; d++) {
        const c = anchorCost(s, d);
        if (c < bestC) { bestC = c; best = d; }
      }
      daysArr[best].push(s);
    }
    for (let d = 0; d < days; d++) orderDay(d);
    // 2) 容量調整：把爆量天的景點勻到有空、且離其路段近的天（優先填空天）
    const budgetOf = d => Math.max(0, ctx.dayBudget ? ctx.dayBudget(d) : ctx.dayEndMin - ctx.dayStartMin);
    let guard = 0;
    while (guard++ < spots.length * 3) {
      let over = -1, overBy = 0;
      for (let d = 0; d < days; d++) {
        const ex = dayTime(d) - budgetOf(d);
        if (daysArr[d].length > 1 && ex > overBy) { overBy = ex; over = d; }
      }
      if (over < 0) break;
      let mv = null;
      for (const s of daysArr[over]) {
        for (let d = 0; d < days; d++) {
          if (d === over) continue;
          const cost = anchorCost(s, d);
          const spare = budgetOf(d) - dayTime(d);
          // 放得下的天優先（放不下的天大幅加分＝盡量不選），其次選離路段近的
          const score = cost + (spare >= ctx.stayMin(s) ? 0 : 1e5);
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
  // v2.1.37 路線座標壓縮／解壓（Google Encoded Polyline 格式）
  function encodePath(pts) {
    let out = '', pl = 0, pg = 0;
    const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    (pts || []).forEach(p => { const la = Math.round(p.lat * 1e5), lg = Math.round(p.lng * 1e5); out += enc(la - pl) + enc(lg - pg); pl = la; pg = lg; });
    return out;
  }
  function decodePath(str) {
    const pts = []; let i = 0, la = 0, lg = 0;
    const next = () => { let r = 0, sh = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return (r & 1) ? ~(r >> 1) : (r >> 1); };
    while (str && i < str.length) { la += next(); lg += next(); pts.push({ lat: la / 1e5, lng: lg / 1e5 }); }
    return pts;
  }

  // 一筆支出每個人分多少（精確金額，可能有小數）。請客＝整筆算付錢的人。
  function splitShares(e, members) {
    const amt = Number(e.amount) || 0, out = {};
    if (e.treat) { out[e.payer] = amt; return out; }
    const ps = ((e.participants && e.participants.length) ? e.participants : members).filter(p => members.includes(p));
    ps.forEach(p => { out[p] = amt / ps.length; });
    return out;
  }
  // v2.1.44 結算（Mika 指定的零頭規則）：
  // 1. 每個人整趟的精確分攤金額加總後，「無條件進位」到整數元（due）——大家同一個規則
  // 2. 欠錢的人照進位後的金額付（due − 已付）
  // 3. 進位多出來的幾元（整趟最多 人數−1 元）給先墊錢的人，付錢的人不吃虧
  function settleExpenses(expenses, members, repays) {
    const paid = {}, owed = {}, due = {};
    members.forEach(m => { paid[m] = 0; owed[m] = 0; });
    for (const e of expenses) {
      if (paid[e.payer] === undefined) continue;
      paid[e.payer] += Number(e.amount) || 0;
      const sh = splitShares(e, members);
      Object.keys(sh).forEach(p => { if (owed[p] !== undefined) owed[p] += sh[p]; });
    }
    const EPS = 1e-6;
    members.forEach(m => { due[m] = Math.ceil(owed[m] - EPS) || 0; }); // || 0：避免 -0 顯示成「$-0」
    // 欠錢的人：要付 due − 已付（整數）
    const debtors = members.filter(m => due[m] - paid[m] > EPS).map(m => ({ name: m, net: Math.round(due[m] - paid[m]) }));
    const pool = debtors.reduce((s, x) => s + x.net, 0);
    // 收錢的人：照精確應收先取整數，剩下的（進位多出的）依小數大的先各補 1 元，還有剩就給應收最多的人
    const cred = members.map(m => ({ name: m, ex: paid[m] - owed[m] })).filter(x => x.ex > EPS)
      .map(x => ({ name: x.name, net: Math.floor(x.ex + EPS), frac: x.ex - Math.floor(x.ex + EPS) }));
    let left = pool - cred.reduce((s, x) => s + x.net, 0);
    cred.slice().sort((x, y) => y.frac - x.frac).forEach(x => { if (left > 0 && x.frac > EPS) { x.net++; left--; } });
    if (left > 0 && cred.length) { cred.slice().sort((x, y) => y.net - x.net)[0].net += left; left = 0; }
    const netMap = Object.fromEntries(members.map(m => [m, 0]));
    debtors.forEach(x => { netMap[x.name] = -x.net; });
    cred.forEach(x => { netMap[x.name] = x.net; });
    const net = members.map(m => ({ name: m, net: netMap[m] })); // 正＝應收（整數）
    // 進位多出來的零頭：收錢的人實際多收了多少（跟「已付 − 應分攤」比）
    const bonus = cred.map(x => ({ name: x.name, amt: x.net - Math.round(paid[x.name] - due[x.name]) })).filter(x => x.amt > 0);
    const surplus = members.reduce((s, m) => s + due[m], 0) - Math.round(members.reduce((s, m) => s + paid[m], 0));
    const creditors = cred.filter(x => x.net > 0).map(x => ({ name: x.name, net: x.net })).sort((x, y) => y.net - x.net);
    const ds = debtors.filter(x => x.net > 0).map(x => ({ ...x })).sort((x, y) => y.net - x.net);
    const transfers = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < ds.length) {
      const amt = Math.min(creditors[ci].net, ds[di].net);
      if (amt > 0) transfers.push({ from: ds[di].name, to: creditors[ci].name, amount: amt });
      creditors[ci].net -= amt; ds[di].net -= amt;
      if (creditors[ci].net <= 0) ci++;
      if (ds[di].net <= 0) di++;
    }
    const rp = applyRepays(netMap, transfers, repays, members);
    return { paid, owed, due, net, netMap, plan: transfers, transfers: rp.transfers, left: rp.left, settled: rp.settled, repaid: rp.repaid, surplus, bonus };
  }

  // v2.1.50 帳款關係：不折抵時，兩兩之間誰欠誰多少（照每筆支出「誰付錢、誰有參與」算）。
  // 回傳 [{ a, b, aOwes, bOwes, from, to, amount }]：a 欠 b 共 aOwes、b 欠 a 共 bOwes，
  // 抵掉後 from 要給 to amount（整數）。零頭調整成跟結算一致：每個人的往來加總＝netMap。
  function pairDebts(expenses, members, netMap) {
    const owe = {}; // owe[x][y]：x 欠 y（精確）
    members.forEach(x => { owe[x] = {}; members.forEach(y => { owe[x][y] = 0; }); });
    for (const e of expenses || []) {
      if (e.treat || !members.includes(e.payer)) continue;
      const sh = splitShares(e, members);
      Object.keys(sh).forEach(p => { if (p !== e.payer && owe[p]) owe[p][e.payer] += sh[p]; });
    }
    const pairs = [];
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      pairs.push({ a, b, ex: owe[a][b] - owe[b][a], v: Math.round(owe[a][b] - owe[b][a]) }); // v＞0：a 給 b
    }
    // 零頭調整：每個人的往來加總要等於結算的 netMap（正＝應收）
    if (netMap) {
      const recv = m => pairs.reduce((s, p) => s + (p.b === m ? p.v : p.a === m ? -p.v : 0), 0);
      for (let guard = 0; guard < 200; guard++) {
        const r = Object.fromEntries(members.map(m => [m, (netMap[m] || 0) - recv(m)]));
        const up = members.filter(m => r[m] > 0).sort((x, y) => r[y] - r[x])[0];
        const dn = members.filter(m => r[m] < 0).sort((x, y) => r[x] - r[y])[0];
        if (!up || !dn) break;
        // dn 要多付 1 元給 up：挑這兩人之間那一對調整
        const p = pairs.find(q => (q.a === dn && q.b === up) || (q.a === up && q.b === dn));
        if (!p) break;
        p.v += p.a === dn ? 1 : -1;
      }
    }
    return pairs.filter(p => p.v !== 0 || owe[p.a][p.b] > 0.004 || owe[p.b][p.a] > 0.004).map(p => {
      const from = p.v >= 0 ? p.a : p.b, to = p.v >= 0 ? p.b : p.a, amount = Math.abs(p.v);
      // 顯示用的「你欠我／我欠你」：收錢那邊欠的取整數，付錢那邊＝它＋折抵後金額，減起來剛好對得上
      const toOwes = Math.round(owe[to][from]);
      const fromOwes = toOwes + amount;
      return { a: p.a, b: p.b, from, to, amount, fromOwes, toOwes };
    });
  }

  // v2.1.49 分段還錢（算法 A）：已轉帳的錢算進結餘，再重算「還要給多少」。
  // 原本建議的轉帳對象優先保留；給太多 → 由收到錢的人退回（refund）。
  function applyRepays(netMap, plan, repays, members) {
    const amt = x => Math.round(Number(x.amount)) || 0;
    const ok = (repays || []).filter(x => members.includes(x.from) && members.includes(x.to) && x.from !== x.to && amt(x) > 0);
    if (!ok.length) return { transfers: plan.map(p => ({ ...p, given: 0 })), left: { ...netMap }, settled: [], repaid: 0 };
    const bal = { ...netMap }, given = {};
    const key = (f, t) => f + '\u0001' + t;
    ok.forEach(x => { bal[x.from] += amt(x); bal[x.to] -= amt(x); given[key(x.from, x.to)] = (given[key(x.from, x.to)] || 0) + amt(x); });
    const left = { ...bal }; // 「還差」：正＝還要收、負＝還要給
    const out = [];
    const add = (from, to, amount, refund) => {
      if (amount <= 0) return;
      const f = out.find(o => o.from === from && o.to === to);
      if (f) f.amount += amount; else out.push({ from, to, amount, ...(refund ? { refund: true } : {}) });
      bal[from] += amount; bal[to] -= amount;
    };
    // 1. 原本該付錢（或扯平）的人給太多 → 從最近收到他錢的人退回
    members.forEach(m => {
      if (netMap[m] > 0 || bal[m] <= 0) return;
      ok.filter(x => x.from === m).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).forEach(x => {
        if (bal[m] > 0) add(x.to, m, Math.min(bal[m], amt(x)), true);
      });
    });
    // 2. 收太多的人退給給他錢的人；3. 原本建議的對象優先
    const pri = ok.map(x => [x.to, x.from, true]).concat(plan.map(p => [p.from, p.to, false]));
    pri.forEach(([f, t, ref]) => { if (bal[f] < 0 && bal[t] > 0) add(f, t, Math.min(-bal[f], bal[t]), ref && netMap[f] >= 0); });
    // 4. 其餘用最省事的配法
    const cs = members.filter(m => bal[m] > 0).sort((a, b) => bal[b] - bal[a]);
    const dsx = members.filter(m => bal[m] < 0).sort((a, b) => bal[a] - bal[b]);
    let i = 0, j = 0;
    while (i < cs.length && j < dsx.length) {
      add(dsx[j], cs[i], Math.min(-bal[dsx[j]], bal[cs[i]]), false);
      if (bal[cs[i]] <= 0) i++;
      if (bal[dsx[j]] >= 0) j++;
    }
    out.forEach(o => { o.given = given[key(o.from, o.to)] || 0; });
    const settled = Object.keys(given).map(k => { const [from, to] = k.split('\u0001'); return { from, to, given: given[k] }; })
      .filter(s => !out.some(o => o.from === s.from && o.to === s.to));
    return { transfers: out, left, settled, repaid: ok.reduce((s, x) => s + amt(x), 0) };
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
    toMin, toHHMM, buildTimeline, settleExpenses, splitShares, pairDebts, encodePath, decodePath, outfitAdvice,
    genEditCode, genViewCode, normalizeCode, isEditCodeFormat, isViewCodeFormat,
    uid, datesBetween
  };
})();
