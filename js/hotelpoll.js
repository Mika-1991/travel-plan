// ============================================================
// 🏨 飯店投票（v2.1.30）
// 大家把想住的飯店加成「候選」（一間可以包好幾晚），每一晚每人一票；
// 主揪（建立行程的人）拍板「確定入住」→ 寫進行程的住宿並標「✅ 已確定」。
// 資料：trip.hotelPoll = { owner, candidates:[{ id, place, nights:[0-based], must, price, link, note,
//        addedBy, addedAt, votes:{ '<night>': ['名字',…] } }] }
// 「已確定」不另外存旗標，而是看 trip.hotels 裡有沒有 fromPoll === 候選 id（行程頁手動換掉就自動不算）。
// 投票寫成「投票操作」交給 Store：多人同時投票撞版本時，Store 會自動讀最新版、重放投票再存（不跳衝突視窗）。
// ============================================================
const HotelPoll = (() => {
  const $ = id => document.getElementById(id);
  const trip = () => Store.get();
  const poll = () => {
    const t = trip();
    if (!t.hotelPoll) t.hotelPoll = { owner: '', candidates: [] };
    if (!Array.isArray(t.hotelPoll.candidates)) t.hotelPoll.candidates = [];
    return t.hotelPoll;
  };
  const nightsCount = () => Math.max(Store.days() - 1, 0);
  const nightLabel = n => {
    const iso = Store.dateOfDay(n + 1) || '';
    return `第 ${n + 1} 晚${iso ? `（${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}）` : ''}`;
  };
  const nightsText = ns => {
    const s = [...ns].sort((a, b) => a - b);
    if (!s.length) return '';
    const contiguous = s.every((n, i) => i === 0 || n === s[i - 1] + 1);
    return contiguous && s.length > 1 ? `第 ${s[0] + 1}～${s[s.length - 1] + 1} 晚` : s.map(n => `第 ${n + 1} 晚`).join('、');
  };
  const me = () => Store.getEditor();
  const owner = () => poll().owner || ((trip().members || [])[0] || '');
  const isOwner = () => !Store.isReadonly() && !!me() && me() === owner();
  const canVote = () => !Store.isReadonly() && !!me();
  const isConfirmed = c => (trip().hotels || []).some(h => h.fromPoll === c.id);
  const confirmedNightOf = n => (trip().hotels || []).find(h => Number(h.night) === n && h.fromPoll);
  const votesOf = (c, n) => (c.votes && c.votes[n]) || [];

  // ---------- 投票操作（純資料，也給 Store 重放用） ----------
  // op = { cand, night, voter, on:true/false }；同一人同一晚只能投一間 → 投新的會從其他候選移走
  function applyVote(t, op) {
    const p = t.hotelPoll; if (!p || !Array.isArray(p.candidates)) return;
    const target = p.candidates.find(c => c.id === op.cand);
    if (!target) return;
    const key = String(op.night);
    p.candidates.forEach(c => {
      if (!c.votes) c.votes = {};
      const list = (c.votes[key] || []).filter(v => v !== op.voter);
      if (c === target && op.on) list.push(op.voter);
      if (list.length) c.votes[key] = list; else delete c.votes[key];
    });
  }
  function vote(c, on) {
    if (!canVote()) { UI.toast('請先選擇「你是誰」才能投票'); return; }
    const locked = c.nights.filter(n => confirmedNightOf(n));
    if (locked.length) { UI.toast(`${nightsText(locked)}已經確定住宿，不能再投票`); return; }
    const ops = c.nights.map(n => ({ cand: c.id, night: n, voter: me(), on }));
    ops.forEach(op => applyVote(trip(), op));
    Store.touch({ voteOps: ops });
    render();
    UI.toast(on ? `👍 已投給「${c.place.name}」（${nightsText(c.nights)}）` : '已取消投票');
  }

  // ---------- 主揪：確定入住／取消確定／必去 ----------
  function confirmStay(c) {
    if (!isOwner()) { UI.toast(`只有主揪（${owner() || '建立行程的人'}）可以確定住宿`); return; }
    const t = trip();
    const clash = c.nights.map(n => Store.hotelOfNight(n)).filter(h => h && h.fromPoll !== c.id);
    const doIt = () => {
      t.hotels = (t.hotels || []).filter(h => !c.nights.includes(Number(h.night)));
      c.nights.forEach(n => t.hotels.push(Object.assign({}, c.place, {
        night: n, note: [c.price ? `價格：${c.price}` : '', c.note].filter(Boolean).join('｜'),
        confirmed: true, fromPoll: c.id
      })));
      t.hotels.sort((a, b) => a.night - b.night);
      c.nights.forEach(n => { delete t.legsByDay[n + 1]; delete t.legsByDay[n + 2]; });
      Store.touch({ manual: true });
      render(); Itin.render();
      UI.toast(`✅ 已確定 ${nightsText(c.nights)} 住「${c.place.name}」，行程已更新`);
    };
    if (clash.length) {
      UI.confirm('要取代目前的住宿嗎？',
        `${clash.map(h => `${nightLabel(Number(h.night))}目前是「${h.name}」`).join('\n')}\n\n確定後會改成「${c.place.name}」。（可用「上一步」復原）`, doIt);
    } else doIt();
  }
  function unconfirm(c) {
    if (!isOwner()) return;
    UI.confirm('取消確定？', `會把行程裡${nightsText(c.nights)}的「${c.place.name}」移除（票數保留）。`, () => {
      const t = trip();
      t.hotels = (t.hotels || []).filter(h => h.fromPoll !== c.id);
      c.nights.forEach(n => { delete t.legsByDay[n + 1]; delete t.legsByDay[n + 2]; });
      Store.touch({ manual: true });
      render(); Itin.render();
      UI.toast('已取消確定');
    });
  }
  function toggleMust(c) {
    if (!isOwner()) return;
    c.must = !c.must;
    Store.touch({ manual: true });
    render();
    UI.toast(c.must ? `⭐ 「${c.place.name}」設為必去飯店` : '已取消必去');
  }
  function removeCand(c) {
    if (!(isOwner() || c.addedBy === me())) { UI.toast('只有主揪或加入的人可以刪除'); return; }
    if (isConfirmed(c)) { UI.toast('已確定的飯店要先「取消確定」才能刪除'); return; }
    UI.confirm('刪除候選？', `確定要刪除「${c.place.name}」（${nightsText(c.nights)}）嗎？票數也會一起刪除。`, () => {
      poll().candidates = poll().candidates.filter(x => x.id !== c.id);
      Store.touch({ manual: true });
      render();
    });
  }
  function changeOwner() {
    if (!isOwner()) { UI.toast(`只有目前的主揪（${owner()}）可以更換主揪`); return; }
    const members = (trip().members || []).filter(Boolean);
    UI.choose('👑 換誰當主揪？（主揪可以確定住宿、設定必去）', members.map(m => ({ label: (m === owner() ? '✓ ' : '') + m, value: m })), v => {
      poll().owner = v;
      Store.touch({ manual: true });
      render();
      UI.toast(`👑 主揪改為 ${v}`);
    });
  }

  // ---------- 新增／編輯候選 ----------
  function openForm(existing) {
    if (!canVote()) { UI.toast('請先選擇「你是誰」'); return; }
    const n = nightsCount();
    if (!n) { UI.toast('一日遊不需要住宿'); return; }
    const c = existing ? JSON.parse(JSON.stringify(existing)) : { id: Logic.uid(), place: null, nights: [], must: false, price: '', link: '', note: '', addedBy: me(), addedAt: Date.now(), votes: {} };
    const body = document.createElement('div');
    body.className = 'flight-form';
    body.innerHTML = `
      <div class="ap-box">
        <label>🏨 飯店</label>
        <div class="ap-chosen">${c.place ? `✅ ${UI.esc(c.place.name)}<div class="hint">${UI.esc(c.place.address || '')}</div>` : '<span class="hint">還沒選擇飯店</span>'}</div>
        <div style="display:flex;gap:8px"><input id="hpQ" type="text" placeholder="例：青森 JR 飯店" style="margin-bottom:0"><button id="hpSearch" class="btn-small" type="button">搜尋</button></div>
        <div id="hpResults" class="stack" style="margin-top:6px"></div>
      </div>
      <label>住哪幾晚？（可複選）</label>
      <div class="hp-nights">${Array.from({ length: n }, (_, i) => `<label class="copy-item"><input type="checkbox" value="${i}" ${c.nights.includes(i) ? 'checked' : ''}>${UI.esc(nightLabel(i))}</label>`).join('')}</div>
      <label>價格（選填）</label>
      <input id="hpPrice" type="text" maxlength="40" placeholder="例：每晚約 NT$3,200（4 人）" value="${UI.esc(c.price || '')}">
      <label>訂房連結（選填）</label>
      <input id="hpLink" type="url" maxlength="300" placeholder="例：Booking／Agoda 的網址" value="${UI.esc(c.link || '')}">
      <label>備註（選填）</label>
      <input id="hpNote" type="text" maxlength="60" placeholder="例：有大浴場、離車站 3 分鐘" value="${UI.esc(c.note || '')}">`;
    const results = body.querySelector('#hpResults');
    const search = async () => {
      const q = body.querySelector('#hpQ').value.trim();
      if (!q) { UI.toast('請輸入飯店名稱'); return; }
      results.innerHTML = '<p class="hint">搜尋中…</p>';
      try {
        const list = await Api.searchPlaces(q, 'hotel');
        results.innerHTML = list.length ? '' : '<p class="hint">找不到，換個關鍵字試試</p>';
        list.slice(0, 5).forEach(p => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'btn-outline ap-item';
          b.innerHTML = `${UI.esc(p.name)}${p.rating ? ` ⭐${p.rating}` : ''}<div class="hint">${UI.esc(p.address || '')}</div>`;
          b.onclick = () => {
            c.place = { name: p.name, address: p.address || '', lat: p.lat, lng: p.lng, placeId: p.placeId || '', photo: p.photo || '', rating: p.rating || 0 };
            body.querySelector('.ap-chosen').innerHTML = `✅ ${UI.esc(p.name)}<div class="hint">${UI.esc(p.address || '')}</div>`;
            results.innerHTML = '';
          };
          results.appendChild(b);
        });
      } catch (e) { results.innerHTML = ''; UI.alert('搜尋失敗', UI.friendlyError(e)); }
    };
    body.querySelector('#hpSearch').onclick = search;
    body.querySelector('#hpQ').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    UI.modal(existing ? '✎ 編輯候選飯店' : '➕ 加入候選飯店', body, [{
      label: existing ? '儲存' : '加入候選', primary: true, onClick: () => {
        c.nights = [...body.querySelectorAll('.hp-nights input:checked')].map(x => Number(x.value)).sort((a, b) => a - b);
        c.price = body.querySelector('#hpPrice').value.trim();
        c.link = body.querySelector('#hpLink').value.trim();
        c.note = body.querySelector('#hpNote').value.trim();
        if (!c.place) { UI.toast('請搜尋並選擇飯店'); return; }
        if (!c.nights.length) { UI.toast('請勾選要住哪幾晚'); return; }
        if (c.link && !/^https?:\/\//i.test(c.link)) c.link = 'https://' + c.link;
        // 晚數改了 → 不再涵蓋的晚，票要拿掉
        Object.keys(c.votes || {}).forEach(k => { if (!c.nights.includes(Number(k))) delete c.votes[k]; });
        const p = poll();
        p.candidates = p.candidates.filter(x => x.id !== c.id);
        p.candidates.push(c);
        Store.touch({ manual: true });
        UI.closeModal();
        render();
        UI.toast(existing ? '已更新候選飯店' : `🏨 已加入候選「${c.place.name}」，大家可以開始投票了`);
      }
    }], { stackActions: true });
  }

  // ---------- 畫面 ----------
  function cardHtml(c, n, maxVotes, totalVoters) {
    const v = votesOf(c, n);
    const mine = v.includes(me());
    const confirmedHere = isConfirmed(c) && confirmedNightOf(n) && confirmedNightOf(n).fromPoll === c.id;
    const lockedNight = !!confirmedNightOf(n);
    const leading = !lockedNight && v.length > 0 && v.length === maxVotes;
    const pct = totalVoters ? Math.round(v.length / totalVoters * 100) : 0;
    const linkHref = c.link || UI.hotelPriceLink(c.place.name);
    return `
      <div class="hp-card${confirmedHere ? ' hp-confirmed' : ''}" data-cand="${UI.esc(c.id)}">
        <div class="hp-top">
          ${c.place.photo ? `<img class="thumb hp-photo" src="${UI.esc(c.place.photo)}" alt="">` : '<span class="hp-photo hp-noimg">🏨</span>'}
          <div class="hp-info">
            <div class="hp-name">${c.must ? '<span class="hp-must">⭐ 必去</span>' : ''}${UI.esc(c.place.name)}
              ${confirmedHere ? '<span class="hp-tag ok">✅ 已確定</span>' : (leading ? `<span class="hp-tag lead">${v.length === maxVotes && countAtMax(n) > 1 ? '平手' : '目前領先'}</span>` : '')}</div>
            <div class="hint">${UI.esc(nightsText(c.nights))}${c.place.rating ? `｜⭐ ${c.place.rating}` : ''}${c.price ? `｜${UI.esc(c.price)}` : ''}</div>
            ${c.note ? `<div class="hint">📝 ${UI.esc(c.note)}</div>` : ''}
            <div class="hint">由 ${UI.esc(c.addedBy || '（未具名）')} 加入</div>
          </div>
        </div>
        <div class="hp-bar"><i style="width:${pct}%"></i></div>
        <div class="hp-voters">${v.length} 票${v.length ? `：${v.map(UI.esc).join('、')}` : ''}</div>
        <div class="hp-actions">
          ${canVote() && !lockedNight ? `<button class="${mine ? 'btn-primary' : 'btn-outline'}" data-act="vote">${mine ? '✓ 已投這間' : '👍 投這間'}</button>` : ''}
          <a class="btn-outline hp-link" href="${UI.esc(linkHref)}" target="_blank" rel="noopener">🔗 ${c.link ? '訂房' : '查房價'}</a>
          <a class="btn-outline hp-link" href="${UI.esc(UI.gmapLink(c.place))}" target="_blank" rel="noopener">📍</a>
          ${canVote() ? '<button class="btn-outline hp-more" data-act="more">⋯</button>' : ''}
        </div>
      </div>`;
  }
  function countAtMax(n) {
    const list = poll().candidates.filter(c => c.nights.includes(n));
    const max = Math.max(0, ...list.map(c => votesOf(c, n).length));
    return list.filter(c => votesOf(c, n).length === max).length;
  }
  function render() {
    const root = $('hotelPollRoot');
    if (!root || !trip()) return;
    const p = poll();
    const n = nightsCount();
    const ownerName = owner();
    const members = (trip().members || []).filter(Boolean);
    let html = `
      <div class="hp-intro">
        <p class="hint">把想住的飯店加進候選，<b>每一晚每人一票</b>。主揪確定後會自動放進行程，並標上「✅ 已確定」。</p>
        <div class="hp-owner">👑 主揪：<b>${UI.esc(ownerName || '（尚未設定）')}</b>${isOwner() ? ' <button id="hpOwnerBtn" class="btn-ghost">更換</button>' : ''}
          ${canVote() ? `｜你是 <b>${UI.esc(me())}</b>` : ''}</div>
        ${canVote() ? '<button id="hpAddBtn" class="btn-primary" style="width:100%;margin-top:8px">➕ 加入候選飯店</button>' : (Store.isReadonly() ? '<p class="hint">👀 唯讀模式：可以看候選和票數，投票請用編輯連結。</p>' : '')}
      </div>`;
    if (!n) html += '<p class="hint" style="padding:12px">這是一日遊，不需要住宿。</p>';
    for (let night = 0; night < n; night++) {
      const locked = confirmedNightOf(night);
      // 排序：這晚已確定的那間 → ⭐ 必去 → 票數多的
      const list = p.candidates.filter(c => c.nights.includes(night))
        .sort((a, b) => ((locked && b.id === locked.fromPoll) - (locked && a.id === locked.fromPoll)) || (b.must - a.must) || (votesOf(b, night).length - votesOf(a, night).length));
      const maxVotes = Math.max(0, ...list.map(c => votesOf(c, night).length));
      const voted = new Set(list.flatMap(c => votesOf(c, night)));
      const notYet = members.filter(m => !voted.has(m));
      html += `
        <section class="hp-night">
          <div class="hp-night-head"><span class="hp-night-title">${UI.esc(nightLabel(night))}</span>
            ${locked ? `<span class="hp-tag ok">✅ 已確定：${UI.esc(locked.name)}</span>` : `<span class="hint">${voted.size} 人已投${notYet.length && list.length ? `｜還沒投：${notYet.map(UI.esc).join('、')}` : ''}</span>`}</div>
          ${list.length ? list.map(c => cardHtml(c, night, maxVotes, Math.max(members.length, voted.size, 1))).join('') : '<p class="hint hp-empty">這晚還沒有候選飯店</p>'}
        </section>`;
    }
    root.innerHTML = html;
    const ob = $('hpOwnerBtn'); if (ob) ob.onclick = changeOwner;
    const ab = $('hpAddBtn'); if (ab) ab.onclick = () => openForm(null);
    root.querySelectorAll('.hp-card').forEach(el => {
      const c = p.candidates.find(x => x.id === el.dataset.cand);
      const vb = el.querySelector('[data-act="vote"]');
      // 已在這間涵蓋的每一晚都投了 → 再按一次＝取消；否則＝投這間
      if (vb) vb.onclick = () => vote(c, !c.nights.every(nn => votesOf(c, nn).includes(me())));
      const mb = el.querySelector('[data-act="more"]');
      if (mb) mb.onclick = () => moreMenu(c);
      const ph = el.querySelector('img.hp-photo');
      if (ph) ph.onclick = () => UI.photoZoom(c.place.photo, c.place.name);
    });
  }
  function moreMenu(c) {
    const opts = [];
    if (isOwner()) {
      opts.push(isConfirmed(c) ? { label: '↩ 取消確定（從行程移除）', value: 'unconfirm' } : { label: '✅ 確定入住（加入行程）', value: 'confirm' });
      opts.push({ label: c.must ? '☆ 取消必去' : '⭐ 設為必去飯店', value: 'must' });
    }
    if (isOwner() || c.addedBy === me()) {
      opts.push({ label: '✎ 編輯（晚數／價格／連結／備註）', value: 'edit' });
      opts.push({ label: '🗑 刪除候選', value: 'del', danger: true });
    }
    if (!opts.length) { UI.toast(`確定住宿請找主揪（${owner()}）`); return; }
    UI.choose(c.place.name, opts, v => {
      if (v === 'confirm') confirmStay(c);
      else if (v === 'unconfirm') unconfirm(c);
      else if (v === 'must') toggleMust(c);
      else if (v === 'edit') openForm(c);
      else if (v === 'del') removeCand(c);
    });
  }

  return { render, applyVote, isConfirmedHotel: h => !!(h && h.confirmed && h.fromPoll) };
})();
