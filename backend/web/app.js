(() => {
  const $ = (s) => document.querySelector(s);
  const flipsBody = $('#flips tbody');
  const bazaarBody = $('#bazaar tbody');
  const conn = $('#conn');
  const statsEl = $('#stats');
  const form = $('#settingsForm');
  const tooltip = $('#tooltip');
  let settings = null;
  let ws;
  let audioCtx;
  let token = '';
  try { token = localStorage.getItem('skyflip.token') || ''; } catch {}
  const flips = [];

  const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'b' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : Math.round(n).toLocaleString();
  const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? s.toFixed(0) + 's' : s < 3600 ? (s / 60).toFixed(0) + 'm' : (s / 3600).toFixed(1) + 'h'; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /** Minecraft § colour codes → spans. */
  const mc = (s) => { let out = '', open = 0; for (const part of String(s).split(/(§[0-9a-fk-or])/i)) { if (/^§/.test(part)) { out += `<span class="c${part[1].toLowerCase()}">`; open++; } else out += esc(part); } return out + '</span>'.repeat(open); };

  function beep() {
    if (!settings || !settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.12);
    } catch {}
  }

  // ---- tabs ----
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab));
  });

  // ---- flips ----
  function flipRow(f, isNew) {
    const tr = document.createElement('tr');
    if (isNew) tr.className = 'new';
    tr.dataset.ts = f.detectedAt; tr.dataset.risk = f.risk; tr.dataset.uuid = f.uuid;
    const src = f.priceSource === 'coflnet' ? ' · ref: coflnet' : f.priceSource === 'none' ? ' · no history' : '';
    tr.innerHTML = `
      <td class="age">${ago(f.detectedAt)}</td>
      <td><span class="kind ${f.kind}">${f.kind}</span>${f.whitelisted ? ' <span class="pill">WL</span>' : ''}</td>
      <td class="item"><span class="r-${f.rarity} lore" data-uuid="${f.uuid}">${esc(f.itemName)}</span>${f.count > 1 ? ' ×' + f.count : ''}<div class="sub">${esc(f.summary || '')}${f.lowestBin ? ' · LBIN ' + fmt(f.lowestBin) : ''}${f.median ? ' · med ' + fmt(f.median) : ''} · tier ${f.keyTier}${src}</div></td>
      <td>${fmt(f.price)}</td>
      <td>${fmt(f.target)}</td>
      <td class="profit">+${fmt(f.profit)}</td>
      <td>${(f.profitPercent * 100).toFixed(0)}%</td>
      <td>${f.salesPerDay || '–'}</td>
      <td class="risk ${f.risk}">${f.risk}</td>
      <td class="muted">${f.latencyMs}ms</td>
      <td><button class="small copy" data-cmd="${f.command}">Copy /viewauction</button> <button class="small copy" data-cmd="${f.uuid}">UUID</button></td>`;
    return tr;
  }
  function applyFlipFilter() {
    const onlyLow = $('#onlyLow').checked;
    for (const tr of flipsBody.children) tr.classList.toggle('hidden', onlyLow && tr.dataset.risk !== 'LOW');
  }
  function addFlip(f, isNew) {
    flips.unshift(f); if (flips.length > 300) flips.pop();
    $('#empty').style.display = 'none';
    flipsBody.prepend(flipRow(f, isNew));
    while (flipsBody.children.length > 300) flipsBody.lastChild.remove();
    $('#flipCount').textContent = `${flips.length} flips shown`;
    applyFlipFilter();
    if (isNew) beep();
  }
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button.copy'); if (!b) return;
    navigator.clipboard.writeText(b.dataset.cmd).then(() => { const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => (b.textContent = t), 1200); });
  });
  $('#onlyLow').addEventListener('change', applyFlipFilter);
  // lore tooltip
  flipsBody.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.lore'); if (!el || !$('#showLore').checked) return;
    const f = flips.find((x) => x.uuid === el.dataset.uuid); if (!f || !f.lore || !f.lore.length) return;
    tooltip.innerHTML = f.lore.map(mc).join('\n');
    tooltip.classList.remove('hidden');
  });
  flipsBody.addEventListener('mousemove', (e) => { tooltip.style.left = Math.min(e.clientX + 14, innerWidth - 440) + 'px'; tooltip.style.top = Math.min(e.clientY + 14, innerHeight - tooltip.offsetHeight - 10) + 'px'; });
  flipsBody.addEventListener('mouseout', (e) => { if (e.target.closest('.lore')) tooltip.classList.add('hidden'); });

  // ---- bazaar ----
  function renderBazaar(list) {
    bazaarBody.innerHTML = '';
    for (const b of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="item">${esc(b.name)}<div class="sub">${esc(b.productId)} · ${b.buyOrders} buy / ${b.sellOrders} sell orders</div></td>
        <td>${fmt(b.buyOrderPrice)}</td>
        <td>${fmt(b.sellOrderPrice)}</td>
        <td class="profit">+${fmt(b.profitPerUnit)}</td>
        <td>${(b.profitPercent * 100).toFixed(1)}%</td>
        <td>${Math.round(b.unitsPerHour).toLocaleString()}</td>
        <td class="profit">${fmt(b.profitPerHour)}</td>
        <td class="muted">${fmt(b.buyMovingWeek)} · ${fmt(b.sellMovingWeek)}</td>
        <td class="risk ${b.risk}">${b.risk}</td>
        <td><button class="small copy" data-cmd="${esc(b.command)}">Copy /bz</button></td>`;
      bazaarBody.appendChild(tr);
    }
    $('#bazaarUpdated').textContent = list.length ? `${list.length} flips · updated ${new Date().toLocaleTimeString()}` : 'no bazaar flips match the current filters';
  }

  // ---- profit ----
  const profitForm = $('#profitForm');
  profitForm.addEventListener('submit', (e) => {
    e.preventDefault();
    send({ type: 'profit', uuid: profitForm.uuid.value.trim(), days: Number(profitForm.days.value) });
  });
  function renderProfit(s) {
    const card = (k, v, cls = '') => `<div class="card"><div class="v ${cls}">${v}</div><div class="k">${k}</div></div>`;
    $('#profitSummary').innerHTML = card('bought', s.bought) + card('sold', s.sold) + card('spent', fmt(s.spent)) + card('revenue (net)', fmt(s.revenue))
      + card('realized profit', (s.realizedProfit >= 0 ? '+' : '') + fmt(s.realizedProfit), s.realizedProfit >= 0 ? 'profit' : 'loss') + card('pending', `${s.pending} · ${fmt(s.pendingValue)}`);
    const tb = $('#purchases tbody'); tb.innerHTML = '';
    for (const p of s.recent) {
      const net = p.soldPrice ? p.soldPrice - Math.floor(p.soldPrice * (p.soldPrice >= 1e8 ? 0.03 : p.soldPrice >= 1e7 ? 0.02 : 0.01)) - (p.soldPrice > 1e6 ? Math.floor(p.soldPrice * 0.01) : 0) - p.price : null;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${ago(p.boughtAt)} ago</td><td>${esc(p.itemName)}</td><td>${fmt(p.price)}</td><td>${p.predictedProfit != null ? '+' + fmt(p.predictedProfit) : '<span class="muted">manual</span>'}</td>
        <td>${p.soldPrice ? fmt(p.soldPrice) : '<span class="muted">unsold</span>'}</td><td class="${net == null ? 'muted' : net >= 0 ? 'profit' : 'loss'}">${net == null ? '–' : (net >= 0 ? '+' : '') + fmt(net)}</td>
        <td class="muted">${p.soldAt ? ago(p.boughtAt - (Date.now() - p.soldAt)) : ago(p.boughtAt)}</td>`;
      tb.appendChild(tr);
    }
  }
  function logEvent(text) {
    const d = document.createElement('div'); d.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    $('#events').prepend(d);
  }

  // ---- status ----
  function renderStatus(s) {
    statsEl.innerHTML = `
      <span>API <b>${s.apiLastUpdated ? ago(s.apiLastUpdated) + ' ago' : '–'}</b></span>
      <span>lag <b>${s.detectLagMs ? s.detectLagMs + 'ms' : '–'}</b></span>
      <span>auctions <b>${s.totalAuctions.toLocaleString()}</b></span>
      <span>new <b>${s.newAuctions}</b></span>
      <span>flips <b>${s.flipsTotal}</b></span>
      <span>sales <b>${s.salesTracked.toLocaleString()}</b></span>
      <span>coflnet <b>${s.coflnet ? s.coflnet.cacheSize : 0}</b></span>
      <span>bazaar <b>${s.bazaarFlips || 0}</b></span>
      <span>clients <b>${s.clients || 0}</b></span>`;
  }

  // ---- settings ----
  const rulesToText = (rules) => rules.map((r) => JSON.stringify(r)).join('\n');
  function textToRules(text) {
    const t = text.trim(); if (!t) return [];
    if (t.startsWith('[')) return JSON.parse(t);
    return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : { item: l.toUpperCase() }));
  }
  function fillForm(s) {
    form.minProfit.value = s.minProfit;
    form.minProfitPercent.value = Math.round(s.minProfitPercent * 100);
    form.maxPrice.value = s.maxPrice;
    form.minSalesPerDay.value = s.minSalesPerDay;
    form.maxKeyTier.value = s.maxKeyTier;
    form.maxRisk.value = s.maxRisk;
    form.SNIPE.checked = s.kinds.SNIPE;
    form.MEDIAN.checked = s.kinds.MEDIAN;
    form.whitelistOnly.checked = s.whitelistOnly;
    form.sound.checked = s.sound;
    form.blacklist.value = rulesToText(s.blacklist);
    form.whitelist.value = rulesToText(s.whitelist);
    form.bzMinProfitPerHour.value = s.bazaar.minProfitPerHour;
    form.bzMinProfitPercent.value = +(s.bazaar.minProfitPercent * 100).toFixed(2);
    form.bzMaxPrice.value = s.bazaar.maxPrice;
    form.bzMinVolumeWeek.value = s.bazaar.minVolumeWeek;
    form.bzMaxRisk.value = s.bazaar.maxRisk;
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let blacklist, whitelist;
    try { blacklist = textToRules(form.blacklist.value); whitelist = textToRules(form.whitelist.value); }
    catch (err) { $('#saveMsg').textContent = 'Rule JSON error: ' + err.message; return; }
    const patch = {
      minProfit: Number(form.minProfit.value), minProfitPercent: Number(form.minProfitPercent.value) / 100,
      maxPrice: Number(form.maxPrice.value), minSalesPerDay: Number(form.minSalesPerDay.value), maxKeyTier: Number(form.maxKeyTier.value),
      maxRisk: form.maxRisk.value, kinds: { SNIPE: form.SNIPE.checked, MEDIAN: form.MEDIAN.checked }, whitelistOnly: form.whitelistOnly.checked, sound: form.sound.checked,
      blacklist, whitelist,
      bazaar: { minProfitPerHour: Number(form.bzMinProfitPerHour.value), minProfitPercent: Number(form.bzMinProfitPercent.value) / 100, maxPrice: Number(form.bzMaxPrice.value), minVolumeWeek: Number(form.bzMinVolumeWeek.value), maxRisk: form.bzMaxRisk.value },
    };
    send({ type: 'settings', settings: patch });
    send({ type: 'bazaar', limit: 50 });
    $('#saveMsg').textContent = 'Saved'; setTimeout(() => ($('#saveMsg').textContent = ''), 1500);
  });

  // ---- token ----
  $('#tokenForm').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('#tokenForm').token.value.trim();
    try { localStorage.setItem('skyflip.token', token); } catch {}
    $('#tokenPanel').classList.add('hidden');
    connect();
  });

  // ---- socket ----
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  let unauthorized = false;
  function connect() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`);
    unauthorized = false;
    ws.onopen = () => { conn.textContent = 'live'; conn.className = 'pill on'; };
    ws.onerror = () => { unauthorized = true; };
    ws.onclose = (ev) => {
      conn.textContent = 'offline'; conn.className = 'pill off';
      // A handshake rejected with 401 surfaces as an immediate error+close with code 1006.
      if (unauthorized && ev.code === 1006 && !ws.gotHello) { $('#tokenPanel').classList.remove('hidden'); return; }
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello') {
        ws.gotHello = true; settings = m.settings; fillForm(settings); renderStatus(m.status);
        flipsBody.innerHTML = ''; flips.length = 0; m.flips.forEach((f) => addFlip(f, false)); renderBazaar(m.bazaar || []);
        fetch('/api/players' + (token ? `?token=${encodeURIComponent(token)}` : '')).then((r) => r.json()).then((ps) => { $('#players').innerHTML = ps.map((p) => `<option value="${p}">`).join(''); }).catch(() => {});
      }
      else if (m.type === 'flip') addFlip(m.flip, true);
      else if (m.type === 'status') renderStatus(m.status);
      else if (m.type === 'settings') { settings = m.settings; fillForm(settings); }
      else if (m.type === 'bazaar') renderBazaar(m.flips);
      else if (m.type === 'profit') renderProfit(m.summary);
      else if (m.type === 'purchase') { logEvent(`bought ${m.purchase.itemName} for ${fmt(m.purchase.price)}${m.flip ? ` (predicted +${fmt(m.flip.profit)})` : ''}`); }
      else if (m.type === 'sold') { logEvent(`sold ${m.purchase.itemName} for ${fmt(m.purchase.soldPrice)} (paid ${fmt(m.purchase.price)})`); }
      else if (m.type === 'msg') logEvent(m.text);
    };
  }
  setInterval(() => { for (const tr of flipsBody.children) tr.querySelector('.age').textContent = ago(Number(tr.dataset.ts)); }, 5000);
  connect();
})();
