import http.client
import json
import os
import queue
import socket
import ssl
import struct
import sys
import threading
import time
from urllib.parse import urlparse

def log(msg):
    print(f"[MimoBridge] {time.strftime('%H:%M:%S')} {msg}", flush=True)

API_ENDPOINT = os.environ.get("MIMO_API_ENDPOINT", "https://api-sgp-oc.xiaomimimo.com/v1/chat/completions").rstrip("/")
KEY = os.environ.get("MIMO_API_KEY", "")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

def _api_root(url):
    url = url.rstrip("/")
    for marker in ("/anthropic/v1", "/v1"):
        idx = url.find(marker)
        if idx >= 0:
            return url[:idx]
    return url

API_ROOT = os.environ.get("MIMO_API_BASE", _api_root(API_ENDPOINT)).rstrip("/")
OPENAI_BASE = os.environ.get("MIMO_OPENAI_BASE", API_ROOT + "/v1").rstrip("/")
ANTHROPIC_BASE = os.environ.get("MIMO_ANTHROPIC_BASE", API_ROOT + "/anthropic/v1").rstrip("/")
ORIGIN = os.environ.get("MIMO_ORIGIN", API_ROOT)

class WebSocketClient:
    def __init__(self):
        self.sock = None
        self.buf = b""
        self.sendq = queue.Queue(maxsize=10000)
        self.sender = None
        self.closed = False
        self.write_lock = threading.Lock()

    def connect(self, url):
        parsed = urlparse(url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path + ("?" + parsed.query if parsed.query else "")

        self.sock = socket.create_connection((host, port), timeout=15)
        try:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        if parsed.scheme == "wss":
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=host)

        key = __import__("base64").b64encode(os.urandom(16)).decode()
        headers = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        self.sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode())

        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("websocket handshake failed")
            raw += chunk

        self.buf = raw.split(b"\r\n\r\n", 1)[1]
        self.closed = False
        while not self.sendq.empty():
            try:
                self.sendq.get_nowait()
            except queue.Empty:
                break
        self.sender = threading.Thread(target=self._sender, daemon=True)
        self.sender.start()

    def _sender(self):
        while not self.closed:
            try:
                data = self.sendq.get(timeout=0.5)
            except queue.Empty:
                continue
            if data is None:
                break
            with self.write_lock:
                if self.closed or not self.sock:
                    continue
                try:
                    if isinstance(data, tuple):
                        self._frame(data[0], data[1])
                    else:
                        self._frame(0x1, data)
                except Exception:
                    self.closed = True
                    try:
                        self.sock.close()
                    except Exception:
                        pass
                    break

    def send(self, data):
        if self.closed or not self.sock:
            return
        try:
            self.sendq.put_nowait(data.encode() if isinstance(data, str) else data)
        except queue.Full:
            log("SendQ full")
            self.closed = True
            try:
                self.sock.close()
            except Exception:
                pass

    def ping(self):
        if self.closed or not self.sock:
            return
        try:
            self.sendq.put_nowait((0x9, b"keepalive"))
        except queue.Full:
            log("SendQ full")
            self.closed = True
            try:
                self.sock.close()
            except Exception:
                pass

    def recv(self, timeout=60):
        self.sock.settimeout(timeout)
        while True:
            opcode, payload = self._read_frame()
            if opcode == 1:
                return payload.decode()
            if opcode == 8:
                raise ConnectionError("websocket closed")
            if opcode == 9:
                try:
                    self.sendq.put_nowait((0xA, payload))
                except Exception:
                    pass
            if opcode == 0xA:
                continue

    def close(self):
        self.closed = True
        try:
            while not self.sendq.empty():
                try:
                    self.sendq.get_nowait()
                except queue.Empty:
                    break
            self.sendq.put(None)
        except Exception:
            pass
        with self.write_lock:
            try:
                self._frame(0x8, b"")
            except Exception:
                pass
            try:
                self.sock.close()
            except Exception:
                pass

    def _frame(self, opcode, data):
        mask = os.urandom(4)
        frame = bytearray([0x80 | opcode])
        size = len(data)
        if size < 126:
            frame.append(0x80 | size)
        elif size < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack(">H", size))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack(">Q", size))
        frame.extend(mask)
        frame.extend(byte ^ mask[i % 4] for i, byte in enumerate(data))
        self.sock.sendall(bytes(frame))

    def _read_frame(self):
        def read(n):
            while len(self.buf) < n:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise ConnectionError("websocket closed")
                self.buf += chunk
            out = self.buf[:n]
            self.buf = self.buf[n:]
            return out

        b1 = read(1)[0]
        b2 = read(1)[0]
        opcode = b1 & 0x0F
        size = b2 & 0x7F
        if size == 126:
            size = struct.unpack(">H", read(2))[0]
        elif size == 127:
            size = struct.unpack(">Q", read(8))[0]
        if b2 & 0x80:
            mask = read(4)
            payload = bytearray(read(size))
            for i in range(size):
                payload[i] ^= mask[i % 4]
            return opcode, bytes(payload)
        return opcode, read(size)

_pools = {}
_pool_lock = threading.Lock()

def _conn_key(parsed):
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)

def _new_conn(scheme, host, port, timeout=30):
    cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
    conn = cls(host, port, timeout=timeout)
    conn.connect()
    try:
        conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass
    return conn

def _get_conn(parsed):
    key = _conn_key(parsed)
    with _pool_lock:
        pool = _pools.setdefault(key, [])
        while pool:
            conn = pool.pop()
            if conn.sock:
                return conn, key
            try:
                conn.close()
            except Exception:
                pass
    return _new_conn(*key), key

def _return_conn(conn, key):
    if not conn:
        return
    try:
        with _pool_lock:
            pool = _pools.setdefault(key, [])
            if len(pool) < 32 and conn.sock:
                pool.append(conn)
            else:
                conn.close()
    except Exception:
        pass

def _join_url(base, suffix):
    suffix = suffix or "/"
    if not suffix.startswith("/"):
        suffix = "/" + suffix
    return base.rstrip("/") + suffix

def _strip_public_prefix(path):
    if path.startswith("/api/claw/"):
        return path[len("/api/claw"):]
    return path

def _target_url(public_path):
    public_path = public_path or "/"
    path, sep, query = public_path.partition("?")
    path = _strip_public_prefix(path)
    query = sep + query if sep else ""

    if path == "/anthropic/v1/models":
        return _join_url(OPENAI_BASE, "/models") + query, False

    if path.startswith("/anthropic/v1"):
        suffix = path[len("/anthropic/v1"):] or "/"
        return _join_url(ANTHROPIC_BASE, suffix) + query, True

    if path == "/v1/messages" or path.startswith("/v1/messages/"):
        suffix = path[len("/v1"):] or "/"
        return _join_url(ANTHROPIC_BASE, suffix) + query, True

    if path.startswith("/v1"):
        suffix = path[len("/v1"):] or "/"
        return _join_url(OPENAI_BASE, suffix) + query, False

    return _join_url(OPENAI_BASE, path) + query, False

def _body_bytes(body):
    if body is None:
        return None
    if isinstance(body, (dict, list)):
        return json.dumps(body).encode()
    if isinstance(body, str):
        return body.encode()
    return json.dumps(body).encode()

def _headers(incoming, is_anthropic, has_body):
    headers = {
        "User-Agent": UA,
        "Origin": ORIGIN,
        "Referer": ORIGIN.rstrip("/") + "/",
    }
    if has_body:
        headers["Content-Type"] = incoming.get("content-type") or incoming.get("Content-Type") or "application/json"
    if is_anthropic:
        headers["anthropic-version"] = incoming.get("anthropic-version") or "2023-06-01"
    if KEY:
        headers["api-key"] = KEY
        if is_anthropic:
            headers["x-api-key"] = KEY
        else:
            headers["Authorization"] = f"Bearer {KEY}"
    return headers

def _send_response(ws, req_id, status, content_type, data):
    try:
        body = json.loads(data) if data else {}
    except Exception:
        body = {"raw": data.decode("utf-8", errors="replace")[:2000]}
    ws.send(json.dumps({
        "type": "response",
        "id": req_id,
        "status": status,
        "headers": {"content-type": content_type or "application/json"},
        "body": body,
    }))

def handle_request(ws, msg):
    req_id = msg.get("id") or msg.get("req_id")
    public_path = msg.get("path", "/")
    method = msg.get("method", "POST").upper()
    body = msg.get("body")
    incoming = msg.get("headers", {}) or {}
    is_stream = bool(msg.get("stream", False))

    target, is_anthropic = _target_url(public_path)
    parsed = urlparse(target)
    req_path = parsed.path or "/"
    if parsed.query:
        req_path += "?" + parsed.query

    body_raw = None if method == "GET" else _body_bytes(body if body is not None else {})
    headers = _headers(incoming, is_anthropic, body_raw is not None)
    conn = None
    key = None

    try:
        log(f"{method} {public_path} -> {req_path}")
        try:
            conn, key = _get_conn(parsed)
            conn.timeout = 30
            conn.request(method, req_path, body=body_raw, headers=headers)
            resp = conn.getresponse()
        except Exception:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
            conn = _new_conn(*_conn_key(parsed))
            key = _conn_key(parsed)
            conn.request(method, req_path, body=body_raw, headers=headers)
            resp = conn.getresponse()

        try:
            resp._fp.raw._sock.settimeout(None)
        except Exception:
            pass

        status = resp.status
        content_type = resp.headers.get("content-type", "")

        if is_stream and "text/event-stream" in content_type:
            ws.send(json.dumps({
                "type": "stream_start",
                "id": req_id,
                "status": status,
                "headers": {"content-type": "text/event-stream"},
            }))
            while True:
                line = resp.readline()
                if not line:
                    break
                line = line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:]
                if data.strip() == "[DONE]":
                    break
                ws.send(json.dumps({"type": "stream_delta", "id": req_id, "chunk": data}))
            ws.send(json.dumps({"type": "stream_end", "id": req_id}))
        else:
            data = resp.read()
            _send_response(ws, req_id, status, content_type, data)

    except Exception as exc:
        err = json.dumps({"error": str(exc)[:2000]}).encode()
        _send_response(ws, req_id, 502, "application/json", err)
    finally:
        _return_conn(conn, key)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python bridge.py WS_URL [TOKEN] [--account-id ID]")
        sys.exit(1)

    target = sys.argv[1]
    token = ""
    account_id = ""
    for i, arg in enumerate(sys.argv[2:], 2):
        if arg == "--account-id" and i + 1 < len(sys.argv):
            account_id = sys.argv[i + 1]
        elif not arg.startswith("--") and i == 2:
            token = arg

    parsed_target = urlparse(target)
    # The manager already appends accountId and token to the WS URL,
    # so we only need to add them if they are missing from the URL.
    query = [parsed_target.query] if parsed_target.query else []
    if token and "token=" not in (parsed_target.query or ""):
        query.append(f"token={token}")
    if account_id and "accountId=" not in (parsed_target.query or ""):
        query.append(f"accountId={account_id}")

    if parsed_target.scheme in ("ws", "wss"):
        ws_path = parsed_target.path or "/ws"
        ws_url = f"{parsed_target.scheme}://{parsed_target.netloc}{ws_path}"
    else:
        server_parts = target.split(":")
        server_host = server_parts[0]
        server_port = int(server_parts[1]) if len(server_parts) > 1 else 4141
        proto = "wss" if server_port == 443 else "ws"
        ws_url = f"{proto}://{server_host}:{server_port}/ws/mimo"
    
    ws_url += ("?" + "&".join(query) if query else "")
    delay = 1

    ws = WebSocketClient()
    while True:
        try:
            log("Connecting...")
            ws.connect(ws_url)
            log("Connected")
            delay = 1
            while True:
                try:
                    raw = ws.recv(25)
                except socket.timeout:
                    ws.ping()
                    continue
                try:
                    message = json.loads(raw)
                except Exception:
                    continue
                
                msg_type = message.get("type")
                if msg_type == "request":
                    threading.Thread(target=handle_request, args=(ws, message), daemon=True).start()
                elif msg_type == "auth_challenge":
                    ws.send(json.dumps({"type": "auth_response", "code": message.get("code", "")}))
                    log("Auth OK")
                elif msg_type == "ping":
                    ws.send(json.dumps({"type": "pong", "id": message.get("id", "")}))
                elif msg_type == "disconnect":
                    log("Server requested disconnect, exiting")
                    raise SystemExit(0)
        except Exception as exc:
            log(f"Disconnected: {exc}")
        finally:
            ws.close()
        time.sleep(delay)
        delay = min(delay * 2, 30)
