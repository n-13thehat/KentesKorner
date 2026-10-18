/* Kente's Korner — Settings engine and app state. */
'use strict';

/* ══════════════════════════════════════════
   SETTINGS ENGINE
══════════════════════════════════════════ */
const SETTINGS_CONFIG = [
  { group:'DISPLAY', items:[
    { label:'CRT Scanlines',    key:'crtScanlines', type:'toggle',             default:true  },
    { label:'Vignette Effect',  key:'vignette',     type:'toggle',             default:true  },
    { label:'Room Theme',       key:'roomTheme',    type:'cycle', opts:['DEFAULT','NEON','MIDNIGHT','CRIMSON','MATRIX','VAPOR','AMBER','ICE','COPPER'], default:'DEFAULT' },
  ]},
  { group:'WINDOW', items:[
    { label:'Full Screen',      key:'fullScreen',   type:'toggle',             default:false },
  ]},
  { group:'AUDIO', items:[
    { label:'UI Sounds',        key:'uiSounds',     type:'toggle',             default:true  },
    { label:'Ambient Hum',      key:'ambientHum',   type:'toggle',             default:true  },
    { label:'Volume',           key:'volume',       type:'cycle', opts:[20,40,60,80,100],     default:80 },
  ]},
  { group:'CAMERA', items:[
    { label:'VR Parallax',      key:'cameraVR',        type:'toggle', default:false },
    { label:'Wii Pointer',      key:'wiiPointer',      type:'toggle', default:false },
    { label:'Calibrate Controls', key:'calibrate',     type:'action', value:'OPEN ›' },
  ]},
  { group:'THEATER', items:[
    { label:'Sandbox Mode',     key:'theaterSandbox',  type:'cycle',
      opts:['OFF','PERMISSIVE','STRICT','ULTRA'], default:'OFF' },
    { label:'Ad Shield',        key:'theaterAdShield', type:'toggle', default:true },
  ]},
  { group:'SYSTEM', items:[
    { label:'Tier',             key:null,           type:'readonly', value:'LITE'             },
    { label:'Build',            key:null,           type:'readonly', value:'01'               },
    { label:'Sacrifice Chamber',key:'openChamber',  type:'action',   value:'ENTER \u203A'     },
    { label:'Reset Systems',    key:'resetSystems', type:'action',   value:'FACTORY RESET'   },
    { label:'USB Boot Guide',   key:'usbGuide',     type:'action',   value:'VIEW \u203A'      },
    { label:'PS4 Console Mod',  key:'ps4Guide',     type:'action',   value:'VIEW \u203A'      },
  ]},
  { group:'ABOUT', items:[
    { label:'Shell Version',    key:null,           type:'readonly', value:'2.0.0'            },
    { label:'Base OS',          key:null,           type:'readonly', value:'Alpine Linux'     },
    { label:'Library Entries',  key:null,           type:'readonly', value: () => `${(window.KenteLibrary?.games||[]).length} GAMES` },
    { label:'Discord',          key:null,           type:'readonly', value:'artkeys.json \u2192 discordAppId' },
  ]},
];

const SETTINGS_DEFAULTS = { crtScanlines:true, vignette:true, roomTheme:'DEFAULT', fullScreen:false, uiSounds:true, ambientHum:true, volume:80, cameraVR:false, wiiPointer:false, theaterSandbox:'OFF', theaterAdShield:true };
let appSettings = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('kente_settings')||'{}');
    // Migrate the boolean strictSandbox flag → theaterSandbox enum.
    if ('strictSandbox' in raw && !('theaterSandbox' in raw)) {
      raw.theaterSandbox = raw.strictSandbox ? 'STRICT' : 'OFF';
      delete raw.strictSandbox;
    }
    return {...SETTINGS_DEFAULTS, ...raw};
  } catch { return {...SETTINGS_DEFAULTS}; }
})();

function saveSettings() {
  try { localStorage.setItem('kente_settings', JSON.stringify(appSettings)); } catch(e) {
    console.warn('[saveSettings]', e);
  }
  // Mirror to Batocera shadow when native server is running
  if (KENTE_SERVER_ONLINE) {
    fetch(`${KENTE_SERVER_URL}/api/settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(appSettings),
    }).catch(() => {}); // fire-and-forget — never block the UI
  }
}

function applySetting(key) {
  switch(key) {
    case 'crtScanlines': document.body.classList.toggle('crt-off', !appSettings.crtScanlines); break;
    case 'vignette':     document.body.classList.toggle('vignette-off', !appSettings.vignette); break;
    case 'roomTheme': {
      const _t = appSettings.roomTheme === 'DEFAULT' ? '' : appSettings.roomTheme.toLowerCase();
      document.body.dataset.theme = _t;
      _t === 'matrix' ? MatrixRain.start() : MatrixRain.stop();
      break;
    }
    case 'fullScreen': {
      const fs = !!appSettings.fullScreen;
      // Desktop app (Electron): toggle the native window fullscreen state.
      if (window.electronAPI?.setFullScreen) {
        window.electronAPI.setFullScreen(fs);
      } else {
        // Browser: best-effort only (requires a user gesture in most browsers).
        try {
          if (fs) document.documentElement.requestFullscreen?.().catch(()=>{});
          else    document.exitFullscreen?.().catch(()=>{});
        } catch {}
      }
      break;
    }
    case 'volume':       KenteAudio.setMasterVol(appSettings.volume / 100); break;
    case 'ambientHum':   KenteAudio.setHumVol(appSettings.ambientHum ? 0.018 : 0); break;
    case 'cameraVR':
      // CameraManager may not exist yet during early boot — guard with typeof
      if (typeof CameraManager !== 'undefined') {
        appSettings.cameraVR ? CameraManager.startVR() : CameraManager.stopVR();
      }
      break;
    case 'wiiPointer':
      if (typeof CameraManager !== 'undefined') {
        appSettings.wiiPointer ? CameraManager.startWiiPointer() : CameraManager.stopWiiPointer();
      }
      break;
  }
}
function applyAllSettings() { Object.keys(appSettings).forEach(applySetting); }

// Sync fullscreen state when toggled via F11 / OS window controls in Electron.
try {
  window.electronAPI?.onFullScreenChanged?.(fs => {
    const next = !!fs;
    if (appSettings.fullScreen === next) return;
    appSettings.fullScreen = next;
    saveSettings();
    const valEl = document.querySelector('.settings-item[data-setting="fullScreen"] .settings-item-value');
    if (valEl) valEl.textContent = next ? 'ON' : 'OFF';
  });
} catch {}

/* ── STATE ── */
let state = {
  screen: 'splash',   // splash | room | menu
  activeMenu: null,
  focusedTV: null,
  focusIndex: 0,
  transitioning: false,
  // Restore last-used profile from localStorage
  activeProfile: (() => { try { return localStorage.getItem('kente_profile') || 'player1'; } catch { return 'player1'; } })()
};
