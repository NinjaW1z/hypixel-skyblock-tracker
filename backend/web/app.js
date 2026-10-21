(() => {
  const $ = (s) => document.querySelector(s);
  const tbody = $('#flips tbody');
  const conn = $('#conn');
  const statsEl = $('#stats');
  const form = $('#settingsForm');
  let settings = null;
  let ws;
  let audioCtx;

  const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'b' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
  const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? s.toFixed(0) + 's' : (s / 60).toFixed(0) + 'm'; };

  function beep() {
    if (!settings || !settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.12);
    } catch {}
  }

  function row(f, isNew) {
    const tr = document.createElement('tr');
    if (isNew) tr.className = 'new';
    tr.dataset.ts = f.detectedAt;
    tr.innerHTML = `
      <td class="age">${ago(f.detectedAt)}</td>
      <td><span class="kind ${f.kind}">${f.kind}</span></td>
      <td class="item"><span class="r-${f.rarity}">${esc(f.itemName)}</span>${f.count > 1 ? ' ×' + f.count : ''}<div class="sub">${esc(f.summary || '')}${f.lowestBin ? ' · LBIN ' + fmt(f.lowestBin) : ''}${f.median ? ' · med ' + fmt(f.median) : ''} · tier ${f.keyTier}</div></td>
      <td>${fmt(f.price)}</td>
      <td>${fmt(f.target)}</td>
      <td class="profit">+${fmt(f.profit)}</td>
      <td>${(f.profitPercent * 100).toFixed(0)}%</td>
      <td>${f.salesPerDay || '–'}</td>
      <td class="risk ${f.risk}">${f.risk}</td>
      <td class="muted">${f.latencyMs}ms</td>
      <td><button class="small copy" data-cmd="${f.command}">Copy /viewauction</button></td>`;
    return tr;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  tbody.addEventListener('click', (e) => {
    const b = e.target.closest('button.copy');
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.cmd).then(() => { b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy /viewauction'), 1200); });
  });

  function addFlip(f, isNew) {
    $('#empty').style.display = 'none';
    tbody.prepend(row(f, isNew));
    while (tbody.children.length > 300) tbody.lastChild.remove();
    if (isNew) beep();
  }

  function renderStatus(s) {
    const lag = s.detectLagMs ? `${s.detectLagMs}ms` : '–';
    statsEl.innerHTML = `
      <span>API refresh <b>${s.apiLastUpdated ? ago(s.apiLastUpdated) + ' ago' : '–'}</b></span>
      <span>detect lag <b>${lag}</b></span>
      <span>fetch <b>${s.fetchMs ? s.fetchMs + 'ms' : '–'}</b></span>
      <span>auctions <b>${s.totalAuctions.toLocaleString()}</b></span>
      <span>new/cycle <b>${s.newAuctions}</b></span>
      <span>flips <b>${s.flipsTotal}</b></span>
      <span>sales tracked <b>${s.salesTracked.toLocaleString()}</b></span>
      <span>cycles <b>${s.cycles}</b></span>`;
  }

  function fillForm(s) {
    form.minProfit.value = s.minProfit;
    form.minProfitPercent.value = Math.round(s.minProfitPercent * 100);
    form.maxPrice.value = s.maxPrice;
    form.minSalesPerDay.value = s.minSalesPerDay;
    form.maxKeyTier.value = s.maxKeyTier;
    form.SNIPE.checked = s.kinds.SNIPE;
    form.MEDIAN.checked = s.kinds.MEDIAN;
    form.sound.checked = s.sound;
    form.blacklist.value = s.blacklist.join(', ');
    form.whitelist.value = s.whitelist.join(', ');
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const ids = (v) => v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    const patch = {
      minProfit: Number(form.minProfit.value), minProfitPercent: Number(form.minProfitPercent.value) / 100,
      maxPrice: Number(form.maxPrice.value), minSalesPerDay: Number(form.minSalesPerDay.value), maxKeyTier: Number(form.maxKeyTier.value),
      kinds: { SNIPE: form.SNIPE.checked, MEDIAN: form.MEDIAN.checked }, sound: form.sound.checked,
      blacklist: ids(form.blacklist.value), whitelist: ids(form.whitelist.value),
    };
    ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'settings', settings: patch }));
    $('#saveMsg').textContent = 'Saved'; setTimeout(() => ($('#saveMsg').textContent = ''), 1500);
  });
  $('#settingsBtn').addEventListener('click', () => $('#settings').classList.toggle('hidden'));

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { conn.textContent = 'live'; conn.className = 'pill on'; };
    ws.onclose = () => { conn.textContent = 'offline'; conn.className = 'pill off'; setTimeout(connect, 1500); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello') { settings = m.settings; fillForm(settings); renderStatus(m.status); tbody.innerHTML = ''; m.flips.forEach((f) => addFlip(f, false)); }
      else if (m.type === 'flip') addFlip(m.flip, true);
      else if (m.type === 'status') renderStatus(m.status);
      else if (m.type === 'settings') { settings = m.settings; fillForm(settings); }
    };
  }
  setInterval(() => { for (const tr of tbody.children) tr.querySelector('.age').textContent = ago(Number(tr.dataset.ts)); }, 5000);
  connect();
})();
