// ============================================================
// 🗳️ 投票分頁 ─ 🏨 飯店投票（v2.1.30 起；v2.1.31 加預算區間、過半、主揪推薦、官網、外觀照）
// 大家把想住的飯店加成「候選」（一間可以包好幾晚），每一晚每人一票；
// 主揪拍板「確定入住」→ 寫進行程的住宿並標「✅ 已確定」。
// 資料：trip.hotelPoll = { owner, budget:{min,max}, budgetByNight:{ '<night>':{min,max} },
//        candidates:[{ id, place, nights:[0-based], must, rec, priceNum, price(舊版文字), link, website,
//        photos:[url,url], photoIdx:[i,i], note, addedBy, addedAt, votes:{ '<night>': ['名字',…] } }] }
// 「已確定」不另外存旗標，而是看 trip.hotels 裡有沒有 fromPoll === 候選 id（行程頁手動換掉就自動不算）。
// 投票寫成「投票操作」交給 Store：多人同時投票撞版本時，Store 會自動讀最新版、重放投票再存（不跳衝突視窗）。
// 之後要加「餐廳／景點投票」：在 KINDS 加一筆、各自一個 render 函式即可。
// ============================================================
const HotelPoll = (() => {
  const $ = id => document.getElementById(id);
  const trip = () => Store.get();
  const SUGGEST_PER_NIGHT = 3;
  const KINDS = [{ key: 'hotel', label: '🏨 飯店' }]; // 投票小分頁（之後擴充）
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
  const money = n => 'NT$' + Number(n).toLocaleString('en-US');
  const members = () => (trip().members || []).filter(Boolean);
  const me = () => Store.getEditor();
  const ownerSet = () => !!poll().owner;
  const owner = () => poll().owner || (members()[0] || '');
  const isOwner = () => !Store.isReadonly() && !!me() && me() === owner();
  const canVote = () => !Store.isReadonly() && !!me();
  const isConfirmed = c => (trip().hotels || []).some(h => h.fromPoll === c.id);
  const confirmedNightOf = n => (trip().hotels || []).find(h => Number(h.night) === n && h.fromPoll);
  const votesOf = (c, n) => (c.votes && c.votes[n]) || [];
  const isMajority = count => { const m = members().length; return m > 0 && count > m / 2; };

  // ---------- 價格與預算 ----------
  // 新版存數字 priceNum（每晚）；舊版只有文字 price → 從文字抓第一個像價格的數字
  function priceOf(c) {
    if (Number(c.priceNum) > 0) return Number(c.priceNum);
    const m = String(c.price || '').replace(/,/g, '').match(/\d{3,7}/);
    return m ? Number(m[0]) : 0;
  }
  function budgetOf(n) {
    const p = poll();
    const own = p.budgetByNight && p.budgetByNight[n];
    const b = own && (own.min || own.max) ? own : p.budget;
    return b && (b.min || b.max) ? { min: Number(b.min) || 0, max: Number(b.max) || 0, perNight: own === b } : null;
  }
  function budgetState(c, n) { // 'over' | 'under' | ''
    const price = priceOf(c), b = budgetOf(n);
    if (!price || !b) return '';
    if (b.max && price > b.max) return 'over';
    if (b.min && price < b.min) return 'under';
    return '';
  }
  const budgetText = b => b.min && b.max ? `${money(b.min)}～${money(b.max)}` : b.max ? `${money(b.max)} 以內` : `${money(b.min)} 以上`;

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
  function vote(c, on, btn) {
    if (!canVote()) { UI.toast('請先選擇「你是誰」才能投票'); return; }
    const locked = c.nights.filter(n => confirmedNightOf(n));
    if (locked.length) { UI.toast(`${nightsText(locked)}已經確定住宿，不能再投票`); return; }
    const ops = c.nights.map(n => ({ cand: c.id, night: n, voter: me(), on }));
    ops.forEach(op => applyVote(trip(), op));
    Store.touch({ voteOps: ops });
    if (on && btn) burst(btn);
    render({ keepScroll: true, animateBars: true });
    UI.toast(on ? `👍 已投給「${c.place.name}」（${nightsText(c.nights)}）` : '已取消投票');
  }
  // 按讚動畫：👍 從按鈕往上飄
  function burst(btn) {
    try {
      const r = btn.getBoundingClientRect();
      const f = document.createElement('span');
      f.className = 'vote-burst'; f.textContent = '👍';
      f.style.left = (r.left + r.width / 2 - 10) + 'px'; f.style.top = (r.top - 4) + 'px';
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 900);
    } catch {}
  }

  // ---------- 主揪：確定入住／取消確定／必去／推薦／預算 ----------
  function confirmStay(c) {
    if (!isOwner()) { UI.toast(`只有主揪（${owner() || '建立行程的人'}）可以確定住宿`); return; }
    const t = trip();
    const clash = c.nights.map(n => Store.hotelOfNight(n)).filter(h => h && h.fromPoll !== c.id);
    const doIt = () => {
      t.hotels = (t.hotels || []).filter(h => !c.nights.includes(Number(h.night)));
      const price = priceOf(c);
      c.nights.forEach(n => t.hotels.push(Object.assign({}, c.place, {
        photo: (c.photos && c.photos[0]) || c.place.photo || '',
        night: n, note: [price ? `每晚 ${money(price)}` : (c.price ? `價格：${c.price}` : ''), c.note].filter(Boolean).join('｜'),
        confirmed: true, fromPoll: c.id
      })));
      t.hotels.sort((a, b) => a.night - b.night);
      c.nights.forEach(n => { delete t.legsByDay[n + 1]; delete t.legsByDay[n + 2]; });
      Store.touch({ manual: true });
      render({ keepScroll: true }); Itin.render();
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
      render({ keepScroll: true }); Itin.render();
      UI.toast('已取消確定');
    });
  }
  function toggleFlag(c, key, onMsg, offMsg) {
    if (!isOwner()) return;
    c[key] = !c[key];
    Store.touch({ manual: true });
    render({ keepScroll: true });
    UI.toast(c[key] ? onMsg : offMsg);
  }
  function removeCand(c) {
    if (!(isOwner() || c.addedBy === me())) { UI.toast('只有主揪或加入的人可以刪除'); return; }
    if (isConfirmed(c)) { UI.toast('已確定的飯店要先「取消確定」才能刪除'); return; }
    UI.confirm('刪除候選？', `確定要刪除「${c.place.name}」（${nightsText(c.nights)}）嗎？票數也會一起刪除。`, () => {
      poll().candidates = poll().candidates.filter(x => x.id !== c.id);
      Store.touch({ manual: true });
      render({ keepScroll: true });
    });
  }
  // 主揪還沒正式設定（舊行程）→ 有編輯連結的人都可以設定一次；設定後只有主揪本人能換
  function changeOwner() {
    if (ownerSet() && !isOwner()) { UI.toast(`只有目前的主揪（${owner()}）可以更換主揪`); return; }
    UI.choose('👑 誰是主揪？（主揪可以確定住宿、設定必去／推薦／預算）', members().map(m => ({ label: (m === owner() ? '✓ ' : '') + m, value: m })), v => {
      poll().owner = v;
      Store.touch({ manual: true });
      render({ keepScroll: true });
      UI.toast(`👑 主揪是 ${v}`);
    });
  }
  function openBudget() {
    if (!isOwner()) { UI.toast(`預算由主揪（${owner()}）設定`); return; }
    const p = poll(), n = nightsCount();
    const b = p.budget || {}, by = p.budgetByNight || {};
    const v = x => (Number(x) > 0 ? Number(x) : '');
    const body = document.createElement('div');
    body.className = 'flight-form';
    body.innerHTML = `
      <p class="hint">每晚房價（整間房，新台幣）。超出預算的候選會變灰並標「超出預算」。不填＝不限。</p>
      <label>整趟預算（每晚）</label>
      <div class="hp-range"><input id="bgMin" type="number" inputmode="numeric" min="0" step="100" placeholder="最低" value="${v(b.min)}"><span>～</span><input id="bgMax" type="number" inputmode="numeric" min="0" step="100" placeholder="最高" value="${v(b.max)}"></div>
      <details class="hp-per-night" ${Object.keys(by).length ? 'open' : ''}>
        <summary>某幾晚想另外設定？（例如最後一晚想住好一點）</summary>
        ${Array.from({ length: n }, (_, i) => `
          <div class="hp-range-row"><span>${UI.esc(nightLabel(i))}</span>
            <div class="hp-range"><input data-bn="${i}" data-k="min" type="number" inputmode="numeric" min="0" step="100" placeholder="跟整趟一樣" value="${v((by[i] || {}).min)}"><span>～</span><input data-bn="${i}" data-k="max" type="number" inputmode="numeric" min="0" step="100" placeholder="跟整趟一樣" value="${v((by[i] || {}).max)}"></div></div>`).join('')}
      </details>`;
    UI.modal('💰 住宿預算', body, [
      { label: '儲存', primary: true, onClick: () => {
        const num = el => Math.max(0, Math.round(Number(el.value) || 0));
        const min = num(body.querySelector('#bgMin')), max = num(body.querySelector('#bgMax'));
        if (min && max && min > max) { UI.toast('最低價不能比最高價高'); return; }
        const per = {};
        let bad = false;
        body.querySelectorAll('[data-bn]').forEach(el => {
          const k = el.dataset.bn, val = num(el);
          if (!val) return;
          per[k] = per[k] || {}; per[k][el.dataset.k] = val;
        });
        Object.values(per).forEach(x => { if (x.min && x.max && x.min > x.max) bad = true; });
        if (bad) { UI.toast('有一晚的最低價比最高價高，請檢查'); return; }
        p.budget = (min || max) ? { min, max } : null;
        p.budgetByNight = per;
        Store.touch({ manual: true });
        UI.closeModal();
        render({ keepScroll: true });
        UI.toast('💰 預算已更新');
      } },
      { label: '清除預算', onClick: () => {
        p.budget = null; p.budgetByNight = {};
        Store.touch({ manual: true });
        UI.closeModal(); render({ keepScroll: true });
        UI.toast('已清除預算');
      } }
    ], { stackActions: true });
  }

  // ---------- 新增／編輯候選 ----------
  function openForm(existing) {
    if (!canVote()) { UI.toast('請先選擇「你是誰」'); return; }
    const n = nightsCount();
    if (!n) { UI.toast('一日遊不需要住宿'); return; }
    const c = existing ? JSON.parse(JSON.stringify(existing)) : { id: Logic.uid(), place: null, nights: [], must: false, rec: false, priceNum: 0, price: '', link: '', website: '', photos: [], photoIdx: [], note: '', addedBy: me(), addedAt: Date.now(), votes: {} };
    if (!c.priceNum && c.price) c.priceNum = priceOf(c);
    let pool = []; // 這間飯店的照片池（最多 8 張）
    const body = document.createElement('div');
    body.className = 'flight-form';
    const countOf = i => poll().candidates.filter(x => x.id !== c.id && x.nights.includes(i)).length;
    body.innerHTML = `
      <div class="ap-box">
        <label>🏨 飯店</label>
        <div class="ap-chosen">${c.place ? `✅ ${UI.esc(c.place.name)}<div class="hint">${UI.esc(c.place.address || '')}</div>` : '<span class="hint">還沒選擇飯店</span>'}</div>
        <div style="display:flex;gap:8px"><input id="hpQ" type="text" placeholder="例：青森 JR 飯店" style="margin-bottom:0"><button id="hpSearch" class="btn-small" type="button">搜尋</button></div>
        <div id="hpResults" class="stack" style="margin-top:6px"></div>
      </div>
      <div id="hpPhotoBox" class="hidden">
        <label>外觀照（點選 2 張，會顯示在候選卡上）</label>
        <div id="hpPhotos" class="hp-photo-pick"></div>
      </div>
      <label>住哪幾晚？（可複選）</label>
      <div class="hp-nights">${Array.from({ length: n }, (_, i) => `<label class="copy-item"><input type="checkbox" value="${i}" ${c.nights.includes(i) ? 'checked' : ''}>${UI.esc(nightLabel(i))}<span class="hint">　已有 ${countOf(i)} 間</span></label>`).join('')}</div>
      <label>每晚價格（新台幣，選填）</label>
      <input id="hpPrice" type="number" inputmode="numeric" min="0" step="100" placeholder="例：3200" value="${c.priceNum || ''}">
      <label>🌐 飯店官網（選填，選好飯店會自動帶入）</label>
      <input id="hpSite" type="url" maxlength="300" placeholder="https://" value="${UI.esc(c.website || '')}">
      <label>🔗 訂房連結（選填）</label>
      <input id="hpLink" type="url" maxlength="300" placeholder="例：Booking／Agoda 的網址" value="${UI.esc(c.link || '')}">
      <label>備註（選填）</label>
      <input id="hpNote" type="text" maxlength="60" placeholder="例：有大浴場、離車站 3 分鐘" value="${UI.esc(c.note || '')}">`;
    const results = body.querySelector('#hpResults');
    const photoBox = body.querySelector('#hpPhotoBox'), photoGrid = body.querySelector('#hpPhotos');
    const drawPhotos = () => {
      if (!pool.length) { photoBox.classList.add('hidden'); return; }
      photoBox.classList.remove('hidden');
      photoGrid.innerHTML = pool.map((u, i) => `<button type="button" class="hp-pick${c.photoIdx.includes(i) ? ' on' : ''}" data-i="${i}" style="background-image:url('${UI.esc(u)}')">${c.photoIdx.includes(i) ? `<b>${c.photoIdx.indexOf(i) + 1}</b>` : ''}</button>`).join('');
      photoGrid.querySelectorAll('.hp-pick').forEach(b => b.onclick = () => {
        const i = Number(b.dataset.i);
        if (c.photoIdx.includes(i)) c.photoIdx = c.photoIdx.filter(x => x !== i);
        else { c.photoIdx.push(i); if (c.photoIdx.length > 2) c.photoIdx.shift(); }
        drawPhotos();
      });
    };
    const loadExtras = async (fillSite) => {
      if (!c.place || !c.place.placeId) return;
      photoBox.classList.remove('hidden');
      photoGrid.innerHTML = '<p class="hint">正在抓飯店照片…</p>';
      const ex = await Api.placeExtras(c.place.placeId);
      pool = ex.photos || [];
      if (!c.photoIdx || !c.photoIdx.length) c.photoIdx = pool.slice(0, 2).map((_, i) => i);
      c.photoIdx = c.photoIdx.filter(i => i < pool.length);
      const site = body.querySelector('#hpSite');
      if (fillSite && ex.website && !site.value.trim()) site.value = ex.website;
      if (!pool.length) photoGrid.innerHTML = '<p class="hint">Google 上沒有這間飯店的照片</p>';
      else drawPhotos();
    };
    const search = async () => {
      const q = body.querySelector('#hpQ').value.trim();
      if (!q) { UI.toast('請輸入飯店名稱'); return; }
      results.innerHTML = '<p class="hint">搜尋中…</p>';
      try {
        const list = await Api.searchPlaces(q, 'hotel', Itin.tripArea());
        results.innerHTML = list.length ? '' : '<p class="hint">找不到，換個關鍵字試試</p>';
        list.slice(0, 5).forEach(p => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'btn-outline ap-item';
          b.innerHTML = `${UI.esc(p.name)}${p.rating ? ` ⭐${p.rating}` : ''}<div class="hint">${UI.esc(p.address || '')}</div>`;
          b.onclick = () => {
            c.place = { name: p.name, address: p.address || '', lat: p.lat, lng: p.lng, placeId: p.placeId || '', photo: p.photo || '', rating: p.rating || 0 };
            c.photoIdx = []; c.photos = [];
            body.querySelector('#hpSite').value = '';
            body.querySelector('.ap-chosen').innerHTML = `✅ ${UI.esc(p.name)}<div class="hint">${UI.esc(p.address || '')}</div>`;
            results.innerHTML = '';
            loadExtras(true);
          };
          results.appendChild(b);
        });
      } catch (e) { results.innerHTML = ''; UI.alert('搜尋失敗', UI.friendlyError(e)); }
    };
    body.querySelector('#hpSearch').onclick = search;
    body.querySelector('#hpQ').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    if (existing) loadExtras(false);
    UI.modal(existing ? '✎ 編輯候選飯店' : '➕ 加入候選飯店', body, [{
      label: existing ? '儲存' : '加入候選', primary: true, onClick: () => {
        c.nights = [...body.querySelectorAll('.hp-nights input:checked')].map(x => Number(x.value)).sort((a, b) => a - b);
        c.priceNum = Math.max(0, Math.round(Number(body.querySelector('#hpPrice').value) || 0));
        if (c.priceNum) c.price = '';
        const url = el => { const s = el.value.trim(); return s && !/^https?:\/\//i.test(s) ? 'https://' + s : s; };
        c.website = url(body.querySelector('#hpSite'));
        c.link = url(body.querySelector('#hpLink'));
        c.note = body.querySelector('#hpNote').value.trim();
        if (!c.place) { UI.toast('請搜尋並選擇飯店'); return; }
        if (!c.nights.length) { UI.toast('請勾選要住哪幾晚'); return; }
        if (pool.length) c.photos = c.photoIdx.map(i => pool[i]).filter(Boolean);
        // 晚數改了 → 不再涵蓋的晚，票要拿掉
        Object.keys(c.votes || {}).forEach(k => { if (!c.nights.includes(Number(k))) delete c.votes[k]; });
        const full = c.nights.filter(i => countOf(i) >= SUGGEST_PER_NIGHT);
        const p = poll();
        p.candidates = p.candidates.filter(x => x.id !== c.id);
        p.candidates.push(c);
        Store.touch({ manual: true });
        UI.closeModal();
        render({ keepScroll: !!existing });
        if (full.length) UI.toast(`已加入。小提醒：${nightsText(full)}已經超過 ${SUGGEST_PER_NIGHT} 間，建議每晚 ${SUGGEST_PER_NIGHT} 間比較好決定`);
        else UI.toast(existing ? '已更新候選飯店' : `🏨 已加入候選「${c.place.name}」，大家可以開始投票了`);
      }
    }], { stackActions: true });
  }

  // ---------- 照片過期 → 自動換新 ----------
  const refreshing = new Set();
  const freshPhotos = {}; // 候選 id → 這次重抓到的網址（只放記憶體，不寫進行程）
  async function refreshPhotos(c) {
    if (!c.place || !c.place.placeId || refreshing.has(c.id)) return;
    refreshing.add(c.id);
    const ex = await Api.placeExtras(c.place.placeId);
    const pool = ex.photos || [];
    const idx = (c.photoIdx && c.photoIdx.length ? c.photoIdx : [0, 1]).filter(i => i < pool.length);
    const fresh = idx.map(i => pool[i]);
    if (fresh.length && JSON.stringify(fresh) !== JSON.stringify(c.photos || [])) {
      freshPhotos[c.id] = fresh;
      render({ keepScroll: true });
    }
  }

  // ---------- 畫面 ----------
  function photosOf(c) {
    const list = (freshPhotos[c.id] || (c.photos && c.photos.length ? c.photos : (c.place.photo ? [c.place.photo] : []))).slice(0, 2);
    return list;
  }
  function cardHtml(c, n, maxVotes, i) {
    const v = votesOf(c, n);
    const mine = v.includes(me());
    const confirmedHere = isConfirmed(c) && confirmedNightOf(n) && confirmedNightOf(n).fromPoll === c.id;
    const lockedNight = !!confirmedNightOf(n);
    const leading = !lockedNight && v.length > 0 && v.length === maxVotes;
    const win = !lockedNight && isMajority(v.length);
    const total = Math.max(members().length, 1);
    const pct = Math.round(v.length / total * 100);
    const price = priceOf(c), bs = budgetState(c, n);
    const pics = photosOf(c);
    const tags = [
      confirmedHere ? '<span class="hp-tag ok">✅ 已確定</span>' : '',
      win ? '<span class="hp-tag win">🎉 過半</span>' : (leading ? `<span class="hp-tag lead">${countAtMax(n) > 1 ? '平手' : '目前領先'}</span>` : ''),
      c.rec ? '<span class="hp-tag rec">👍 主揪推薦</span>' : '',
      c.must ? '<span class="hp-tag must">⭐ 必去</span>' : '',
      bs === 'over' ? '<span class="hp-tag over">超出預算</span>' : (bs === 'under' ? '<span class="hp-tag over">低於預算</span>' : '')
    ].join('');
    const priceTxt = price ? `每晚 <span class="hp-price${bs ? ' out' : ''}">${money(price)}</span>` : (c.price ? UI.esc(c.price) : '');
    const linkHref = c.link || UI.hotelPriceLink(c.place.name);
    const avatars = v.map(name => `<span class="hp-av" style="background:${avColor(name)}">${UI.esc(name.slice(0, 1))}</span>`).join('');
    return `
      <div class="hp-card rise${confirmedHere ? ' hp-confirmed' : ''}${win ? ' hp-win' : ''}" style="animation-delay:${Math.min(i, 6) * 60}ms" data-cand="${UI.esc(c.id)}">
        <div class="hp-pics n${pics.length}">
          ${pics.length ? pics.map((u, k) => `<img src="${UI.esc(u)}" alt="" data-k="${k}" loading="lazy">`).join('') : '<span class="hp-noimg">🏨</span>'}
          <div class="hp-tags">${tags}</div>
        </div>
        <div class="hp-body">
          <div class="hp-name-row"><div class="hp-name">${UI.esc(c.place.name)}</div>${canVote() ? '<button class="hp-more" data-act="more" aria-label="更多">⋯</button>' : ''}</div>
          <div class="hint">${[UI.esc(nightsText(c.nights)), c.place.rating ? `⭐ ${c.place.rating}` : '', priceTxt].filter(Boolean).join('｜')}</div>
          ${c.note ? `<div class="hint">📝 ${UI.esc(c.note)}</div>` : ''}
          <div class="hp-vrow"><div class="hp-bar"><i data-w="${pct}" style="width:${pct}%"></i></div><span class="hp-count">${v.length} / ${total}</span></div>
          <div class="hp-voters">${v.length ? `${avatars}<span>${v.map(UI.esc).join('、')}</span>` : '還沒有人投'}</div>
          <div class="hint hp-by">由 ${UI.esc(c.addedBy || '（未具名）')} 加入</div>
          <div class="hp-actions">
            ${canVote() && !lockedNight ? `<button class="${mine ? 'btn-soft' : 'btn-primary'} hp-vote" data-act="vote">${mine ? '✓ 已投' : '👍 投這間'}</button>` : ''}
            ${c.website ? `<a class="btn-outline hp-link" href="${UI.esc(c.website)}" target="_blank" rel="noopener">🌐 官網</a>` : ''}
            <a class="btn-outline hp-link" href="${UI.esc(linkHref)}" target="_blank" rel="noopener">🔗 ${c.link ? '訂房' : '查房價'}</a>
            <a class="btn-outline hp-link hp-icon" href="${UI.esc(UI.gmapLink(c.place))}" target="_blank" rel="noopener" aria-label="地圖">📍</a>
          </div>
        </div>
      </div>`;
  }
  const AV_COLORS = ['#006599', '#FF8C00', '#0F9D58', '#7C3AED', '#E11D48', '#0891B2', '#B45309', '#4B5563'];
  const avColor = name => { const i = members().indexOf(name); return AV_COLORS[(i < 0 ? name.length : i) % AV_COLORS.length]; };
  function countAtMax(n) {
    const list = poll().candidates.filter(c => c.nights.includes(n));
    const max = Math.max(0, ...list.map(c => votesOf(c, n).length));
    return list.filter(c => votesOf(c, n).length === max).length;
  }
  function render(opts) {
    opts = opts || {};
    const root = $('hotelPollRoot');
    if (!root || !trip()) return;
    const keepY = opts.keepScroll ? window.scrollY : null;
    const p = poll();
    const n = nightsCount();
    const ownerName = owner();
    const mem = members();
    const wb = p.budget && (p.budget.min || p.budget.max) ? p.budget : null;
    const anyPer = Object.keys(p.budgetByNight || {}).length > 0;
    let html = `
      <div class="vote-subtabs">${KINDS.map((k, i) => `<button class="${i === 0 ? 'on' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}</div>
      <div class="hp-intro">
        <p class="hint">把想住的飯店加進候選，<b>每一晚每人一票</b>，建議每晚 ${SUGGEST_PER_NIGHT} 間比較好決定。票數超過同行人數一半會變綠色「🎉 過半」。</p>
        <div class="hp-owner">👑 主揪：<b>${UI.esc(ownerName || '（尚未設定）')}</b>${!ownerSet() ? '<span class="hint">（預設）</span>' : ''}
          ${(isOwner() || (!ownerSet() && canVote())) ? ` <button id="hpOwnerBtn" class="btn-ghost">${ownerSet() ? '更換' : '設定主揪'}</button>` : ''}
          ${canVote() ? `<span class="hp-me">你是 <b>${UI.esc(me())}</b></span>` : ''}</div>
        <div class="hp-budget${wb || anyPer ? '' : ' empty'}">💰 預算 <b>${wb ? `每晚 ${budgetText(wb)}` : '還沒設定'}</b>${anyPer ? '<span class="hint">（部分晚另外設定）</span>' : ''}
          ${isOwner() ? '<button id="hpBudgetBtn" class="btn-ghost">設定</button>' : ''}</div>
        ${canVote() ? '<button id="hpAddBtn" class="btn-primary hp-add">➕ 加入候選飯店</button>' : (Store.isReadonly() ? '<p class="hint">👀 唯讀模式：可以看候選和票數，投票請用編輯連結。</p>' : '')}
      </div>`;
    if (!n) html += '<p class="hint" style="padding:12px">這是一日遊，不需要住宿。</p>';
    let idx = 0;
    for (let night = 0; night < n; night++) {
      const locked = confirmedNightOf(night);
      // 排序：這晚已確定的那間 → ⭐ 必去 → 👍 主揪推薦 → 票數多的
      const list = p.candidates.filter(c => c.nights.includes(night))
        .sort((a, b) => ((locked && b.id === locked.fromPoll) - (locked && a.id === locked.fromPoll)) || (!!b.must - !!a.must) || (!!b.rec - !!a.rec) || (votesOf(b, night).length - votesOf(a, night).length));
      const maxVotes = Math.max(0, ...list.map(c => votesOf(c, night).length));
      const voted = new Set(list.flatMap(c => votesOf(c, night)));
      const notYet = mem.filter(m => !voted.has(m));
      const b = budgetOf(night);
      const left = SUGGEST_PER_NIGHT - list.length;
      html += `
        <section class="hp-night">
          <div class="hp-night-head"><span class="hp-night-title">${UI.esc(nightLabel(night))}</span>
            ${locked ? `<span class="hp-tag ok">✅ 已確定：${UI.esc(locked.name)}</span>` : `<span class="hp-slots${left < 0 ? ' over' : ''}">${left > 0 ? `還可加 ${left} 間` : left === 0 ? `已有 ${SUGGEST_PER_NIGHT} 間` : `${list.length} 間（建議 ${SUGGEST_PER_NIGHT} 間）`}</span>`}</div>
          ${!locked ? `<div class="hint hp-night-sub">${voted.size} 人已投${notYet.length && list.length ? `｜還沒投：${notYet.map(UI.esc).join('、')}` : ''}${b && b.perNight ? `｜💰 這晚預算 ${budgetText(b)}` : ''}</div>` : ''}
          ${list.length ? list.map(c => cardHtml(c, night, maxVotes, idx++)).join('') : '<p class="hint hp-empty">這晚還沒有候選飯店</p>'}
        </section>`;
    }
    root.innerHTML = html;
    if (keepY !== null) window.scrollTo(0, keepY);
    if (opts.keepScroll) root.querySelectorAll('.rise').forEach(el => el.classList.remove('rise'));
    // 票數條：從 0 長到目前比例
    if (!opts.keepScroll || opts.animateBars) {
      const bars = [...root.querySelectorAll('.hp-bar i')];
      if (!opts.animateBars) bars.forEach(el => { el.style.width = '0'; });
      requestAnimationFrame(() => setTimeout(() => bars.forEach(el => { el.style.width = el.dataset.w + '%'; }), 60));
    }
    const ob = $('hpOwnerBtn'); if (ob) ob.onclick = changeOwner;
    const bb = $('hpBudgetBtn'); if (bb) bb.onclick = openBudget;
    const ab = $('hpAddBtn'); if (ab) ab.onclick = () => openForm(null);
    root.querySelectorAll('.hp-card').forEach(el => {
      const c = p.candidates.find(x => x.id === el.dataset.cand);
      const vb = el.querySelector('[data-act="vote"]');
      // 已在這間涵蓋的每一晚都投了 → 再按一次＝取消；否則＝投這間
      if (vb) vb.onclick = () => vote(c, !c.nights.every(nn => votesOf(c, nn).includes(me())), vb);
      const mb = el.querySelector('[data-act="more"]');
      if (mb) mb.onclick = () => moreMenu(c);
      // v2.1.41 破圖自動隱藏：載入失敗，或 Google 回的「沒有圖片」小圖（照片網址過期時是 100×100）
      // → 拿掉那張；兩張都壞就變成沒照片的樣子（🏨），同時在背景重抓新照片
      const pics = el.querySelector('.hp-pics');
      const bad = img => {
        if (!img.isConnected) return;
        img.remove();
        const left = pics.querySelectorAll('img').length;
        pics.className = 'hp-pics n' + left;
        if (!left && !pics.querySelector('.hp-noimg')) pics.insertAdjacentHTML('afterbegin', '<span class="hp-noimg">🏨</span>');
        refreshPhotos(c);
      };
      el.querySelectorAll('.hp-pics img').forEach(img => {
        img.onclick = () => UI.photoZoom(img.src, c.place.name);
        const check = () => { if (img.naturalWidth && img.naturalWidth <= 120) bad(img); };
        img.addEventListener('error', () => bad(img), { once: true });
        if (img.complete) { if (!img.naturalWidth) bad(img); else check(); } else img.addEventListener('load', check, { once: true });
      });
    });
  }
  function moreMenu(c) {
    const opts = [];
    if (isOwner()) {
      opts.push(isConfirmed(c) ? { label: '↩ 取消確定（從行程移除）', value: 'unconfirm' } : { label: '✅ 確定入住（加入行程）', value: 'confirm' });
      opts.push({ label: c.rec ? '取消「主揪推薦」' : '👍 標為主揪推薦', value: 'rec' });
      opts.push({ label: c.must ? '☆ 取消必去' : '⭐ 設為必去飯店', value: 'must' });
    }
    if (isOwner() || c.addedBy === me()) {
      opts.push({ label: '✎ 編輯（晚數／價格／照片／連結／備註）', value: 'edit' });
      opts.push({ label: '🗑 刪除候選', value: 'del', danger: true });
    }
    if (!opts.length) { UI.toast(`確定住宿請找主揪（${owner()}）`); return; }
    UI.choose(c.place.name, opts, v => {
      if (v === 'confirm') confirmStay(c);
      else if (v === 'unconfirm') unconfirm(c);
      else if (v === 'rec') toggleFlag(c, 'rec', `👍 「${c.place.name}」標為主揪推薦`, '已取消主揪推薦');
      else if (v === 'must') toggleFlag(c, 'must', `⭐ 「${c.place.name}」設為必去飯店`, '已取消必去');
      else if (v === 'edit') openForm(c);
      else if (v === 'del') removeCand(c);
    });
  }

  return { render, applyVote, owner, isConfirmedHotel: h => !!(h && h.confirmed && h.fromPoll) };
})();
