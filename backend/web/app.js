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

  // Soft two-note chime (a gentle fifth, sine, short decay). Volume from the slider, remembered per browser.
  const volumeEl = $('#volume');
  const webSoundEl = $('#webSound');
  try { volumeEl.value = localStorage.getItem('skyflip.volume') ?? '30'; webSoundEl.checked = localStorage.getItem('skyflip.sound') !== '0'; } catch {}
  volumeEl.addEventListener('input', () => { try { localStorage.setItem('skyflip.volume', volumeEl.value); } catch {} });
  volumeEl.addEventListener('change', () => beep(true));
  webSoundEl.addEventListener('change', () => { try { localStorage.setItem('skyflip.sound', webSoundEl.checked ? '1' : '0'); } catch {} });
  function beep(force) {
    if (!force && !webSoundEl.checked) return;
    const vol = Number(volumeEl.value) / 100;
    if (vol <= 0) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      [[523.25, 0], [783.99, 0.09]].forEach(([freq, dt]) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0, t0 + dt);
        g.gain.linearRampToValueAtTime(0.12 * vol, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.45);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0 + dt); o.stop(t0 + dt + 0.5);
      });
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
      <td class="num">${fmt(f.price)}</td>
      <td class="num">${fmt(f.target)}</td>
      <td class="num profit">+${fmt(f.profit)}</td>
      <td class="num">${(f.profitPercent * 100).toFixed(0)}%</td>
      <td class="num">${f.salesPerDay || '–'}</td>
      <td><span class="risk ${f.risk}">${f.risk}</span></td>
      <td class="num muted">${(f.latencyMs / 1000).toFixed(1)}s</td>
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
        <td class="num">${fmt(b.buyOrderPrice)}</td>
        <td class="num">${fmt(b.sellOrderPrice)}</td>
        <td class="num profit">+${fmt(b.profitPerUnit)}</td>
        <td class="num">${(b.profitPercent * 100).toFixed(1)}%</td>
        <td class="num">${Math.round(b.unitsPerHour).toLocaleString()}</td>
        <td class="num profit">${fmt(b.profitPerHour)}</td>
        <td class="num muted">${fmt(b.buyMovingWeek)} · ${fmt(b.sellMovingWeek)}</td>
        <td><span class="risk ${b.risk}">${b.risk}</span></td>
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
      tr.innerHTML = `<td>${ago(p.boughtAt)} ago</td><td>${esc(p.itemName)}</td><td class="num">${fmt(p.price)}</td><td class="num">${p.predictedProfit != null ? '+' + fmt(p.predictedProfit) : '<span class="muted">manual</span>'}</td>
        <td class="num">${p.soldPrice ? fmt(p.soldPrice) : '<span class="muted">unsold</span>'}</td><td class="num ${net == null ? 'muted' : net >= 0 ? 'profit' : 'loss'}">${net == null ? '–' : (net >= 0 ? '+' : '') + fmt(net)}</td>
        <td class="muted">${p.soldAt ? ago(p.boughtAt - (Date.now() - p.soldAt)) : ago(p.boughtAt)}</td>`;
      tb.appendChild(tr);
    }
  }
  function logEvent(text) {
    const d = document.createElement('div'); d.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    $('#events').prepend(d);
  }

  // ---- bot ----
  let botState = null;
  function renderBot(b) {
    botState = b;
    const svc = b.service || {}, br = b.bridge || {}, ab = b.autobuy || {}, pc = b.pacing || {};
    const loginOn = svc.desired === 'on';
    $('#loginState').textContent = svc.available === false ? 'not configured' : `${loginOn ? 'ON' : 'OFF'} · service ${svc.active || '?'}`;
    $('#loginState').className = loginOn ? 'on' : 'off';
    $('#loginSub').textContent = svc.pausedBy ? `stopped by ${svc.pausedBy}` : svc.lastError ? svc.lastError : loginOn ? 'The bot account logs in when the service is active.' : 'The bot process is stopped; the account is not logged in.';
    $('#autobuyState').textContent = ab.enabled ? 'ON' : 'OFF';
    $('#autobuyState').className = ab.enabled ? 'on' : 'off';
    $('#autobuySub').textContent = ab.enabled ? `forwarding flips ≥ ${fmt(ab.minProfit)} / ${Math.round(ab.minProfitPercent * 100)}% · risk ≤ ${ab.maxRisk}${ab.maxPrice ? ' · ≤ ' + fmt(ab.maxPrice) : ''}${br.lastRejectReason ? ' · last skip: ' + br.lastRejectReason : ''}` : 'Flips are shown but not sent to the bot.';
    $('#pacingState').textContent = pc.enabled ? `ON · ${pc.phase}${pc.phaseEndsAt ? ' until ' + new Date(pc.phaseEndsAt).toLocaleTimeString() : ''}` : 'off';
    $('#pacingSub').textContent = pc.enabled ? `${Math.round((pc.onlineMsToday || 0) / 60000)} min online today${pc.dailyCapMinutes ? ' of ' + pc.dailyCapMinutes : ''}${pc.humanize ? ' · humanization on' : ''}` : 'Configure under Settings → Pacing.';
    const card = (k, v, cls = '') => `<div class="card"><div class="v ${cls}">${v}</div><div class="k">${k}</div></div>`;
    $('#botSummary').innerHTML = card('bots connected', (br.bots || []).length) + card('flips forwarded', br.flipsForwarded || 0) + card('flips skipped', br.flipsRejected || 0) + card('waiting to sell', (br.pending || []).length);
    const tb = $('#bots tbody'); tb.innerHTML = '';
    for (const x of br.bots || []) {
      const tr = document.createElement('tr');
      const inv = (x.inventory || []).filter((i) => i.name).map((i) => esc(i.name) + (i.count > 1 ? ' ×' + i.count : ''));
      tr.innerHTML = `<td>${esc(x.player)}<div class="sub">${esc(x.uuid || 'resolving uuid…')}</div></td><td class="muted">${esc(x.version)}</td><td class="num">${x.purse != null ? fmt(x.purse) : '–'}${x.purseAt ? `<div class="sub">${ago(x.purseAt)} ago</div>` : ''}</td><td>${esc(x.location || '–')}</td><td class="num">${x.flipsSent}</td><td class="num">${x.buysLastHour}</td><td class="small">${inv.length ? inv.join(', ') : '<span class="muted">' + (x.inventoryAt ? 'empty' : 'not uploaded yet') + '</span>'}</td><td class="muted">${ago(x.lastSeen)} ago</td>`;
      tb.appendChild(tr);
    }
    $('#botsEmpty').style.display = (br.bots || []).length ? 'none' : '';
    const pb = $('#pendingSales tbody'); pb.innerHTML = '';
    for (const p of br.pending || []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(p.itemName)}</td><td class="num">${fmt(p.cost)}</td><td class="num">${p.target ? fmt(p.target) : '–'}</td><td class="num">${p.lastPrice ? fmt(p.lastPrice) : '<span class="muted">not yet</span>'}</td><td class="num">${p.listings}</td><td class="muted">${esc(p.note || (p.lastListedAt ? 'listed ' + ago(p.lastListedAt) + ' ago' : 'waiting for the bot'))}</td>`;
      pb.appendChild(tr);
    }
    const lg = $('#botLog'); lg.innerHTML = '';
    for (const l of [...(br.log || [])].reverse()) { const d = document.createElement('div'); d.className = l.level; d.textContent = `${new Date(l.ts).toLocaleTimeString()} ${l.text}`; lg.appendChild(d); }
  }
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bot]'); if (!b) return;
    const action = b.dataset.bot;
    if (action === 'login-on' && !confirm('Start the bot service? The bot account will log in to Hypixel. Automated purchasing is against Hypixel\'s rules.')) return;
    if (action === 'autobuy-on' && !confirm('Forward flips to the bot for purchase?')) return;
    send({ type: 'botControl', action });
  });
  $('#botCmdSend').addEventListener('click', () => { const t = $('#botCmd').value.trim(); if (!t) return; send({ type: 'botControl', action: 'execute', text: t }); $('#botCmd').value = ''; });

  // ---- status ----
  function renderStatus(s) {
    const stat = (label, value, title) => `<span class="stat" title="${esc(title)}"><span class="k">${label}</span><b>${value}</b></span>`;
    statsEl.innerHTML =
      stat('API refresh', s.apiLastUpdated ? ago(s.apiLastUpdated) + ' ago' : '–', "Time since Hypixel's last auction-house refresh. Flips can only appear once a minute, right after this.") +
      stat('Detect lag', s.detectLagMs ? s.detectLagMs + ' ms' : '–', "How long after Hypixel's refresh timestamp the server saw the new data. 4–5 s is Hypixel's CDN delay; everyone sees it then.") +
      stat('Auctions', s.totalAuctions.toLocaleString(), 'Active auctions in the latest snapshot.') +
      stat('New', s.newAuctions, 'Listings that appeared in the latest refresh.') +
      stat('Flips', s.flipsTotal, 'Flips found since the server started.') +
      stat('Sales history', s.salesTracked.toLocaleString(), 'Sold auctions recorded in our own price history (the basis for MEDIAN flips). Grows every minute.') +
      stat('Coflnet prices', s.coflnet ? s.coflnet.cacheSize : 0, 'Item prices cached from the Coflnet API, used as a reference where our own history is still thin.') +
      stat('Bazaar flips', s.bazaarFlips || 0, 'Bazaar products with a positive order spread, before your filters.') +
      stat('Clients', s.clients || 0, 'Connected browser tabs and mods.') +
      stat('Auto-buy', `${s.autobuy ? 'ON' : 'off'} · ${s.bots || 0} bot${s.bots === 1 ? '' : 's'}`, 'Purchase switch and connected bots. Login switch: ' + (s.botService || 'n/a'));
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
    form.blacklist.value = rulesToText(s.blacklist);
    form.whitelist.value = rulesToText(s.whitelist);
    form.bzMinProfitPerHour.value = s.bazaar.minProfitPerHour;
    form.bzMinProfitPercent.value = +(s.bazaar.minProfitPercent * 100).toFixed(2);
    form.bzMaxPrice.value = s.bazaar.maxPrice;
    form.bzMinVolumeWeek.value = s.bazaar.minVolumeWeek;
    form.bzMaxRisk.value = s.bazaar.maxRisk;
    const ab = s.autobuy || {}, pc = s.pacing || {};
    form.abMinProfit.value = ab.minProfit; form.abMinProfitPercent.value = Math.round((ab.minProfitPercent || 0) * 100); form.abMaxPrice.value = ab.maxPrice; form.abMaxRisk.value = ab.maxRisk;
    form.abPurseReserve.value = ab.purseReserve; form.abMaxBuysPerHour.value = ab.maxBuysPerHour; form.abBedDelayMs.value = ab.bedDelayMs;
    form.abRequireHistory.checked = ab.requireHistory !== false; form.abRequireOwnHistory.checked = ab.requireOwnHistory === true; form.abAutoSell.checked = ab.autoSell !== false;
    form.abUndercut.value = +((ab.undercutPercent || 0) * 100).toFixed(2); form.abListHours.value = ab.listHours; form.abWebhook.value = ab.webhookUrl || '';
    form.pcEnabled.checked = pc.enabled === true; form.pcMinSession.value = pc.minSessionMinutes; form.pcMaxSession.value = pc.maxSessionMinutes; form.pcMinBreak.value = pc.minBreakMinutes; form.pcMaxBreak.value = pc.maxBreakMinutes;
    form.pcDaily.value = pc.dailyOnlineMinutes; form.pcHumanize.checked = pc.humanize === true; form.pcHumanMinInterval.value = pc.humanMinIntervalMinutes; form.pcHumanMaxInterval.value = pc.humanMaxIntervalMinutes;
    form.pcHumanMinBreak.value = pc.humanMinBreakMinutes; form.pcHumanMaxBreak.value = pc.humanMaxBreakMinutes;
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let blacklist, whitelist;
    try { blacklist = textToRules(form.blacklist.value); whitelist = textToRules(form.whitelist.value); }
    catch (err) { $('#saveMsg').textContent = 'Rule JSON error: ' + err.message; return; }
    const patch = {
      minProfit: Number(form.minProfit.value), minProfitPercent: Number(form.minProfitPercent.value) / 100,
      maxPrice: Number(form.maxPrice.value), minSalesPerDay: Number(form.minSalesPerDay.value), maxKeyTier: Number(form.maxKeyTier.value),
      maxRisk: form.maxRisk.value, kinds: { SNIPE: form.SNIPE.checked, MEDIAN: form.MEDIAN.checked }, whitelistOnly: form.whitelistOnly.checked,
      blacklist, whitelist,
      bazaar: { minProfitPerHour: Number(form.bzMinProfitPerHour.value), minProfitPercent: Number(form.bzMinProfitPercent.value) / 100, maxPrice: Number(form.bzMaxPrice.value), minVolumeWeek: Number(form.bzMinVolumeWeek.value), maxRisk: form.bzMaxRisk.value },
      // The enabled switch itself is only changed from the Bot tab.
      autobuy: { ...(settings.autobuy || {}), minProfit: Number(form.abMinProfit.value), minProfitPercent: Number(form.abMinProfitPercent.value) / 100, maxPrice: Number(form.abMaxPrice.value), maxRisk: form.abMaxRisk.value,
        purseReserve: Number(form.abPurseReserve.value), maxBuysPerHour: Number(form.abMaxBuysPerHour.value), bedDelayMs: Number(form.abBedDelayMs.value), requireHistory: form.abRequireHistory.checked, requireOwnHistory: form.abRequireOwnHistory.checked,
        autoSell: form.abAutoSell.checked, undercutPercent: Number(form.abUndercut.value) / 100, listHours: Number(form.abListHours.value), webhookUrl: form.abWebhook.value.trim() },
      pacing: { enabled: form.pcEnabled.checked, minSessionMinutes: Number(form.pcMinSession.value), maxSessionMinutes: Number(form.pcMaxSession.value), minBreakMinutes: Number(form.pcMinBreak.value), maxBreakMinutes: Number(form.pcMaxBreak.value),
        dailyOnlineMinutes: Number(form.pcDaily.value), humanize: form.pcHumanize.checked, humanMinIntervalMinutes: Number(form.pcHumanMinInterval.value), humanMaxIntervalMinutes: Number(form.pcHumanMaxInterval.value),
        humanMinBreakMinutes: Number(form.pcHumanMinBreak.value), humanMaxBreakMinutes: Number(form.pcHumanMaxBreak.value) },
    };
    send({ type: 'settings', settings: patch });
    send({ type: 'bazaar', limit: 50 });
    $('#saveMsg').textContent = 'Saved'; setTimeout(() => ($('#saveMsg').textContent = ''), 1500);
  });

  // ---- packs & import ----
  function renderPacks(packs) {
    const el = $('#packs');
    el.innerHTML = packs.length ? packs.map((p) => `<button type="button" class="pack" data-id="${esc(p.id)}" title="${esc(p.description)}">Load ${esc(p.name)} (${p.rules} rules)</button>`).join(' ') : '<span class="muted">no packs found</span>';
  }
  $('#packs').addEventListener('click', (e) => {
    const b = e.target.closest('button.pack'); if (!b) return;
    const mode = $('#importMode').value;
    if (mode === 'replace' && !confirm('Replace all current blacklist and whitelist rules with this pack?')) return;
    send({ type: 'pack', pack: b.dataset.id, mode });
    $('#importMsg').textContent = 'loading pack…';
  });
  $('#importBtn').addEventListener('click', () => {
    let data;
    try { data = JSON.parse($('#importText').value); } catch (err) { $('#importMsg').textContent = 'not valid JSON: ' + err.message; return; }
    const mode = $('#importMode').value;
    if (mode === 'replace' && !confirm('Replace all current blacklist and whitelist rules with the imported ones?')) return;
    send({ type: 'import', mode, data });
    $('#importMsg').textContent = 'importing…';
  });
  function renderImport(r) {
    $('#importMsg').textContent = `${r.imported} rules imported (${r.blacklist.length} blacklist, ${r.whitelist.length} whitelist, ${r.whitelist.filter((x) => x.finder).length} finders), ${r.skipped.length} skipped`;
    const uns = Object.entries(r.unsupported || {}).map(([k, v]) => `${k} (${v})`).join(', ');
    $('#importReport').innerHTML = [
      Object.keys(r.settingsPatch).length ? `Thresholds applied: ${esc(JSON.stringify(r.settingsPatch))}` : '',
      uns ? `Filters without an equivalent here, dropped from their entries: ${esc(uns)}` : '',
      r.skipped.length ? `Skipped: ${r.skipped.slice(0, 15).map((s) => esc(s.entry) + ' — ' + esc(s.reason)).join('; ')}${r.skipped.length > 15 ? ' …' : ''}` : '',
      ...r.notes.map(esc),
    ].filter(Boolean).map((x) => `<div>${x}</div>`).join('');
  }

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
        flipsBody.innerHTML = ''; flips.length = 0; m.flips.forEach((f) => addFlip(f, false)); renderBazaar(m.bazaar || []); renderPacks(m.packs || []);
        if (m.bot) renderBot(m.bot);
        fetch('/api/players' + (token ? `?token=${encodeURIComponent(token)}` : '')).then((r) => r.json()).then((ps) => { $('#players').innerHTML = ps.map((p) => `<option value="${p}">`).join(''); }).catch(() => {});
      }
      else if (m.type === 'flip') addFlip(m.flip, true);
      else if (m.type === 'status') renderStatus(m.status);
      else if (m.type === 'settings') { settings = m.settings; fillForm(settings); }
      else if (m.type === 'bazaar') renderBazaar(m.flips);
      else if (m.type === 'profit') renderProfit(m.summary);
      else if (m.type === 'purchase') { logEvent(`bought ${m.purchase.itemName} for ${fmt(m.purchase.price)}${m.flip ? ` (predicted +${fmt(m.flip.profit)})` : ''}`); }
      else if (m.type === 'sold') { logEvent(`sold ${m.purchase.itemName} for ${fmt(m.purchase.soldPrice)} (paid ${fmt(m.purchase.price)})`); }
      else if (m.type === 'import') renderImport(m.report);
      else if (m.type === 'bot') renderBot(m.bot);
      else if (m.type === 'msg') { logEvent(m.text); if (/pack/.test(m.text)) $('#importMsg').textContent = m.text; }
    };
  }
  setInterval(() => { for (const tr of flipsBody.children) tr.querySelector('.age').textContent = ago(Number(tr.dataset.ts)); }, 5000);
  connect();
})();
