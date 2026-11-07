/* Kente's Korner — Play Together rooms (PS2 host-stream MVP). */
'use strict';

const PlayTogether = (() => {
  const RELAY_DEFAULT = 'http://localhost:7788';
  const KEEPALIVE_MS = 1500;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let iceRelay = '';
  const PAD2_KEYS = new Set(['w','a','s','d','i','j','k','l','u','o','q','e','z','c']);
  let game = null, relay = RELAY_DEFAULT, room = null, token = null, playerId = null;
  let isHost = false, pollTimer = null, launchTimer = null, captureStream = null, captureStarting = false, joinAddress = '';
  let peers = new Map(), inputHeld = new Set(), pendingOffers = [], closing = false, hostStarted = false;

  const $ = id => document.getElementById(id);
  const setStatus = (message, error = false) => {
    const el = $('pt-status');
    if (el) { el.textContent = message; el.classList.toggle('error', !!error); }
  };
  const relayUrl = address => {
    const value = String(address || '').trim();
    if (!value) throw new Error('ENTER THE HOST ADDRESS AND LOBBY PORT');
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('USE AN HTTP OR HTTPS HOST ADDRESS');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const parts = host.split('.').map(Number);
    const privateHost = ['localhost', '::1'].includes(host) || host.endsWith('.local') ||
      (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
       (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
    if (url.protocol === 'http:' && !privateHost) throw new Error('PUBLIC LOBBIES MUST USE HTTPS');
    return url.origin;
  };
  async function loadIceServers() {
    if (iceRelay === relay) return iceServers;
    try {
      const response = await fetch(`${relay}/api/lobby/ice`, { cache: 'no-store', signal: _abortTimeout(8000) });
      const data = await response.json();
      if (response.ok && Array.isArray(data.iceServers) && data.iceServers.length) iceServers = data.iceServers;
    } catch { /* STUN remains available when the relay cannot provide TURN credentials. */ }
    iceRelay = relay;
    return iceServers;
  }
  async function api(path, body = {}, base = relay) {
    const response = await fetch(`${base}/api/lobby/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: _abortTimeout(8000), cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `LOBBY ERROR ${response.status}`);
    return data;
  }

  function open(selectedGame) {
    if (!selectedGame || selectedGame.systemId !== 'ps2') {
      showToast('PLAY TOGETHER IS STARTING WITH PLAYSTATION 2');
      return;
    }
    game = selectedGame;
    $('game-detail-panel')?.classList.remove('open');
    closing = false;
    $('play-together-overlay').classList.add('active');
    renderStart();
    $('pt-name').value = localStorage.getItem('kente.playerName') || '';
    $('pt-room-code').value = '';
    $('pt-host-address').value = '';
    $('pt-host-address').value = localStorage.getItem('kente.lobbyRelay') || '';
    $('pt-name')?.focus();
  }

  function renderStart() {
    const label = $('pt-selected-game');
    if (label) label.textContent = `${game?.title || 'PLAYSTATION 2'} · PLAYSTATION 2`;
    $('pt-start-view').hidden = false;
    $('pt-room-view').hidden = true;
    $('pt-stream-view').hidden = true;
    $('pt-close').hidden = false;
    setStatus('CREATE A ROOM OR JOIN A FRIEND');
  }

  function playerName() {
    const value = ($('pt-name').value || '').trim().slice(0, 24);
    if (!value) throw new Error('ENTER A USERNAME');
    localStorage.setItem('kente.playerName', value);
    return value;
  }

  async function createRoom() {
    try {
      if (!window.electronAPI?.nativePlayerSupported) throw new Error('PS2 ROOM HOSTING REQUIRES KENTE ON WINDOWS');
      if (!KENTE_SERVER_ONLINE) throw new Error('CONNECT THE KENTE SERVER BEFORE HOSTING A ROOM');
      relay = relayUrl($('pt-host-address').value || RELAY_DEFAULT);
      localStorage.setItem('kente.lobbyRelay', relay === RELAY_DEFAULT ? '' : relay);
      const response = await api('create', { name: playerName(), game: {
        id: game.id, title: game.title, systemId: 'ps2',
      }});
      token = response.token; playerId = response.playerId; room = response.room; isHost = true;
      joinAddress = relay === RELAY_DEFAULT
        ? `${response.addresses?.[0] || 'YOUR-LAN-IP'}:${response.port || 7788}`
        : relay;
      setStatus('ROOM CREATED · SHARE THE ADDRESS AND CODE');
      showRoom(); startPolling();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function joinRoom() {
    try {
      relay = relayUrl($('pt-host-address').value || RELAY_DEFAULT);
      localStorage.setItem('kente.lobbyRelay', relay === RELAY_DEFAULT ? '' : relay);
      const response = await api('join', { roomCode: $('pt-room-code').value, name: playerName() });
      token = response.token; playerId = response.playerId; room = response.room; isHost = false;
      showRoom(); startPolling();
    } catch (error) { setStatus(error.message, true); }
  }

  function showRoom() {
    $('pt-start-view').hidden = true;
    $('pt-room-view').hidden = false;
    $('pt-stream-view').hidden = true;
    $('pt-room-code-display').textContent = room.roomCode;
    $('pt-room-game').textContent = room.game.title;
    $('pt-room-invite').textContent = isHost
      ? `HOST ADDRESS ${joinAddress} · ROOM CODE ${room.roomCode}`
      : `CONNECTED TO ${relay} · ROOM CODE ${room.roomCode}`;
    $('pt-ready-btn').hidden = isHost;
    $('pt-start-btn').hidden = !isHost;
    setStatus(isHost ? 'WAITING FOR PLAYERS' : 'JOINED · READY UP WHEN YOU ARE SET');
    refreshRoom(room);
  }

  function refreshRoom(next) {
    if (!next) return;
    room = next;
    const list = $('pt-player-list');
    list.replaceChildren(...room.players.map(p => {
      const row = document.createElement('div');
      row.className = 'pt-player-row';
      const name = document.createElement('span'); name.textContent = p.name + (p.host ? ' · HOST' : '');
      const badge = document.createElement('strong'); badge.textContent = p.ready ? 'READY' : 'NOT READY';
      badge.classList.toggle('ready', p.ready);
      row.append(name, badge); return row;
    }));
    const everyoneReady = room.players.length >= 2 && room.players.every(p => p.ready);
    $('pt-start-btn').disabled = !everyoneReady || room.status !== 'waiting';
    if (!isHost) {
      const self = room.players.find(p => p.id === playerId);
      $('pt-ready-btn').textContent = self?.ready ? '✓ READY · CLICK TO UNREADY' : 'READY UP';
    }
    if (room.status === 'starting' && room.startAt && !launchTimer && isHost) {
      const delay = Math.max(0, room.startAt - Date.now());
      setStatus('EVERYONE READY · STARTING TOGETHER...');
      launchTimer = setTimeout(startHostGame, delay);
    } else if (room.status === 'starting' && !isHost) {
      setStatus('EVERYONE READY · HOST IS STARTING THE PS2...');
    } else if (room.status === 'running' && isHost) {
      setStatus('GAME LIVE · PLAYERS ARE WATCHING THE HOST SESSION');
      startHostCapture();
    } else if (room.status === 'running' && !isHost) {
      setStatus('CONNECTING TO THE HOST’S PS2 SESSION...');
      $('pt-room-view').hidden = true;
      $('pt-stream-view').hidden = false;
      ensureGuestPeer();
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, KEEPALIVE_MS);
    poll();
  }

  async function poll() {
    if (!room || !token || closing) return;
    if (isHost && hostStarted && !NativePlayer.active) { await leave(); return; }
    try {
      const result = await api('poll', { roomCode: room.roomCode, token });
      refreshRoom(result.room);
      for (const envelope of result.messages || []) handleSignal(envelope.from, envelope.message).catch(error => setStatus(error.message, true));
    } catch (error) {
      setStatus(error.message, true);
      if (/room access expired|room not found/i.test(error.message)) leave();
    }
  }

  async function signal(target, message) {
    await api('signal', { roomCode: room.roomCode, token, target, message });
  }

  async function toggleReady() {
    try {
      const self = room.players.find(p => p.id === playerId);
      const result = await api('ready', { roomCode: room.roomCode, token, ready: !self?.ready });
      refreshRoom(result.room);
    } catch (error) { setStatus(error.message, true); }
  }

  async function startGame() {
    try {
      const result = await api('start', { roomCode: room.roomCode, token });
      refreshRoom(result.room);
    } catch (error) { setStatus(error.message, true); }
  }

  async function startHostGame() {
    launchTimer = null;
    setStatus('STARTING PLAYSTATION 2...');
    $('pt-room-view').hidden = true;
    $('play-together-overlay').classList.remove('active');
    try {
      const localRom = await findServerRom(game);
      if (!localRom) throw new Error('DOWNLOAD THIS PS2 GAME TO THE HOST FIRST');
      await NativePlayer.launch(game, { filename: localRom.filename, remotePlayer2: true });
      if (!NativePlayer.active) throw new Error('PCSX2 DID NOT START');
      hostStarted = true;
      await api('running', { roomCode: room.roomCode, token });
      setStatus('GAME LIVE · CONNECTING PLAYERS...');
      poll();
    } catch (error) {
      hostStarted = false;
      await api('abort', { roomCode: room.roomCode, token }).catch(() => {});
      $('play-together-overlay').classList.add('active');
      $('pt-room-view').hidden = false;
      setStatus(`GAME COULD NOT START · ${error.message}`, true);
    }
  }

  async function startHostCapture() {
    if (captureStream || captureStarting || !window.electronAPI?.lobbyCaptureSources) return;
    captureStarting = true;
    try {
      const sources = await window.electronAPI.lobbyCaptureSources();
      const source = sources.find(s => /kente/i.test(s.name));
      if (!source) throw new Error('KENTE GAME WINDOW NOT AVAILABLE FOR SHARING');
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id,
          minWidth: 640, minHeight: 360, maxFrameRate: 30 } },
      });
      const screen = sources.find(s => s.id.startsWith('screen:'));
      if (screen) {
        try {
          const audio = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: screen.id } },
            video: false,
          });
          for (const track of audio.getAudioTracks()) captureStream.addTrack(track);
        } catch { /* Windows may not provide loopback audio for this capture source. */ }
      }
      for (const offer of pendingOffers.splice(0)) await handleSignal(offer.from, offer.message);
      for (const p of room.players) {
        if (p.id !== playerId && !peers.has(p.id)) await createHostPeer(p.id);
      }
    } catch (error) {
      setStatus(`SCREEN SHARE FAILED · ${error.message}`, true);
      showToast(`⚠ SCREEN SHARE FAILED — ${error.message}`);
    }
    finally { captureStarting = false; }
  }

  async function gatherAndSend(pc, target, description) {
    await pc.setLocalDescription(description);
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 6000);
    });
    await signal(target, { type: description.type, sdp: pc.localDescription?.sdp || description.sdp });
  }

  async function createHostPeer(target) {
    const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
    peers.set(target, pc);
    for (const track of captureStream?.getTracks() || []) pc.addTrack(track, captureStream);
    pc.ondatachannel = event => attachRemoteControls(event.channel);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') setStatus('PLAYER CONNECTION FAILED · CHECK NETWORK/NAT', true); };
    const offer = await pc.createOffer();
    await gatherAndSend(pc, target, offer);
  }

  async function ensureGuestPeer() {
    if (isHost || peers.has('host')) return;
    const host = room.players.find(p => p.host);
    if (!host) return;
    const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
    peers.set('host', pc);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const channel = pc.createDataChannel('pad2-controls');
    pc._kenteControls = channel;
    channel.onopen = () => { setStatus('CONNECTED · USE WASD / IJKL / QEZC / UO'); $('pt-remote-video')?.focus(); };
    pc.ontrack = event => {
      const video = $('pt-remote-video');
      if (video) { video.srcObject = event.streams[0]; video.play().catch(() => {}); }
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') setStatus('HOST CONNECTION FAILED · CHECK NETWORK/NAT', true); };
    const offer = await pc.createOffer();
    await gatherAndSend(pc, host.id, offer);
  }

  async function handleSignal(from, message) {
    if (message.type === 'offer' && isHost) {
      if (!captureStream) { pendingOffers.push({ from, message }); return; }
      if (peers.has(from)) return;
      const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
      peers.set(from, pc);
      for (const track of captureStream.getTracks()) pc.addTrack(track, captureStream);
      pc.ondatachannel = event => attachRemoteControls(event.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await gatherAndSend(pc, from, await pc.createAnswer());
    } else if (message.type === 'answer' && !isHost) {
      const pc = peers.get('host');
      if (pc && !pc.currentRemoteDescription) await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
    }
  }

  function attachRemoteControls(channel) {
    const held = new Set();
    channel.onmessage = event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type !== 'key' || !PAD2_KEYS.has(packet.key) || typeof packet.down !== 'boolean') return;
      if (packet.down) held.add(packet.key); else held.delete(packet.key);
      window.electronAPI?.lobbyRemoteKey(packet.key, packet.down, NativePlayer.sessionId)
        .catch(() => {});
    };
    channel.onclose = () => {
      for (const key of held) window.electronAPI?.lobbyRemoteKey(key, false, NativePlayer.sessionId).catch(() => {});
      held.clear();
    };
  }

  function sendRemoteKey(event, down) {
    if (isHost || !room || room.status !== 'running' || event.repeat) return;
    const key = event.key.toLowerCase();
    if (!PAD2_KEYS.has(key)) return;
    event.preventDefault();
    for (const pc of peers.values()) {
      // The guest owns a single outbound controller channel.
      if (pc._kenteControls?.readyState === 'open') pc._kenteControls.send(JSON.stringify({ type: 'key', key, down }));
    }
    if (down) inputHeld.add(key); else inputHeld.delete(key);
  }

  function releaseAllRemoteKeys() {
    for (const key of inputHeld) sendRemoteKey({ key, repeat: false, preventDefault() {} }, false);
    inputHeld.clear();
  }

  function closeStream() {
    $('pt-remote-video')?.pause();
    if ($('pt-remote-video')) $('pt-remote-video').srcObject = null;
    captureStream?.getTracks().forEach(track => track.stop()); captureStream = null;
    for (const pc of peers.values()) pc.close(); peers.clear();
  }

  async function leave() {
    closing = true;
    clearInterval(pollTimer); pollTimer = null;
    clearTimeout(launchTimer); launchTimer = null;
    releaseAllRemoteKeys(); closeStream();
    if (room && token) await api('leave', { roomCode: room.roomCode, token }).catch(() => {});
    room = token = playerId = null; game = null; isHost = false; joinAddress = ''; hostStarted = false; pendingOffers = []; captureStarting = false;
    $('play-together-overlay')?.classList.remove('active');
    closing = false;
  }

  function init() {
    $('pt-create-btn')?.addEventListener('click', createRoom);
    $('pt-join-btn')?.addEventListener('click', joinRoom);
    $('pt-ready-btn')?.addEventListener('click', toggleReady);
    $('pt-start-btn')?.addEventListener('click', startGame);
    $('pt-close')?.addEventListener('click', leave);
    $('pt-copy-invite')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(`${joinAddress} ${room.roomCode}`); setStatus('INVITE COPIED'); }
      catch { setStatus('COPY FAILED · COPY THE ADDRESS AND CODE MANUALLY', true); }
    });
    $('pt-remote-video')?.addEventListener('keydown', event => sendRemoteKey(event, true));
    $('pt-remote-video')?.addEventListener('keyup', event => sendRemoteKey(event, false));
    $('pt-remote-video')?.addEventListener('blur', releaseAllRemoteKeys);
    window.addEventListener('blur', releaseAllRemoteKeys);
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && $('play-together-overlay')?.classList.contains('active')) leave();
    });
  }

  return { open, init };
})();
