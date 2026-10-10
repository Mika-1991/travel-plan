// ============================================================
// 🧭 行程進度表／行前準備（v2.1.32）
// 行程頁最上方的主色大卡顯示整體進度；點「看全部」展開完整清單。
// 項目＝系統自動項目（航班、住宿、每天景點、飯店投票：即時計算、按比例）＋自訂待辦。
// 資料：trip.prep = { templateAsked, autoOwners:{flights,stay,spots,vote}, tasks:[{ id, cat, title, note,
//        owners:[名字], due:'YYYY-MM-DD', status:'todo'|'doing'|'done', cost, expenseId, createdBy, createdAt, doneBy, doneAt }] }
// 權限：有編輯連結都能新增／指派；只有負責人本人或主揪能改狀態（沒指派負責人＝大家都能改）；唯讀只看。
// ============================================================
const Prep = (() => {
  const $ = id => document.getElementById(id);
  const trip = () => Store.get();
  const CATS = [
    ['transport', '✈️ 交通'], ['stay', '🏨 住宿'], ['docs', '🛂 證件保險'],
    ['money', '💳 金錢通訊'], ['booking', '🎫 預約門票'], ['other', '📌 其他']
  ];
  const catLabel = k => (CATS.find(c => c[0] === k) || CATS[5])[1];
  const STATUS = { todo: '未開始', doing: '進行中', done: '完成' };
  const NEXT_STATUS = { todo: 'doing', doing: 'done', done: 'todo' };
  const TEMPLATE_ABROAD = [
    ['transport', '訂機票'], ['transport', '訂租車／交通票券'], ['transport', '申請國際駕照', 'drive'],
    ['docs', '確認護照效期（6 個月以上）'], ['docs', '填入境登錄（如 Visit Japan Web）'], ['docs', '買旅平險'],
    ['money', '換匯／準備信用卡'], ['money', '買網卡／eSIM'],
    ['booking', '熱門景點門票預約'], ['booking', '餐廳訂位']
  ];
  const TEMPLATE_HOME = [
    ['transport', '訂車票／租車'], ['docs', '買旅平險'], ['booking', '景點門票預約'], ['booking', '餐廳訂位']
  ];
  const AV_COLORS = ['#006599', '#FF8C00', '#0F9D58', '#7C3AED', '#E11D48', '#0891B2', '#B45309', '#4B5563'];

  let panelOpen = false;
  try { panelOpen = localStorage.getItem('mika_prep_open') === '1'; } catch {}
  let groupMode = 'cat', onlyMine = false;

  const prep = () => {
    const t = trip();
    if (!t.prep || typeof t.prep !== 'object') t.prep = { templateAsked: false, tasks: [], autoOwners: {} };
    if (!Array.isArray(t.prep.tasks)) t.prep.tasks = [];
    if (!t.prep.autoOwners) t.prep.autoOwners = {};
    return t.prep;
  };
  const members = () => (trip().members || []).filter(Boolean);
  const me = () => Store.getEditor();
  const canEdit = () => !Store.isReadonly() && !!me();
  const boss = () => (typeof HotelPoll !== 'undefined' && HotelPoll.owner) ? HotelPoll.owner() : (members()[0] || '');
  const isBoss = () => canEdit() && me() === boss();
  const canStatus = task => canEdit() && (!(task.owners || []).length || task.owners.includes(me()) || isBoss());
  const avColor = name => { const i = members().indexOf(name); return AV_COLORS[(i < 0 ? name.length : i) % AV_COLORS.length]; };
  const avatars = names => (names || []).map(n => `<span class="pp-av" style="background:${avColor(n)}" title="${UI.esc(n)}">${UI.esc(n.slice(0, 1))}</span>`).join('');
  const money = n => 'NT$' + Number(n).toLocaleString('en-US');

  // ---------- 日期 ----------
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);
  const md = iso => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  function dueState(task) { // 'over' | 'soon' | ''
    if (!task.due || task.status === 'done') return '';
    const left = daysBetween(todayISO(), task.due);
    return left < 0 ? 'over' : left <= 3 ? 'soon' : '';
  }
  function dueText(task) {
    if (!task.due) return '';
    if (task.status === 'done') return md(task.due);
    const left = daysBetween(todayISO(), task.due);
    return left < 0 ? `逾期 ${-left} 天` : left === 0 ? '今天到期' : `${md(task.due)}（剩 ${left} 天）`;
  }
  function countdown() {
    const t = trip(), today = todayISO();
    const toStart = daysBetween(today, t.startDate), toEnd = daysBetween(today, t.endDate);
    if (toStart > 0) return `距離出發 ${toStart} 天`;
    if (toEnd >= 0) return `旅行中・第 ${-toStart + 1} 天`;
    return '旅程已結束';
  }

  // ---------- 國外／國內 ----------
  function isAbroad() {
    const t = trip();
    if ((t.flights || []).some(f => f.intl)) return true;
    const pts = [...(t.spots || []), ...(t.hotels || [])].filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
    const inTW = p => p.lat > 21.7 && p.lat < 26.5 && p.lng > 118 && p.lng < 122.2;
    return pts.length > 0 && pts.filter(p => !inTW(p)).length > pts.length / 2;
  }

  // ---------- 系統自動項目（即時計算） ----------
  function autoItems() {
    const t = trip(), days = Store.days(), nights = Math.max(days - 1, 0), out = [];
    const ao = prep().autoOwners;
    const ownersOf = k => (ao[k] && ao[k].length ? ao[k] : (boss() ? [boss()] : []));
    const fl = t.flights || [];
    if (fl.length || isAbroad()) {
      const arr = fl.some(f => f.type === 'arrive'), dep = fl.some(f => f.type === 'depart');
      out.push({ key: 'flights', cat: 'transport', title: '填好去程／回程航班', progress: (arr ? .5 : 0) + (dep ? .5 : 0),
        detail: `${arr ? '✓' : '○'} 去程　${dep ? '✓' : '○'} 回程`, owners: ownersOf('flights') });
    }
    if (nights) {
      const set = new Set((t.hotels || []).map(h => Number(h.night)).filter(n => n >= 0 && n < nights));
      out.push({ key: 'stay', cat: 'stay', title: '每晚住宿都訂好', progress: set.size / nights, detail: `${set.size}/${nights} 晚`, owners: ownersOf('stay') });
    }
    if (days) {
      let filled = 0;
      for (let d = 1; d <= days; d++) if ((t.spots || []).some(s => Number(s.day) === d)) filled++;
      out.push({ key: 'spots', cat: 'other', title: '每天都排好景點', progress: filled / days, detail: `${filled}/${days} 天`, owners: ownersOf('spots') });
    }
    const cands = ((t.hotelPoll || {}).candidates || []);
    if (cands.length) {
      const pollNights = [...new Set(cands.flatMap(c => c.nights || []))];
      const done = pollNights.filter(n => (t.hotels || []).some(h => Number(h.night) === n && h.fromPoll)).length;
      out.push({ key: 'vote', cat: 'stay', title: '飯店投票拍板', progress: pollNights.length ? done / pollNights.length : 0, detail: `${done}/${pollNights.length} 晚已確定`, owners: ownersOf('vote') });
    }
    return out.map(a => Object.assign(a, { auto: true, status: a.progress >= 1 ? 'done' : a.progress > 0 ? 'doing' : 'todo' }));
  }
  function stats() {
    const autos = autoItems(), tasks = prep().tasks;
    const total = autos.length + tasks.length;
    const doneSum = autos.reduce((s, a) => s + a.progress, 0) + tasks.filter(x => x.status === 'done').length;
    const doneCount = autos.filter(a => a.progress >= 1).length + tasks.filter(x => x.status === 'done').length;
    const open = tasks.filter(x => x.status !== 'done');
    const overdue = open.filter(x => dueState(x) === 'over');
    const next = open.filter(x => x.due).sort((a, b) => a.due.localeCompare(b.due))[0]
      || open[0] || autos.find(a => a.progress < 1) || null;
    return { autos, tasks, total, pct: total ? Math.round(doneSum / total * 100) : 0, doneCount, overdue, next };
  }

  // ---------- 主色大卡的進度區塊（給 Itin.renderSummaryBar 用） ----------
  function cardHtml() {
    const s = stats();
    const p = prep();
    const nextTxt = s.next ? `${UI.esc(s.next.title)}${(s.next.owners || []).length ? `（${s.next.owners.map(UI.esc).join('、')}）` : ''}${s.next.auto ? `・${UI.esc(s.next.detail)}` : (s.next.due ? `・${UI.esc(dueText(s.next))}` : '')}` : '';
    const askTpl = canEdit() && !p.templateAsked && !p.tasks.length;
    return `
      <div class="pp-card">
        <div class="pp-head"><span>🧭 行前準備</span><b class="pp-pct">${s.pct}%</b></div>
        <div class="pp-bar"><i data-w="${s.pct}" style="width:0"></i></div>
        <div class="pp-sub">${s.doneCount}/${s.total} 項完成${s.pct >= 100 ? '　🎉 全部準備好了！' : ''}</div>
        ${nextTxt && s.pct < 100 ? `<div class="pp-line">⏰ 下一件：${nextTxt}</div>` : ''}
        ${s.overdue.length ? `<div class="pp-line pp-over">⚠️ 逾期 ${s.overdue.length} 項：${s.overdue.slice(0, 2).map(x => UI.esc(x.title) + ((x.owners || []).length ? `（${x.owners.map(UI.esc).join('、')}）` : '')).join('、')}${s.overdue.length > 2 ? '…' : ''}</div>` : ''}
        ${askTpl ? `<div class="pp-tpl">📋 要帶入${isAbroad() ? '出國' : '國內'}旅遊的建議待辦嗎？<button id="ppTplYes" class="pp-mini">帶入</button><button id="ppTplNo" class="pp-mini ghost">不用</button></div>` : ''}
        <button id="ppToggle" class="pp-toggle">${panelOpen ? '收起清單 ▴' : '看全部 ▾'}</button>
      </div>`;
  }
  function bindCard() {
    const tg = $('ppToggle');
    if (tg) tg.onclick = () => {
      panelOpen = !panelOpen;
      try { localStorage.setItem('mika_prep_open', panelOpen ? '1' : '0'); } catch {}
      tg.textContent = panelOpen ? '收起清單 ▴' : '看全部 ▾';
      renderPanel();
      if (panelOpen) setTimeout(() => { const el = $('prepPanel'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
    };
    const y = $('ppTplYes'); if (y) y.onclick = () => applyTemplate();
    const n = $('ppTplNo'); if (n) n.onclick = () => { prep().templateAsked = true; Store.touch(); refresh(); };
    requestAnimationFrame(() => setTimeout(() => document.querySelectorAll('.pp-bar i').forEach(el => { el.style.width = el.dataset.w + '%'; }), 80));
    renderPanel();
  }
  function refresh() { if (typeof Itin !== 'undefined') Itin.render(); }

  function applyTemplate() {
    const p = prep();
    const drive = trip().transport === 'driving';
    const list = (isAbroad() ? TEMPLATE_ABROAD : TEMPLATE_HOME).filter(x => x[2] !== 'drive' || drive);
    const have = new Set(p.tasks.map(x => x.title));
    let added = 0;
    list.forEach(([cat, title]) => {
      if (have.has(title)) return;
      p.tasks.push(newTask({ cat, title }));
      added++;
    });
    p.templateAsked = true;
    Store.touch({ manual: true });
    panelOpen = true;
    try { localStorage.setItem('mika_prep_open', '1'); } catch {}
    refresh();
    UI.toast(added ? `📋 已帶入 ${added} 項建議待辦，可以指派負責人和截止日` : '建議待辦都已經在清單裡了');
  }
  const newTask = o => Object.assign({ id: Logic.uid(), cat: 'other', title: '', note: '', owners: [], due: '', status: 'todo', cost: 0, expenseId: '', createdBy: me() || '', createdAt: Date.now(), doneBy: '', doneAt: 0 }, o);

  // ---------- 完整清單 ----------
  function renderPanel() {
    const box = $('prepPanel');
    if (!box) return;
    box.classList.toggle('hidden', !panelOpen);
    if (!panelOpen) return;
    const s = stats();
    let items = [...s.autos, ...s.tasks];
    if (onlyMine && me()) items = items.filter(x => (x.owners || []).includes(me()));
    const groups = [];
    if (groupMode === 'cat') {
      CATS.forEach(([k, lb]) => { const g = items.filter(x => x.cat === k); if (g.length) groups.push([lb, g]); });
    } else if (groupMode === 'owner') {
      const names = [...new Set(items.flatMap(x => (x.owners || []).length ? x.owners : ['（還沒指派）']))];
      names.sort((a, b) => (a === '（還沒指派）') - (b === '（還沒指派）') || members().indexOf(a) - members().indexOf(b));
      names.forEach(n => groups.push([n === '（還沒指派）' ? n : `👤 ${n}`, items.filter(x => n === '（還沒指派）' ? !(x.owners || []).length : (x.owners || []).includes(n))]));
    } else {
      const sorted = items.slice().sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.due || '9999').localeCompare(b.due || '9999'));
      groups.push(['依截止日（最急的在上面）', sorted]);
    }
    box.innerHTML = `
      <div class="pp-tools">
        <div class="pp-seg">${[['cat', '分類'], ['owner', '負責人'], ['due', '截止日']].map(([k, lb]) => `<button data-g="${k}" class="${groupMode === k ? 'on' : ''}">${lb}</button>`).join('')}</div>
        ${me() ? `<label class="pp-mine"><input type="checkbox" id="ppMine" ${onlyMine ? 'checked' : ''}> 只看我的</label>` : ''}
      </div>
      ${groups.length ? groups.map(([lb, g]) => `<div class="pp-group"><div class="pp-gtitle">${UI.esc(lb)}</div>${g.map(rowHtml).join('')}</div>`).join('') : '<p class="hint" style="padding:8px 2px">沒有符合的項目</p>'}
      ${canEdit() ? `<div class="pp-actions"><button id="ppAdd" class="btn-primary">➕ 新增待辦</button><button id="ppTpl" class="btn-outline">📋 帶入建議待辦</button></div>` : ''}
      <p class="hint pp-foot">自動項目由系統依行程資料判斷，填好就會自動完成。狀態只有負責人本人或主揪（${UI.esc(boss() || '未設定')}）可以改。</p>`;
    box.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { groupMode = b.dataset.g; renderPanel(); });
    const mine = $('ppMine'); if (mine) mine.onchange = () => { onlyMine = mine.checked; renderPanel(); };
    const add = $('ppAdd'); if (add) add.onclick = () => openForm(null);
    const tpl = $('ppTpl'); if (tpl) tpl.onclick = () => applyTemplate();
    box.querySelectorAll('.pp-row').forEach(el => {
      const autoKey = el.dataset.auto;
      const task = autoKey ? null : prep().tasks.find(x => x.id === el.dataset.id);
      const st = el.querySelector('[data-act="status"]');
      if (st && task) st.onclick = () => cycleStatus(task);
      const more = el.querySelector('[data-act="more"]');
      if (more) more.onclick = () => (task ? moreMenu(task) : autoMenu(autoKey));
      const go = el.querySelector('[data-act="go"]');
      if (go) go.onclick = () => gotoAuto(autoKey);
    });
  }
  function rowHtml(x) {
    if (x.auto) {
      const pct = Math.round(x.progress * 100);
      return `
        <div class="pp-row auto ${x.status}" data-auto="${x.key}">
          <span class="pp-dot ${x.status}" aria-hidden="true">${x.status === 'done' ? '✓' : ''}</span>
          <div class="pp-main" data-act="go" role="button">
            <div class="pp-title">${UI.esc(x.title)} <span class="pp-auto">自動</span></div>
            <div class="pp-meta"><span class="pp-mbar"><i style="width:${pct}%"></i></span>${UI.esc(x.detail)}</div>
          </div>
          <span class="pp-owners">${avatars(x.owners)}</span>
          ${canEdit() ? '<button class="pp-more" data-act="more" aria-label="指派負責人">⋯</button>' : ''}
        </div>`;
    }
    const ds = dueState(x);
    return `
      <div class="pp-row ${x.status}" data-id="${UI.esc(x.id)}">
        <button class="pp-dot ${x.status}" data-act="status" ${canStatus(x) ? '' : 'disabled'} title="${STATUS[x.status]}（點一下切換）">${x.status === 'done' ? '✓' : x.status === 'doing' ? '…' : ''}</button>
        <div class="pp-main">
          <div class="pp-title">${UI.esc(x.title)}${x.status === 'doing' ? ' <span class="pp-doing">進行中</span>' : ''}</div>
          <div class="pp-meta">${[
            x.due ? `<span class="pp-due ${ds}">📅 ${UI.esc(dueText(x))}</span>` : '',
            x.cost ? `<span>💰 ${money(x.cost)}${x.expenseId ? '・已記帳' : ''}</span>` : '',
            x.note ? `<span>📝 ${UI.esc(x.note)}</span>` : ''
          ].filter(Boolean).join('')}</div>
        </div>
        <span class="pp-owners">${avatars(x.owners)}</span>
        ${canEdit() ? '<button class="pp-more" data-act="more" aria-label="更多">⋯</button>' : ''}
      </div>`;
  }

  // ---------- 動作 ----------
  function cycleStatus(task) {
    if (!canStatus(task)) { UI.toast(`只有負責人（${task.owners.join('、')}）或主揪（${boss()}）可以改狀態`); return; }
    setStatus(task, NEXT_STATUS[task.status] || 'doing');
  }
  function setStatus(task, status) {
    task.status = status;
    if (status === 'done') { task.doneBy = me(); task.doneAt = Date.now(); } else { task.doneBy = ''; task.doneAt = 0; }
    Store.touch({ manual: true });
    refresh();
    if (status === 'done') {
      UI.toast(`✅ 完成「${task.title}」`);
      if (Number(task.cost) > 0 && !task.expenseId && typeof Feat !== 'undefined' && Feat.quickExpense) {
        setTimeout(() => UI.confirm('要記到分帳嗎？', `「${task.title}」${money(task.cost)}，要順便記一筆帳嗎？（付款人預設是負責人，可以修改）`, () => {
          Feat.quickExpense({
            item: task.title, amount: Number(task.cost), payer: (task.owners || [])[0] || me(),
            onSaved: id => { task.expenseId = id; Store.touch(); refresh(); }
          });
        }), 250);
      }
    }
  }
  function moreMenu(task) {
    const opts = [];
    if (canStatus(task)) Object.keys(STATUS).filter(k => k !== task.status).forEach(k => opts.push({ label: `改成「${STATUS[k]}」`, value: 's:' + k }));
    opts.push({ label: '✎ 編輯（負責人／截止日／費用／備註）', value: 'edit' });
    if (task.createdBy === me() || isBoss() || !task.createdBy) opts.push({ label: '🗑 刪除這項', value: 'del', danger: true });
    UI.choose(task.title, opts, v => {
      if (v.startsWith('s:')) {
        const st = v.slice(2);
        if (!canStatus(task)) { UI.toast('只有負責人或主揪可以改狀態'); return; }
        setStatus(task, st);
      } else if (v === 'edit') openForm(task);
      else if (v === 'del') UI.confirm('刪除這項待辦？', `確定要刪除「${task.title}」嗎？`, () => {
        prep().tasks = prep().tasks.filter(x => x.id !== task.id);
        Store.touch({ manual: true }); refresh();
      });
    });
  }
  function ownerPicker(selected) {
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    wrap.innerHTML = members().map(m => `<span class="chip${selected.includes(m) ? ' on' : ''}" data-m="${UI.esc(m)}">${UI.esc(m)}</span>`).join('') || '<span class="hint">行程還沒有成員名單</span>';
    wrap.querySelectorAll('.chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
    wrap.value = () => [...wrap.querySelectorAll('.chip.on')].map(c => c.dataset.m);
    return wrap;
  }
  function autoMenu(key) {
    const a = autoItems().find(x => x.key === key);
    if (!a) return;
    const body = document.createElement('div');
    body.innerHTML = `<p class="hint">這是系統自動判斷的項目（${UI.esc(a.detail)}），資料填好就會自動完成。這裡可以指派誰負責。</p><label>負責人（可多選）</label>`;
    const picker = ownerPicker(a.owners);
    body.appendChild(picker);
    UI.modal(`👤 ${a.title}`, body, [{ label: '儲存', primary: true, onClick: () => {
      prep().autoOwners[key] = picker.value();
      Store.touch({ manual: true }); UI.closeModal(); refresh();
    } }, { label: '前往填寫', onClick: () => { UI.closeModal(); gotoAuto(key); } }], { stackActions: true });
  }
  function gotoAuto(key) {
    const t = trip(), days = Store.days();
    if (key === 'stay' || key === 'vote') { App.switchPage('page-hotel'); return; }
    if (key === 'flights') {
      if (Store.isReadonly()) return;
      const hasArr = (t.flights || []).some(f => f.type === 'arrive');
      Flights.openDay(hasArr ? days : 1, () => Itin.render());
      return;
    }
    if (key === 'spots') {
      let d = 1;
      for (; d <= days; d++) if (!(t.spots || []).some(s => Number(s.day) === d)) break;
      const card = document.querySelector(`.day-card[data-day="${Math.min(d, days)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  function openForm(existing) {
    if (!canEdit()) { UI.toast('請先選擇「你是誰」'); return; }
    const t = trip();
    const x = existing ? JSON.parse(JSON.stringify(existing)) : newTask({});
    const body = document.createElement('div');
    body.className = 'flight-form';
    body.innerHTML = `
      <label>項目名稱</label>
      <input id="ppTitle" type="text" maxlength="40" placeholder="例：訂租車" value="${UI.esc(x.title)}">
      <label>分類</label>
      <select id="ppCat">${CATS.map(([k, lb]) => `<option value="${k}" ${x.cat === k ? 'selected' : ''}>${lb}</option>`).join('')}</select>
      <label>負責人（可多選）</label>
      <div id="ppOwnersSlot"></div>
      <div class="row-2">
        <div><label>截止日期</label><input id="ppDue" type="date" value="${UI.esc(x.due || '')}" max="${UI.esc(t.endDate)}"></div>
        <div><label>費用（選填）</label><input id="ppCost" type="number" inputmode="numeric" min="0" step="100" placeholder="NT$" value="${Number(x.cost) > 0 ? Number(x.cost) : ''}"></div>
      </div>
      <label>狀態</label>
      <div class="seg" id="ppStatus">${Object.entries(STATUS).map(([k, lb]) => `<button type="button" data-s="${k}" class="${x.status === k ? 'on' : ''}">${lb}</button>`).join('')}</div>
      <label>備註（選填）</label>
      <input id="ppNote" type="text" maxlength="80" placeholder="例：在官網訂，記得選含保險" value="${UI.esc(x.note || '')}">`;
    const picker = ownerPicker(x.owners || []);
    body.querySelector('#ppOwnersSlot').appendChild(picker);
    let status = x.status;
    body.querySelectorAll('#ppStatus button').forEach(b => b.onclick = () => {
      if (b.dataset.s !== x.status && existing && !canStatus(existing)) { UI.toast('只有負責人或主揪可以改狀態'); return; }
      status = b.dataset.s;
      body.querySelectorAll('#ppStatus button').forEach(o => o.classList.toggle('on', o === b));
    });
    UI.modal(existing ? '✎ 編輯待辦' : '➕ 新增待辦', body, [{
      label: existing ? '儲存' : '加入', primary: true, onClick: () => {
        const title = body.querySelector('#ppTitle').value.trim();
        if (!title) { UI.toast('請輸入項目名稱'); return; }
        x.title = title;
        x.cat = body.querySelector('#ppCat').value;
        x.owners = picker.value();
        x.due = body.querySelector('#ppDue').value || '';
        x.cost = Math.max(0, Math.round(Number(body.querySelector('#ppCost').value) || 0));
        x.note = body.querySelector('#ppNote').value.trim();
        const becameDone = status === 'done' && x.status !== 'done';
        const p = prep();
        const idx = p.tasks.findIndex(o => o.id === x.id);
        if (idx >= 0) p.tasks[idx] = x; else p.tasks.push(x);
        UI.closeModal();
        if (status !== x.status) setStatus(x, status);
        else { Store.touch({ manual: true }); refresh(); UI.toast(existing ? '已更新待辦' : `📋 已新增「${title}」`); }
        if (!becameDone && !panelOpen) { panelOpen = true; renderPanel(); }
      }
    }], { stackActions: true });
    setTimeout(() => { if (!existing) body.querySelector('#ppTitle').focus(); }, 50);
  }

  // ---------- 進場提醒：自己負責、逾期或 3 天內到期 ----------
  function remindMine() {
    if (!canEdit()) return;
    const mine = prep().tasks.filter(x => x.status !== 'done' && (x.owners || []).includes(me()) && dueState(x));
    if (!mine.length) return;
    const over = mine.filter(x => dueState(x) === 'over').length;
    setTimeout(() => UI.toast(`📋 ${me()}，你有 ${mine.length} 件待辦${over ? `（${over} 件已逾期）` : '快到期'}：${mine.slice(0, 2).map(x => x.title).join('、')}${mine.length > 2 ? '…' : ''}`), 1800);
  }

  // ---------- 下載：行前準備清單 PDF ----------
  function printHtml() {
    const t = trip(), s = stats();
    const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const all = [...s.autos, ...s.tasks];
    const rows = CATS.map(([k, lb]) => {
      const g = all.filter(x => x.cat === k);
      if (!g.length) return '';
      return `<section class="group"><h2>${esc(lb)}</h2><table>${g.map(x => `<tr class="${x.status}">
        <td class="st">${x.status === 'done' ? '☑' : x.status === 'doing' ? '◐' : '☐'}</td>
        <td><b>${esc(x.title)}</b>${x.auto ? ` <span class="auto">自動・${esc(x.detail)}</span>` : ''}${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}</td>
        <td class="who">${esc((x.owners || []).join('、'))}</td>
        <td class="due">${x.due ? esc(dueText(x)) : ''}</td>
        <td class="cost">${x.cost ? esc(money(x.cost)) : ''}</td></tr>`).join('')}</table></section>`;
    }).join('');
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=800, initial-scale=1, minimum-scale=0.2, maximum-scale=5, user-scalable=yes"><title>${esc(t.name)} 行前準備清單</title>
<style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:"Microsoft JhengHei",sans-serif;color:#14293A;background:#EEF3F7;margin:0}.sheet{width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:12mm}
@media screen and (max-width:820px){.sheet{width:100%;min-height:0;padding:14px}}
h1{margin:0 0 6px;color:#004D73;font-size:24px}.meta{color:#617587;margin-bottom:10px}
.prog{height:12px;border-radius:99px;background:#DDE7EF;overflow:hidden;margin:4px 0 16px}.prog i{display:block;height:100%;background:#006599}
.group{break-inside:avoid;border:1px solid #DDE7EF;border-radius:8px;padding:10px 12px;margin-bottom:10px}
h2{margin:0 0 6px;color:#006599;font-size:16px}table{width:100%;border-collapse:collapse}td{border-top:1px solid #EEF3F7;padding:7px 6px;vertical-align:top;font-size:14px}
.st{width:24px;color:#006599;font-weight:700}.who{width:110px;color:#617587}.due{width:120px;color:#617587}.cost{width:90px;text-align:right}
tr.done b{color:#94A3B8;text-decoration:line-through}.auto{font-size:12px;color:#006599}.note{font-size:12px;color:#617587;margin-top:2px}
@media print{body{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0}}
</style></head><body><main class="sheet"><h1>${esc(t.name)} 行前準備清單</h1>
<div class="meta">${esc(t.startDate)} ~ ${esc(t.endDate)}｜${esc(countdown())}｜完成 ${s.doneCount}/${s.total} 項（${s.pct}%）</div>
<div class="prog"><i style="width:${s.pct}%"></i></div>${rows || '<p>還沒有任何項目</p>'}</main></body></html>`;
  }

  return { cardHtml, bindCard, renderPanel, remindMine, printHtml, countdown, stats };
})();
