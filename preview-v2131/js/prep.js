// ============================================================
// 🧭 行前準備（v2.1.32 起；v2.1.33 搬到獨立「準備」分頁＋範本定案＋每人各自完成）
// 「準備」分頁：進度大卡（％、下一件、逾期）＋待辦清單；行程頁大卡只留一行迷你進度（點了跳過來）。
// 項目＝系統自動項目（航班、住宿、每天景點、飯店投票：即時計算、按比例）＋自訂待辦。
// 資料：trip.prep = { templateAsked, autoOwners:{flights,stay,spots,vote}, tasks:[{ id, cat, title, note,
//        owners:[名字], due:'YYYY-MM-DD', status:'todo'|'doing'|'done', cost, expenseId,
//        perPerson, checks:{ 名字:true },   // 每人各自完成：每個人勾自己的
//        createdBy, createdAt, doneBy, doneAt }] }
// 權限：有編輯連結都能新增／指派；狀態只有負責人本人或主揪能改（沒指派＝大家都能改）；
//       每人項目只能勾自己的，主揪可以幫任何人勾；唯讀只看。
// ============================================================
const Prep = (() => {
  const $ = id => document.getElementById(id);
  const trip = () => Store.get();
  const CATS = [
    ['transport', '✈️ 交通'], ['stay', '🏨 住宿'], ['docs', '🛂 證件保險'],
    ['money', '💳 金錢通訊'], ['booking', '🎫 預約行前'], ['other', '📌 其他']
  ];
  const STATUS = { todo: '未開始', doing: '進行中', done: '完成' };
  const NEXT_STATUS = { todo: 'doing', doing: 'done', done: 'todo' };
  // 範本：[分類, 名稱, 出發前幾天截止, 條件(drive/transit), 每人各自完成]
  const TEMPLATE_ABROAD = [
    ['transport', '訂機票（含選位、加購行李）', 60, '', true],
    ['transport', '訂高鐵票（往返桃園機場）', 14],
    ['transport', '機場接送包車', 14],
    ['transport', '訂租車', 30, 'drive'],
    ['transport', '駕照日文譯本／國際駕照', 21, 'drive', true],
    ['transport', '交通票券（JR Pass、交通卡）', 14, 'transit'],
    ['docs', '確認護照效期（6 個月以上）', 60, '', true],
    ['docs', '入境登錄（Visit Japan Web 等）', 7, '', true],
    ['docs', '旅平險＋旅遊不便險', 3, '', true],
    ['money', '換匯', 7],
    ['money', '準備海外回饋信用卡', 7],
    ['money', '網卡／eSIM／漫遊', 7, '', true],
    ['money', '下載離線地圖與必備 App', 2, '', true],
    ['booking', '熱門景點門票預約', 30],
    ['booking', '熱門餐廳訂位', 30],
    ['booking', '行前會議（確認行程與分工）', 14],
    ['booking', '出發前一天確認天氣與集合時間', 1]
  ];
  const TEMPLATE_HOME = [
    ['transport', '訂車票（高鐵／台鐵）', 14],
    ['booking', '熱門景點門票預約', 30],
    ['booking', '熱門餐廳訂位', 30],
    ['booking', '行前會議（確認行程與分工）', 14],
    ['booking', '出發前一天確認天氣與集合時間', 1]
  ];
  const AV_COLORS = ['#006599', '#FF8C00', '#0F9D58', '#7C3AED', '#E11D48', '#0891B2', '#B45309', '#4B5563'];

  let groupMode = 'cat', onlyMine = false;
  const openChecks = new Set(); // 展開中的每人勾選列

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
  const canCheck = name => canEdit() && (name === me() || isBoss());
  const avColor = name => { const i = members().indexOf(name); return AV_COLORS[(i < 0 ? name.length : i) % AV_COLORS.length]; };
  const avatars = names => (names || []).map(n => `<span class="pp-av" style="background:${avColor(n)}" title="${UI.esc(n)}">${UI.esc(n.slice(0, 1))}</span>`).join('');
  const money = n => 'NT$' + Number(n).toLocaleString('en-US');

  // ---------- 每人各自完成 ----------
  const whoOf = task => (task.owners && task.owners.length ? task.owners : members());
  const checkedOf = task => whoOf(task).filter(n => task.checks && task.checks[n]);
  function progressOf(task) {
    if (!task.perPerson) return task.status === 'done' ? 1 : 0;
    const who = whoOf(task);
    return who.length ? checkedOf(task).length / who.length : 0;
  }
  // 每人項目的狀態由勾選人數決定（給 PDF／修改紀錄／排序用）
  function syncStatus(task) {
    if (!task.perPerson) return;
    const p = progressOf(task);
    task.status = p >= 1 ? 'done' : p > 0 ? 'doing' : 'todo';
  }

  // ---------- 日期 ----------
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayISO = () => iso(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);
  const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  // 截止＝出發前 N 天；已經過了（或今天）→ 今天＋3 天，但不晚於出發日；旅程已開始就不填
  function dueFor(daysBefore) {
    const start = trip().startDate, today = todayISO();
    if (!start || !daysBefore) return '';
    if (daysBetween(today, start) < 0) return '';
    let due = addDays(start, -daysBefore);
    if (daysBetween(today, due) <= 0) due = addDays(today, 3);
    if (daysBetween(due, start) < 0) due = start;
    return due;
  }
  function dueState(task) { // 'over' | 'soon' | ''
    if (!task.due || progressOf(task) >= 1) return '';
    const left = daysBetween(todayISO(), task.due);
    return left < 0 ? 'over' : left <= 3 ? 'soon' : '';
  }
  function dueText(task) {
    if (!task.due) return '';
    if (progressOf(task) >= 1) return md(task.due);
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
    tasks.forEach(syncStatus);
    const total = autos.length + tasks.length;
    const doneSum = autos.reduce((s, a) => s + a.progress, 0) + tasks.reduce((s, x) => s + progressOf(x), 0);
    const doneCount = autos.filter(a => a.progress >= 1).length + tasks.filter(x => progressOf(x) >= 1).length;
    const open = tasks.filter(x => progressOf(x) < 1);
    const overdue = open.filter(x => dueState(x) === 'over');
    const next = open.filter(x => x.due).sort((a, b) => a.due.localeCompare(b.due))[0]
      || open[0] || autos.find(a => a.progress < 1) || null;
    return { autos, tasks, total, pct: total ? Math.round(doneSum / total * 100) : 0, doneCount, overdue, next };
  }
  const whoTxt = x => {
    if (x.perPerson) { const left = whoOf(x).filter(n => !(x.checks || {})[n]); return left.length ? `（還沒：${left.join('、')}）` : ''; }
    return (x.owners || []).length ? `（${x.owners.join('、')}）` : '';
  };

  // ---------- 行程頁大卡的迷你進度（一行，點了跳到準備分頁） ----------
  function miniHtml() {
    const s = stats();
    const tip = s.overdue.length ? `<span class="pp-mini-over">⚠️ 逾期 ${s.overdue.length}</span>` : '';
    return `<button id="ppMiniLine" class="pp-mini-line" type="button">
      <span>🧭 行前準備</span><span class="pp-mini-bar"><i style="width:${s.pct}%"></i></span><b>${s.pct}%</b>${tip}<span class="pp-mini-go">›</span></button>`;
  }
  function bindMini() {
    const b = $('ppMiniLine');
    if (b) b.onclick = () => App.switchPage('page-prep');
  }

  // ---------- 準備分頁 ----------
  function renderPage() {
    const root = $('prepRoot');
    if (!root || !trip()) return;
    const s = stats();
    const p = prep();
    const nextTxt = s.next ? `${UI.esc(s.next.title)}${UI.esc(whoTxt(s.next))}${s.next.auto ? `・${UI.esc(s.next.detail)}` : (s.next.due ? `・${UI.esc(dueText(s.next))}` : '')}` : '';
    const askTpl = canEdit() && !p.templateAsked && !p.tasks.length;
    let items = [...s.autos, ...s.tasks];
    if (onlyMine && me()) items = items.filter(x => (x.perPerson ? whoOf(x) : (x.owners || [])).includes(me()));
    const groups = [];
    if (groupMode === 'cat') {
      CATS.forEach(([k, lb]) => { const g = items.filter(x => x.cat === k); if (g.length) groups.push([lb, g]); });
    } else if (groupMode === 'owner') {
      const NONE = '（還沒指派）';
      const ownersFor = x => (x.perPerson ? whoOf(x) : (x.owners || []));
      const names = [...new Set(items.flatMap(x => ownersFor(x).length ? ownersFor(x) : [NONE]))];
      names.sort((a, b) => (a === NONE) - (b === NONE) || members().indexOf(a) - members().indexOf(b));
      names.forEach(n => groups.push([n === NONE ? n : `👤 ${n}`, items.filter(x => n === NONE ? !ownersFor(x).length : ownersFor(x).includes(n))]));
    } else {
      const prog = x => (x.auto ? x.progress : progressOf(x));
      const sorted = items.slice().sort((a, b) => (prog(a) >= 1) - (prog(b) >= 1) || (a.due || '9999').localeCompare(b.due || '9999'));
      groups.push(['依截止日（最急的在上面）', sorted]);
    }
    root.innerHTML = `
      <div class="pp-hero">
        <div class="pp-head"><span>${UI.esc(trip().name)}｜${UI.esc(countdown())}</span><b class="pp-pct">${s.pct}%</b></div>
        <div class="pp-bar"><i data-w="${s.pct}" style="width:0"></i></div>
        <div class="pp-sub">${s.doneCount}/${s.total} 項完成${s.pct >= 100 ? '　🎉 全部準備好了！' : ''}</div>
        ${nextTxt && s.pct < 100 ? `<div class="pp-line">⏰ 下一件：${nextTxt}</div>` : ''}
        ${s.overdue.length ? `<div class="pp-line pp-over">⚠️ 逾期 ${s.overdue.length} 項：${s.overdue.slice(0, 2).map(x => UI.esc(x.title + whoTxt(x))).join('、')}${s.overdue.length > 2 ? '…' : ''}</div>` : ''}
        ${askTpl ? `<div class="pp-tpl">📋 要帶入${isAbroad() ? '出國' : '國內'}旅遊的建議待辦嗎？（截止日會依出發日自動算）<span><button id="ppTplYes" class="pp-mini">帶入</button><button id="ppTplNo" class="pp-mini ghost">不用</button></span></div>` : ''}
      </div>
      <div class="prep-panel">
        <div class="pp-tools">
          <div class="pp-seg">${[['cat', '分類'], ['owner', '負責人'], ['due', '截止日']].map(([k, lb]) => `<button data-g="${k}" class="${groupMode === k ? 'on' : ''}">${lb}</button>`).join('')}</div>
          ${me() ? `<label class="pp-mine"><input type="checkbox" id="ppMine" ${onlyMine ? 'checked' : ''}> 只看我的</label>` : ''}
        </div>
        ${groups.length ? groups.map(([lb, g]) => `<div class="pp-group"><div class="pp-gtitle">${UI.esc(lb)}</div>${g.map(rowHtml).join('')}</div>`).join('') : '<p class="hint" style="padding:8px 2px">沒有符合的項目</p>'}
        ${canEdit() ? `<div class="pp-actions"><button id="ppAdd" class="btn-primary">➕ 新增待辦</button><button id="ppTpl" class="btn-outline">📋 帶入建議待辦</button></div>` : ''}
        <p class="hint pp-foot">「自動」項目由系統依行程資料判斷，填好就會完成。一般項目的狀態只有負責人或主揪（${UI.esc(boss() || '未設定')}）可以改；「每人」項目每個人勾自己的。</p>
      </div>`;
    requestAnimationFrame(() => setTimeout(() => root.querySelectorAll('.pp-bar i').forEach(el => { el.style.width = el.dataset.w + '%'; }), 80));
    const y = $('ppTplYes'); if (y) y.onclick = () => applyTemplate();
    const n = $('ppTplNo'); if (n) n.onclick = () => { prep().templateAsked = true; Store.touch(); refresh(); };
    root.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { groupMode = b.dataset.g; renderPage(); });
    const mine = $('ppMine'); if (mine) mine.onchange = () => { onlyMine = mine.checked; renderPage(); };
    const add = $('ppAdd'); if (add) add.onclick = () => openForm(null);
    const tpl = $('ppTpl'); if (tpl) tpl.onclick = () => applyTemplate();
    root.querySelectorAll('.pp-row').forEach(el => {
      const autoKey = el.dataset.auto;
      const task = autoKey ? null : prep().tasks.find(x => x.id === el.dataset.id);
      const st = el.querySelector('[data-act="status"]');
      if (st && task) st.onclick = () => (task.perPerson ? toggleChecks(task) : cycleStatus(task));
      const more = el.querySelector('[data-act="more"]');
      if (more) more.onclick = () => (task ? moreMenu(task) : autoMenu(autoKey));
      const go = el.querySelector('[data-act="go"]');
      if (go) go.onclick = () => (task ? toggleChecks(task) : gotoAuto(autoKey));
    });
    root.querySelectorAll('[data-check]').forEach(b => b.onclick = () => {
      const task = prep().tasks.find(x => x.id === b.dataset.task);
      if (task) toggleCheck(task, b.dataset.check);
    });
  }
  function refresh() {
    if (!$('page-prep').classList.contains('hidden')) renderPage();
    if (typeof Itin !== 'undefined') Itin.render();
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
    const per = x.perPerson;
    const who = whoOf(x), done = checkedOf(x);
    const dotTxt = x.status === 'done' ? '✓' : x.status === 'doing' ? (per ? done.length : '…') : '';
    const open = per && openChecks.has(x.id);
    return `
      <div class="pp-row ${x.status}${per ? ' per' : ''}" data-id="${UI.esc(x.id)}">
        <button class="pp-dot ${x.status}" data-act="status" ${per || canStatus(x) ? '' : 'disabled'} title="${per ? '點開勾選每個人' : STATUS[x.status] + '（點一下切換）'}">${dotTxt}</button>
        <div class="pp-main"${per ? ' data-act="go" role="button"' : ''}>
          <div class="pp-title">${UI.esc(x.title)}${per ? ` <span class="pp-per">每人 ${done.length}/${who.length}</span>` : ''}${!per && x.status === 'doing' ? ' <span class="pp-doing">進行中</span>' : ''}</div>
          <div class="pp-meta">${[
            per ? `<span class="pp-mbar"><i style="width:${who.length ? Math.round(done.length / who.length * 100) : 0}%"></i></span>` : '',
            x.due ? `<span class="pp-due ${ds}">📅 ${UI.esc(dueText(x))}</span>` : '',
            x.cost ? `<span>💰 ${money(x.cost)}${x.expenseId ? '・已記帳' : ''}</span>` : '',
            x.note ? `<span>📝 ${UI.esc(x.note)}</span>` : ''
          ].filter(Boolean).join('')}</div>
        </div>
        <span class="pp-owners">${per ? '' : avatars(x.owners)}</span>
        ${canEdit() ? '<button class="pp-more" data-act="more" aria-label="更多">⋯</button>' : ''}
      </div>
      ${open ? `<div class="pp-checks">${who.map(n => {
        const on = !!(x.checks || {})[n];
        return `<button class="pp-check${on ? ' on' : ''}" data-task="${UI.esc(x.id)}" data-check="${UI.esc(n)}" ${canCheck(n) ? '' : 'disabled'}><span class="pp-av" style="background:${avColor(n)}">${UI.esc(n.slice(0, 1))}</span>${UI.esc(n)}${on ? ' ✓' : ''}</button>`;
      }).join('')}<span class="hint">${canEdit() ? (isBoss() ? '主揪可以幫大家勾' : '點自己的名字勾選') : ''}</span></div>` : ''}`;
  }

  // ---------- 動作 ----------
  function toggleChecks(task) {
    if (openChecks.has(task.id)) openChecks.delete(task.id); else openChecks.add(task.id);
    renderPage();
  }
  function toggleCheck(task, name) {
    if (!canCheck(name)) { UI.toast(`只有${name}本人或主揪（${boss()}）可以勾`); return; }
    task.checks = task.checks || {};
    if (task.checks[name]) delete task.checks[name]; else task.checks[name] = true;
    const before = task.status;
    syncStatus(task);
    if (task.status === 'done' && before !== 'done') { task.doneBy = me(); task.doneAt = Date.now(); }
    if (task.status !== 'done') { task.doneBy = ''; task.doneAt = 0; }
    Store.touch({ manual: true });
    refresh();
    const n = checkedOf(task).length, all = whoOf(task).length;
    UI.toast(task.checks[name] ? `✅ ${name} 完成「${task.title}」（${n}/${all} 人）` : `已取消 ${name} 的勾選`);
  }
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
  function applyTemplate() {
    const p = prep(), t = trip();
    const list = (isAbroad() ? TEMPLATE_ABROAD : TEMPLATE_HOME)
      .filter(([, , , when]) => !when || (when === 'drive' ? t.transport === 'driving' : t.transport === 'transit'));
    const have = new Set(p.tasks.map(x => x.title));
    let added = 0;
    list.forEach(([cat, title, days, , per]) => {
      if (have.has(title)) return;
      p.tasks.push(newTask({ cat, title, due: dueFor(days), perPerson: !!per, owners: per ? members().slice() : [] }));
      added++;
    });
    p.templateAsked = true;
    Store.touch({ manual: true });
    refresh();
    UI.toast(added ? `📋 已帶入 ${added} 項建議待辦，截止日已依出發日自動算好` : '建議待辦都已經在清單裡了');
  }
  const newTask = o => Object.assign({ id: Logic.uid(), cat: 'other', title: '', note: '', owners: [], due: '', status: 'todo', cost: 0, expenseId: '', perPerson: false, checks: {}, createdBy: me() || '', createdAt: Date.now(), doneBy: '', doneAt: 0 }, o);

  function moreMenu(task) {
    const opts = [];
    if (task.perPerson) opts.push({ label: openChecks.has(task.id) ? '收起勾選列表' : '👥 打開勾選列表', value: 'checks' });
    else if (canStatus(task)) Object.keys(STATUS).filter(k => k !== task.status).forEach(k => opts.push({ label: `改成「${STATUS[k]}」`, value: 's:' + k }));
    opts.push({ label: '✎ 編輯（負責人／截止日／費用／備註）', value: 'edit' });
    if (task.createdBy === me() || isBoss() || !task.createdBy) opts.push({ label: '🗑 刪除這項', value: 'del', danger: true });
    UI.choose(task.title, opts, v => {
      if (v === 'checks') toggleChecks(task);
      else if (v.startsWith('s:')) {
        if (!canStatus(task)) { UI.toast('只有負責人或主揪可以改狀態'); return; }
        setStatus(task, v.slice(2));
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
      App.switchPage('page-trip');
      if (Store.isReadonly()) return;
      const hasArr = (t.flights || []).some(f => f.type === 'arrive');
      Flights.openDay(hasArr ? days : 1, () => Itin.render());
      return;
    }
    if (key === 'spots') {
      let d = 1;
      for (; d <= days; d++) if (!(t.spots || []).some(s => Number(s.day) === d)) break;
      App.switchPage('page-trip');
      if (Itin.showDay) Itin.showDay(Math.min(d, days));
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
      <label class="check-row" style="margin:8px 0"><input type="checkbox" id="ppPer" ${x.perPerson ? 'checked' : ''}> 👥 每人各自完成（例如護照、網卡，每個人勾自己的）</label>
      <label id="ppOwnersLabel">${x.perPerson ? '需要完成的人' : '負責人（可多選）'}</label>
      <div id="ppOwnersSlot"></div>
      <div class="row-2">
        <div><label>截止日期</label><input id="ppDue" type="date" value="${UI.esc(x.due || '')}" max="${UI.esc(t.endDate)}"></div>
        <div><label>費用（選填）</label><input id="ppCost" type="number" inputmode="numeric" min="0" step="100" placeholder="NT$" value="${Number(x.cost) > 0 ? Number(x.cost) : ''}"></div>
      </div>
      <div id="ppStatusWrap" class="${x.perPerson ? 'hidden' : ''}">
        <label>狀態</label>
        <div class="seg" id="ppStatus">${Object.entries(STATUS).map(([k, lb]) => `<button type="button" data-s="${k}" class="${x.status === k ? 'on' : ''}">${lb}</button>`).join('')}</div>
      </div>
      <label>備註（選填）</label>
      <input id="ppNote" type="text" maxlength="80" placeholder="例：在官網訂，記得選含保險" value="${UI.esc(x.note || '')}">`;
    const picker = ownerPicker(x.perPerson && !(x.owners || []).length ? members() : (x.owners || []));
    body.querySelector('#ppOwnersSlot').appendChild(picker);
    const perBox = body.querySelector('#ppPer');
    perBox.onchange = () => {
      body.querySelector('#ppStatusWrap').classList.toggle('hidden', perBox.checked);
      body.querySelector('#ppOwnersLabel').textContent = perBox.checked ? '需要完成的人' : '負責人（可多選）';
      if (perBox.checked && !picker.value().length) picker.querySelectorAll('.chip').forEach(c => c.classList.add('on'));
    };
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
        x.perPerson = perBox.checked;
        x.owners = picker.value();
        x.checks = x.checks || {};
        x.due = body.querySelector('#ppDue').value || '';
        x.cost = Math.max(0, Math.round(Number(body.querySelector('#ppCost').value) || 0));
        x.note = body.querySelector('#ppNote').value.trim();
        const p = prep();
        const idx = p.tasks.findIndex(o => o.id === x.id);
        if (idx >= 0) p.tasks[idx] = x; else p.tasks.push(x);
        UI.closeModal();
        if (x.perPerson) { syncStatus(x); Store.touch({ manual: true }); refresh(); UI.toast(existing ? '已更新待辦' : `📋 已新增「${title}」`); }
        else if (status !== x.status) setStatus(x, status);
        else { Store.touch({ manual: true }); refresh(); UI.toast(existing ? '已更新待辦' : `📋 已新增「${title}」`); }
      }
    }], { stackActions: true });
    setTimeout(() => { if (!existing) body.querySelector('#ppTitle').focus(); }, 50);
  }

  // ---------- 進場提醒：自己負責（或自己還沒勾）、逾期或 3 天內到期 ----------
  function remindMine() {
    if (!canEdit()) return;
    const mine = prep().tasks.filter(x => dueState(x) && (x.perPerson
      ? whoOf(x).includes(me()) && !(x.checks || {})[me()]
      : x.status !== 'done' && (x.owners || []).includes(me())));
    if (!mine.length) return;
    const over = mine.filter(x => dueState(x) === 'over').length;
    setTimeout(() => UI.toast(`📋 ${me()}，你有 ${mine.length} 件待辦${over ? `（${over} 件已逾期）` : '快到期'}：${mine.slice(0, 2).map(x => x.title).join('、')}${mine.length > 2 ? '…' : ''}`), 1800);
  }

  // ---------- 下載：行前準備清單 PDF ----------
  function printHtml() {
    const t = trip(), s = stats();
    const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const all = [...s.autos, ...s.tasks];
    const whoCell = x => {
      if (!x.perPerson) return esc((x.owners || []).join('、'));
      const done = checkedOf(x), left = whoOf(x).filter(n => !done.includes(n));
      return `${done.length ? `✓ ${esc(done.join('、'))}` : ''}${done.length && left.length ? '<br>' : ''}${left.length ? `<span class="left">未：${esc(left.join('、'))}</span>` : ''}`;
    };
    const rows = CATS.map(([k, lb]) => {
      const g = all.filter(x => x.cat === k);
      if (!g.length) return '';
      return `<section class="group"><h2>${esc(lb)}</h2><table>${g.map(x => `<tr class="${x.status}">
        <td class="st">${x.status === 'done' ? '☑' : x.status === 'doing' ? '◐' : '☐'}</td>
        <td><b>${esc(x.title)}</b>${x.auto ? ` <span class="auto">自動・${esc(x.detail)}</span>` : ''}${x.perPerson ? ` <span class="auto">每人 ${checkedOf(x).length}/${whoOf(x).length}</span>` : ''}${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}</td>
        <td class="who">${whoCell(x)}</td>
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
.st{width:24px;color:#006599;font-weight:700}.who{width:150px;color:#617587}.who .left{color:#D93025}.due{width:120px;color:#617587}.cost{width:90px;text-align:right}
tr.done b{color:#94A3B8;text-decoration:line-through}.auto{font-size:12px;color:#006599}.note{font-size:12px;color:#617587;margin-top:2px}
@media print{body{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0}}
</style></head><body><main class="sheet"><h1>${esc(t.name)} 行前準備清單</h1>
<div class="meta">${esc(t.startDate)} ~ ${esc(t.endDate)}｜${esc(countdown())}｜完成 ${s.doneCount}/${s.total} 項（${s.pct}%）</div>
<div class="prog"><i style="width:${s.pct}%"></i></div>${rows || '<p>還沒有任何項目</p>'}</main></body></html>`;
  }

  return { renderPage, miniHtml, bindMini, remindMine, printHtml, countdown, stats };
})();
