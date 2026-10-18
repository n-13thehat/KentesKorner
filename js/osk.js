/* Kente's Korner — On-screen keyboard. */
'use strict';

/* ══════════════════════════════════════════
   KENTE ON-SCREEN KEYBOARD (OSK)
   Themed pop-up keyboard for search inputs.
   While open: global keyboard/gamepad menu
   navigation is gated; only OSK keys move
   focus.  Esc / East button closes.
══════════════════════════════════════════ */
const KenteOSK = (() => {
  const KEY_ROW_DIGITS = '1234567890'.split('');
  const KEY_ROW_TOP    = 'qwertyuiop'.split('');
  const KEY_ROW_MID    = 'asdfghjkl'.split('');
  const KEY_ROW_BOT    = 'zxcvbnm'.split('');

  let _overlay = null;
  let _target  = null;        // <input> being driven
  let _shift   = false;
  let _focus   = { r: 1, c: 0 }; // start on QWERTY row first key
  let _onChangeTimer = null;

  function active() { return !!_overlay; }

  function _commit() {
    // Trigger an "input" event so the search debouncer in hydrateTheaterMenu
    // (and any other listener bound to the input) picks up the change.
    if (!_target) return;
    _target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function _setValue(val) {
    if (!_target) return;
    _target.value = val;
    _renderDisplay();
    _commit();
  }

  function _renderDisplay() {
    if (!_overlay) return;
    const disp = _overlay.querySelector('.osk-display');
    if (!disp) return;
    const v = _target?.value || '';
    disp.innerHTML = v
      ? escHtml(v) + '<span class="osk-caret">▎</span>'
      : '<span class="osk-placeholder">SEARCH TITLES…</span>';
  }

  // Build the 5-row grid of {char?, action?, label, span} cells.
  function _grid() {
    const cap = c => _shift ? c.toUpperCase() : c;
    return [
      KEY_ROW_DIGITS.map(c => ({ char: c, label: c })),
      KEY_ROW_TOP   .map(c => ({ char: cap(c), label: cap(c) })),
      KEY_ROW_MID   .map(c => ({ char: cap(c), label: cap(c) })),
      [
        { action:'shift', label: _shift ? 'SHIFT●' : 'SHIFT' },
        ...KEY_ROW_BOT.map(c => ({ char: cap(c), label: cap(c) })),
        { action:'backspace', label: '⌫' },
      ],
      [
        { action:'char', char: ' ', label:'SPACE', span: 6 },
        { action:'char', char: '-', label:'-' },
        { action:'char', char: '.', label:'.' },
        { action:'clear', label:'CLEAR', span: 2 },
        { action:'close', label:'DONE',  span: 2 },
      ],
    ];
  }

  function _press(cell) {
    if (!cell) return;
    if (cell.action === 'shift') {
      _shift = !_shift; _renderKeys(); KenteAudio?.click?.(); return;
    }
    if (cell.action === 'backspace') {
      const v = _target.value || '';
      _setValue(v.slice(0, -1));
      KenteAudio?.click?.(); return;
    }
    if (cell.action === 'clear') {
      _setValue(''); KenteAudio?.click?.(); return;
    }
    if (cell.action === 'close') { close(); return; }
    // Character key
    const ch = cell.char;
    if (typeof ch === 'string') {
      _setValue((_target.value || '') + ch);
      KenteAudio?.click?.();
      // Auto-revert one-shot shift after a single capital letter.
      if (_shift && /[A-Z]/.test(ch)) { _shift = false; _renderKeys(); }
    }
  }

  function _renderKeys() {
    if (!_overlay) return;
    const wrap = _overlay.querySelector('.osk-grid');
    if (!wrap) return;
    const grid = _grid();
    wrap.innerHTML = grid.map((row, ri) => `
      <div class="osk-row">
        ${row.map((cell, ci) => {
          const isFocus = ri === _focus.r && ci === _focus.c;
          const cls = ['osk-key',
            cell.action === 'shift'     ? 'osk-key-mod'   : '',
            cell.action === 'backspace' ? 'osk-key-mod'   : '',
            cell.action === 'shift' && _shift ? 'osk-key-on' : '',
            cell.action === 'close'     ? 'osk-key-go'    : '',
            cell.action === 'clear'     ? 'osk-key-mod'   : '',
            cell.span                   ? 'osk-key-wide'  : '',
            isFocus                     ? 'osk-key-focus' : ''].filter(Boolean).join(' ');
          const span = cell.span ? `style="flex:${cell.span}"` : '';
          return `<button type="button" class="${cls}" ${span}
                          data-r="${ri}" data-c="${ci}">${escHtml(cell.label)}</button>`;
        }).join('')}
      </div>`).join('');
  }

  function _focusCell(r, c) {
    const grid = _grid();
    if (r < 0) r = grid.length - 1;
    if (r >= grid.length) r = 0;
    const row = grid[r];
    if (c < 0) c = row.length - 1;
    if (c >= row.length) c = 0;
    _focus = { r, c };
    _renderKeys();
  }

  function navigate(dir) {
    if (!_overlay) return;
    const grid = _grid();
    let { r, c } = _focus;
    if (dir === 'left')      c -= 1;
    else if (dir === 'right') c += 1;
    else if (dir === 'up')    r -= 1;
    else if (dir === 'down')  r += 1;
    // Wrap rows; clamp column to new row's length.
    if (r < 0) r = grid.length - 1;
    if (r >= grid.length) r = 0;
    const row = grid[r];
    if (c < 0) c = row.length - 1;
    if (c >= row.length) c = 0;
    _focusCell(r, c);
    KenteAudio?.click?.();
  }

  function confirm() {
    if (!_overlay) return;
    const cell = _grid()[_focus.r]?.[_focus.c];
    _press(cell);
  }

  function backspace() {
    if (!_overlay) return;
    _press({ action:'backspace' });
  }

  function shift() {
    if (!_overlay) return;
    _press({ action:'shift' });
  }

  function open(input) {
    if (!input) return;
    if (_overlay) { close(); }
    _target = input;
    _shift  = false;
    _focus  = { r: 1, c: 0 };

    _overlay = document.createElement('div');
    _overlay.id = 'kente-osk';
    _overlay.className = 'osk-overlay';
    _overlay.innerHTML = `
      <div class="osk-card">
        <div class="osk-header">
          <div class="osk-title">VIRTUAL KEYBOARD</div>
          <div class="osk-sub">PRESS <b>ESC</b> OR <b>B</b> TO CLOSE</div>
        </div>
        <div class="osk-display"></div>
        <div class="osk-grid"></div>
        <div class="osk-legend">
          <span><b>↑↓←→</b> MOVE</span>
          <span><b>A / ENTER</b> PRESS</span>
          <span><b>X</b> ⌫</span>
          <span><b>Y</b> SHIFT</span>
          <span><b>B / ESC</b> CLOSE</span>
        </div>
      </div>`;
    document.body.appendChild(_overlay);
    _renderDisplay();
    _renderKeys();

    // Click delegation for mouse / touch users.
    _overlay.addEventListener('click', e => {
      const btn = e.target.closest('button.osk-key');
      if (!btn) {
        // Click on backdrop closes.
        if (e.target === _overlay) close();
        return;
      }
      const r = +btn.dataset.r, c = +btn.dataset.c;
      _focus = { r, c };
      _press(_grid()[r][c]);
    });

    // Capture keydown so menu nav handlers don't fire while typing.
    _overlay._keyHandler = e => _onKey(e);
    document.addEventListener('keydown', _overlay._keyHandler, true);

    // Keep the input focused (caret visible to users that prefer typing).
    requestAnimationFrame(() => _target?.focus({ preventScroll: true }));
  }

  function close() {
    if (!_overlay) return;
    document.removeEventListener('keydown', _overlay._keyHandler, true);
    _overlay.remove();
    _overlay = null;
    if (_target) {
      _target.blur();
      _target = null;
    }
    GamepadManager?.resetFocus?.();
  }

  function _onKey(e) {
    // Letters / digits / symbols typed on a real keyboard pass through to the
    // focused <input> naturally (we don't preventDefault).  We only intercept
    // navigation, backspace echo, and close keys here.
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation(); close(); return;
    }
    if (k === 'ArrowUp')    { e.preventDefault(); e.stopPropagation(); navigate('up');    return; }
    if (k === 'ArrowDown')  { e.preventDefault(); e.stopPropagation(); navigate('down');  return; }
    if (k === 'ArrowLeft')  { e.preventDefault(); e.stopPropagation(); navigate('left');  return; }
    if (k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); navigate('right'); return; }
    if (k === 'Enter')      { e.preventDefault(); e.stopPropagation(); confirm();         return; }
    if (k === 'Backspace') {
      // Let the input handle Backspace itself; just refresh our display.
      requestAnimationFrame(_renderDisplay);
      e.stopPropagation();
      return;
    }
    // Any other key: refresh display after the input updates, and stop the
    // event bubbling so the global handleKey() can't consume it.
    requestAnimationFrame(() => { _renderDisplay(); _commit(); });
    e.stopPropagation();
  }

  return { open, close, active, navigate, confirm, backspace, shift };
})();
