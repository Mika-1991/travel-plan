// ============================================================
// 🧭 新手導覽（v2.1.33）：畫面變暗、依序亮起重要按鈕＋泡泡說明，可上一步／下一步／略過
// 第一次用編輯連結進入行程（選完「你是誰」後）自動開始；看過或略過就記在這台裝置（mika_tour_done）。
// 重看：⋯ 更多 → 新手導覽，或 💬 意見回饋視窗裡的「重看新手導覽」。
// 要介紹的東西不在畫面上時，那一步自動略過。
// ============================================================
const Tour = (() => {
  const DONE_KEY = 'mika_tour_done';
  const EDIT_STEPS = [
    { sel: '#tripSummaryBar', title: '行程大卡', text: '這裡看得到出發倒數，還有「行前準備」做到幾 %，點進度那一行會跳到「準備」分頁。' },
    { sel: '#dayStrip', title: '日期軸', text: '點日期看那一天的行程；在行程上左右滑也能換天。「全部」可以一次看所有天。' },
    { sel: '#inpSpot', title: '加入景點', text: '輸入想去的地方，從 Google 搜尋結果加入。加入的景點會先放在「待排」。' },
    { sel: '#dayList .tl-wrap .spot-row:not(.pt-row)', title: '景點卡片', text: '點一下卡片會展開：調整停留時間、設定餐別、記帳、導航、鎖定。' },
    { sel: '#dayList [data-daymenu]', title: '這天設定', text: '出發／結束時間、交通方式、航班、雨天備案、主題，都收在這裡。' },
    { sel: '#btnOptimize', title: '自動安排最佳路線', text: '景點加好後按這裡，系統會依車程與營業時間自動分天、排順序。' },
    { sel: '#tabbar', title: '分頁', text: '🗺️ 地圖看路線、🧭 準備看待辦與下載 PDF、🗳️ 投票選飯店、💰 分帳記花費。' },
    { sel: '.header-actions', title: '頁首', text: '👤 是你的身分（點了可以切換），綠點是同步狀態；💬 可以把問題或建議傳給 Mika。' }
  ];
  const RO_STEPS = [
    { sel: '#tripSummaryBar', title: '行程大卡', text: '這裡看得到出發倒數和行前準備的進度。' },
    { sel: '#dayStrip', title: '日期軸', text: '點日期看那一天的行程；在行程上左右滑也能換天。' },
    { sel: '#dayList .tl-wrap .spot-row:not(.pt-row)', title: '景點卡片', text: '點一下卡片可以開啟導航。' },
    { sel: '#tabbar', title: '分頁', text: '看地圖、行前準備、飯店投票和分帳。你是用唯讀連結進來的，只能瀏覽。' }
  ];
  let steps = [], idx = 0, layer = null;
  const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const done = () => { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return true; } };
  const markDone = () => { try { localStorage.setItem(DONE_KEY, '1'); } catch {} };

  function start(force) {
    if (!force && done()) return;
    if (typeof App !== 'undefined') App.switchPage('page-trip');
    steps = (Store.isReadonly() ? RO_STEPS : EDIT_STEPS).filter(s => visible(document.querySelector(s.sel)));
    if (!steps.length) return;
    idx = 0;
    build();
    show();
  }
  function build() {
    stop(true);
    layer = document.createElement('div');
    layer.className = 'tour-layer' + (reduce() ? ' no-anim' : '');
    layer.innerHTML = `<div class="tour-hole"></div><div class="tour-tip" role="dialog" aria-live="polite">
      <div class="tour-step"></div><b class="tour-title"></b><p class="tour-text"></p>
      <div class="tour-btns"><button class="tour-skip" type="button">略過</button><span></span>
        <button class="tour-prev" type="button">上一步</button><button class="tour-next" type="button">下一步</button></div></div>`;
    document.body.appendChild(layer);
    layer.querySelector('.tour-skip').onclick = () => stop();
    layer.querySelector('.tour-prev').onclick = () => { if (idx > 0) { idx--; show(); } };
    layer.querySelector('.tour-next').onclick = () => { if (idx < steps.length - 1) { idx++; show(); } else stop(); };
    layer.addEventListener('click', e => { if (e.target === layer) { idx < steps.length - 1 ? (idx++, show()) : stop(); } });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    document.addEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (!layer) return;
    if (e.key === 'Escape') stop();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') layer.querySelector('.tour-next').click();
    else if (e.key === 'ArrowLeft') layer.querySelector('.tour-prev').click();
  }
  function show() {
    const s = steps[idx];
    const el = document.querySelector(s.sel);
    if (!el) { if (idx < steps.length - 1) { idx++; show(); } else stop(); return; }
    // 先捲到看得到（固定在畫面上的東西不用捲）
    const fixed = el.closest('.app-header,.tabbar,.fab-wrap');
    if (!fixed) {
      const r = el.getBoundingClientRect();
      const top = window.scrollY + r.top - Math.max(140, (window.innerHeight - r.height) / 3);
      window.scrollTo(0, Math.max(0, top)); // 直接跳（平滑捲動在部分手機／內嵌瀏覽器不會動），亮框自己有滑動動畫
    }
    const tip = layer.querySelector('.tour-tip');
    tip.classList.remove('in'); void tip.offsetWidth;
    layer.querySelector('.tour-step').textContent = `${idx + 1} / ${steps.length}`;
    layer.querySelector('.tour-title').textContent = s.title;
    layer.querySelector('.tour-text').textContent = s.text;
    layer.querySelector('.tour-prev').disabled = idx === 0;
    layer.querySelector('.tour-next').textContent = idx === steps.length - 1 ? '完成 🎉' : `下一步（${idx + 2}/${steps.length}）`;
    setTimeout(() => { place(); tip.classList.add('in'); }, 60);
  }
  function place() {
    if (!layer) return;
    const s = steps[idx], el = document.querySelector(s.sel);
    if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6;
    const hole = layer.querySelector('.tour-hole');
    const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
    const w = Math.min(window.innerWidth - 8, r.width + pad * 2), h = Math.min(window.innerHeight - 8, r.height + pad * 2);
    Object.assign(hole.style, { top: top + 'px', left: left + 'px', width: w + 'px', height: h + 'px' });
    const tip = layer.querySelector('.tour-tip');
    const tw = Math.min(340, window.innerWidth - 24);
    tip.style.width = tw + 'px';
    const th = tip.offsetHeight || 150;
    const below = top + h + 12, above = top - th - 12;
    const y = below + th < window.innerHeight - 8 ? below : (above > 8 ? above : Math.max(8, window.innerHeight - th - 8));
    const x = Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 12);
    Object.assign(tip.style, { top: y + 'px', left: x + 'px' });
  }
  function stop(silent) {
    if (layer) { layer.remove(); layer = null; }
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place);
    document.removeEventListener('keydown', onKey);
    if (!silent) { markDone(); UI.toast('之後想再看，可以從「⋯ 更多 → 新手導覽」打開'); }
  }
  return { start, stop };
})();
