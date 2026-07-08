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
  async function searchPlaces(query, kind) { // kind: 'spot' | 'hotel'
    if (isMock()) {
      await delay(200);
      const pool = kind === 'hotel' ? MOCK.hotels : MOCK.spots;
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
        { query: query, type: kind === 'hotel' ? 'lodging' : undefined },
        (results, status) => okStatus(status) ? resolve((results || []).map(mapPlace))
          : reject(new Error('地點搜尋暫時無法使用，請稍後再試'))
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

  // ---------- 路線最佳化 ----------
  // origin/destination: {lat,lng}|null；spots: [{lat,lng,...}]
  // 回傳 { order:[原索引...], legs:[分鐘...] }（legs[i]=抵達第 i 站前的車程；最後多一段回終點）
  async function optimizeRoute(origin, destination, spots, mode) {
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
    // TRANSIT 不支援多中途點最佳化 → 交通模式改用本地估算順序 + 單段查時間
    if (travelMode === 'TRANSIT') {
      const order = Logic.optimizeOrder(spots, o, d);
      const legs = routeLegsSync(o, d, order.map(i => spots[i]), mode, !!origin, !!destination);
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
      return Object.values(mockCloud())
        .filter(t => (t.creatorEmail || '').toLowerCase() === email)
        .map(t => ({ name: t.name, startDate: t.startDate, endDate: t.endDate, editCode: t.editCode }));
    }
    return gasCall('findTripsByEmail', { email });
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

  return {
    isMock, loadGoogleMaps,
    searchPlaces, nearbySearch,
    optimizeRoute, routeLegs,
    weatherOn,
    cloudGetTrip, cloudSaveTrip, cloudSendCodes, cloudFindByEmail
  };
})();
