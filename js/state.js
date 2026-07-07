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
      hotels: [],        // [{night(0-based), placeId, name, address, rating, phone, lat, lng}]
      spots: [],         // [{id, placeId, name, address, lat, lng, stayMin, must, note, day(1-based|0未排), order}]
      legsByDay: {},     // {day: [分鐘,...]}（排完路線後快取，含飯店段）
      rainPlans: {},     // {day: {spots:[...] }}
      rainActive: {},    // {day: true} 已切換備案
      rainBackup: {},    // {day: [原本的 spots]}（供還原）
      expenses: [],      // [{id, date, item, amount, payer, participants:[]}]
      creatorEmail: '',
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
  const hotelOfNight = night => trip.hotels.find(h => h.night === night) || null;

  function create(basic) {
    trip = newTrip(basic);
    trip.viewCode = Logic.genViewCode(trip.editCode);
    role = 'edit';
    manualDirty = false;
    persistLocal();
    return trip;
  }

  function load(t, r) {
    trip = t;
    role = r || 'edit';
    manualDirty = false;
    persistLocal();
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
    create, load, loadLocal, clearLocal,
    prefs, setPref,
    touch, isManualDirty, clearManualDirty,
    cloudSaveNow, reloadFromCloud
  };
})();
