// ============================================================
// API 轉接層：所有外部呼叫都走這裡
// CONFIG.mode = 'mock' → 用內建假資料 + localStorage 模擬雲端
// CONFIG.mode = 'real' → Google Places / Directions / GAS Web App
// 前端其他程式不需要知道目前是哪種模式
// ============================================================
const Api = (() => {

  const isMock = () => CONFIG.mode !== 'real';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Google Maps SDK 載入（正式模式） ----------
  let gmapsReady = null;
  function loadGoogleMaps() {
    if (isMock()) return Promise.resolve(false);
    if (gmapsReady) return gmapsReady;
    gmapsReady = new Promise((resolve, reject) => {
      if (window.google && google.maps) return resolve(true);
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.googleApiKey}&libraries=places&language=zh-TW&region=TW`;
      s.onload = () => resolve(true);
      s.onerror = () => {
        gmapsReady = null; // 失敗不快取，下次呼叫可重試
        reject(new Error('Google 地圖服務載入失敗，請檢查網路或 API Key 設定'));
      };
      document.head.appendChild(s);
    });
    return gmapsReady;
  }

  let _placesSvc = null;
  function placesSvc() {
    if (!_placesSvc) _placesSvc = new google.maps.places.PlacesService(document.createElement('div'));
    return _placesSvc;
  }
  const okStatus = s => s === google.maps.places.PlacesServiceStatus.OK ||
                        s === google.maps.places.PlacesServiceStatus.ZERO_RESULTS;
  function mapPlace(p) {
    return {
      placeId: p.place_id,
      name: p.name,
      address: p.formatted_address || p.vicinity || '',
      lat: p.geometry?.location?.lat(), lng: p.geometry?.location?.lng(),
      rating: p.rating || 0, reviews: p.user_ratings_total || 0,
      price: p.price_level || 0,
      phone: p.formatted_phone_number || '',
      photo: p.photos?.[0]?.getUrl({ maxWidth: 400 }) || ''
    };
  }

  // ---------- 地點搜尋 ----------
  async function searchPlaces(query, kind) { // kind: 'spot' | 'hotel' | 'restaurant'
    if (isMock()) {
      await delay(200);
      const pool = kind === 'hotel' ? MOCK.hotels : kind === 'restaurant' ? MOCK.restaurants : MOCK.spots;
      const q = (query || '').trim();
      if (!q) return [];
      // 名稱互相包含，或每個字都出現在名稱中，才算符合
      const hit = pool.filter(p => p.name.includes(q) || q.includes(p.name) ||
        [...q].every(ch => p.name.includes(ch)));
      if (hit.length) return hit.slice(0, 8);
      return pool.slice(0, 5); // 完全沒中：給幾個熱門選項當建議
    }
    await loadGoogleMaps();
    return new Promise((resolve, reject) => {
      placesSvc().textSearch(
        { query: query, type: kind === 'hotel' ? 'lodging' : kind === 'restaurant' ? 'restaurant' : undefined },
        (results, status) => okStatus(status) ? resolve((results || []).map(mapPlace))
          : reject(new Error('地點搜尋暫時無法使用，請稍後再試'))
      );
    });
  }

  async function searchFood(query, center, radiusM) {
    const q = String(query || '').trim();
    if (!q) return nearbySearch(center, 'restaurant', radiusM);
    if (isMock()) {
      await delay(220);
      return MOCK.restaurants
        .map(p => ({ ...p, distKm: Logic.haversineKm(center, p) }))
        .filter(p => (p.name + (p.kind || '') + (p.address || '')).includes(q))
        .sort((a, b) => a.distKm - b.distKm);
    }
    await loadGoogleMaps();
    return new Promise((resolve, reject) => {
      placesSvc().textSearch(
        { query: q, location: center, radius: radiusM, type: 'restaurant' },
        (results, status) => okStatus(status) ? resolve((results || []).map(mapPlace)
          .map(p => ({ ...p, distKm: Logic.haversineKm(center, p) })))
          : reject(new Error('美食搜尋暫時無法使用，請稍後再試'))
      );
    });
  }

  async function nearbySearch(center, type, radiusM) { // type: 'lodging'|'restaurant'|'indoor'
    if (isMock()) {
      await delay(250);
      let pool = type === 'lodging' ? MOCK.hotels
               : type === 'restaurant' ? MOCK.restaurants
               : MOCK.indoorSpots;
      return pool
        .map(p => ({ ...p, distKm: Logic.haversineKm(center, p) }))
        .filter(p => p.distKm <= Math.max(radiusM / 1000, 3) || type !== 'restaurant')
        .sort((a, b) => a.distKm - b.distKm);
    }
    await loadGoogleMaps();
    const types = type === 'indoor'
      ? ['museum', 'art_gallery', 'shopping_mall', 'aquarium']
      : [type];
    const all = [];
    for (const t of types) {
      const part = await new Promise((resolve) => {
        placesSvc().nearbySearch(
          { location: center, radius: radiusM, type: t },
          (results, status) => resolve(okStatus(status) ? (results || []).map(mapPlace) : [])
        );
      });
      all.push(...part);
    }
    const seen = new Set();
    return all.filter(p => !seen.has(p.placeId) && seen.add(p.placeId))
      .map(p => ({ ...p, distKm: Logic.haversineKm(center, p) }))
      .sort((a, b) => a.distKm - b.distKm);
  }

  // ---------- 營業時間／公休日（加入景點時抓一次） ----------
  // 回傳 { weekdayText:[...], closedDays:[0..6] }（0=週日）或 null
  async function placeHours(placeId) {
    if (isMock() || !placeId) { await delay(30); return null; }
    try {
      await loadGoogleMaps();
      return await new Promise(resolve => {
        placesSvc().getDetails({ placeId, fields: ['opening_hours'] }, (res, status) => {
          const oh = res && res.opening_hours;
          if (!okStatus(status) || !oh) { resolve(null); return; }
          const periods = oh.periods || [];
          const openDays = new Set(periods.map(p => p.open && p.open.day).filter(d => d !== undefined && d !== null));
          const closedDays = periods.length ? [0, 1, 2, 3, 4, 5, 6].filter(d => !openDays.has(d)) : [];
          resolve({ weekdayText: oh.weekday_text || [], closedDays });
        });
      });
    } catch (e) { console.warn('營業時間查詢失敗', e); return null; }
  }

  // ---------- 今日營業時間（搜尋結果即時顯示用） ----------
  // 回傳 { todayText:'09:00–18:00'|'本日公休'|'24 小時營業', openNow:true|false|undefined } 或 null
  const hm = t => (t && t.length === 4) ? (t.slice(0, 2) + ':' + t.slice(2)) : (t || '');
  async function placeToday(placeId) {
    if (isMock() || !placeId) { await delay(20); return null; }
    try {
      await loadGoogleMaps();
      return await new Promise(resolve => {
        placesSvc().getDetails({ placeId, fields: ['opening_hours', 'utc_offset_minutes'] }, (res, status) => {
          const oh = res && res.opening_hours;
          if (!okStatus(status) || !oh) { resolve(null); return; }
          const periods = oh.periods || [];
          const today = new Date().getDay(); // 0=週日
          let todayText;
          if (periods.length === 1 && periods[0].open && !periods[0].close &&
              (periods[0].open.time === '0000' || periods[0].open.time === undefined)) {
            todayText = '24 小時營業';
          } else {
            const todays = periods.filter(p => p.open && p.open.day === today);
            todayText = todays.length
              ? todays.map(p => `${hm(p.open.time)}${p.close ? '–' + hm(p.close.time) : ''}`).join('、')
              : '本日公休';
          }
          let openNow;
          try { openNow = typeof oh.isOpen === 'function' ? oh.isOpen() : undefined; } catch { openNow = undefined; }
          resolve({ todayText, openNow });
        });
      });
    } catch (e) { console.warn('營業時間查詢失敗', e); return null; }
  }

  // ---------- 地址轉座標（自訂住宿補地址後可估算路程） ----------
  async function geocodeAddress(address) {
    address = String(address || '').trim();
    if (!address) return null;
    if (isMock()) { await delay(200); return null; } // 模擬模式無法定位
    try {
      await loadGoogleMaps();
      const g = new google.maps.Geocoder();
      const res = await g.geocode({ address, region: 'TW' });
      const loc = res.results && res.results[0] && res.results[0].geometry.location;
      return loc ? { lat: loc.lat(), lng: loc.lng() } : null;
    } catch (e) {
      console.warn('地址定位失敗', e);
      return null;
    }
  }

  // ---------- 路線最佳化 ----------
  // origin/destination: {lat,lng}|null；spots: [{lat,lng,...}]
  // 回傳 { order:[原索引...], legs:[分鐘...] }（legs[i]=抵達第 i 站前的車程；最後多一段回終點）
  const routeDurationCache = {};
  const pointKey = p => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
  const pointLatLng = p => ({ lat: Number(p.lat), lng: Number(p.lng) });

  async function routeDuration(svc, a, b, travelMode, mode) {
    const key = `${travelMode}:${pointKey(a)}>${pointKey(b)}`;
    if (routeDurationCache[key]) return routeDurationCache[key];
    const fallback = Logic.travelMinutes(a, b, mode);
    try {
      const res = await svc.route({ origin: pointLatLng(a), destination: pointLatLng(b), travelMode });
      const min = Math.max(1, Math.round(res.routes[0].legs[0].duration.value / 60));
      routeDurationCache[key] = min;
      return min;
    } catch (e) {
      console.warn('單段路線查詢失敗，改用估算', e);
      routeDurationCache[key] = fallback;
      return fallback;
    }
  }

  async function routeMatrix(svc, points, travelMode, mode, onProgress) {
    const matrix = Array.from({ length: points.length }, () => Array(points.length).fill(0));
    const total = points.length * (points.length - 1);
    let done = 0;
    for (let i = 0; i < points.length; i++) {
      for (let j = 0; j < points.length; j++) {
        if (i !== j) {
          matrix[i][j] = await routeDuration(svc, points[i], points[j], travelMode, mode);
          done++;
          if (onProgress) onProgress(done, total);
        }
      }
    }
    return matrix;
  }

  function matrixOrder(spots, matrix, hasOrigin, hasDest) {
    const n = spots.length;
    const spotNode = i => hasOrigin ? i + 1 : i;
    const destNode = hasDest ? (hasOrigin ? n + 1 : n) : null;
    const remain = spots.map((_, i) => i);
    const order = [];
    let curNode = hasOrigin ? 0 : spotNode(0);
    while (remain.length) {
      let bestAt = 0, bestCost = Infinity;
      for (let i = 0; i < remain.length; i++) {
        const cost = matrix[curNode][spotNode(remain[i])];
        if (cost < bestCost) { bestCost = cost; bestAt = i; }
      }
      const idx = remain.splice(bestAt, 1)[0];
      order.push(idx);
      curNode = spotNode(idx);
    }

    let improved = true, guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const leftNode = i === 0 ? (hasOrigin ? 0 : spotNode(order[0])) : spotNode(order[i - 1]);
          const rightNode = j + 1 === order.length ? (hasDest ? destNode : spotNode(order[order.length - 1])) : spotNode(order[j + 1]);
          const before = matrix[leftNode][spotNode(order[i])] + matrix[spotNode(order[j])][rightNode];
          const after = matrix[leftNode][spotNode(order[j])] + matrix[spotNode(order[i])][rightNode];
          if (after + 1e-9 < before) {
            order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse());
            improved = true;
          }
        }
      }
    }
    return order;
  }

  async function optimizeRoute(origin, destination, spots, mode, opts) {
    const onProgress = (opts && opts.onProgress) || null;
    const o = origin || spots[0];
    const d = destination || o;
    if (isMock() || spots.length > 23) { // Directions 上限 25 站（含起終點）
      await delay(400);
      const order = Logic.optimizeOrder(spots, o, d);
      const legs = routeLegsSync(o, d, order.map(i => spots[i]), mode, !!origin, !!destination);
      return { order, legs };
    }
    await loadGoogleMaps();
    const svc = new google.maps.DirectionsService();
    const travelMode = mode === 'walking' ? 'WALKING' : mode === 'transit' ? 'TRANSIT' : 'DRIVING';
    const canUseMatrix = (travelMode === 'DRIVING' || travelMode === 'WALKING') &&
      spots.length <= (CONFIG.routeMatrixMaxStops || 10) &&
      spots.every(Logic.hasCoords) && (!origin || Logic.hasCoords(origin)) && (!destination || Logic.hasCoords(destination));
    if (canUseMatrix) {
      const hasOrigin = !!origin;
      const hasDest = !!destination;
      const points = [...(hasOrigin ? [origin] : []), ...spots, ...(hasDest ? [destination] : [])];
      const matrix = await routeMatrix(svc, points, travelMode, mode, onProgress);
      const order = matrixOrder(spots, matrix, hasOrigin, hasDest);
      const spotNode = i => hasOrigin ? i + 1 : i;
      const destNode = hasDest ? (hasOrigin ? spots.length + 1 : spots.length) : null;
      const legs = [];
      legs.push(hasOrigin ? matrix[0][spotNode(order[0])] : 0);
      for (let i = 1; i < order.length; i++) {
        legs.push(matrix[spotNode(order[i - 1])][spotNode(order[i])]);
      }
      legs.push(hasDest ? matrix[spotNode(order[order.length - 1])][destNode] : 0);
      return { order, legs, source: 'matrix' };
    }
    // TRANSIT 不支援多中途點最佳化 → 用本地估算排序；車程時間逐段查 Google 真實大眾運輸
    // （opts.realLegs=true 時才真的查，全域排序階段的 legs 會被丟棄，用估算即可省查詢）
    if (travelMode === 'TRANSIT') {
      const order = Logic.optimizeOrder(spots, o, d);
      const ordered = order.map(i => spots[i]);
      const legs = (opts && opts.realLegs)
        ? await routeLegsReal(svc, o, d, ordered, 'TRANSIT', mode, !!origin, !!destination, onProgress)
        : routeLegsSync(o, d, ordered, mode, !!origin, !!destination);
      return { order, legs };
    }
    const res = await svc.route({
      origin: o, destination: d,
      waypoints: spots.map(s => ({ location: { lat: s.lat, lng: s.lng }, stopover: true })),
      optimizeWaypoints: true, travelMode
    });
    const route = res.routes[0];
    const legs = route.legs.map(l => Math.round(l.duration.value / 60));
    // 合理性防護：目的地若是車開不到的點（例如山丘上的燈塔），
    // Google 偶爾會回離譜的繞路時間 → 超過估算 3 倍就改用估算值
    const seq = [o, ...route.waypoint_order.map(i => spots[i]), d];
    for (let i = 0; i < legs.length; i++) {
      const est = Logic.travelMinutes(seq[i], seq[i + 1], mode);
      if (legs[i] > est * 3 + 60) {
        console.warn(`路段 ${i} 車程異常（Google 回 ${legs[i]} 分，估算 ${est} 分），改用估算值`);
        legs[i] = est;
      }
    }
    return { order: route.waypoint_order, legs };
  }

  // 依既定順序計算各路段時間（不改順序）
  function routeLegsSync(origin, destination, orderedSpots, mode, hasOrigin, hasDest) {
    const legs = [];
    let prev = hasOrigin ? origin : null;
    for (const s of orderedSpots) {
      legs.push(prev ? Logic.travelMinutes(prev, s, mode) : 0);
      prev = s;
    }
    legs.push(hasDest && destination && prev ? Logic.travelMinutes(prev, destination, mode) : 0);
    return legs;
  }
  async function routeLegs(origin, destination, orderedSpots, mode) {
    // mock 與正式都先用估算；正式模式排路線時已用 Directions 的真實時間
    await delay(50);
    return routeLegsSync(origin, destination, orderedSpots, mode, !!origin, !!destination);
  }
  // 沿既定順序逐段查 Google 真實車程（大眾運輸用；單段點對點才有效，routeDuration 失敗自動退估算）
  async function routeLegsReal(svc, origin, destination, orderedSpots, travelMode, mode, hasOrigin, hasDest, onProgress) {
    const total = (hasOrigin ? orderedSpots.length : Math.max(orderedSpots.length - 1, 0)) + (hasDest ? 1 : 0);
    const legs = [];
    let prev = hasOrigin ? origin : null;
    let done = 0;
    for (const s of orderedSpots) {
      if (prev && Logic.hasCoords(prev) && Logic.hasCoords(s)) {
        legs.push(await routeDuration(svc, prev, s, travelMode, mode));
        if (onProgress) onProgress(++done, total);
      } else legs.push(0);
      prev = s;
    }
    if (hasDest && destination && prev && Logic.hasCoords(prev) && Logic.hasCoords(destination)) {
      legs.push(await routeDuration(svc, prev, destination, travelMode, mode));
      if (onProgress) onProgress(++done, total);
    } else legs.push(0);
    return legs;
  }

  async function travelTime(a, b, mode) {
    if (!Logic.hasCoords(a) || !Logic.hasCoords(b)) return null;
    if (isMock()) { await delay(20); return Logic.travelMinutes(a, b, mode); }
    try {
      await loadGoogleMaps();
      const svc = new google.maps.DirectionsService();
      const travelMode = mode === 'walking' ? 'WALKING' : mode === 'transit' ? 'TRANSIT' : 'DRIVING';
      return routeDuration(svc, a, b, travelMode, mode);
    } catch (e) {
      console.warn('路程時間查詢失敗，改用估算', e);
      return Logic.travelMinutes(a, b, mode);
    }
  }

  // ---------- 天氣（Open-Meteo，永遠真實資料） ----------
  const weatherCache = {};
  // 回傳 {tmax,tmin,rainProb,code} 或 null（超出預報範圍/失敗）
  async function weatherOn(lat, lng, dateISO, dayStartHHMM, dayEndHHMM) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(dateISO + 'T00:00:00');
    const diffDays = Math.round((target - today) / 86400000);
    if (diffDays < 0 || diffDays >= CONFIG.forecastMaxDays) return { outOfRange: true };
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${dateISO}`;
    if (weatherCache[key]) return weatherCache[key];
    try {
      const url = `${CONFIG.weatherApi}?latitude=${lat}&longitude=${lng}` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
        `&hourly=precipitation_probability&timezone=auto` +
        `&start_date=${dateISO}&end_date=${dateISO}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('weather http ' + res.status);
      const j = await res.json();
      const sh = Math.floor(Logic.toMin(dayStartHHMM) / 60), eh = Math.floor(Logic.toMin(dayEndHHMM) / 60);
      const probs = (j.hourly?.precipitation_probability || [])
        .filter((_, i) => i >= sh && i <= eh);
      const out = {
        tmax: Math.round(j.daily.temperature_2m_max[0]),
        tmin: Math.round(j.daily.temperature_2m_min[0]),
        rainProb: probs.length ? Math.max(...probs) : 0,
        code: j.daily.weather_code[0]
      };
      weatherCache[key] = out;
      return out;
    } catch (e) {
      console.warn('天氣查詢失敗', e);
      return null;
    }
  }

  // ---------- 雲端後端（GAS / 模擬） ----------
  const CLOUD_KEY = 'mika_cloud_trips'; // mock 模式的「雲端」
  function mockCloud() { try { return JSON.parse(localStorage.getItem(CLOUD_KEY)) || {}; } catch { return {}; } }
  function mockCloudSave(db) { localStorage.setItem(CLOUD_KEY, JSON.stringify(db)); }

  async function gasCall(action, payload) {
    const res = await fetch(CONFIG.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS preflight
      body: JSON.stringify({ action, ...payload })
    });
    if (!res.ok) throw new Error('雲端連線失敗（' + res.status + '），請稍後再試');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '雲端回應異常');
    return j.data;
  }

  // 回傳 { trip, role: 'edit'|'view' }；找不到丟錯
  async function cloudGetTrip(code) {
    code = Logic.normalizeCode(code);
    if (isMock()) {
      await delay(300);
      const db = mockCloud();
      for (const t of Object.values(db)) {
        if (t.deletedAt) continue; // 已刪除的行程開不了
        if (t.editCode === code) return { trip: t, role: 'edit' };
        if (t.viewCode === code) return { trip: t, role: 'view' };
      }
      throw new Error('找不到這個行程代碼，請確認輸入是否正確');
    }
    return gasCall('getTrip', { code });
  }

  // 整筆覆蓋 + 時間戳比對；code 必須是編輯代碼
  async function cloudSaveTrip(trip, code) {
    code = Logic.normalizeCode(code);
    if (isMock()) {
      await delay(300);
      const db = mockCloud();
      const existing = db[trip.tripId];
      if (existing && existing.editCode !== code) {
        throw new Error('唯讀代碼無法儲存變更');
      }
      if (existing && existing.updatedAt > trip.baseUpdatedAt) {
        const err = new Error('雲端已有更新的版本'); err.conflict = true; throw err;
      }
      trip.updatedAt = Date.now();
      trip.baseUpdatedAt = trip.updatedAt;
      db[trip.tripId] = JSON.parse(JSON.stringify(trip));
      mockCloudSave(db);
      return { updatedAt: trip.updatedAt };
    }
    return gasCall('saveTrip', { code, trip });
  }

  // 用建立行程時留的 Email 找回行程（可能有多筆）
  async function cloudFindByEmail(email) {
    email = String(email || '').trim().toLowerCase();
    if (isMock()) {
      await delay(300);
      const list = Object.values(mockCloud())
        .filter(t => (t.creatorEmail || '').toLowerCase() === email)
        .map(t => ({ name: t.name, startDate: t.startDate, endDate: t.endDate }));
      return { count: list.length, simulated: true };
    }
    return gasCall('findTripsByEmail', { email });
  }

  // ---------- OTP 驗證與行程管理（v2） ----------
  const MOCK_OTP = '123456'; // mock 模式固定驗證碼（畫面會提示）
  let mockSession = null;

  async function cloudRequestOtp(email) {
    email = String(email || '').trim().toLowerCase();
    if (isMock()) {
      await delay(300);
      const has = Object.values(mockCloud()).some(t => !t.deletedAt && (t.creatorEmail || '').toLowerCase() === email);
      if (!has) throw new Error('這個 Email 沒有綁定任何行程。請確認是建立行程時填的那個 Email。');
      return { sent: true, simulated: true, mockOtp: MOCK_OTP };
    }
    return gasCall('requestEmailOtp', { email });
  }

  async function cloudVerifyOtp(email, otp) {
    email = String(email || '').trim().toLowerCase();
    if (isMock()) {
      await delay(300);
      if (String(otp).trim() !== MOCK_OTP) throw new Error('驗證碼不正確，請再確認信件內容');
      mockSession = 'mock-session-' + Date.now();
      const trips = Object.values(mockCloud())
        .filter(t => !t.deletedAt && (t.creatorEmail || '').toLowerCase() === email)
        .map(t => ({ tripId: t.tripId, name: t.name, startDate: t.startDate, endDate: t.endDate, editCode: t.editCode }));
      return { sessionToken: mockSession, trips };
    }
    return gasCall('verifyEmailOtp', { email, otp });
  }

  async function cloudDeleteTripByEmail(email, sessionToken, tripId) {
    email = String(email || '').trim().toLowerCase();
    if (isMock()) {
      await delay(300);
      if (sessionToken !== mockSession) throw new Error('驗證已失效，請重新用 Email 取得驗證碼');
      const db = mockCloud();
      if (!db[tripId] || db[tripId].deletedAt) throw new Error('找不到這個行程，可能已被刪除');
      db[tripId].deletedAt = Date.now(); // 軟刪除：資料保留、僅標記
      mockCloudSave(db);
      const trips = Object.values(db)
        .filter(t => !t.deletedAt && (t.creatorEmail || '').toLowerCase() === email)
        .map(t => ({ tripId: t.tripId, name: t.name, startDate: t.startDate, endDate: t.endDate, editCode: t.editCode }));
      return { deleted: true, trips };
    }
    return gasCall('deleteTripByEmail', { email, sessionToken, tripId });
  }

  async function cloudSendCodes(email, trip) {
    if (isMock()) {
      await delay(400);
      return { simulated: true }; // 正式模式由 GAS MailApp 寄出
    }
    return gasCall('sendTripCodes', {
      email, code: trip.editCode,
      tripName: trip.name, editCode: trip.editCode, viewCode: trip.viewCode
    });
  }

  // 寄送完整行程（唯讀連結＋每日行程明細）。html 由前端組好，GAS 直接寄出
  async function cloudSendItinerary(email, subject, html, code) {
    if (isMock()) { await delay(400); return { simulated: true }; }
    return gasCall('sendItinerary', { email, subject, html, code });
  }

  // 沿實際道路的路徑座標（Google Directions overview_path）；失敗或模擬回 null → 呼叫端改用直線
  async function routePath(seq, mode) {
    if (isMock() || !seq || seq.length < 2) return null;
    try {
      await loadGoogleMaps();
      const svc = new google.maps.DirectionsService();
      const travelMode = mode === 'walking' ? 'WALKING' : mode === 'transit' ? 'TRANSIT' : 'DRIVING';
      const origin = seq[0], destination = seq[seq.length - 1];
      const waypoints = seq.slice(1, -1).map(p => ({ location: { lat: p.lat, lng: p.lng }, stopover: true }));
      const res = await svc.route({
        origin: { lat: origin.lat, lng: origin.lng },
        destination: { lat: destination.lat, lng: destination.lng },
        waypoints, optimizeWaypoints: false, travelMode,
        avoidFerries: true   // 避免路線繞到離島渡輪（例如飄到澎湖／七美）
      });
      const path = res.routes[0].overview_path.map(ll => ({ lat: ll.lat(), lng: ll.lng() }));
      // 防護 1：幾何邊界——道路路徑若跑出景點群經緯度範圍太多（例如飄到澎湖／七美），視為異常
      const lats = seq.map(p => p.lat), lngs = seq.map(p => p.lng);
      const M = 0.2; // 約 20km 邊界寬容度（容許正常繞路）
      const minLat = Math.min(...lats) - M, maxLat = Math.max(...lats) + M;
      const minLng = Math.min(...lngs) - M, maxLng = Math.max(...lngs) + M;
      const escaped = path.some(p => p.lat < minLat || p.lat > maxLat || p.lng < minLng || p.lng > maxLng);
      if (escaped) {
        console.warn('道路路徑跑出景點範圍（可能繞到離島／渡輪），改用直線');
        return null;
      }
      // 防護 2：道路路徑長度遠大於直線距離（繞太遠／怪路線），改用直線
      let pathKm = 0;
      for (let i = 1; i < path.length; i++) pathKm += Logic.haversineKm(path[i - 1], path[i]);
      let directKm = 0;
      for (let i = 1; i < seq.length; i++) directKm += Logic.haversineKm(seq[i - 1], seq[i]);
      if (pathKm > directKm * 2.5 + 10) {
        console.warn(`道路路徑異常（${Math.round(pathKm)}km vs 直線 ${Math.round(directKm)}km），改用直線`);
        return null;
      }
      return path;
    } catch (e) {
      console.warn('道路路徑查詢失敗，改用直線', e);
      return null;
    }
  }

  // 單段（兩點）的實際路徑座標；大眾運輸不支援途經點，改逐段畫時用這個。含快取避免每次 render 重打
  const legPathCache = {};
  async function routeLegPath(a, b, mode) {
    if (isMock() || !Logic.hasCoords(a) || !Logic.hasCoords(b)) return null;
    const travelMode = mode === 'walking' ? 'WALKING' : mode === 'transit' ? 'TRANSIT' : 'DRIVING';
    const key = `${travelMode}:${pointKey(a)}>${pointKey(b)}`;
    if (legPathCache[key] !== undefined) return legPathCache[key];
    try {
      await loadGoogleMaps();
      const svc = new google.maps.DirectionsService();
      const res = await svc.route({
        origin: { lat: a.lat, lng: a.lng }, destination: { lat: b.lat, lng: b.lng }, travelMode
      });
      const path = res.routes[0].overview_path.map(ll => ({ lat: ll.lat(), lng: ll.lng() }));
      // 基本防呆：路徑不該離兩點包絡太遠（避免怪路線／離島飄移）
      const M = 0.3;
      const minLat = Math.min(a.lat, b.lat) - M, maxLat = Math.max(a.lat, b.lat) + M;
      const minLng = Math.min(a.lng, b.lng) - M, maxLng = Math.max(a.lng, b.lng) + M;
      const ok = !path.some(p => p.lat < minLat || p.lat > maxLat || p.lng < minLng || p.lng > maxLng);
      legPathCache[key] = ok && path.length > 1 ? path : null;
      return legPathCache[key];
    } catch (e) {
      legPathCache[key] = null; // 這段查不到就記著，之後 render 用直線、不再重打
      return null;
    }
  }

  return {
    isMock, loadGoogleMaps, geocodeAddress,
    searchPlaces, searchFood, nearbySearch, placeHours, placeToday,
    optimizeRoute, routeLegs, routePath, routeLegPath, travelTime,
    weatherOn,
    cloudGetTrip, cloudSaveTrip, cloudSendCodes, cloudSendItinerary, cloudFindByEmail,
    cloudRequestOtp, cloudVerifyOtp, cloudDeleteTripByEmail
  };
})();
