// ============================================================
// App 主控：共用 UI 元件、分頁切換、初始化
// ============================================================

// ---------- 共用 UI ----------
const UI = (() => {
  const $ = id => document.getElementById(id);

  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const isRealPlaceId = p => p.placeId && !String(p.placeId).startsWith('m-') && !String(p.placeId).startsWith('custom-');
  const gmapLink = p => isRealPlaceId(p)
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${p.placeId}`
    : Logic.hasCoords(p)
      ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name || p.address || '')}`;
  const navLink = p =>
    Logic.hasCoords(p)
      ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}` +
        (isRealPlaceId(p) ? `&destination_place_id=${p.placeId}` : '')
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name || p.address || '')}`;
  // Google 旅館頁：可切換日期看平日/假日房價（Google API 不直接提供房價）
  const hotelPriceLink = name =>
    `https://www.google.com/travel/hotels?q=${encodeURIComponent(name)}`;

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  function loading(on, text) {
    $('loading').classList.toggle('hidden', !on);
    if (text) $('loadingText').textContent = text;
  }

  // ---------- 通用彈窗（支援疊層：彈窗裡再開彈窗會疊在上面，關閉只退回上一層）----------
  // body 可為 HTML 字串或元素；actions: [{label, onClick, primary, danger}]；opts.noClose = 不顯示「關閉」也不可點背景關
  const modalStack = [];
  let guardPushed = false;   // 是否已在 history 放一個「返回鍵先關彈窗」的守衛
  let suppressPop = false;   // 我們自己呼叫 history.back() 造成的 popstate，忽略之
  let backTimer = null;      // 延後清 guard 的計時器（避免關閉後同一輪又開彈窗時 back()+pushState 打架）

  function modal(title, body, actions, opts) {
    opts = opts || {};
    const overlay = $('modalOverlay');
    if (modalStack.length) modalStack[modalStack.length - 1].box.style.display = 'none';
    const box = document.createElement('div');
    box.className = 'modal-box' + (opts.fullscreen ? ' fullscreen' : '');
    box.innerHTML = `<button class="modal-x" type="button" aria-label="關閉視窗" title="關閉">×</button><h3>${esc(title)}</h3>`;
    box.querySelector('.modal-x').onclick = () => closeModal();
    if (typeof body === 'string') {
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = body;
      box.appendChild(p);
    } else if (body) box.appendChild(body);
    const act = document.createElement('div');
    act.className = 'modal-actions';
    (actions || []).forEach(a => {
      const b = document.createElement('button');
      b.className = a.primary ? 'btn-primary' : 'btn-outline';
      if (a.danger) { b.style.borderColor = 'var(--danger)'; b.style.color = 'var(--danger)'; }
      b.textContent = a.label;
      b.onclick = a.onClick || (() => closeModal());
      act.appendChild(b);
    });
    if (!opts.noClose) {
      const c = document.createElement('button');
      c.className = 'btn-outline';
      c.textContent = '關閉';
      c.onclick = () => closeModal();
      act.appendChild(c);
    }
    box.appendChild(act);
    overlay.appendChild(box);
    modalStack.push({ box, opts });
    overlay.classList.remove('hidden');
    clearTimeout(backTimer); // 上一個彈窗剛關又立刻開新彈窗（choose→onPick→再開）→ 取消那次返回，續用同一個 guard
    if (!guardPushed) { guardPushed = true; try { history.pushState({ mikaModal: 1 }, ''); } catch {} }
  }

  // 關閉最上層彈窗
  function closeModal() {
    const top = modalStack.pop();
    if (top && top.box && top.box.parentNode) top.box.parentNode.removeChild(top.box);
    if (modalStack.length) modalStack[modalStack.length - 1].box.style.display = '';
    else finishModals();
  }
  // 一次關閉所有彈窗（流程完成、母資料已變動時用）
  function closeAllModals() {
    while (modalStack.length) {
      const m = modalStack.pop();
      if (m.box && m.box.parentNode) m.box.parentNode.removeChild(m.box);
    }
    finishModals();
  }
  function finishModals() {
    $('modalOverlay').classList.add('hidden');
    if (!guardPushed) return;
    // 延後一拍才清 guard：若同一輪又開了新彈窗，modal() 會 clearTimeout 取消這次返回，
    // 避免 history.back() 與同步的 pushState 在同一個 tick 打架（桌機會誤跳上一頁）。
    clearTimeout(backTimer);
    backTimer = setTimeout(() => {
      if (!modalStack.length && guardPushed) {
        guardPushed = false; suppressPop = true;
        try { history.back(); } catch { suppressPop = false; }
      }
    }, 0);
  }
  // 供 App 初始化時掛：點背景關、手機返回鍵先關彈窗
  function initModalDismiss() {
    const overlay = $('modalOverlay');
    overlay.addEventListener('click', e => {
      if (e.target !== overlay || !modalStack.length) return;
      const top = modalStack[modalStack.length - 1];
      if (!top.opts.noClose) closeModal();
    });
    window.addEventListener('popstate', () => {
      if (suppressPop) { suppressPop = false; return; }
      if (modalStack.length) { guardPushed = false; closeAllModals(); }
    });
  }

  function alertBox(title, msg) { modal(title, msg, []); }
  function confirmBox(title, msg, onYes) {
    modal(title, msg, [
      { label: '確定', primary: true, onClick: () => { closeModal(); onYes && onYes(); } },
      { label: '取消', onClick: closeModal }
    ], { noClose: true });
  }
  // 選項清單彈窗
  function choose(title, options, onPick) {
    const body = document.createElement('div');
    body.className = 'stack';
    options.forEach(o => {
      const b = document.createElement('button');
      b.className = 'btn-outline';
      if (o.danger) { b.style.borderColor = 'var(--danger)'; b.style.color = 'var(--danger)'; }
      b.textContent = o.label;
      b.onclick = () => { closeModal(); onPick(o.value); };
      body.appendChild(b);
    });
    modal(title, body, []);
  }

  async function copy(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || '已複製');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      toast(okMsg || '已複製');
    }
  }

  // 飯店付款狀態標籤（全站共用）
  const PAY_LABELS = { full: '已刷全額', part: '已刷部分', onsite: '當天現刷' };

  // 照片點擊放大
  function photoZoom(url, title) {
    if (!url) return;
    const body = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'zoom-img';
    img.alt = title || '';
    img.onerror = () => { body.innerHTML = '<p class="hint" style="text-align:center;padding:20px 0">這張照片已過期或無法顯示。</p>'; };
    img.src = url;
    body.appendChild(img);
    modal(title || '照片', body, []);
  }

  // 搜尋結果卡片：非同步補上「旅遊當天營業時間」（每筆一次 Google 查詢，一次拿整週；模擬模式自動略過）
  // dayInfos: [{ n: 天數(可 null), wd: 星期0-6 }]。指定某天→傳 1 筆；待排→傳全部天。星期用旅遊日期換算＝當地那天。
  const WEEK_ZH = ['日', '一', '二', '三', '四', '五', '六'];
  function fillResultHours(container, results, dayInfos) {
    if (!container) return;
    const infos = (dayInfos && dayInfos.length) ? dayInfos : [{ n: null, wd: new Date().getDay() }];
    container.querySelectorAll('[data-hours-i]').forEach(el => {
      const r = results[Number(el.dataset.hoursI)];
      if (!r || !r.placeId) { el.remove(); return; }
      Api.placeWeekHours(r.placeId).then(w => {
        if (!w) { el.remove(); return; }
        const parts = infos.map(info => {
          const d = w.days[info.wd] || { text: '?', closed: false };
          const tag = info.n ? `Day${info.n}(${WEEK_ZH[info.wd]})` : `週${WEEK_ZH[info.wd]}`;
          return d.closed ? `<span class="closed">${tag} 公休</span>` : `${tag} ${esc(d.text)}`;
        });
        el.innerHTML = '🕒 ' + parts.join('｜');
      }).catch(() => el.remove());
    });
  }

  return { esc, gmapLink, navLink, hotelPriceLink, toast, loading, modal, closeModal, closeAllModals, initModalDismiss, alert: alertBox, confirm: confirmBox, choose, copy, PAY_LABELS, photoZoom, fillResultHours };
})();

// ---------- App 主控 ----------
const App = (() => {
  const $ = id => document.getElementById(id);

  function switchPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    $(pageId).classList.remove('hidden');
    document.querySelectorAll('#tabbar button').forEach(b =>
      b.classList.toggle('on', b.dataset.page === pageId));
    $('fabWrap').classList.toggle('hidden', pageId !== 'page-trip' || Store.isReadonly());
    if (pageId === 'page-map') Itin.renderFullMap(0);
    if (pageId === 'page-exp') Feat.renderExpensePage();
    if (pageId === 'page-res') Feat.renderResourcePage();
    window.scrollTo(0, 0);
  }

  function applyRole() {
    const ro = Store.isReadonly();
    document.body.classList.toggle('readonly', ro);
    $('readonlyBanner').classList.toggle('hidden', !ro);
    $('fabWrap').classList.toggle('hidden', ro);
  }

  function enterMain() {
    $('wizard').classList.add('hidden');
    $('app').classList.remove('hidden');
    document.body.classList.add('in-app');
    ['btnReload', 'btnHome', 'btnClear'].forEach(id => $(id).classList.remove('hidden'));
    applyRole();
    Itin.render();
    switchPage('page-trip');
  }

  function initHeader() {
    $('appTitle').textContent = `Mika 旅遊路線規劃 ${CONFIG.version}`;
    document.title = `Mika 旅遊路線規劃 ${CONFIG.version}`;
    // 點標題 → 回行程主畫面
    $('appTitle').onclick = () => {
      if (!$('app').classList.contains('hidden')) {
        switchPage('page-trip');
      }
    };
    $('btnReload').onclick = async () => {
      try {
        UI.loading(true, '重新載入中…');
        await Store.reloadFromCloud();
        UI.loading(false);
        enterMain();
        UI.toast('已載入最新版本');
      } catch (e) { UI.loading(false); UI.alert('載入失敗', e.message); }
    };
    const roCopy = $('btnCopyTripRO');
    if (roCopy) roCopy.onclick = () => Feat.copyTrip();
    $('btnHome').onclick = () => { location.href = location.pathname; };
    $('btnClear').onclick = () => {
      UI.confirm('清除本機資料？',
        '會清除這台裝置記住的行程與偏好設定。\n\n☁️ 雲端的行程不受影響，之後仍可用行程代碼載入。\n\n確定要清除嗎？', () => {
          Store.clearLocal();
          UI.toast('已清除，即將回到開始畫面');
          setTimeout(() => location.href = location.pathname, 900);
        });
    };

    // 同步狀態小圓點
    document.addEventListener('sync-state', e => {
      $('syncDot').className = 'sync-dot ' + (e.detail === 'idle' ? '' : e.detail);
      $('syncDot').title = {
        idle: '已同步', saving: '儲存中…', error: '同步失敗，稍後會再試',
        offline: '離線中，恢復連線後會自動同步', conflict: '偵測到其他人更新了行程'
      }[e.detail] || '';
    });
    document.addEventListener('trip-conflict', () => {
      UI.confirm('行程有更新的版本',
        '有人（或另一台裝置）已經更新了這份行程。\n\n建議重新載入最新版本，避免互相覆蓋。要現在載入嗎？',
        async () => {
          try {
            UI.loading(true, '載入最新版本…');
            await Store.reloadFromCloud();
            UI.loading(false);
            enterMain();
          } catch (e) { UI.loading(false); UI.alert('載入失敗', e.message); }
        });
    });

    // 行程資料變動 → 重畫目前頁面相關區塊
    document.addEventListener('trip-changed', () => {
      if (!$('page-exp').classList.contains('hidden')) Feat.renderExpensePage();
    });
  }

  function initTabs() {
    document.querySelectorAll('#tabbar button').forEach(b =>
      b.onclick = () => switchPage(b.dataset.page));
  }

  async function initFromUrl() {
    const code = new URLSearchParams(location.search).get('code');
    if (!code) return false;
    try {
      UI.loading(true, '正在開啟分享的行程…');
      const r = await Api.cloudGetTrip(code);
      Store.load(r.trip, r.role);
      UI.loading(false);
      UI.toast(r.role === 'view' ? '已用唯讀模式開啟' : '行程已開啟，可以編輯');
      enterMain();
      return true;
    } catch (e) {
      UI.loading(false);
      UI.alert('開啟失敗', e.message + '\n\n將回到開始畫面。');
      return false;
    }
  }

  async function init() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // 重新整理後從頁首開始
    UI.initModalDismiss();
    // 破圖自動隱藏：Google Places 照片網址會過期。兩種情況都藏起來（不留破圖）：
    // 1) 載入失敗（error）；2) 載入成功但只是 Google 的「無照片」小佔位圖（naturalWidth 很小）
    const isThumb = el => el && el.tagName === 'IMG' &&
      (el.classList.contains('thumb') || el.classList.contains('thumb-sm') || el.classList.contains('spot-thumb'));
    document.addEventListener('error', e => { if (isThumb(e.target)) e.target.style.display = 'none'; }, true);
    document.addEventListener('load', e => {
      const el = e.target;
      if (isThumb(el) && el.naturalWidth && el.naturalWidth <= 120) el.style.display = 'none';
    }, true);
    initHeader();
    initTabs();
    Wizard.init();
    Itin.init();
    Feat.initExpense();
    const opened = await initFromUrl();
    if (!opened) Wizard.show('w-start');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { enterMain, switchPage };
})();
