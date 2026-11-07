"""Small, room-code-only signaling relay for Kente's Play Together rooms.

This listener exposes only temporary lobby state and WebRTC signaling. It does
not serve the Kente API or filesystem. A room is removed after its host leaves
or its participants stop sending heartbeats.
"""
import json
import base64
import hashlib
import hmac
import ipaddress
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = 7788
_LOCK = threading.RLock()
_ROOMS = {}
_SERVER = None
_SERVER_THREAD = None
_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
_MAX_MEMBERS = 2
_MAX_SIGNAL_BYTES = 64 * 1024
_MAX_ROOMS = 100
_RATE = {}
_PUBLIC = os.environ.get('KENTE_LOBBY_PUBLIC', '').strip() == '1'


def _name(value):
    value = ' '.join(str(value or '').split())[:24]
    return value or 'PLAYER'


def _room(code):
    return _ROOMS.get(str(code or '').upper()[:8])


def _member(room, token):
    if not room or not isinstance(token, str):
        return None
    return next((p for p in room['players'].values() if secrets.compare_digest(p['token'], token)), None)


def _prune():
    now = time.time()
    for code, room in list(_ROOMS.items()):
        for player_id, player in list(room['players'].items()):
            if now - player['seen'] > 40:
                del room['players'][player_id]
                room['inbox'].pop(player_id, None)
        if room['host'] not in room['players'] or now - room['created'] > 4 * 60 * 60:
            del _ROOMS[code]


def _public(room):
    return {
        'roomCode': room['code'], 'game': room['game'], 'status': room['status'],
        'startAt': room.get('startAt'), 'players': [
            {'id': p['id'], 'name': p['name'], 'ready': p['ready'], 'host': p['id'] == room['host']}
            for p in room['players'].values()
        ],
    }


def _lan_addresses():
    result = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
            ip = info[4][0]
            if not ip.startswith('127.') and ipaddress.ip_address(ip).is_private and ip not in result:
                result.append(ip)
    except OSError:
        pass
    return result


def _private_client(value):
    try:
        address = ipaddress.ip_address(value)
        return address.is_private or address.is_loopback or address.is_link_local
    except ValueError:
        return False


def _client_allowed(value):
    return _PUBLIC or _private_client(value)


def _remote_ip(handler):
    if os.environ.get('KENTE_TRUST_PROXY') == '1':
        forwarded = handler.headers.get('X-Forwarded-For', '').split(',', 1)[0].strip()
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            pass
    return handler.client_address[0]


def _rate_limited(address, action):
    now = time.time()
    key = (address, action)
    window, count = _RATE.get(key, (now, 0))
    if now - window >= 60:
        window, count = now, 0
    count += 1
    _RATE[key] = (window, count)
    if len(_RATE) > 4096:
        for old, item in list(_RATE.items()):
            if now - item[0] > 120:
                _RATE.pop(old, None)
    return count > (30 if action in ('create', 'join') else 240)


def _allowed_origin(origin):
    if not origin or origin == 'null':
        return True
    try:
        parsed = urlsplit(origin)
        return parsed.scheme in ('http', 'https') and parsed.hostname in ('localhost', '127.0.0.1')
    except ValueError:
        return False


def _respond(handler, status, data):
    payload = json.dumps(data, separators=(',', ':')).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(payload)))
    handler.send_header('Cache-Control', 'no-store')
    origin = handler.headers.get('Origin', '')
    if _allowed_origin(origin):
        handler.send_header('Access-Control-Allow-Origin', origin or '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type')
    handler.send_header('Access-Control-Allow-Private-Network', 'true')
    handler.end_headers()
    handler.wfile.write(payload)


class _Handler(BaseHTTPRequestHandler):
    server_version = 'KenteLobby/1'

    def log_message(self, *_args):
        return

    def do_OPTIONS(self):
        if not _allowed_origin(self.headers.get('Origin', '')):
            self.send_error(403); return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def do_GET(self):
        if not _allowed_origin(self.headers.get('Origin', '')):
            _respond(self, 403, {'error': 'Origin not allowed'}); return
        if not _client_allowed(_remote_ip(self)):
            _respond(self, 403, {'error': 'Rooms are limited to your local network'}); return
        parsed = urlsplit(self.path)
        if parsed.path == '/api/lobby/ice':
            urls = [u.strip() for u in os.environ.get('KENTE_TURN_URLS', '').split(',') if u.strip()]
            secret = os.environ.get('KENTE_TURN_SECRET', '')
            if urls and secret:
                username = f"{int(time.time()) + 3600}:kente"
                credential = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
                servers = [{'urls': urls, 'username': username, 'credential': credential}]
            else:
                servers = [{'urls': 'stun:stun.l.google.com:19302'}]
            _respond(self, 200, {'iceServers': servers}); return
        if parsed.path != '/api/lobby/health':
            _respond(self, 404, {'error': 'Not found'}); return
        _respond(self, 200, {'ok': True, 'port': PORT})

    def do_POST(self):
        if not _allowed_origin(self.headers.get('Origin', '')):
            _respond(self, 403, {'error': 'Origin not allowed'}); return
        if not _client_allowed(_remote_ip(self)):
            _respond(self, 403, {'error': 'Rooms are limited to your local network'}); return
        if not self.path.startswith('/api/lobby/'):
            _respond(self, 404, {'error': 'Not found'}); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > _MAX_SIGNAL_BYTES:
                _respond(self, 413, {'error': 'Request too large'}); return
            body = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(body, dict):
                _respond(self, 400, {'error': 'Invalid request'}); return
        except (ValueError, json.JSONDecodeError):
            _respond(self, 400, {'error': 'Invalid request'}); return

        path = urlsplit(self.path).path
        action = path.rsplit('/', 1)[-1]
        if _rate_limited(_remote_ip(self), action):
            _respond(self, 429, {'error': 'Too many lobby requests; wait a minute and try again'}); return
        with _LOCK:
            _prune()
            if path == '/api/lobby/create':
                game = body.get('game') if isinstance(body.get('game'), dict) else {}
                if game.get('systemId') != 'ps2' or not game.get('id') or not game.get('title'):
                    _respond(self, 400, {'error': 'Choose a PlayStation 2 game first'}); return
                if len(_ROOMS) >= _MAX_ROOMS:
                    _respond(self, 429, {'error': 'The lobby service is full; try again later'}); return
                code = ''.join(secrets.choice(_CODE_CHARS) for _ in range(6))
                player_id, token = secrets.token_urlsafe(9), secrets.token_urlsafe(32)
                room = {'code': code, 'game': {'id': str(game['id'])[:100], 'title': str(game['title'])[:120], 'systemId': 'ps2'},
                        'status': 'waiting', 'created': time.time(), 'host': player_id,
                        'players': {}, 'inbox': {}}
                room['players'][player_id] = {'id': player_id, 'token': token, 'name': _name(body.get('name')),
                                               'ready': True, 'seen': time.time()}
                room['inbox'][player_id] = []
                _ROOMS[code] = room
                _respond(self, 200, {'token': token, 'playerId': player_id, 'room': _public(room),
                                     'addresses': _lan_addresses(), 'port': int(os.environ.get('KENTE_LOBBY_PORT', PORT))}); return

            code = body.get('roomCode')
            room = _room(code)
            if path == '/api/lobby/join':
                if not room or room['status'] != 'waiting':
                    _respond(self, 404, {'error': 'Room not found or already started'}); return
                if len(room['players']) >= _MAX_MEMBERS:
                    _respond(self, 409, {'error': 'Room is full'}); return
                player_id, token = secrets.token_urlsafe(9), secrets.token_urlsafe(32)
                room['players'][player_id] = {'id': player_id, 'token': token, 'name': _name(body.get('name')),
                                               'ready': False, 'seen': time.time()}
                room['inbox'][player_id] = []
                _respond(self, 200, {'token': token, 'playerId': player_id, 'room': _public(room)}); return

            player = _member(room, body.get('token'))
            if not player:
                _respond(self, 403, {'error': 'Room access expired'}); return
            player['seen'] = time.time()
            if path == '/api/lobby/state':
                _respond(self, 200, {'room': _public(room), 'playerId': player['id']}); return
            if path == '/api/lobby/ready':
                if room['status'] != 'waiting':
                    _respond(self, 409, {'error': 'The room has already started'}); return
                player['ready'] = bool(body.get('ready'))
                _respond(self, 200, {'room': _public(room)}); return
            if path == '/api/lobby/start':
                if player['id'] != room['host']:
                    _respond(self, 403, {'error': 'Only the host can start'}); return
                if len(room['players']) < 2:
                    _respond(self, 409, {'error': 'Invite one Player 2 before starting'}); return
                if room['status'] != 'waiting' or not all(p['ready'] for p in room['players'].values()):
                    _respond(self, 409, {'error': 'Everyone must be ready'}); return
                room['status'] = 'starting'
                room['startAt'] = int((time.time() + 5) * 1000)
                _respond(self, 200, {'room': _public(room)}); return
            if path == '/api/lobby/abort':
                if player['id'] != room['host'] or room['status'] != 'starting':
                    _respond(self, 403, {'error': 'Invalid host state'}); return
                room['status'] = 'waiting'
                room.pop('startAt', None)
                _respond(self, 200, {'room': _public(room)}); return
            if path == '/api/lobby/running':
                if player['id'] != room['host'] or room['status'] != 'starting':
                    _respond(self, 403, {'error': 'Invalid host state'}); return
                room['status'] = 'running'
                _respond(self, 200, {'room': _public(room)}); return
            if path == '/api/lobby/signal':
                target = str(body.get('target') or '')[:64]
                message = body.get('message')
                if target not in room['players'] or target == player['id'] or not isinstance(message, dict):
                    _respond(self, 400, {'error': 'Invalid signal'}); return
                box = room['inbox'].setdefault(target, [])
                if len(box) >= 80:
                    _respond(self, 429, {'error': 'Signal queue full'}); return
                box.append({'from': player['id'], 'message': message})
                _respond(self, 200, {'ok': True}); return
            if path == '/api/lobby/poll':
                messages = room['inbox'].setdefault(player['id'], [])
                room['inbox'][player['id']] = []
                _respond(self, 200, {'messages': messages, 'room': _public(room)}); return
            if path == '/api/lobby/leave':
                if player['id'] == room['host']:
                    del _ROOMS[room['code']]
                else:
                    room['players'].pop(player['id'], None)
                    room['inbox'].pop(player['id'], None)
                _respond(self, 200, {'ok': True}); return
        _respond(self, 404, {'error': 'Not found'})


def start_lobby_relay(host='0.0.0.0'):
    """Start the isolated local lobby listener once, on demand."""
    global _SERVER, _SERVER_THREAD
    with _LOCK:
        if _SERVER:
            return {'ok': True, 'port': PORT, 'addresses': _lan_addresses()}
        server = ThreadingHTTPServer((host, int(os.environ.get('KENTE_LOBBY_PORT', PORT))), _Handler)
        server.daemon_threads = True
        _SERVER = server
        _SERVER_THREAD = threading.Thread(target=server.serve_forever, name='kente-lobby', daemon=True)
        _SERVER_THREAD.start()
        return {'ok': True, 'port': PORT, 'addresses': _lan_addresses()}


if __name__ == '__main__':
    port = int(os.environ.get('KENTE_LOBBY_PORT', PORT))
    server = ThreadingHTTPServer(('0.0.0.0', port), _Handler)
    print(f'Kente lobby listening on 0.0.0.0:{port} (public={_PUBLIC})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
