// ============================================================
// 行程狀態管理：正本資料、localStorage 快取、雲端同步
// ============================================================
const Store = (() => {

  const LOCAL_KEY = 'mika_trip_current';   // 上次行程快取
  const PREF_KEY = 'mika_prefs';           // 個人偏好

  let trip = null;       // 目前行程（見下方 newTrip 結構）
  let role = 'edit';     // 'edit' | 'view'
  let manualDirty = false; // 使用者手動調整過順序（一鍵最佳化前要確認）
  let saveTimer = null;

  function newTrip(basic) {
    return {
      tripId: Logic.uid(),
      editCode: Logic.genEditCode(),
      viewCode: '',
      name: basic.name || '我的旅程',
      startDate: basic.startDate,
      endDate: basic.endDate,
      members: basic.members || [],
      transport: basic.transport || 'driving',
      dayStart: basic.dayStart || CONFIG.defaults.dayStart,
      dayEnd: basic.dayEnd || CONFIG.defaults.dayEnd,
      dayStartOv: {},   // {day: 'HH:MM'} 個別天的出發時間（覆寫 dayStart）
      dayEndOv: {},     // {day: 'HH:MM'} 個別天的結束時間（覆寫 dayEnd）
      dayTransportOv: {}, // {day: 'driving'|'transit'|'walking'} 個別天的交通方式（覆寫 transport）
      hotels: [],        // [{night(0-based), placeId, name, address, rating, phone, lat, lng}]
      spots: [],         // [{id, placeId, name, address, lat, lng, stayMin, must, note, day(1-based|0未排), order}]
      legsByDay: {},     // {day: [分鐘,...]}（排完路線後快取，含飯店段）
      rainPlans: {},     // {day: {spots:[...] }}
      rainActive: {},    // {day: true} 已切換備案
      rainBackup: {},    // {day: [原本的 spots]}（供還原）
      expenses: [],      // [{id, date, item, amount, payer, participants:[]}]
      creatorEmail: basic.creatorEmail || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      baseUpdatedAt: 0   // 上次成功同步時的雲端時間戳（衝突偵測用）
    };
  }

  // ---------- 基本存取 ----------
  const get = () => trip;
  const getRole = () => role;
  const isReadonly = () => role === 'view';
  const days = () => trip ? Logic.datesBetween(trip.startDate, trip.endDate).length : 0;
  const dateOfDay = d => Logic.datesBetween(trip.startDate, trip.endDate)[d - 1]; // d: 1-based
  const hotelOfNight = night => (trip.hotels || []).find(h => Number(h.night) === Number(night)) || null;

  function normalizeTrip(t) {
    if (!t) return t;
    t.hotels = Array.isArray(t.hotels) ? t.hotels : [];
    t.spots = Array.isArray(t.spots) ? t.spots : [];
    t.expenses = Array.isArray(t.expenses) ? t.expenses : [];
    t.hotels.forEach(h => { h.night = Number(h.night) || 0; });
    t.spots.forEach(s => {
      s.day = Number(s.day) || 0;
      s.order = Number(s.order) || 0;
      s.stayMin = Number(s.stayMin) || CONFIG.defaults.stayMin;
    });
    t.legsByDay = t.legsByDay || {};
    t.dayTransportOv = t.dayTransportOv || {};
    t.rainPlans = t.rainPlans || {};
    t.rainActive = t.rainActive || {};
    t.rainBackup = t.rainBackup || {};
    return t;
  }

  function create(basic) {
    trip = newTrip(basic);
    normalizeTrip(trip);
    trip.viewCode = Logic.genViewCode(trip.editCode);
    if (basic.meetPoint) trip.meetPoint = basic.meetPoint;
    if (basic.endPoint) trip.endPoint = basic.endPoint;
    role = 'edit';
    manualDirty = false;
    resetHistory();
    loadSavedSnap();
    persistLocal();
    return trip;
  }

  function load(t, r) {
    trip = normalizeTrip(t);
    role = r || 'edit';
    manualDirty = false;
    resetHistory();
    loadSavedSnap();
    persistLocal();
  }

  // 複製一份行程成「全新的獨立行程」（新代碼、新 Email；原行程不受影響）
  function cloneAsNew(source, name, email) {
    const copy = JSON.parse(JSON.stringify(source));
    copy.tripId = Logic.uid();
    copy.editCode = Logic.genEditCode();
    copy.viewCode = Logic.genViewCode(copy.editCode);
    copy.name = name || (source.name + '（複本）');
    copy.creatorEmail = email || '';
    delete copy.codesAutoSent;
    delete copy.deletedAt;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.baseUpdatedAt = 0;
    return normalizeTrip(copy);
  }

  // ---------- 上一步 / 下一步（復原最近 30 步） ----------
  let histPrev = [], histNext = [], lastSnap = null;
  const snap = () => JSON.stringify(trip);
  function resetHistory() { histPrev = []; histNext = []; lastSnap = trip ? snap() : null; }
  function recordHistory() {
    if (lastSnap === null) { lastSnap = snap(); return; }
    histPrev.push(lastSnap);
    if (histPrev.length > 30) histPrev.shift();
    histNext = [];
    lastSnap = snap();
  }
  const canUndo = () => histPrev.length > 0 && !isReadonly();
  const canRedo = () => histNext.length > 0 && !isReadonly();
  function undo() {
    if (!canUndo()) return false;
    histNext.push(snap());
    trip = JSON.parse(histPrev.pop());
    lastSnap = snap();
    afterHistoryJump();
    return true;
  }
  function redo() {
    if (!canRedo()) return false;
    histPrev.push(snap());
    trip = JSON.parse(histNext.pop());
    lastSnap = snap();
    afterHistoryJump();
    return true;
  }
  function afterHistoryJump() {
    trip.updatedAt = Date.now();
    persistLocal();
    scheduleCloudSave();
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }

  // ---------- 上次儲存的安排（可一鍵還原；撐過重新整理） ----------
  const SAVE_KEY = 'mika_lastsave';   // {tripId, json, at}
  let savedSnap = null;               // {json, at, sig}
  // 只擷取「行程安排」相關欄位當比對指紋（排除 updatedAt 等易變欄位）
  function arrangementSig(t) {
    if (!t) return '';
    return JSON.stringify({
      s: (t.spots || []).map(x => [x.id, x.day, x.order, x.stayMin]),
      h: (t.hotels || []).map(x => [x.night, x.placeId || x.name]),
      m: t.meetPoint ? (t.meetPoint.placeId || t.meetPoint.name) : null,
      e: t.endPoint ? (t.endPoint.placeId || t.endPoint.name) : null,
      tr: t.transport,
      ds: t.dayStartOv || {},
      l: t.legsByDay || {}
    });
  }
  function loadSavedSnap() {
    try {
      const j = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (j && trip && j.tripId === trip.tripId) {
        savedSnap = { json: j.json, at: j.at, sig: arrangementSig(JSON.parse(j.json)) };
      } else savedSnap = null;
    } catch { savedSnap = null; }
  }
  function markSaved() {
    if (!trip) return;
    savedSnap = { json: snap(), at: Date.now(), sig: arrangementSig(trip) };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ tripId: trip.tripId, json: savedSnap.json, at: savedSnap.at }));
    } catch {}
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }
  const hasSavedSnap = () => !!savedSnap;
  const savedSnapAt = () => savedSnap ? savedSnap.at : 0;
  // 目前安排與已儲存版本不同，且可編輯時才需要顯示「還原」
  const canRestoreSaved = () => !!savedSnap && !isReadonly() && arrangementSig(trip) !== savedSnap.sig;
  function restoreSaved() {
    if (!savedSnap || isReadonly()) return false;
    recordHistory();                         // 先把目前狀態推進 undo，讓還原也能用「上一步」救回
    const restored = normalizeTrip(JSON.parse(savedSnap.json));
    restored.baseUpdatedAt = trip.baseUpdatedAt;  // 保留最新雲端衝突基準
    trip = restored;
    trip.updatedAt = Date.now();
    lastSnap = snap();
    persistLocal();
    scheduleCloudSave();
    document.dispatchEvent(new CustomEvent('trip-changed'));
    return true;
  }

  // ---------- 本機快取 ----------
  function persistLocal() {
    if (!trip) return;
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ trip, role }));
  }
  function loadLocal() {
    try {
      const j = JSON.parse(localStorage.getItem(LOCAL_KEY));
      return j && j.trip ? j : null;
    } catch { return null; }
  }
  function clearLocal() {
    localStorage.removeItem(LOCAL_KEY);
    localStorage.removeItem(PREF_KEY);
  }

  function prefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
  function setPref(k, v) { const p = prefs(); p[k] = v; localStorage.setItem(PREF_KEY, JSON.stringify(p)); }

  // ---------- 變更 + 同步 ----------
  // 所有修改行程的動作都呼叫 touch()：存本機 + 延遲 1.5 秒批次上雲
  function touch(opts) {
    if (!trip) return;
    if (opts && opts.manual) manualDirty = true;
    trip.updatedAt = Date.now();
    recordHistory();
    persistLocal();
    scheduleCloudSave();
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }
  const isManualDirty = () => manualDirty;
  const clearManualDirty = () => { manualDirty = false; };

  let syncState = 'idle'; // idle | saving | error | offline
  function scheduleCloudSave() {
    if (isReadonly()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(cloudSaveNow, 1500);
  }
  async function cloudSaveNow() {
    if (!trip || isReadonly()) return;
    try {
      syncState = 'saving'; notifySync();
      const r = await Api.cloudSaveTrip(JSON.parse(JSON.stringify(trip)), trip.editCode);
      trip.baseUpdatedAt = r.updatedAt;
      syncState = 'idle'; notifySync();
    } catch (e) {
      if (e.conflict) {
        syncState = 'conflict'; notifySync();
        document.dispatchEvent(new CustomEvent('trip-conflict'));
      } else {
        syncState = navigator.onLine ? 'error' : 'offline'; notifySync();
      }
    }
  }
  function notifySync() {
    document.dispatchEvent(new CustomEvent('sync-state', { detail: syncState }));
  }

  async function reloadFromCloud() {
    const code = isReadonly() ? trip.viewCode : trip.editCode;
    const r = await Api.cloudGetTrip(code);
    load(r.trip, r.role);
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }

  return {
    get, getRole, isReadonly, days, dateOfDay, hotelOfNight,
    create, load, cloneAsNew, loadLocal, clearLocal,
    prefs, setPref,
    touch, isManualDirty, clearManualDirty,
    undo, redo, canUndo, canRedo,
    markSaved, hasSavedSnap, savedSnapAt, canRestoreSaved, restoreSaved,
    cloudSaveNow, reloadFromCloud
  };
})();
