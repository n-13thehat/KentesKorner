"""Kente's Korner — WiFi / network management helpers."""
import os, platform, re, subprocess, tempfile

# ── Network Management ─────────────────────────────────────────────────────────
_IS_WINDOWS = platform.system() == 'Windows'

def _net_run(args, timeout=10):
    """Run a command and return (stdout, stderr, returncode). Never raises."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.stderr, r.returncode
    except Exception as ex:
        return '', str(ex), -1

# ── Network helpers ───────────────────────────────────────────────────────────
def _net_status():
    """Return current WiFi/network connection status."""
    result = {'connected': False, 'ssid': None, 'ip': None, 'signal': None, 'interface': None}
    if _IS_WINDOWS:
        out, _, _ = _net_run(['netsh', 'wlan', 'show', 'interfaces'])
        for line in out.splitlines():
            l = line.strip()
            if l.startswith('SSID') and not l.startswith('BSSID'):
                result['ssid'] = l.split(':', 1)[-1].strip() or None
            elif l.startswith('Signal'):
                try: result['signal'] = int(l.split(':', 1)[-1].strip().rstrip('%'))
                except: pass
            elif l.startswith('Name'):
                result['interface'] = l.split(':', 1)[-1].strip()
        result['connected'] = bool(result['ssid'])
        if result['connected'] and result['interface']:
            out2, _, _ = _net_run(['ipconfig'])
            in_iface = False
            for line in out2.splitlines():
                if result['interface'] in line:
                    in_iface = True
                if in_iface and 'IPv4 Address' in line:
                    # Remove trailing annotations like "(Preferred)" using regex
                    raw_ip = line.split(':', 1)[-1].strip()
                    result['ip'] = re.sub(r'\s*\(.*?\)\s*$', '', raw_ip).strip()
                    break
    else:
        out, _, _ = _net_run(['nmcli', '-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'])
        for line in out.splitlines():
            parts = line.split(':')
            if len(parts) >= 3 and parts[0] == 'yes':
                result['connected'] = True
                result['ssid'] = parts[1]
                try: result['signal'] = int(parts[2])
                except: pass
                break
        out2, _, _ = _net_run(['hostname', '-I'])
        ips = out2.strip().split()
        if ips: result['ip'] = ips[0]
        out3, _, _ = _net_run(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE', 'dev'])
        for line in out3.splitlines():
            p = line.split(':')
            if len(p) >= 3 and p[1] == 'wifi' and 'connected' in p[2]:
                result['interface'] = p[0]; break
    return result

def _net_scan():
    """Scan for visible WiFi networks. Returns {'networks': [...]}."""
    networks = []
    if _IS_WINDOWS:
        out, _, _ = _net_run(['netsh', 'wlan', 'show', 'networks', 'mode=Bssid'])
        cur = {}
        for line in out.splitlines():
            l = line.strip()
            if l.startswith('SSID') and not l.startswith('BSSID'):
                if cur.get('ssid'): networks.append(cur)
                cur = {'ssid': l.split(':', 1)[-1].strip(), 'signal': 0, 'secured': True}
            elif l.startswith('Authentication') and cur:
                cur['secured'] = l.split(':', 1)[-1].strip().lower() not in ('open', '')
            elif l.startswith('Signal') and cur:
                try: cur['signal'] = int(l.split(':', 1)[-1].strip().rstrip('%'))
                except: pass
        if cur.get('ssid'): networks.append(cur)
    else:
        out, _, _ = _net_run(
            ['nmcli', '-t', '-f', 'SSID,SIGNAL,SECURITY,ACTIVE', 'dev', 'wifi', 'list', '--rescan', 'yes'],
            timeout=20)
        seen = set()
        for line in out.splitlines():
            p = line.split(':')
            if len(p) < 4 or not p[0] or p[0] in seen: continue
            seen.add(p[0])
            try: sig = int(p[1])
            except: sig = 0
            networks.append({'ssid': p[0], 'signal': sig,
                             'secured': p[2].strip() not in ('', '--'), 'active': p[3] == 'yes'})
    networks.sort(key=lambda n: n.get('signal', 0), reverse=True)
    return {'networks': networks}

def _net_connect(ssid, password=''):
    """Connect to a WiFi network (creates a profile on Windows via netsh XML)."""
    if not ssid:
        return False, 'No SSID provided'
    if _IS_WINDOWS:
        import xml.sax.saxutils as _sax
        safe_ssid = _sax.escape(ssid)
        if password:
            safe_pw = _sax.escape(password)
            xml_body = (f'<authEncryption><authentication>WPA2PSK</authentication>'
                        f'<encryption>AES</encryption><useOneX>false</useOneX></authEncryption>'
                        f'<sharedKey><keyType>passPhrase</keyType><protected>false</protected>'
                        f'<keyMaterial>{safe_pw}</keyMaterial></sharedKey>')
        else:
            xml_body = ('<authEncryption><authentication>open</authentication>'
                        '<encryption>none</encryption><useOneX>false</useOneX></authEncryption>')
        xml_content = (
            f'<?xml version="1.0"?>'
            f'<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">'
            f'<name>{safe_ssid}</name>'
            f'<SSIDConfig><SSID><name>{safe_ssid}</name></SSID></SSIDConfig>'
            f'<connectionType>ESS</connectionType><connectionMode>auto</connectionMode>'
            f'<MSM><security>{xml_body}</security></MSM></WLANProfile>'
        )
        fd, tmp_xml = tempfile.mkstemp(suffix='.xml')
        try:
            os.write(fd, xml_content.encode()); os.close(fd)
            _, err, rc = _net_run(['netsh', 'wlan', 'add', 'profile', f'filename={tmp_xml}'])
            if rc != 0: return False, f'Profile error: {err.strip()}'
            out2, err2, rc2 = _net_run(['netsh', 'wlan', 'connect', f'name={ssid}'], timeout=15)
            return rc2 == 0, out2.strip() or err2.strip() or f'Connecting to {ssid}'
        finally:
            try: os.unlink(tmp_xml)
            except: pass
    else:
        args = ['nmcli', 'dev', 'wifi', 'connect', ssid]
        if password: args += ['password', password]
        out, err, rc = _net_run(args, timeout=30)
        return rc == 0, out.strip() or err.strip() or f'Connected to {ssid}'

def _net_disconnect():
    """Disconnect the active WiFi interface."""
    if _IS_WINDOWS:
        out, err, rc = _net_run(['netsh', 'wlan', 'disconnect'])
        return rc == 0, out.strip() or err.strip()
    else:
        out, _, _ = _net_run(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE', 'dev'])
        iface = next((l.split(':')[0] for l in out.splitlines()
                      if ':wifi:' in l and 'connected' in l), None)
        if not iface: return False, 'No active WiFi interface'
        out2, err2, rc = _net_run(['nmcli', 'dev', 'disconnect', iface])
        return rc == 0, out2.strip() or err2.strip()

def _net_forget(ssid):
    """Delete a saved network profile."""
    if not ssid: return False, 'No SSID provided'
    if _IS_WINDOWS:
        out, err, rc = _net_run(['netsh', 'wlan', 'delete', 'profile', f'name={ssid}'])
        return rc == 0, out.strip() or err.strip()
    else:
        out, err, rc = _net_run(['nmcli', 'connection', 'delete', ssid])
        return rc == 0, out.strip() or err.strip()
