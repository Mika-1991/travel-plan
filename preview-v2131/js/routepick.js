// ============================================================
// 🛣 選路線＋冬季封路（v2.1.35）
// 點時間軸的交通藥丸、或地圖分頁上的路段 → 顯示 Google 的 2～3 條路線（不同顏色）讓人點選；
// 也可以「✋ 拖曳改路線」自己拉到想走的路。選定後存在 trip.legRoutes[key]：
//   { mode, via:[{lat,lng}], min, km, summary, path:[{lat,lng}]（抽樣 ≤150 點）, by, at }
// key＝起點>終點座標（有方向）＋交通方式。車程時間會改用選定路線（legsForDay 會套用）。
// trip.closedRoads＝使用者標記「冬季封閉」的道路名稱（Google 路線摘要），選路線時變灰、提醒。
// Google 是用「現在」的路況算路線，夏天規劃冬天行程時不一定知道冬天封路 → 讓使用者自己標。
// ============================================================
const RoutePick = (() => {
  const trip = () => Store.get();
  const COLORS = ['#006599', '#E07B00', '#0F9D58'];
  const pk = p => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
  const keyOf = (a, b, mode) => `${mode === 'walking' ? 'W' : 'D'}:${pk(a)}>${pk(b)}`;
  const chosenOf = (a, b, mode) => (a && b && Logic.hasCoords(a) && Logic.hasCoords(b)) ? ((trip().legRoutes || {})[keyOf(a, b, mode)] || null) : null;
  const closed = () => (trip().closedRoads || []);
  const pathOf = r => (r && r.pathEnc ? Logic.decodePath(r.pathEnc) : ((r && r.path) || []));
  const isClosed = summary => !!summary && closed().some(r => summary.includes(r) || r.includes(summary));
  const sample = (path, max) => {
    if (path.length <= max) return path.map(p => ({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5) }));
    const step = (path.length - 1) / (max - 1), out = [];
    for (let i = 0; i < max; i++) { const p = path[Math.round(i * step)]; out.push({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5) }); }
    return out;
  };

  // 冬季（12～4 月）在日本或其他海外、而且這天開車 → 提醒
  function winterTip(d) {
    const iso = Store.dateOfDay(d);
    if (!iso) return false;
    const m = Number(iso.slice(5, 7));
    if (!(m === 12 || m <= 4)) return false;
    if (Itin.dayTransportOf(d) !== 'driving') return false;
    const area = Itin.tripArea && Itin.tripArea();
    if (!area) return false;
    const c = area.center, inTW = c.lat > 21.7 && c.lat < 26.5 && c.lng > 118 && c.lng < 122.2;
    return !inTW;
  }

  function open(from, to, mode, onDone) {
    mode = mode || trip().transport;
    if (mode === 'transit') { UI.toast('大眾運輸的路線請到 Google 地圖看（這裡可以選開車、走路的路線）'); return; }
    if (!from || !to || !Logic.hasCoords(from) || !Logic.hasCoords(to)) { UI.toast('這段有地點沒有座標，沒辦法選路線'); return; }
    if (Api.isMock()) { UI.toast('模擬模式沒有真實路線'); return; }
    const ro = Store.isReadonly();
    const key = keyOf(from, to, mode);
    const cur = (trip().legRoutes || {})[key] || null;
    const body = document.createElement('div');
    body.className = 'rp-body';
    body.innerHTML = `
      <div class="rp-ends"><b>${UI.esc(from.name || '起點')}</b> → <b>${UI.esc(to.name || '終點')}</b></div>
      <div class="rp-map"></div>
      <div class="rp-list"><p class="hint">正在找路線…</p></div>
      ${ro ? '' : `<div class="rp-tools">
        <button type="button" class="btn-outline rp-drag">✋ 拖曳改路線</button>
        ${cur ? '<button type="button" class="btn-ghost rp-reset">↩ 恢復 Google 預設</button>' : ''}
      </div>`}
      <p class="hint rp-note">❄️ Google 用的是「現在」的路況，冬天封閉的山路不一定知道。遇到封閉的路，按「⛔ 冬季封閉」標記，之後選路線會提醒大家。</p>`;
    let routes = [], result = null, sel = 0, renderer = null, dragged = null, done = false;
    let gmap = null, lines = [];
    const actions = ro ? [] : [{ label: '用這條路線', primary: true, onClick: () => save() }];
    // v2.1.39 拖曳過但還沒按「用這條路線」就要關 → 先問要不要存
    const beforeClose = () => {
      if (ro || done || !dragged) return true;
      UI.modal('拖曳的路線還沒存', '你剛剛拖曳的路線還沒存起來，現在關掉就不見了。要存嗎？', [
        { label: '💾 存起來', primary: true, onClick: () => { UI.closeModal(); save(); } },
        { label: '不存，直接關掉', danger: true, onClick: () => { done = true; UI.closeModal(); UI.closeModal(); } },
        { label: '繼續編輯', onClick: () => UI.closeModal() }
      ], { stackActions: true, noClose: true });
      return false;
    };
    UI.modal('🛣 選路線', body, actions, { stackActions: true, beforeClose });
    const saveBtn = () => body.closest('.modal-box') && body.closest('.modal-box').querySelector('.modal-actions .btn-primary');

    const draw = () => {
      lines.forEach(l => l.setMap(null)); lines = [];
      if (!gmap) return;
      const bounds = new google.maps.LatLngBounds();
      routes.forEach((r, i) => {
        if (dragged) return;
        const on = i === sel;
        const line = new google.maps.Polyline({
          map: gmap, path: r.path, zIndex: on ? 10 : 1,
          strokeColor: isClosed(r.summary) ? '#94A3B8' : COLORS[i % 3], strokeOpacity: on ? .95 : .5, strokeWeight: on ? 7 : 5
        });
        line.addListener('click', () => { sel = i; draw(); list(); });
        lines.push(line);
        // v2.1.39 線很細不好點：疊一條看不見的粗線當「感應區」，手指點在附近也算點到
        const hit = new google.maps.Polyline({ map: gmap, path: r.path, zIndex: on ? 11 : 2, strokeColor: '#000000', strokeOpacity: 0.01, strokeWeight: 34 });
        hit.addListener('click', () => { sel = i; draw(); list(); });
        lines.push(hit);
        r.path.forEach(p => bounds.extend(p));
      });
      [from, to].forEach((p, i) => {
        const mk = new google.maps.Marker({ map: gmap, position: { lat: p.lat, lng: p.lng }, label: { text: i ? '終' : '起', color: '#fff', fontWeight: '700' } });
        lines.push(mk);
        bounds.extend({ lat: p.lat, lng: p.lng });
      });
      if (!dragged) gmap.fitBounds(bounds, 30);
    };
    const list = () => {
      const box = body.querySelector('.rp-list');
      const items = dragged ? [dragged] : routes;
      box.innerHTML = items.map((r, i) => {
        const on = dragged ? true : i === sel;
        const cl = isClosed(r.summary);
        return `<div class="rp-card${on ? ' on' : ''}${cl ? ' closed' : ''}" data-i="${i}">
          <span class="rp-dot" style="background:${dragged ? '#7C3AED' : (cl ? '#94A3B8' : COLORS[i % 3])}"></span>
          <div class="rp-info"><b>${dragged ? '✋ 你拖曳的路線' : (r.mine ? '📌 目前用的路線' : (i === (routes[0] && routes[0].mine ? 1 : 0) ? 'Google 建議' : `替代路線 ${i - (routes[0] && routes[0].mine ? 1 : 0)}`))}｜約 ${Logic.fmtDur(r.min)}・${r.km} 公里</b>
            <div class="hint">經過：${UI.esc(r.summary || '（沒有道路名稱）')}${cl ? '　<span class="rp-closed">⛔ 你標記冬季封閉</span>' : ''}</div></div>
          ${!ro && r.summary ? `<button type="button" class="rp-mark" data-sum="${UI.esc(r.summary)}">${cl ? '取消封閉' : '⛔ 冬季封閉'}</button>` : ''}
        </div>`;
      }).join('') || '<p class="hint">找不到路線</p>';
      box.querySelectorAll('.rp-card').forEach(c => c.onclick = e => {
        if (e.target.closest('.rp-mark')) return;
        if (dragged) return;
        sel = Number(c.dataset.i); draw(); list();
      });
      box.querySelectorAll('.rp-mark').forEach(b => b.onclick = () => toggleClosed(b.dataset.sum));
    };
    const toggleClosed = summary => {
      const t = trip();
      t.closedRoads = closed().slice();
      const i = t.closedRoads.findIndex(r => r === summary);
      if (i >= 0) t.closedRoads.splice(i, 1); else t.closedRoads.push(summary);
      Store.touch({ manual: true });
      // 選中的剛好被標封閉 → 自動改選第一條沒封閉的
      if (!dragged && isClosed((routes[sel] || {}).summary)) { const ok = routes.findIndex(r => !isClosed(r.summary)); if (ok >= 0) sel = ok; }
      draw(); list();
      UI.toast(i >= 0 ? `已取消「${summary}」的封閉標記` : `⛔ 已標記「${summary}」冬季封閉`);
    };
    const save = () => {
      const r = dragged || routes[sel];
      if (!r) { UI.toast('還沒有路線可以選'); return; }
      if (!dragged && sel === 0 && !cur) { done = true; UI.closeModal(); UI.toast('維持 Google 建議路線'); return; }
      if (!dragged && r.mine) { done = true; UI.closeModal(); UI.toast('維持目前用的路線'); return; } // 沒換 → 原本存的（含拖曳途經點）不動
      const t = trip();
      t.legRoutes = Object.assign({}, t.legRoutes || {});
      t.legRoutes[key] = {
        mode, via: dragged ? dragged.via : (sel === (routes[0] && routes[0].mine ? 1 : 0) ? [] : [r.path[Math.floor(r.path.length / 2)]].map(p => ({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5) }))),
        min: r.min, km: r.km, summary: r.summary || '', pathEnc: Logic.encodePath(sample(r.path, 80)), by: Store.getEditor() || '', at: Date.now(),
        from: from.name || '', to: to.name || ''
      };
      Store.touch({ manual: true });
      done = true;
      UI.closeModal();
      UI.toast(`🛣 改走「${r.summary || '自訂路線'}」約 ${Logic.fmtDur(r.min)}，時間已更新`);
      onDone && onDone();
    };
    const reset = () => {
      const t = trip();
      t.legRoutes = Object.assign({}, t.legRoutes || {});
      delete t.legRoutes[key];
      Store.touch({ manual: true });
      done = true;
      UI.closeModal();
      UI.toast('已恢復 Google 預設路線');
      onDone && onDone();
    };
    const startDrag = () => {
      if (!result || !gmap) return;
      lines.forEach(l => l.setMap && l.setMap(null)); lines = [];
      renderer = new google.maps.DirectionsRenderer({ map: gmap, draggable: true, directions: result, routeIndex: sel, suppressMarkers: false, polylineOptions: { strokeColor: '#7C3AED', strokeWeight: 6 } });
      UI.toast('把紫色路線拖到你要走的路上，放開後會重新計算時間');
      renderer.addListener('directions_changed', () => {
        const d = renderer.getDirections();
        const rt = d.routes[renderer.getRouteIndex ? (renderer.getRouteIndex() || 0) : 0] || d.routes[0];
        const s = Api.summarizeRoute(rt);
        const wps = ((d.request && d.request.waypoints) || []).map(w => {
          const loc = w.location && (w.location.location || w.location);
          return loc && typeof loc.lat === 'function' ? { lat: +loc.lat().toFixed(5), lng: +loc.lng().toFixed(5) } : (loc && loc.lat !== undefined ? { lat: +Number(loc.lat).toFixed(5), lng: +Number(loc.lng).toFixed(5) } : null);
        }).filter(Boolean);
        dragged = Object.assign(s, { via: wps });
        list();
        const b = saveBtn();
        if (b) { b.textContent = '💾 用我拖曳的路線'; b.classList.add('rp-save-hot'); }
        const box = body.querySelector('.rp-list');
        if (box && !box.querySelector('.rp-remind')) box.insertAdjacentHTML('afterbegin', '<p class="rp-remind">✋ 拖好了嗎？記得按下方「💾 用我拖曳的路線」才會存起來</p>');
      });
      const db = body.querySelector('.rp-drag'); if (db) db.disabled = true;
    };

    // 載入：已有選定路線時，用它的途經點查一次，並另外列出 Google 替代路線
    (async () => {
      try {
        await Api.loadGoogleMaps();
        gmap = new google.maps.Map(body.querySelector('.rp-map'), { center: { lat: from.lat, lng: from.lng }, zoom: 9, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, gestureHandling: 'greedy' });
        const alt = await Api.routeAlternatives(from, to, mode);
        routes = alt.routes; result = alt.result;
        if (cur) {
          // 找跟目前選定一樣的那條（道路名稱相同、距離差不到 1 公里）；找不到（例如拖曳過的）就把選定的那條加在最前面
          const idx = routes.findIndex(r => r.summary && r.summary === cur.summary && Math.abs((r.km || 0) - (cur.km || 0)) < 1);
          if (idx >= 0) sel = idx;
          else { routes.unshift({ min: cur.min, km: cur.km, summary: cur.summary, path: pathOf(cur), warnings: [], mine: true }); sel = 0; }
        } else if (isClosed((routes[0] || {}).summary)) {
          const ok = routes.findIndex(r => !isClosed(r.summary)); if (ok >= 0) sel = ok;
        }
        draw(); list();
      } catch (e) {
        body.querySelector('.rp-list').innerHTML = `<p class="hint">找不到這段的路線（${UI.esc(UI.friendlyError(e))}）</p>`;
      }
    })();
    const db = body.querySelector('.rp-drag'); if (db) db.onclick = startDrag;
    const rb = body.querySelector('.rp-reset'); if (rb) rb.onclick = reset;
  }

  return { open, chosenOf, keyOf, isClosed, winterTip, pathOf };
})();
