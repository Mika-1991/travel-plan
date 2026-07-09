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

  // 通用彈窗：body 可為 HTML 字串或元素；actions: [{label, onClick, primary, danger}]
  function modal(title, body, actions, opts) {
    const box = $('modalBox');
    box.innerHTML = `<button class="modal-x" type="button" aria-label="關閉視窗" title="關閉">×</button><h3>${esc(title)}</h3>`;
    box.querySelector('.modal-x').onclick = closeModal;
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
      b.onclick = a.onClick || closeModal;
      act.appendChild(b);
    });
    if (!opts || !opts.noClose) {
      const c = document.createElement('button');
      c.className = 'btn-outline';
      c.textContent = '關閉';
      c.onclick = closeModal;
      act.appendChild(c);
    }
    box.appendChild(act);
    $('modalOverlay').classList.remove('hidden');
  }
  function closeModal() { $('modalOverlay').classList.add('hidden'); }

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
    body.innerHTML = `<img class="zoom-img" src="${url}" alt="${esc(title || '')}">`;
    modal(title || '照片', body, []);
  }

  return { esc, gmapLink, navLink, hotelPriceLink, toast, loading, modal, closeModal, alert: alertBox, confirm: confirmBox, choose, copy, PAY_LABELS, photoZoom };
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
