"""sesame serve の薄い公式 Python クライアント (標準ライブラリのみ・依存ゼロ)。

事前に CLI 側でログイン:  sesame login <email>

    pip install ./clients/python      # どこからでも import 可能に
    from sesame_client import SesameClient

    c = SesameClient.unix()                       # 既定 UDS パスを自動解決 (sesame serve で起動)
    print(c.status())
    print(c.unlock("front"))                      # = c.call("lock.unlock", name="front")

    # HTTP:   SesameClient.http("http://127.0.0.1:8080")   (token は serve.token から自動)
    # 埋め込み: SesameClient.stdio()

    # イベント購読 (UDS/stdio/HTTP 共通)。受信し続けるには wait() でメインを生かす。
    c.subscribe(["lockState"], lambda topic, payload: print("EVENT", topic, payload))
    c.wait()

失敗は SesameRpcError(message, kind) を raise (kind: not_authenticated / connection_lost / timeout /
not_implemented / bad_params / rejected / internal — serve の error.data.kind 7 種と一致)。
(旧名 SesameError は deprecated alias として 1 リリース維持。)
エラーメッセージは「次に何をすべきか」を含む (例: デーモン未起動なら起動コマンドを案内)。
"""
from __future__ import annotations

import itertools
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Any, Callable, Optional


def _default_config_dir() -> str:
    # CLI の権威ある解決順 (src/paths.js) に合わせる:
    #   1. SESAME_KIT_HOME (アプリ専用) → そのディレクトリ直下
    #   2. XDG_CONFIG_HOME → $XDG_CONFIG_HOME/sesame-kit
    #   3. ~/.config/sesame-kit
    # クライアントは standalone コピーなので src/ から import せず自前で再現する。
    home = os.environ.get("SESAME_KIT_HOME")
    if home:
        return home
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return os.path.join(xdg, "sesame-kit")
    return os.path.join(os.path.expanduser("~"), ".config", "sesame-kit")


def _default_socket_path() -> str:
    return os.path.join(_default_config_dir(), "sesame.sock")


def _default_token_path() -> str:
    return os.path.join(_default_config_dir(), "serve.token")


# P4-9 (SURF-35): core の SesameError (src/errors.js, code:string) との同名異義を解消するため、
# clients/js・sdk/python と同じ SesameRpcError (kind / code:int) に改名。name はクラス名と同期する。
class SesameRpcError(RuntimeError):
    def __init__(self, message: str, kind: Optional[str] = None, code: Optional[int] = None):
        super().__init__(message)
        self.message, self.kind, self.code = message, kind, code

    def __str__(self):
        extra = f" [{self.kind}]" if self.kind else ""
        return f"{self.message}{extra}"


# deprecated alias: 後方互換として 1 リリース維持し、次 minor で削除予定。
# (旧名 SesameError と core の SesameError — src/errors.js — は同名異義だった)
SesameError = SesameRpcError


# HTTP ステータス → SesameRpcError.kind 写像 (出典: REFACTORING_PLAN.md P4-5/SURF-10)。
# sdk/ts・sdk/python・clients/js と共通の正で、tests/fixtures/http-kind-map.json に固定。
#   400/413/415→bad_params, 401/403→not_authenticated, 404→not_implemented,
#   408/429/5xx→connection_lost (再試行可), その他→internal
# (thin クライアントは retryable フィールドを持たない — connection_lost が再試行可能の意)
def _http_kind(status: int) -> str:
    if status in (401, 403):
        return "not_authenticated"
    if status in (400, 413, 415):
        return "bad_params"
    if status == 404:
        return "not_implemented"
    if status in (408, 429) or status >= 500:
        return "connection_lost"
    return "internal"


def _sesame_error_from_http(code: int, reason: str, body: bytes) -> SesameRpcError:
    text = body.decode("utf-8", "replace") if body else ""
    try:
        data = json.loads(text) if text else None
    except json.JSONDecodeError:
        data = None
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        err_data = err.get("data") or {}
        return SesameRpcError(err.get("message") or reason or "HTTP error", err_data.get("kind") or _http_kind(code), err.get("code", code))
    if isinstance(err, str):
        return SesameRpcError(err, _http_kind(code), code)
    return SesameRpcError(text or f"HTTP {code}: {reason}", _http_kind(code), code)


class SesameClient:
    """JSON-RPC over UDS / stdio / HTTP. 直接 new せず unix()/stdio()/http() を使う。"""

    def __init__(self, transport):
        self._t = transport  # id 採番は transport が一元管理 (call と subscribe で衝突しないよう)

    # ---- ファクトリ ----
    @classmethod
    def unix(cls, path: Optional[str] = None) -> "SesameClient":
        path = path or _default_socket_path()
        if not hasattr(socket, "AF_UNIX"):
            raise SesameRpcError("Unix socket は POSIX 専用です。Windows では SesameClient.http() か .stdio() を使ってください",
                                 kind="not_implemented")
        return cls(_StreamTransport(_connect_unix(path)))

    @classmethod
    def stdio(cls, cmd=("sesame", "serve", "--stdio")) -> "SesameClient":
        return cls(_StdioTransport(cmd))

    @classmethod
    def http(cls, base: str = "http://127.0.0.1:8080", token: Optional[str] = None) -> "SesameClient":
        if token is None:
            try:
                with open(_default_token_path()) as f:
                    token = f.read().strip()
            except OSError:
                token = None  # 後続 401 で具体的に案内する
        return cls(_HttpTransport(base.rstrip("/"), token))

    # ---- 基本 API ----
    def call(self, method: str, **params) -> Any:
        # id は transport が採番する (call と subscribe で id 空間を共有させ衝突を防ぐ)。
        resp = self._t.request({"jsonrpc": "2.0", "method": method, "params": params})
        if "error" in resp:
            e = resp["error"]
            raise SesameRpcError(e.get("message", "error"), (e.get("data") or {}).get("kind"), e.get("code"))
        return resp.get("result")

    def subscribe(self, topics, on_event: Callable[[str, Any], None]) -> None:
        """topics を購読し、各イベントで on_event(topic, payload) を呼ぶ (バックグラウンド)。
        受信し続けるにはメインスレッドを生かすこと → wait() が使える。
        接続/認証/不正 topic エラーは握り潰さず SesameRpcError を raise する (JS クライアントと対称)。"""
        resp = self._t.subscribe(list(topics), on_event)
        # UDS/stdio は購読要求の応答 (dict) を返す。error があれば raise (不正 topic 等)。
        # HTTP は初回接続を同期確立し 401/400 をその場で raise 済み (resp は None)。
        if isinstance(resp, dict) and "error" in resp:
            e = resp["error"]
            raise SesameRpcError(e.get("message", "error"), (e.get("data") or {}).get("kind"), e.get("code"))

    def wait(self) -> None:
        """購読を生かしたままブロックする (Ctrl-C で抜ける)。"""
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass

    def discover(self) -> Any:
        return self.call("rpc.discover")

    def discover_names(self):
        return [m["name"] for m in self.discover()["methods"]]

    # ---- よく使うショートカット ----
    def status(self):
        return self.call("status")

    def unlock(self, name=None, **kw):
        return self.call("lock.unlock", **({"name": name} if name else {}), **kw)

    def lock(self, name=None, **kw):
        return self.call("lock.lock", **({"name": name} if name else {}), **kw)

    def toggle(self, name=None, **kw):
        return self.call("lock.toggle", **({"name": name} if name else {}), **kw)

    def devices(self):
        return self.call("devices.list")

    def close(self):
        self._t.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ---------------- transports ----------------

def _connect_unix(path: str):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(path)
    except (FileNotFoundError, ConnectionRefusedError):
        s.close()
        raise SesameRpcError(
            f"sesame serve が起動していません (socket: {path})。別ターミナルで `sesame serve` を実行してください",
            kind="connection_lost") from None
    except OSError as e:
        s.close()
        raise SesameRpcError(f"socket 接続失敗: {e}", kind="connection_lost") from e
    return s


class _StreamTransport:
    """UDS など双方向ストリーム共通。応答とイベントを id/method で振り分ける。"""

    def __init__(self, sock):
        self._sock = sock
        self._wfile = sock.makefile("w")
        self._rfile = sock.makefile("r")
        self._pending: dict[int, dict] = {}
        self._ids = itertools.count(1)  # call と subscribe で共有する id 空間
        self._on_event: Optional[Callable[[str, Any], None]] = None
        self._lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self._rfile:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            slot = None
            if "id" in msg:
                with self._lock:               # pending の参照/取り出しは登録と同一 lock で保護
                    slot = self._pending.pop(msg["id"], None)
            if slot is not None:
                slot["msg"] = msg
                slot["ev"].set()
            elif isinstance(msg.get("method"), str) and msg["method"].startswith("event."):
                if self._on_event:
                    self._on_event(msg["method"][len("event."):], msg.get("params"))

    def request(self, msg: dict) -> dict:
        mid = next(self._ids)             # ここで一意 id を採番 (caller は id を持たない)
        msg = {**msg, "id": mid}
        slot = {"ev": threading.Event(), "msg": None}
        with self._lock:                  # pending 登録と write を同一 lock 内で (reader との競合を防ぐ)
            self._pending[mid] = slot
            self._wfile.write(json.dumps(msg) + "\n")
            self._wfile.flush()
        if not slot["ev"].wait(timeout=20):
            with self._lock:
                self._pending.pop(mid, None)
            raise SesameRpcError("request timed out", kind="timeout")
        return slot["msg"]

    def subscribe(self, topics, on_event):
        self._on_event = on_event
        return self.request({"jsonrpc": "2.0", "method": "events.subscribe", "params": {"topics": topics}})

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass


class _StdioTransport(_StreamTransport):
    def __init__(self, cmd):
        try:
            self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True, bufsize=1)
        except FileNotFoundError:
            raise SesameRpcError(
                f"`{cmd[0]}` が見つかりません。`npm link` (sesame-kit 内で実行) で PATH を通すか、"
                f"cmd=['node','bin/sesame.js','serve','--stdio'] を渡してください",
                kind="connection_lost") from None
        # stderr を読む儀式は不要 (早期入力は OS パイプが buffer。request は timeout 付き)。
        # 起動直後に死んだ場合だけ検知して分かりやすく報告する。
        if self._proc.poll() is not None:
            err = (self._proc.stderr.read() or "").strip()
            raise SesameRpcError(f"sesame serve が起動直後に終了しました: {err}", kind="connection_lost")
        self._wfile = self._proc.stdin
        self._rfile = self._proc.stdout
        self._pending = {}
        self._ids = itertools.count(1)
        self._on_event = None
        self._lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def close(self):
        try:
            self._proc.stdin.close()
            self._proc.terminate()
        except Exception:
            pass


class _HttpTransport:
    def __init__(self, base: str, token: Optional[str]):
        self._base, self._token = base, token
        self._ids = itertools.count(1)

    def _headers(self):
        h = {"content-type": "application/json"}
        if self._token:
            h["authorization"] = f"Bearer {self._token}"
        return h

    def _unauthorized(self):
        if not self._token:
            return SesameRpcError(
                f"token が見つかりません。`sesame serve --http` で起動すると {_default_token_path()} に保存されます "
                f"(または http(token=...) で明示指定)", kind="not_authenticated", code=401)
        return SesameRpcError("unauthorized (token 不一致)", kind="not_authenticated", code=401)

    def request(self, msg: dict) -> dict:
        msg = {**msg, "id": next(self._ids)}  # id 必須 (無いと通知扱いで応答が返らない)
        data = json.dumps(msg).encode()
        req = urllib.request.Request(f"{self._base}/rpc", data=data, headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
                return json.loads(body) if body else {"id": msg["id"], "result": None}
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code == 401 and not self._token:
                raise self._unauthorized() from None
            raise _sesame_error_from_http(e.code, str(e.reason), body) from None
        except urllib.error.URLError as e:
            raise SesameRpcError(f"接続失敗: {e.reason}。`sesame serve --http` を起動しましたか?",
                                 kind="connection_lost") from None

    def subscribe(self, topics, on_event):
        q = ",".join(topics)
        # token は Authorization ヘッダ (_headers) で送る。URL クエリに載せると proxy/access ログに漏れる。
        url = f"{self._base}/events?topics={q}"
        # 初回接続を**同期で**確立し、401/400 (不正 topic) をその場で raise (JS と対称。
        # バックグラウンドで黙って失敗していた旧挙動を是正)。
        req = urllib.request.Request(url, headers=self._headers())
        try:
            r = urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code == 401 and not self._token:
                raise self._unauthorized() from None
            raise _sesame_error_from_http(e.code, str(e.reason), body) from None
        except urllib.error.URLError as e:
            raise SesameRpcError(f"events 接続失敗: {e.reason}。`sesame serve --http` を起動しましたか?",
                                 kind="connection_lost") from None

        def run():
            try:
                with r:
                    for raw in r:
                        line = raw.decode().strip()
                        if line.startswith("data: "):
                            msg = json.loads(line[len("data: "):])
                            m = msg.get("method", "")
                            if m.startswith("event."):
                                on_event(m[len("event."):], msg.get("params"))
            except Exception as exc:  # 確立後のストリーム中断は握り潰さず stderr に
                print(f"[sesame] subscribe stream error: {exc}", file=sys.stderr)

        threading.Thread(target=run, daemon=True).start()

    def close(self):
        pass


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "unix"
    c = SesameClient.http() if mode == "http" else SesameClient.unix()
    print("status:", c.status())
    print("methods:", len(c.discover_names()))
