/* Kente's Korner — Settings menu and WiFi panel. */
'use strict';

/* ── SETTINGS MENU ── */
function contentSettings() {
  const hwSection = KENTE_SERVER_ONLINE
    ? `<div id="settings-hardware-section">
         <div class="settings-group-label">HARDWARE</div>
         <div class="settings-list" id="settings-hw-list">
           ${['BATOCERA VERSION','STORAGE FREE','STORAGE USED','CONTROLLERS','UPTIME','HOSTNAME'].map(l =>
             `<div class="settings-item" style="cursor:default">
               <span class="settings-item-label">${l}</span>
               <span class="settings-item-value settings-hw-val" data-hw="${l.toLowerCase().replace(/ /g,'-')}">…</span>
             </div>`).join('')}
         </div>
       </div>` : '';

  const networkSection = KENTE_SERVER_ONLINE ? `
    <div class="settings-group-label">NETWORK</div>
    <div class="settings-list" id="settings-network-section">
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">CONNECTION</span>
        <span class="settings-item-value net-status-val" id="net-status-ssid">CHECKING&hellip;</span>
      </div>
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">IP ADDRESS</span>
        <span class="settings-item-value net-status-val" id="net-status-ip">CHECKING&hellip;</span>
      </div>
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">SIGNAL STRENGTH</span>
        <span class="settings-item-value net-status-val" id="net-status-signal">CHECKING&hellip;</span>
      </div>
      <div class="settings-item interactive settings-item--net-action" data-net-action="refresh">
        <span class="settings-item-label">REFRESH STATUS</span>
        <span class="settings-item-value net-scan-value">&#8635; REFRESH</span>
      </div>
      <div class="settings-item interactive settings-item--net-action" data-net-action="scan">
        <span class="settings-item-label">SCAN FOR NETWORKS</span>
        <span class="settings-item-value net-scan-value">SCAN &#9654;</span>
      </div>
      <div class="settings-item interactive settings-item--net-action" data-net-action="disconnect"
           id="net-disconnect-row" style="display:none">
        <span class="settings-item-label">DISCONNECT</span>
        <span class="settings-item-value" style="color:var(--red)">DISCONNECT</span>
      </div>
    </div>
    <div id="wifi-scan-panel" class="wifi-scan-panel"></div>` : '';

  const configSections = SETTINGS_CONFIG.map(g => {
    const rows = g.items.map(item => {
      let displayVal = '';
      let classes    = 'settings-item';
      let dataAttrs  = '';

      if (item.type === 'readonly') {
        displayVal = typeof item.value === 'function' ? item.value() : item.value;
      } else if (item.type === 'toggle') {
        const val  = appSettings[item.key] ?? item.default;
        displayVal = val ? 'ON' : 'OFF';
        classes   += ' interactive';
        dataAttrs  = `data-setting="${item.key}" data-type="toggle"`;
      } else if (item.type === 'cycle') {
        const val  = appSettings[item.key] ?? item.default;
        displayVal = typeof val === 'number' ? val + '%' : val;
        classes   += ' interactive';
        // Use double-quote delimiter + escHtml so option labels containing ' or " never
        // break the attribute.  The browser decodes &quot; → " before JS reads dataset.opts,
        // so JSON.parse(el.dataset.opts) always receives valid JSON.
        dataAttrs  = `data-setting="${item.key}" data-type="cycle" data-opts="${escHtml(JSON.stringify(item.opts))}"`;

      } else if (item.type === 'action') {
        displayVal = item.value;
        classes   += ' settings-item--action interactive';
        dataAttrs  = `data-action="${item.key}"`;
      }

      return `<div class="${classes}" ${dataAttrs}>
        <span class="settings-item-label">${item.label}</span>
        <span class="settings-item-value">${displayVal}</span>
      </div>`;
    }).join('');

    return `<div class="settings-group-label">${g.group}</div>
    <div class="settings-list">${rows}</div>`;
  }).join('') + hwSection;
  // NETWORK is pinned to the top so connection status is visible immediately
  return networkSection + configSections;
}

async function hydrateSettingsMenu() {
  if (!KENTE_SERVER_ONLINE) return;
  // Run hardware info + network status in parallel
  await Promise.all([hydrateHardwareInfo(), hydrateNetworkStatus()]);
}

async function hydrateHardwareInfo() {
  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/system/info`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const MAP = {
      'batocera-version': info.batocera_version || '\u2014',
      'storage-free':     info.disk_free        || '\u2014',
      'storage-used':     info.disk_used_pct != null ? `${info.disk_used_pct}%` : '\u2014',
      'controllers':      info.controllers != null ? `${info.controllers} CONNECTED` : '\u2014',
      'uptime':           info.uptime           || '\u2014',
      'hostname':         info.hostname         || '\u2014',
    };
    document.querySelectorAll('.settings-hw-val[data-hw]').forEach(el => {
      const val = MAP[el.dataset.hw];
      if (val !== undefined) el.textContent = val;
    });
  } catch {
    document.querySelectorAll('.settings-hw-val').forEach(el => el.textContent = '\u2014');
  }
}

async function hydrateNetworkStatus() {
  if (!KENTE_SERVER_ONLINE) return;
  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/network/status`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    const ssidEl  = document.getElementById('net-status-ssid');
    const ipEl    = document.getElementById('net-status-ip');
    const sigEl   = document.getElementById('net-status-signal');
    const discRow = document.getElementById('net-disconnect-row');
    if (ssidEl)  ssidEl.textContent  = s.connected ? (s.ssid || 'CONNECTED') : 'NOT CONNECTED';
    if (ipEl)    ipEl.textContent    = s.ip || (s.connected ? 'ACQUIRING...' : '--');
    if (sigEl)   sigEl.textContent   = s.signal != null ? `${s.signal}%` : '--';
    if (discRow) discRow.style.display = s.connected ? '' : 'none';
  } catch {
    const el = document.getElementById('net-status-ssid');
    if (el) el.textContent = 'UNAVAILABLE';
  }
}

/* ── WiFi scan panel ─────────────────────────────────────────────────────── */
function _sigBars(pct) {
  // Returns 0-4 filled bars based on signal percentage
  const n = pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 35 ? 2 : pct >= 10 ? 1 : 0;
  return [1,2,3,4].map(i =>
    `<span class="sig-bar${i <= n ? ' sig-bar--on' : ''}"></span>`).join('');
}

async function wifiScanAndShow() {
  const panel = document.getElementById('wifi-scan-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="wifi-scanning">SCANNING...</div>';
  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/network/scan`, { signal: _abortTimeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { networks } = await res.json();
    if (!networks || !networks.length) {
      panel.innerHTML = '<div class="wifi-scanning">NO NETWORKS FOUND</div>';
      return;
    }
    panel.innerHTML = networks.map(n => `
      <div class="wifi-item interactive" data-ssid="${escHtml(n.ssid)}"
           data-secured="${n.secured ? '1' : '0'}">
        <span class="wifi-item-name">${escHtml(n.ssid)}</span>
        <span class="wifi-item-meta">
          <span class="sig-bars">${_sigBars(n.signal || 0)}</span>
          ${n.secured ? '<span class="wifi-lock">&#128274;</span>' : ''}
        </span>
      </div>`).join('');
  } catch(e) {
    panel.innerHTML = `<div class="wifi-scanning">SCAN FAILED: ${escHtml(String(e))}</div>`;
  }
}

async function wifiConnect(ssid, secured) {
  let password = '';
  if (secured) {
    // Show inline password modal
    const existing = document.getElementById('wifi-pw-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'wifi-pw-modal';
    modal.className = 'wifi-pw-modal';
    modal.innerHTML = `
      <div class="wifi-pw-box">
        <div class="wifi-pw-title">CONNECT TO ${escHtml(ssid)}</div>
        <input id="wifi-pw-input" class="wifi-pw-input" type="password"
               placeholder="Enter password..." autocomplete="off" maxlength="63">
        <div class="wifi-pw-actions">
          <button class="wifi-pw-btn wifi-pw-btn--ok"  id="wifi-pw-ok">CONNECT</button>
          <button class="wifi-pw-btn wifi-pw-btn--cancel" id="wifi-pw-cancel">CANCEL</button>
        </div>
        <div class="wifi-pw-status" id="wifi-pw-status"></div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('wifi-pw-input').focus();

    password = await new Promise(resolve => {
      document.getElementById('wifi-pw-ok').onclick     = () => resolve(document.getElementById('wifi-pw-input').value);
      document.getElementById('wifi-pw-cancel').onclick = () => resolve(null);
      document.getElementById('wifi-pw-input').addEventListener('keydown', ev => {
        if (ev.key === 'Enter') resolve(document.getElementById('wifi-pw-input').value);
        if (ev.key === 'Escape') resolve(null);
      });
    });
    if (password === null) { modal.remove(); return; }
    document.getElementById('wifi-pw-status').textContent = 'CONNECTING...';
  }

  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/network/connect`,
      { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ ssid, password }) });
    const data = await res.json();
    document.getElementById('wifi-pw-modal')?.remove();
    if (data.success) {
      showToast(`CONNECTED TO ${ssid}`);
      setTimeout(hydrateNetworkStatus, 2500);
    } else {
      showToast(`CONNECT FAILED: ${data.message || 'Unknown error'}`);
    }
  } catch(e) {
    document.getElementById('wifi-pw-modal')?.remove();
    showToast('NETWORK ERROR');
  }
}

async function wifiDisconnect() {
  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/network/disconnect`, { method: 'POST',
      headers: {'Content-Type':'application/json'}, body: '{}' });
    const data = await res.json();
    showToast(data.success ? 'DISCONNECTED' : `DISCONNECT FAILED: ${data.message}`);
    if (data.success) setTimeout(hydrateNetworkStatus, 1500);
  } catch { showToast('NETWORK ERROR'); }
}
