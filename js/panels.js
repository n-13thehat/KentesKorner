/* Kente's Korner — Downloads panels, guide overlay, emulator releases, download-center launch. */
'use strict';

/* ══════════════════════════════════════════
   ARCHIVE DOWNLOADS PANEL
══════════════════════════════════════════ */

// System color map for the system badge in each row
const DL_SYS_COLORS = {
  nes: '#c0392b', snes: '#8e44ad', gameboy: '#2980b9', gbc: '#27ae60',
  gba: '#e67e22', genesis: '#16a085', mastersys: '#1abc9c',
  gamegear: '#2ecc71', segacd: '#8e44ad', sega32x: '#e74c3c',
  n64: '#2c3e50', ps1: '#2980b9', ps2: '#2471a3', gamecube: '#6c3483',
  nds: '#9b59b6', wii: '#7f8c8d', psp: '#1a5276',
  dreamcast: '#c0392b', saturn: '#7d3c98',
  atari2600: '#e74c3c', atari7800: '#c0392b', turbografx: '#b7950b',
  neogeo: '#922b21',
  // Tier 4-5 native-only systems
  xbox:    '#107c10', xbox360: '#52b043',
  ps3:     '#003087',
  wiiu:    '#009ac7',
  switch:  '#e4000f',
};

/* ══════════════════════════════════════════
   DOWNLOAD CONTROL CENTER
   PS5-style right-side panel. Shows live
   download progress, queue, and completed
   items with a LAUNCH button.
══════════════════════════════════════════ */
/* ══════════════════════════════════════════
   GUIDE OVERLAY
   Opened from Settings › SYSTEM → USB Boot Guide / PS4 Console Mod
   type: 'usb' | 'ps4'
══════════════════════════════════════════ */
const GUIDE_CONTENT = {
  usb: {
    title: 'USB BOOT GUIDE',
    subtitle: 'Make any PC or laptop boot KenteOS from a USB drive',
    sections: [
      {
        heading: 'WHAT YOU NEED',
        steps: [
          'A USB drive — 4 GB minimum (8 GB+ recommended)',
          'WSL (Windows Subsystem for Linux) installed on your PC',
          'Admin PowerShell for writing to the drive',
          'The KenteCorner project folder (this app)',
        ],
      },
      {
        heading: 'STEP 1 — BUILD THE ISO (WSL Terminal)',
        code: 'bash build/create-iso.sh',
        note: 'Creates dist/KenteOS.iso and dist/kente.squashfs. Takes ~5–10 minutes first run.',
      },
      {
        heading: 'STEP 2 — WRITE TO USB (Admin PowerShell)',
        code: '.\\build\\write-usb.ps1 -Mode PC',
        note: 'You will be prompted to choose your USB drive from a list. All existing data on the USB will be erased.',
      },
      {
        heading: 'STEP 3 — BOOT FROM USB',
        steps: [
          'Plug the USB into the target PC',
          'Power on and press the boot menu key: F12 (Dell/Lenovo), F11 (MSI), F9 (HP), ESC/DEL (others)',
          'Select your USB drive from the boot menu list',
          'KenteOS boots in about 15 seconds',
        ],
      },
      {
        heading: 'WHAT HAPPENS ON BOOT',
        steps: [
          'Alpine Linux minimal environment loads from the USB',
          'X11 + Openbox window manager start automatically',
          "Kente's Korner launches full-screen",
          'Your settings, favorites, and saves live on the USB — portable between PCs',
        ],
      },
      {
        heading: 'WANT PC + PS4 ON THE SAME USB?',
        code: '.\\build\\write-usb.ps1 -Mode Both',
        note: 'Writes a FAT32 partition with GRUB (PC boot) AND the PS4 kernel payload side by side.',
      },
    ],
  },

  ps4: {
    title: 'PS4 CONSOLE MOD',
    subtitle: 'Boot KenteOS from USB on your jailbroken PlayStation 4',
    sections: [
      {
        heading: 'WHAT IS THIS?',
        steps: [
          "Turns your PS4 into a full KenteOS retro gaming station using Linux kexec",
          'The PS4 boots our custom Alpine Linux image from your USB drive',
          "Kente's Korner launches on your TV via HDMI — just like a real console",
          'Your PS4 OS and saves are untouched — remove the USB to return to normal',
        ],
      },
      {
        heading: 'REQUIREMENTS',
        steps: [
          'PS4 with firmware 5.05 — 11.00 (PPPwn or GoldHEN jailbreak)',
          'GoldHEN 2.x or PPPwn exploit active on the console',
          'USB drive with KenteOS PS4 payload (written from this PC)',
          'WSL on your Windows PC for building the payload',
        ],
      },
      {
        heading: 'SUPPORTED FIRMWARE',
        note: '5.05 \u00B7 6.72 \u00B7 7.02 \u00B7 7.55 \u00B7 8.00 \u00B7 8.50 \u00B7 9.00 \u00B7 9.60 \u00B7 10.01 \u00B7 11.00',
      },
      {
        heading: 'STEP 1 — BUILD THE PS4 KERNEL PAYLOAD (WSL)',
        code: 'bash build/create-ps4-payload.sh',
        note: 'Downloads a PS4-patched Linux kernel (bzImage) and builds a custom initramfs that finds and mounts kente.squashfs from your USB.',
      },
      {
        heading: 'STEP 2 — BUILD THE SYSTEM IMAGE (WSL)',
        code: 'bash build/create-iso.sh',
        note: 'Creates dist/kente.squashfs — the compressed KenteOS root filesystem.',
      },
      {
        heading: 'STEP 3 — WRITE TO USB (Admin PowerShell)',
        code: '.\\build\\write-usb.ps1 -Mode PS4',
        note: 'Formats USB as FAT32 and copies: bzImage, initramfs.cpio.gz, bootargs.txt, kente.squashfs. Takes about 2–3 minutes.',
      },
      {
        heading: 'STEP 4 — BOOT ON THE PS4',
        steps: [
          'Activate your jailbreak — run PPPwn or load GoldHEN',
          'Plug the KenteOS USB into the PS4 (any port)',
          'Open GoldHEN \u2192 BinLoader (or use a PS4-compatible browser payload)',
          'Visit ps4boot.github.io and select your exact firmware version',
          'The page loads the kexec payload — it will find the USB automatically',
          'PS4 screen goes black, then KenteOS boots \u2192 X11 starts \u2192 Kente\u2019s Korner appears on your TV',
        ],
      },
      {
        heading: 'HOW THE BOOT CHAIN WORKS',
        steps: [
          'GoldHEN / kexec payload reads bzImage + bootargs.txt from the FAT32 USB',
          'kexec hands control to the custom PS4 Linux kernel (AMD GCN GPU support)',
          'initramfs init script scans all drives for kente.squashfs',
          'squashfs is loop-mounted with an overlayfs writable layer for saves',
          'switch_root hands off to Alpine Linux \u2192 X11 \u2192 Openbox \u2192 Kente\u2019s Korner',
        ],
      },
    ],
  },
};

function _buildGuideHTML(guide) {
  const sections = guide.sections.map(s => {
    let body = '';
    if (s.steps)  body += `<ul class="guide-steps">${s.steps.map(t => `<li>${t}</li>`).join('')}</ul>`;
    if (s.code)   body += `<div class="guide-code"><span class="guide-code-prompt">$</span> ${escHtml(s.code)}</div>`;
    if (s.note)   body += `<p class="guide-note">${s.note}</p>`;
    return `<div class="guide-section"><h3 class="guide-section-title">${s.heading}</h3>${body}</div>`;
  }).join('');
  return `
    <div class="guide-header">
      <h2 class="guide-title">${guide.title}</h2>
      <p class="guide-subtitle">${guide.subtitle}</p>
    </div>
    <div class="guide-body">${sections}</div>`;
}

function openGuide(type) {
  const guide = GUIDE_CONTENT[type];
  if (!guide) return;
  const overlay = document.getElementById('guide-overlay');
  const panel   = document.getElementById('guide-panel');
  if (!overlay || !panel) return;
  panel.innerHTML = _buildGuideHTML(guide);
  overlay.classList.add('active');
  panel.scrollTop = 0;

  const close = () => {
    overlay.classList.remove('active');
    overlay.removeEventListener('click', onOverlayClick);
    GamepadManager?.resetFocus?.();
  };
  const onOverlayClick = e => { if (e.target === overlay) close(); };
  overlay.addEventListener('click', onOverlayClick);

  // Close button injected into header
  const closeBtn = document.createElement('button');
  closeBtn.className = 'guide-close-btn';
  closeBtn.textContent = '\u2715 CLOSE';
  closeBtn.onclick = close;
  panel.querySelector('.guide-header')?.appendChild(closeBtn);
}

function openDownloadCenter() {
  KenteAudio.click();
  const overlay = document.getElementById('downloads-overlay');
  overlay.classList.add('active');
  DownloadManager.render();
  document.getElementById('dl-close').onclick = () => {
    overlay.classList.remove('active');
    GamepadManager.resetFocus();
  };
}

/* ══════════════════════════════════════════
   KENTE'S REPOSITORY
   Left-side slide panel. Fetches the public
   GitHub repo n-13thehat/KentesKorner via the
   GitHub REST API and shows ROMs, ISOs, and
   emulator releases available for download.
   • ROM/ISO → queued in DownloadManager
   • Emulator → browser file download (to the
     user's default downloads folder)
══════════════════════════════════════════ */
const KENTE_REPO_API  = 'https://api.github.com/repos/n-13thehat/KentesKorner';
const KENTE_REPO_URL  = 'https://github.com/n-13thehat/KentesKorner';

// File extension → systemId
const _REPO_EXT_SID = {
  '.nes':'nes',  '.sfc':'snes',  '.smc':'snes',  '.gba':'gba',
  '.gbc':'gbc',  '.gb':'gameboy','.nds':'nds',    '.psp':'psp',
  '.cso':'psp',  '.iso':'ps1',   '.bin':'ps1',    '.cue':'ps1',
  '.gcm':'gamecube', '.n64':'n64', '.z64':'n64',  '.v64':'n64',
  '.md':'genesis',   '.smd':'genesis', '.sms':'mastersys', '.gg':'gamegear',
  '.32x':'sega32x',  '.pce':'tgfx', '.ngp':'neogeo', '.ws':'wonderswan',
  '.vb':'virtualboy','.lnx':'lynx', '.a26':'atari2600','.a78':'atari7800',
  '.chd':'ps1',  '.nsp':'switch','.xci':'switch', '.nsz':'switch',
};

// Known emulator folder names and their display info
const _REPO_EMU_DIRS = {
  'dolphin':{ name:'Dolphin',    icon:'🐬', systems:'GameCube · Wii',     sid:'gamecube' },
  'pcsx2':  { name:'PCSX2',      icon:'🎮', systems:'PlayStation 2',       sid:'ps2'      },
  'psx':    { name:'PCSX2',      icon:'🎮', systems:'PlayStation 2',       sid:'ps2'      },
  'rpcs3':  { name:'RPCS3',      icon:'🎮', systems:'PlayStation 3',       sid:'ps3'      },
  'cemu':   { name:'Cemu',       icon:'🎮', systems:'Wii U',               sid:'wiiu'     },
  'ryujinx':{ name:'Ryujinx',    icon:'🎮', systems:'Nintendo Switch',     sid:'switch'   },
};

function _repoExt(filename) {
  const d = filename.lastIndexOf('.');
  return d >= 0 ? filename.slice(d).toLowerCase() : '';
}
function _repoSid(filename) { return _REPO_EXT_SID[_repoExt(filename)] || null; }
function _repoFmtSize(b) {
  if (!b) return '';
  if (b < 1048576)      return `${(b/1024).toFixed(0)} KB`;
  if (b < 1073741824)   return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}

async function _repoFetch(endpoint) {
  const r = await fetch(KENTE_REPO_API + endpoint, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) { const t = await r.text().catch(()=>''); throw new Error(`GitHub ${r.status}: ${t.slice(0,120)}`); }
  return r.json();
}

async function _repoGetAll() {
  // Fetch local library + GitHub in parallel
  const [localData, root, releases] = await Promise.all([
    KENTE_SERVER_ONLINE
      ? fetch(`${KENTE_SERVER_URL}/api/local-library`).then(r => r.json()).catch(() => ({ emulators: [], roms: [] }))
      : Promise.resolve({ emulators: [], roms: [] }),
    _repoFetch('/contents').catch(() => []),
    _repoFetch('/releases').catch(() => []),
  ]);

  const ghRoms = [];
  const ghEmus = [];

  // Walk GitHub root — one level deep
  for (const item of root) {
    if (item.type === 'dir') {
      const key = item.name.toLowerCase();
      if (_REPO_EMU_DIRS[key]) {
        ghEmus.push({ kind: 'folder', ...item, info: _REPO_EMU_DIRS[key] });
        continue;
      }
      const children = await _repoFetch(`/contents/${item.path}`).catch(() => []);
      for (const c of children) {
        if (c.type !== 'file') continue;
        const sid = _repoSid(c.name);
        if (sid) ghRoms.push({ ...c, sid });
      }
    } else if (item.type === 'file') {
      const sid = _repoSid(item.name);
      if (sid) ghRoms.push({ ...item, sid });
    }
  }

  // GitHub release assets
  for (const rel of releases) {
    for (const asset of rel.assets || []) {
      const sid    = _repoSid(asset.name);
      const emuKey = Object.keys(_REPO_EMU_DIRS).find(k => asset.name.toLowerCase().includes(k));
      if (emuKey) {
        ghEmus.push({ kind: 'release', name: asset.name, size: asset.size,
                      dl: asset.browser_download_url, tag: rel.tag_name, info: _REPO_EMU_DIRS[emuKey] });
      } else if (sid) {
        ghRoms.push({ name: asset.name, size: asset.size,
                      download_url: asset.browser_download_url, sid, fromRelease: rel.tag_name });
      }
    }
  }

  return {
    localEmus: localData.emulators || [],
    localRoms: localData.roms      || [],
    ghRoms, ghEmus,
  };
}

async function _renderRepoList() {
  const list = document.getElementById('repo-list');
  if (!list) return;
  list.innerHTML = '<div class="repo-scanning">⟳ &nbsp;SCANNING...</div>';

  let data;
  try { data = await _repoGetAll(); }
  catch (e) {
    list.innerHTML = `<div class="repo-error">⚠ COULD NOT LOAD LIBRARY<br><span style="font-size:9px;opacity:0.5">${e.message}</span></div>`;
    return;
  }

  const { localEmus, localRoms, ghRoms, ghEmus } = data;
  let html = '';

  // ── INSTALLED EMULATORS ──────────────────────────────────────────────────
  if (localEmus.length) {
    html += `<div class="repo-section-label">🛠 &nbsp;INSTALLED EMULATORS</div>`;
    for (const e of localEmus) {
      const shortPath = e.path.replace(/.*[/\\](.+[/\\].+)$/, '…/$1');
      html += `
        <div class="repo-card">
          <div class="repo-card-icon">${e.icon}</div>
          <div class="repo-card-info">
            <div class="repo-card-name">${e.name}</div>
            <div class="repo-card-sys">${e.systems}</div>
            <div class="repo-card-tag" title="${escHtml(e.path)}">${escHtml(shortPath)}</div>
          </div>
          <span class="repo-card-btn repo-card-btn-installed">✓ INSTALLED</span>
        </div>`;
    }
  }

  // ── LOCAL ROM LIBRARY ────────────────────────────────────────────────────
  if (localRoms.length) {
    html += `<div class="repo-section-label">📁 &nbsp;LOCAL LIBRARY (${localRoms.length} ROMS)</div>`;
    for (const r of localRoms) {
      const sys = ALL_SYSTEMS?.find(s => s.id === r.systemId);
      const sysLabel = sys?.label || r.systemId.toUpperCase();
      const sizeLabel = r.sizeBytes > 0 ? _repoFmtSize(r.sizeBytes) : 'ON DISK';
      // Build a game-like object so launchNative can find it via find_rom
      const safeTitle = encodeURIComponent(r.title);
      const safeSid   = encodeURIComponent(r.systemId);
      html += `
        <div class="repo-card">
          <div class="repo-card-icon">🎮</div>
          <div class="repo-card-info">
            <div class="repo-card-name">${escHtml(r.title)}</div>
            <div class="repo-card-sys">${escHtml(sysLabel)}</div>
            <div class="repo-card-tag">${escHtml(sizeLabel)}</div>
          </div>
          <button class="repo-card-btn repo-card-btn-play"
            onclick="repoLaunchLocal(decodeURIComponent('${safeTitle}'),decodeURIComponent('${safeSid}'))">▶ PLAY</button>
        </div>`;
    }
  }

  // ── GITHUB — EMULATORS ───────────────────────────────────────────────────
  if (ghEmus.length) {
    html += `<div class="repo-section-label">☁ &nbsp;GITHUB EMULATORS</div>`;
    for (const e of ghEmus) {
      if (e.kind === 'folder') {
        html += `
          <div class="repo-card">
            <div class="repo-card-icon">${e.info.icon}</div>
            <div class="repo-card-info">
              <div class="repo-card-name">${e.info.name}</div>
              <div class="repo-card-sys">${e.info.systems}</div>
              <div class="repo-card-tag">FOLDER · NO RELEASE YET</div>
            </div>
            <a class="repo-card-btn repo-card-btn-dim" href="${KENTE_REPO_URL}/tree/main/${e.path}" target="_blank">BROWSE ↗</a>
          </div>`;
      } else {
        html += `
          <div class="repo-card">
            <div class="repo-card-icon">${e.info.icon}</div>
            <div class="repo-card-info">
              <div class="repo-card-name">${e.info.name}</div>
              <div class="repo-card-sys">${e.info.systems}</div>
              <div class="repo-card-tag">${e.tag || ''} · ${_repoFmtSize(e.size)}</div>
            </div>
            <a class="repo-card-btn" href="${e.dl}" download="${e.name}">↓ INSTALL</a>
          </div>`;
      }
    }
  }

  // ── GITHUB — ROMS ────────────────────────────────────────────────────────
  if (ghRoms.length) {
    html += `<div class="repo-section-label">☁ &nbsp;GITHUB ROMS & ISOS (${ghRoms.length})</div>`;
    for (const r of ghRoms) {
      const title = r.name.replace(/\.[^.]+$/, '');
      const safe  = encodeURIComponent(r.download_url);
      const safeN = encodeURIComponent(r.name);
      html += `
        <div class="repo-card">
          <div class="repo-card-icon">🎮</div>
          <div class="repo-card-info">
            <div class="repo-card-name">${title}</div>
            <div class="repo-card-sys">${(r.sid || '').toUpperCase()}</div>
            <div class="repo-card-tag">${r.fromRelease ? r.fromRelease + ' · ' : ''}${_repoFmtSize(r.size)}</div>
          </div>
          <button class="repo-card-btn"
            onclick="repoDownloadRom(decodeURIComponent('${safe}'),'${r.sid}',decodeURIComponent('${safeN}'))">↓ GET</button>
        </div>`;
    }
  }

  // ── NOTHING AT ALL ───────────────────────────────────────────────────────
  if (!html) {
    html = `
      <div class="repo-empty-state">
        <div class="repo-empty-icon">📦</div>
        <div class="repo-empty-title">LIBRARY EMPTY</div>
        <div class="repo-empty-sub">No ROMs found in roms/ and no emulators installed.<br>
          Add files to <a href="${KENTE_REPO_URL}" target="_blank" style="color:var(--brand)">n-13thehat/KentesKorner ↗</a></div>
      </div>`;
  }

  list.innerHTML = html;
}

function openKenteRepo() {
  KenteAudio.click();
  const overlay = document.getElementById('repo-overlay');
  if (!overlay) return;
  overlay.classList.add('active');
  _renderRepoList();
  document.getElementById('repo-close').onclick = () => {
    overlay.classList.remove('active');
    GamepadManager.resetFocus();
  };
  // Close if backdrop clicked
  overlay.onclick = e => { if (e.target === overlay) { overlay.classList.remove('active'); GamepadManager.resetFocus(); } };
}

function repoDownloadRom(url, sid, filename) {
  // Build a minimal game object — enough for DownloadManager to display and launch
  const title = filename.replace(/\.[^.]+$/, '');
  const sys   = ALL_SYSTEMS.find(s => s.id === sid);
  const game  = { title, systemId: sid, systemLabel: sys?.label || sid.toUpperCase(), img: null };

  DownloadManager.enqueue(game, url, filename);

  // Close repo panel, open Download Center so the user can watch progress
  document.getElementById('repo-overlay')?.classList.remove('active');
  openDownloadCenter();
}

function repoLaunchLocal(title, systemId) {
  // Launch a ROM from the LOCAL LIBRARY section of Kente's Repo panel.
  // Routes the same way as clicking the game in the room:
  //   • Browser-playable (CORE_MAP entry)  → launchWithEmulatorJS (in-window)
  //   • Native-only (no CORE_MAP entry)    → launchNative → Dolphin/PCSX2/etc.
  document.getElementById('repo-overlay')?.classList.remove('active');
  KenteAudio.click();

  const sys  = ALL_SYSTEMS?.find(s => s.id === systemId);
  const game = {
    id:       `local_${systemId}_${title.toLowerCase().replace(/\s+/g, '_')}`,
    title,
    systemId,
    system:   sys?.label || systemId.toUpperCase(),
    tier:     sys?.tier  || 3,
    img:      null,
  };

  // Re-use the same routing logic as launchGame so the experience is identical
  if (CORE_MAP[systemId]) {
    // Browser-playable — EmulatorJS iframe inside the app
    launchWithEmulatorJS(game);
  } else if (KENTE_SERVER_ONLINE) {
    // Native-only — find ROM on disk and open with installed emulator
    launchNative(game, true);
  } else {
    showNativeModeRequired(game);
  }
}

/* ══════════════════════════════════════════
   LAUNCH FROM DOWNLOAD CENTER
   Called when user clicks ▶ LAUNCH on a
   completed download card in the panel.
══════════════════════════════════════════ */
async function launchFromDownloadCenter(dlid) {
  const item = DownloadManager.getAll().find(i => i.id === dlid);
  if (!item || item.status !== 'complete') return;

  // Close the panel before launching
  document.getElementById('downloads-overlay').classList.remove('active');
  KenteAudio.click();
  // Theater audio collision — same hook as launchGame; this entry point
  // skips that path on several branches.
  _silenceTheaterForLaunch();

  const game = findGameForDownload(item.game.systemId, item.filename) || item.game;

  if (serverIsBatocera) {
    // On Batocera the file is in /userdata/roms/ — native launch works immediately
    launchNative(game, true);
    return;
  }

  if (CORE_MAP[game.systemId]) {
    // Browser-playable system — try RomDB handle, then OPFS, then stream from archive
    const handle = await RomDB.get(game.id).catch(() => null);
    if (handle) { launchWithEmulatorJS(game, handle); return; }

    if (navigator?.storage?.getDirectory) {
      try {
        const romsRoot   = await getOPFSLibrary();
        const sysDir     = await romsRoot.getDirectoryHandle(game.systemId, { create: false });
        const opfsHandle = await sysDir.getFileHandle(item.filename);
        await RomDB.set(game.id, opfsHandle, item.filename).catch(() => {});
        ROM_STATUS[game.id] = true;
        refreshGameCardDots();
        launchWithEmulatorJS(game, opfsHandle);
        return;
      } catch { /* fall through to archive stream */ }
    }

    if (item.archiveUrl) {
      showToast('📡 STREAMING FROM ARCHIVE.ORG...');
      launchWithEmulatorJS(game, item.archiveUrl,
        { url: item.archiveUrl, filename: item.filename, systemId: game.systemId });
      return;
    }

    launchGame(game);
    return;
  }

  // Native-only system on non-Batocera host.
  // The ROM was streamed through the server proxy and saved to roms/<system>/.
  // Use launchNative → /api/launch → find_rom() → native emulator (Dolphin, PCSX2, etc.)
  if (KENTE_SERVER_ONLINE) {
    launchNative(game, true);
  } else {
    showNativeModeRequired(game);
  }
}
