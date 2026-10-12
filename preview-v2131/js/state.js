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
  let pendingLocalChange = false; // 有變更還沒成功存回雲端（決定偵測到新版本時要「安靜刷新」還是「只提醒」）
  let notifiedUpdatedAt = 0; // 避免同一個雲端新版本每 10 秒重複提醒
  // 存檔排隊：GAS 存一次要好幾秒，前一次沒存完就送下一次會帶舊版本號 → 被後端誤判衝突。
  // 所以存檔一律串成一條隊伍；changeSeq 記錄第幾次修改，savedSeq 記錄雲端已存到第幾次。
  let saveChain = Promise.resolve();
  let savesInFlight = 0;
  let changeSeq = 0, savedSeq = 0;
  let pendingSince = 0; // 最早一筆「還沒存上雲端」的修改發生時間（決定要不要跳「還沒存到雲端」提醒）
  // v2.1.25：編輯者身分（每台裝置、每份行程記住一次）＋修改紀錄的比對基準
  let editorName = '';
  let pendingBy = ''; // 有未存修改時切換身分 → 這批修改仍記在切換前的人名下
  let syncedBase = null;        // 上次存上雲端的版本（ChangeLog.strip 過）；'NEW'＝新行程；null＝未知
  let lastRemoteSaveBy = '';    // 心跳看到的「雲端最新版是誰存的」
  let pendingVoteOps = [];      // v2.1.30 飯店投票：還沒存上雲端的投票操作（撞版本時自動重放用）
  const EDITOR_KEY = id => 'mika_editor:' + id;
  function loadEditorFor(t) {
    pendingBy = '';
    try { editorName = (t && localStorage.getItem(EDITOR_KEY(t.tripId))) || ''; } catch { editorName = ''; }
  }
  function setEditor(name) {
    const next = String(name || '').trim();
    if (next !== editorName && changeSeq !== savedSeq && !pendingBy) pendingBy = editorName;
    editorName = next;
    try { if (trip) localStorage.setItem(EDITOR_KEY(trip.tripId), editorName); } catch {}
  }
  const getEditor = () => editorName;
  const getLastRemoteSaveBy = () => lastRemoteSaveBy;
  const sessionId = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36); // 本次分頁的識別碼（線上人數心跳用）

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
    t.flights = Array.isArray(t.flights) ? t.flights : []; // v2.1.27 航班
    if (!t.hotelPoll || !Array.isArray(t.hotelPoll.candidates)) t.hotelPoll = { owner: (t.hotelPoll && t.hotelPoll.owner) || '', candidates: [] }; // v2.1.30 飯店投票
    if (!t.prep || !Array.isArray(t.prep.tasks)) t.prep = { templateAsked: !!(t.prep && t.prep.templateAsked), tasks: [], autoOwners: (t.prep && t.prep.autoOwners) || {} }; // v2.1.32 行前準備
    t.dayTitles = t.dayTitles || {}; t.dayIcons = t.dayIcons || {}; // v2.1.33 每天主題
    // v2.1.37 選定路線的座標改存壓縮字串（舊資料的 path 陣列一次轉掉，省很多字數）
    Object.values(t.legRoutes || {}).forEach(r => {
      if (r && Array.isArray(r.path)) {
        const pts = r.path, max = 80, step = Math.max(1, (pts.length - 1) / (max - 1));
        const sm = pts.length <= max ? pts : Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]);
        r.pathEnc = Logic.encodePath(sm); delete r.path;
      }
    });
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
    pendingLocalChange = false;
    notifiedUpdatedAt = 0;
    changeSeq = 1; savedSeq = 0; pendingSince = 0; // 新行程＝雲端還沒有，第一次存檔一定要送
    syncedBase = 'NEW'; loadEditorFor(trip);
    resetHistory();
    loadSavedSnap();
    reminderBaselineSig = arrangementSig(trip);
    persistLocal();
    if (role === 'edit') askCapacity();
    return trip;
  }

  // opts.fromLocal：從這台裝置的快取「繼續上次行程」——快取裡可能有離線時沒存上雲端的修改
  function load(t, r, opts) {
    trip = normalizeTrip(t);
    role = r || 'edit';
    manualDirty = false;
    pendingLocalChange = false;
    notifiedUpdatedAt = 0;
    changeSeq = 0; savedSeq = 0; pendingSince = 0; // 剛從雲端載入＝跟雲端一致
    if (!(opts && opts.keepVoteOps)) pendingVoteOps = [];
    syncedBase = ChangeLog.strip(trip); loadEditorFor(trip);
    syncState = 'idle'; notifySync();               // 換了一份資料，上一份的存檔失敗狀態不再適用
    resetHistory();
    loadSavedSnap();
    reminderBaselineSig = arrangementSig(trip);
    persistLocal();
    if (role === 'edit') askCapacity();
    // 快取的最後修改時間晚於上次成功存檔 → 有離線修改，標記為未存並排入自動存檔
    if (opts && opts.fromLocal && role === 'edit' && (Number(trip.updatedAt) || 0) > (Number(trip.baseUpdatedAt) || 0)) {
      syncedBase = null; // 不知道雲端長怎樣 → 修改紀錄記成「包含離線時的修改」
      markChanged();
      scheduleCloudSave();
    }
  }
  const hasPendingChanges = () => pendingLocalChange;

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
    // 行前準備：項目留著，但狀態重來、記帳連結清掉（新行程的分帳是另一份）
    if (copy.prep && Array.isArray(copy.prep.tasks)) copy.prep.tasks.forEach(x => { x.status = 'todo'; x.doneBy = ''; x.doneAt = 0; x.expenseId = ''; });
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
    markChanged();
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
    reminderBaselineSig = savedSnap.sig;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ tripId: trip.tripId, json: savedSnap.json, at: savedSnap.at }));
    } catch {}
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }
  const hasSavedSnap = () => !!savedSnap;
  const savedSnapAt = () => savedSnap ? savedSnap.at : 0;

  // 「記得按儲存」提醒的比對基準：獨立於「還原」快照，新行程一開始就有基準，才能一改就提醒
  let reminderBaselineSig = '';
  // v2.1.19 起：只有「自動存檔沒成功」才提醒（存失敗／離線／衝突，或修改超過 10 秒還沒被任何一次存檔存上雲端）
  // 存檔正在進行中＝系統正在努力，不打擾；只有真的卡很久（>50 秒，已超過請求逾時）才提醒
  const SAVE_LATE_MS = 10000, SAVE_STUCK_MS = 50000;
  const needsSaveReminder = () => {
    if (!trip || isReadonly()) return false;
    if (['error', 'offline', 'conflict'].includes(syncState)) return true;
    if (!pendingLocalChange || !pendingSince) return false;
    const late = Date.now() - pendingSince;
    return savesInFlight > 0 ? late > SAVE_STUCK_MS : late > SAVE_LATE_MS;
  };
  // 目前安排與已儲存版本不同，且可編輯時才需要顯示「還原」
  const canRestoreSaved = () => !!savedSnap && !isReadonly() && arrangementSig(trip) !== savedSnap.sig;
  function restoreSaved() {
    if (!savedSnap || isReadonly()) return false;
    recordHistory();                         // 先把目前狀態推進 undo，讓還原也能用「上一步」救回
    const restored = normalizeTrip(JSON.parse(savedSnap.json));
    restored.baseUpdatedAt = trip.baseUpdatedAt;  // 保留最新雲端衝突基準
    trip = restored;
    trip.updatedAt = Date.now();
    markChanged();
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
    if (opts && opts.voteOps) pendingVoteOps.push(...opts.voteOps);
    trip.updatedAt = Date.now();
    markChanged();
    recordHistory();
    persistLocal();
    scheduleCloudSave();
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }
  // 記一筆「本機有新修改、還沒存上雲端」
  function markChanged() {
    if (!pendingLocalChange) pendingSince = Date.now();
    pendingLocalChange = true;
    changeSeq++;
  }
  const isManualDirty = () => manualDirty;
  const clearManualDirty = () => { manualDirty = false; };

  let syncState = 'idle'; // idle | saving | error | offline
  function scheduleCloudSave() {
    if (isReadonly()) return;
    clearTimeout(saveTimer);
    // 背景自動存檔：失敗只反映在同步小圓點（紅點），不彈窗打擾編輯
    saveTimer = setTimeout(() => cloudSaveNow({ auto: true }).catch(() => {}), 1500);
  }
  // 把一次存檔排進隊伍：等前一次（不論成敗）結束才開始，確保每次都帶最新的版本號
  function enqueueSave(job) {
    const p = saveChain.catch(() => {}).then(async () => {
      savesInFlight++;
      try { return await job(); } finally { savesInFlight--; }
    });
    saveChain = p;
    return p;
  }
  // 存檔成功後：雲端已存到「送出當下」那一次修改；若存檔期間又有新修改，仍算有未存變更
  // 組出這次要送的資料：標記是誰、哪個分頁存的，並把「這次改了什麼」附進修改紀錄
  function buildPayload(extraLog) {
    trip._saveSession = sessionId; // 標記「這一版是這個分頁存的」：回應掉了也認得出是自己，不會誤判衝突
    const by = pendingBy || editorName;
    pendingBy = '';
    trip._saveBy = by || '';
    const payload = JSON.parse(JSON.stringify(trip));
    const entries = ChangeLog.makeEntries(ChangeLog.describe(syncedBase, payload), by);
    payload.changeLog = ChangeLog.merge(extraLog, trip.changeLog, entries);
    return fitPayload(payload);
  }
  // v2.1.37 雲端試算表每一格最多 50,000 字：太大就自動精簡（修改紀錄只留最近的、拿掉可以重抓的照片網址）
  // v2.1.38 雲端容量：GAS 17 版起分格存（約 27 萬字），存檔回傳 maxChars；還不知道時用舊的單格上限（保守）
  const MAX_KEY = 'mika_cloud_max';
  let cloudMax = (() => { try { return Number(localStorage.getItem(MAX_KEY)) || 50000; } catch { return 50000; } })();
  ChangeLog.setMax(cloudMax >= 200000 ? 100 : 60);
  let warnedFull = false, capKnown = false;
  let capAsked = false;
  function askCapacity() { // 開行程時問一次後台容量（不等它，失敗就沿用舊值）
    if (capAsked) return; capAsked = true;
    Api.cloudCapacity().then(m => { capKnown = true; noteCloudMax(m); }).catch(() => { capAsked = false; });
  }
  function noteCloudMax(m) {
    m = Number(m) || 0;
    if (!m || m === cloudMax) return;
    cloudMax = m;
    try { localStorage.setItem(MAX_KEY, String(m)); } catch {}
    ChangeLog.setMax(m >= 200000 ? 100 : 60);
  }
  // 平常完全不精簡；80% 提醒一次；95% 才自動精簡（保險）；超過上限就清楚說明、不送出
  function fitPayload(p) {
    const size = () => JSON.stringify(p).length;
    const max = cloudMax - 500, trimAt = Math.round(cloudMax * 0.95);
    let n = size();
    if (capKnown && n >= cloudMax * 0.8 && !warnedFull) {
      warnedFull = true;
      syncLog(`📦 行程資料已用 ${Math.round(n / cloudMax * 100)}%（${Math.round(n / 1000)}k／${Math.round(cloudMax / 1000)}k 字）`);
      setTimeout(() => { try { UI.toast(`📦 這份行程的資料快滿了（已用 ${Math.round(n / cloudMax * 100)}%），請告訴 Mika`); } catch {} }, 500);
    }
    if (n <= trimAt) return p;
    const steps = [
      () => { p.changeLog = (p.changeLog || []).slice(-30); },
      () => { (p.hotelPoll && p.hotelPoll.candidates || []).forEach(c => { if (c.photos && c.photos.length > 1) c.photos = c.photos.slice(0, 1); }); },
      () => { p.changeLog = (p.changeLog || []).slice(-10); },
      () => { (p.spots || []).forEach(s => { delete s.hoursText; }); },
      () => { (p.hotelPoll && p.hotelPoll.candidates || []).forEach(c => { c.photos = []; }); },
      () => { (p.spots || []).forEach(s => { if (s.photo) s.photo = ''; }); (p.hotels || []).forEach(h => { if (h.photo) h.photo = ''; }); }
    ];
    for (const st of steps) { if (size() <= trimAt) break; st(); }
    trip.changeLog = p.changeLog; // 本機也同步精簡，下次不用再算
    n = size();
    if (n > max) {
      const e = new Error(`這份行程的資料太多了（約 ${Math.round(n / 1000)}k 字），超過雲端容量上限，請告訴 Mika。`);
      e.tooBig = true; throw e;
    }
    syncLog('🗜️ 行程資料接近雲端上限，已自動精簡（舊的修改紀錄、可重抓的照片）');
    return p;
  }
  function afterSaved(r, seqAtSend, tripAtSend, sendAt, payload, opsSent) {
    if (trip !== tripAtSend) return; // 存檔期間已切換成別的行程 → 結果不套用到新行程
    trip.baseUpdatedAt = r.updatedAt;
    if (r && r.maxChars) { capKnown = true; noteCloudMax(r.maxChars); } // v2.1.38 後台告訴我們容量
    if (opsSent) pendingVoteOps.splice(0, opsSent); // 已存上雲端的投票操作不用再重放
    if (payload) { trip.changeLog = payload.changeLog; syncedBase = ChangeLog.strip(payload); }
    saveRetryStep = 0; clearTimeout(saveRetryTimer);
    savedSeq = Math.max(savedSeq, seqAtSend);
    pendingLocalChange = changeSeq !== savedSeq;
    // 還沒存到的修改一定發生在這次送出之後 → 從送出時間重新起算（持續編輯時提醒才不會一直亮）
    pendingSince = pendingLocalChange ? sendAt : 0;
    notifiedUpdatedAt = 0;
    syncState = 'idle'; notifySync();
  }
  function cloudSaveNow(opts) {
    return enqueueSave(async () => {
      if (!trip || isReadonly()) return;
      // 自動存檔／手動按儲存：排隊期間前一次已經把最新修改存上去了 → 不用再存一次
      // （衝突／失敗時 savedSeq 不會前進，所以仍會重送）
      if (opts && (opts.auto || opts.skipIfSaved) && savedSeq === changeSeq && syncState === 'idle') return;
      const seqAtSend = changeSeq, tripAtSend = trip, sendAt = Date.now();
      try {
        syncState = 'saving'; notifySync();
        const payload = buildPayload();
        const opsSent = pendingVoteOps.length;
        const r = await Api.cloudSaveTrip(payload, trip.editCode);
        afterSaved(r, seqAtSend, tripAtSend, sendAt, payload, opsSent);
      } catch (e) {
        syncState = e.conflict ? 'conflict' : (navigator.onLine ? 'error' : 'offline');
        notifySync();
        // v2.1.23：存檔被判衝突＝雲端確定有別人的新版本 → 立刻請使用者選擇（不再等心跳才發現）
        // v2.1.30：這段期間本機只有「投票」變動 → 不用問使用者，自動讀最新版、重放投票再存
        if (e.conflict && votesOnlyChanged()) {
          try { await autoMergeVotes(); scheduleCloudSave(); return; } catch (e2) { /* 合併失敗 → 照原本流程問使用者 */ }
        }
        if (e.conflict) askConflictChoice();
        else scheduleSaveRetry(); // v2.1.24：網路類失敗 → 自己排重試，不等心跳
        throw e;
      }
    });
  }
  // 衝突時「用本機這份覆蓋雲端」：先取雲端最新時間戳蓋過衝突檢查，再整筆存回
  function forceCloudSave() {
    return enqueueSave(async () => {
      if (!trip || isReadonly()) throw new Error('唯讀模式無法儲存');
      const seqAtSend = changeSeq, tripAtSend = trip, sendAt = Date.now();
      syncState = 'saving'; notifySync();
      try {
        const latest = await Api.cloudGetTrip(trip.editCode);
        trip.baseUpdatedAt = (latest.trip && latest.trip.baseUpdatedAt) || Date.now();
        // 覆蓋雲端時保留對方的修改紀錄（只蓋掉行程內容，不蓋掉「誰改過什麼」）
        const payload = buildPayload(latest.trip && latest.trip.changeLog);
        const opsSent = pendingVoteOps.length;
        const r = await Api.cloudSaveTrip(payload, trip.editCode);
        afterSaved(r, seqAtSend, tripAtSend, sendAt, payload, opsSent);
      } catch (e) {
        syncState = navigator.onLine ? 'error' : 'offline'; notifySync();
        throw e;
      }
    });
  }
  // 同步紀錄（最近 40 筆）：點頂部小圓點可查看，出狀況時截圖回報用
  const syncLogArr = [];
  function syncLog(msg) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    syncLogArr.push(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}`);
    if (syncLogArr.length > 40) syncLogArr.shift();
  }
  const SYNC_LABEL = { idle: '✅ 已存上雲端', saving: '⏳ 儲存中', error: '❌ 存檔失敗', offline: '📴 離線', conflict: '⚠️ 版本衝突' };
  function notifySync() {
    syncLog((SYNC_LABEL[syncState] || syncState) + (pendingLocalChange ? '（有未存修改）' : ''));
    document.dispatchEvent(new CustomEvent('sync-state', { detail: syncState }));
  }

  async function reloadFromCloud() {
    const code = isReadonly() ? trip.viewCode : trip.editCode;
    const r = await Api.cloudGetTrip(code);
    load(r.trip, r.role);
    document.dispatchEvent(new CustomEvent('trip-changed'));
  }

  // ---------- 線上共同編輯：每 10 秒心跳，回報在線人數＋偵測雲端是否有新版本 ----------
  let presenceTimer = null;
  let lastEditorCount = 1; // 最近一次心跳回報的人數（含自己）；存檔衝突時用來判斷要不要多問一句
  const getLastEditorCount = () => lastEditorCount;
  async function presenceTick(isInitial) {
    if (!trip) return;
    const ro = isReadonly();
    try {
      // 唯讀者也問：只為了知道雲端有沒有新版本（自動刷新），後端不會把唯讀者算進編輯人數
      const r = await Api.cloudPresencePing(ro ? trip.viewCode : trip.editCode, sessionId, ro ? '' : editorName);
      if (r.lastSaveBy !== undefined) lastRemoteSaveBy = r.lastSaveBy || '';
      if (!ro) {
        lastEditorCount = r.editorCount;
        document.dispatchEvent(new CustomEvent('presence-update', { detail: { count: r.editorCount, names: r.names || [], initial: !!isInitial } }));
      }
      // 自己的存檔還在進行中：雲端的新時間戳很可能就是自己剛存的，先不判斷，等下一次心跳
      if (savesInFlight > 0) return;
      // 雲端最新版其實是「這個分頁自己」存的（回應在路上掉了）→ 接受這個時間戳，不當成別人更新
      if (!ro && r.updatedAt > trip.baseUpdatedAt && r.lastSaveSession && r.lastSaveSession === sessionId) {
        trip.baseUpdatedAt = r.updatedAt;
        syncLog('🔎 雲端最新版是自己剛存的（回應曾遺失），已對齊');
        if (pendingLocalChange) cloudSaveNow({ auto: true }).catch(() => {}); // 之後的修改再補存
        else { syncState = 'idle'; notifySync(); }
        return;
      }
      if (r.updatedAt && r.updatedAt > trip.baseUpdatedAt && r.updatedAt !== notifiedUpdatedAt) {
        if (!pendingLocalChange) {
          // 目前沒有還沒存的變更 → 安靜刷新為最新版本
          notifiedUpdatedAt = r.updatedAt;
          syncLog('☁️ 偵測到別人更新 → 自動載入');
          await reloadFromCloud();
          document.dispatchEvent(new CustomEvent('cloud-auto-refreshed'));
        } else {
          // 手上還有未存的變更 → 只提醒，不強制蓋掉
          notifiedUpdatedAt = r.updatedAt;
          if (votesOnlyChanged()) {
            // 自己只有投票變動 → 直接合併，不打擾
            enqueueSave(autoMergeVotes).then(scheduleCloudSave).catch(() => document.dispatchEvent(new CustomEvent('cloud-update-available')));
            return;
          }
          syncLog('☁️ 偵測到別人更新，但自己也有未存修改 → 請使用者選擇');
          document.dispatchEvent(new CustomEvent('cloud-update-available'));
        }
        return;
      }
      // 心跳通了＝網路恢復；之前存失敗、還有未存的修改 → 自動重存（不用使用者再按）
      retryPendingSave();
    } catch (e) { pingFailCount++; syncLog('📡 心跳失敗：' + ((e && e.message) || e)); }
  }
  let pingFailCount = 0; // 累計心跳失敗次數（runPing 用來判斷這次有沒有失敗、決定退避）
  // 跳出「其他人剛更新了行程」三選一（同一時間只跳一個，由 app.js 的 cloud-update-available 處理）
  function askConflictChoice() {
    syncLog('⚠️ 存檔時發現別人已更新 → 請使用者選擇');
    document.dispatchEvent(new CustomEvent('cloud-update-available'));
  }
  // ---------- v2.1.30 投票自動合併 ----------
  // 本機跟「上次存上雲端的版本」比，除了投票以外完全一樣？
  function votesOnlyChanged() {
    if (!pendingVoteOps.length || !syncedBase || syncedBase === 'NEW' || !trip) return false;
    const noVotes = t => { const c = JSON.parse(JSON.stringify(t)); ((c.hotelPoll || {}).candidates || []).forEach(x => { x.votes = {}; }); return JSON.stringify(c); };
    return noVotes(syncedBase) === noVotes(ChangeLog.strip(trip));
  }
  // 讀雲端最新版 → 重放本機的投票操作 → 等下一次自動存檔送出
  async function autoMergeVotes() {
    const ops = pendingVoteOps.slice();
    const r = await Api.cloudGetTrip(trip.editCode);
    load(r.trip, 'edit', { keepVoteOps: true });
    ops.forEach(op => HotelPoll.applyVote(trip, op));
    trip.updatedAt = Date.now();
    markChanged(); persistLocal();
    syncLog('🗳️ 別人也剛存檔：已自動讀取最新版並保留你的投票');
    document.dispatchEvent(new CustomEvent('trip-merged'));
  }
  function retryPendingSave() {
    if (!trip || isReadonly() || !pendingLocalChange || savesInFlight > 0) return;
    if (!['error', 'offline'].includes(syncState)) return;
    cloudSaveNow({ auto: true }).catch(() => {});
  }
  // v2.1.24：存檔因網路失敗 → 5、10、20、30 秒後自動重試（手機剛關飛航時，第一次請求常卡在已斷掉的舊連線上逾時，
  // 放棄後的下一次才會走新連線；原本要等心跳成功才重試，心跳又在退避，等待時間疊加到一分鐘以上）
  const SAVE_RETRY_STEPS_MS = [5000, 10000, 20000, 30000];
  let saveRetryTimer = null, saveRetryStep = 0;
  function scheduleSaveRetry() {
    clearTimeout(saveRetryTimer);
    const wait = SAVE_RETRY_STEPS_MS[Math.min(saveRetryStep, SAVE_RETRY_STEPS_MS.length - 1)];
    saveRetryStep++;
    syncLog('🔁 ' + (wait / 1000) + ' 秒後自動重試存檔');
    saveRetryTimer = setTimeout(retryPendingSave, wait);
  }
  // 瀏覽器偵測到恢復連線 → 重試間隔歸零，馬上重試存檔＋補一次心跳（不等排程）
  window.addEventListener('online', () => {
    syncLog('📶 偵測到網路恢復');
    saveRetryStep = 0; clearTimeout(saveRetryTimer);
    setTimeout(retryPendingSave, 1000);
    if (pollOn) { pingFails = 0; setTimeout(() => runPing(false), 1500); }
  });
  // 手機切回這個網頁（螢幕重新亮起／從別的 App 回來）→ 背景時計時器會被暫停，馬上補一次心跳
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pollOn) { pingFails = 0; runPing(false); } // 已在跑就略過，不會重疊
  });
  // 自動算出來的資料（例如車程）：自己手上有未存修改時才一起存；否則只留在本機，避免兩台裝置互相覆蓋
  function saveDerived() {
    if (!trip || isReadonly()) return;
    if (pendingLocalChange) { markChanged(); persistLocal(); scheduleCloudSave(); }
    else persistLocal();
  }
  // v2.1.22：心跳不重疊＋失敗退避。原本固定每 10 秒送一次，後端一慢，前一次還沒回來下一次又疊上去，
  // 兩台裝置很快累積十幾個請求把後端塞爆（實測心跳 45 秒逾時、404）。
  // 改成「上一次回來後才排下一次」；連續失敗就拉長間隔 10→20→40→60 秒，成功後回到 10 秒。
  const PING_BASE_MS = 10000, PING_MAX_MS = 60000;
  let pingInFlight = false, pingFails = 0, pollOn = false;
  async function runPing(isInitial) {
    if (!pollOn || pingInFlight) return;
    clearTimeout(presenceTimer);
    pingInFlight = true;
    const before = pingFailCount;
    try { await presenceTick(isInitial); } finally { pingInFlight = false; }
    pingFails = pingFailCount > before ? pingFails + 1 : 0;
    if (!pollOn) return;
    const wait = Math.min(PING_MAX_MS, PING_BASE_MS * Math.pow(2, pingFails));
    presenceTimer = setTimeout(() => runPing(false), wait);
  }
  function startPresencePoll() {
    stopPresencePoll();
    lastEditorCount = 1;
    pollOn = true; pingFails = 0;
    runPing(true); // 立刻跑一次（標記為「剛進來」，用來決定要不要跳大提示）
  }
  function stopPresencePoll() {
    pollOn = false;
    clearTimeout(presenceTimer);
    presenceTimer = null;
  }

  return {
    get, getRole, isReadonly, days, dateOfDay, hotelOfNight,
    create, load, cloneAsNew, loadLocal, clearLocal,
    prefs, setPref,
    touch, isManualDirty, clearManualDirty, hasPendingChanges,
    getEditor, setEditor, getLastRemoteSaveBy, getSessionId: () => sessionId,
    undo, redo, canUndo, canRedo,
    markSaved, hasSavedSnap, savedSnapAt, canRestoreSaved, restoreSaved, needsSaveReminder,
    cloudSaveNow, forceCloudSave, reloadFromCloud,
    startPresencePoll, stopPresencePoll, getLastEditorCount, saveDerived,
    getSyncLog: () => syncLogArr.slice()
  };
})();
