// AUTH-0131 / AUTH-0132 / AUTH-0133 — serve フレーミング未被覆 spec テスト
//
// AUTH-0131: proto3 空 request message (StatusRequest/CloudPingRequest/AccountWhoamiRequest)
//            の contract 検証 (jsonFields:[] / optionalScalars:[] → handler normalize が no-op)
// AUTH-0132: NDJSON 行フレーミング (1行=1JSON / maxLine DoS / maxQueue 背圧 drop)
//            stdio (closeWritable=false) と socket (closeWritable=true) の分岐を含む
// AUTH-0133: gRPC 汎用 Invoke の null 応答エンコード非対称
//            (out===null→'' vs 型付き unary result??null→'null')
//
// ファイルは自己完結・ネットワーク/実機不使用 (全て mock or 純関数)。
// vitest unit project で実行可。

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// --- パス解決 ---
const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(HERE, "..", "..", "..", "kit", "src", "serve", "sesame.proto");
const MAP_PATH = resolve(HERE, "..", "..", "..", "kit", "src", "serve", "grpc-methods.generated.json");

// --- makeLineConnection (ndjson.js) ---
import { makeLineConnection } from "../../../kit/src/serve/framing/ndjson.js";

// ──────────────────────────────────────────────────────────────────────────────
// AUTH-0131: proto3 空 message 契約
// ──────────────────────────────────────────────────────────────────────────────

describe("[AUTH-0131] proto3 空 request message 契約 (params=[] 3メソッドの正準形)", () => {
  function loadProto() {
    return readFileSync(PROTO_PATH, "utf8");
  }

  function loadMethodMap() {
    return JSON.parse(readFileSync(MAP_PATH, "utf8"));
  }

  it("[AUTH-0131] sesame.proto の StatusRequest は本体フィールド 0 個の空 message", () => {
    const proto = loadProto();
    const match = proto.match(/message StatusRequest\s*\{([^}]*)\}/s);
    expect(match).not.toBeNull();
    expect(match[1].trim()).toBe("");
  });

  it("[AUTH-0131] sesame.proto の CloudPingRequest は本体フィールド 0 個の空 message", () => {
    const proto = loadProto();
    const match = proto.match(/message CloudPingRequest\s*\{([^}]*)\}/s);
    expect(match).not.toBeNull();
    expect(match[1].trim()).toBe("");
  });

  it("[AUTH-0131] sesame.proto の AccountWhoamiRequest は本体フィールド 0 個の空 message", () => {
    const proto = loadProto();
    const match = proto.match(/message AccountWhoamiRequest\s*\{([^}]*)\}/s);
    expect(match).not.toBeNull();
    expect(match[1].trim()).toBe("");
  });

  it("[AUTH-0131] grpc-methods.generated.json の Status エントリは jsonFields:[] を持つ", () => {
    const map = loadMethodMap();
    expect(map.Status).toBeDefined();
    expect(map.Status.jsonFields).toEqual([]);
  });

  it("[AUTH-0131] grpc-methods.generated.json の Status エントリは optionalScalars:[] を持つ", () => {
    const map = loadMethodMap();
    expect(map.Status.optionalScalars).toEqual([]);
  });

  it("[AUTH-0131] grpc-methods.generated.json の CloudPing エントリは jsonFields:[] / optionalScalars:[] を持つ", () => {
    const map = loadMethodMap();
    expect(map.CloudPing).toBeDefined();
    expect(map.CloudPing.jsonFields).toEqual([]);
    expect(map.CloudPing.optionalScalars).toEqual([]);
  });

  it("[AUTH-0131] grpc-methods.generated.json の AccountWhoami エントリは jsonFields:[] / optionalScalars:[] を持つ", () => {
    const map = loadMethodMap();
    expect(map.AccountWhoami).toBeDefined();
    expect(map.AccountWhoami.jsonFields).toEqual([]);
    expect(map.AccountWhoami.optionalScalars).toEqual([]);
  });

  it("[AUTH-0131] Status の method 名は 'status' (daemon.invoke へ届くメソッド識別子)", () => {
    const map = loadMethodMap();
    expect(map.Status.method).toBe("status");
  });

  it("[AUTH-0131] CloudPing の method 名は 'cloud.ping'", () => {
    const map = loadMethodMap();
    expect(map.CloudPing.method).toBe("cloud.ping");
  });

  it("[AUTH-0131] AccountWhoami の method 名は 'account.whoami'", () => {
    const map = loadMethodMap();
    expect(map.AccountWhoami.method).toBe("account.whoami");
  });

  it("[AUTH-0131] optionalScalars=[] の場合 optional-scalar presence 正規化ループが no-op になる (params 素通し確認)", () => {
    // grpc.js:124-132 の for (const f of (optionalScalars || [])) ループ。
    // optionalScalars が [] のとき、params はそのまま変更されない (no-op)。
    function applyOptionalScalarNormalization(params, optionalScalars) {
      const result = { ...params };
      for (const f of (optionalScalars || [])) {
        if (`_${f}` in result) {
          delete result[`_${f}`];
        } else {
          delete result[f];
        }
      }
      return result;
    }

    const map = loadMethodMap();
    for (const key of ["Status", "CloudPing", "AccountWhoami"]) {
      const { optionalScalars } = map[key];
      const params = {};
      const before = JSON.stringify(params);
      for (const f of optionalScalars) {
        // このブロックは実行されないはず
        if (`_${f}` in params) {
          delete params[`_${f}`];
        } else {
          delete params[f];
        }
      }
      expect(JSON.stringify(params)).toBe(before);
    }

    // 何らかの予期しないフィールドが入っても optionalScalars=[] なら削除されない
    const withExtra = { unexpectedField: "x" };
    expect(applyOptionalScalarNormalization(withExtra, [])).toEqual({ unexpectedField: "x" });
  });

  it("[AUTH-0131] jsonFields=[] の場合 jsonFields parse ループが no-op になる (params 素通し確認)", () => {
    // grpc.js:137-140 の for (const f of jsonFields) ループ。
    // jsonFields が [] のとき、params はそのまま変更されない (no-op)。
    function applyJsonFieldsParse(params, jsonFields) {
      const result = { ...params };
      const parseFail = vi.fn();
      for (const f of jsonFields) {
        if (result[f] === undefined || result[f] === "") { delete result[f]; continue; }
        try { result[f] = JSON.parse(result[f]); } catch { parseFail(); }
      }
      expect(parseFail).not.toHaveBeenCalled();
      return result;
    }

    const map = loadMethodMap();
    for (const key of ["Status", "CloudPing", "AccountWhoami"]) {
      const { jsonFields } = map[key];
      expect(applyJsonFieldsParse({}, jsonFields)).toEqual({});
    }
  });

  it("[AUTH-0131] params フィールドを持つ他 op (LockClick 等) との対照: optionalScalars が非空", () => {
    const map = loadMethodMap();
    // LockClick は optionalScalars に scriptIndex を持つ (params=[] でない対照点)
    expect(map.LockClick.optionalScalars).toContain("scriptIndex");
    // 3 メソッドはどれも空
    for (const key of ["Status", "CloudPing", "AccountWhoami"]) {
      expect(map[key].optionalScalars).toHaveLength(0);
      expect(map[key].jsonFields).toHaveLength(0);
    }

    // LockLock も optional scalar を持つ対照点
    const lockLock = map["LockLock"];
    expect(lockLock).toBeDefined();
    const hasParams = lockLock.optionalScalars.length > 0 || lockLock.jsonFields.length > 0;
    expect(hasParams).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTH-0132: NDJSON 行フレーミング (stdio・socket 共有実体)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * write の戻り値 (背圧) とイベント発火をテスト側から制御できる最小 fake writable。
 */
function fakeWritable() {
  const written = [];
  const handlers = {};
  return {
    written,
    writeResult: true,
    ended: false,
    destroyed: false,
    write(s) {
      written.push(s);
      return this.writeResult;
    },
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev) { handlers[ev]?.(); },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
  };
}

describe("[AUTH-0132] NDJSON 行フレーミング: send は JSON.stringify + '\\n' の 1 行", () => {
  it("[AUTH-0132] conn.send(obj) は JSON.stringify(obj)+'\\n' の 1 行で書き込む", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    conn.send({ method: "status", result: { connected: true } });

    expect(writable.written).toHaveLength(1);
    expect(writable.written[0]).toBe(JSON.stringify({ method: "status", result: { connected: true } }) + "\n");
  });

  it("[AUTH-0132] conn.send で複数オブジェクトを送ると各 1 行で書き込まれる", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    conn.send({ id: 1 });
    conn.send({ id: 2 });

    expect(writable.written[0]).toBe('{"id":1}\n');
    expect(writable.written[1]).toBe('{"id":2}\n');
  });
});

describe("[AUTH-0132] NDJSON 行フレーミング: 受信は '\\n' で行分割して onLine に渡す", () => {
  it("[AUTH-0132] 改行区切りの受信行は onLine へ 1 行ずつ渡される", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('{"jsonrpc":"2.0","id":1,"method":"status"}\n{"jsonrpc":"2.0","id":2,"method":"cloud.ping"}\n');

    expect(onLine).toHaveBeenCalledTimes(2);
    expect(onLine.mock.calls[0][1]).toBe('{"jsonrpc":"2.0","id":1,"method":"status"}');
    expect(onLine.mock.calls[1][1]).toBe('{"jsonrpc":"2.0","id":2,"method":"cloud.ping"}');
  });

  it("[AUTH-0132] チャンク跨ぎの 1 行は改行が来るまで onLine を呼ばず連結してから渡す", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('{"method":"account.');
    expect(onLine).not.toHaveBeenCalled();
    readable.write('whoami"}\n');
    expect(onLine).toHaveBeenCalledExactlyOnceWith(expect.anything(), '{"method":"account.whoami"}');
  });

  it("[AUTH-0132] 空行は onLine に渡されない (trim でスキップ)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('\n\n{"id":1}\n\n');

    expect(onLine).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0132] 複数リクエスト行 (status/cloud.ping/account.whoami) が 1 チャンクで届いても行ごとに分割されて onLine へ渡る", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "cloud.ping", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "account.whoami", params: {} }),
    ];
    readable.write(lines.join("\n") + "\n");

    expect(onLine).toHaveBeenCalledTimes(3);
    expect(onLine.mock.calls[0][1]).toBe(lines[0]);
    expect(onLine.mock.calls[1][1]).toBe(lines[1]);
    expect(onLine.mock.calls[2][1]).toBe(lines[2]);
  });
});

describe("[AUTH-0132] NDJSON 行フレーミング: maxLine DoS 上限", () => {
  it("[AUTH-0132] socket (closeWritable=true): 改行なしで maxLine 超過 → writable.destroy + conn.close", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine, onClose, maxLine: 10, closeWritable: true });

    readable.write("x".repeat(11)); // 改行無しで上限超過

    expect(onClose).toHaveBeenCalledTimes(1);
    // socket (closeWritable=true) は強制 destroy
    // ndjson.js: inbuf > maxLine → writable.destroy() → conn.close() → writable.end()
    // destroy は close() より先に呼ばれる (DoS 即断路)
    expect(writable.destroyed).toBe(true);
  });

  it("[AUTH-0132] stdio (closeWritable=false): 改行なしで maxLine 超過 → conn.close だが writable は触らない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose, maxLine: 10, closeWritable: false });

    readable.write("x".repeat(11));

    expect(onClose).toHaveBeenCalledTimes(1);
    // stdout 共有の stdio は destroy/end しない
    expect(writable.destroyed).toBe(false);
    expect(writable.ended).toBe(false);
  });

  it("[AUTH-0132] maxLine 以内で改行が来れば正常処理される (境界値=上限ちょうど)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine, onClose, maxLine: 10 });

    readable.write("x".repeat(10) + "\n"); // 改行で確定 → inbuf は空に戻る

    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("[AUTH-0132] maxLine 超過後に改行を送っても onLine は呼ばれない (closed ガード)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine, maxLine: 5, closeWritable: false });

    readable.write("x".repeat(6));
    readable.write("\n"); // 切断後に改行

    expect(onLine).not.toHaveBeenCalled();
  });
});

describe("[AUTH-0132] NDJSON 行フレーミング: maxQueue 背圧 drop", () => {
  it("[AUTH-0132] 送信キューが maxQueue 超過の遅い接続はその接続だけ close される", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), onClose, maxQueue: 2 });

    writable.writeResult = false; // 背圧発生
    conn.send({ n: 0 }); // 直接 write (false → draining)
    conn.send({ n: 1 }); // queue[0]
    conn.send({ n: 2 }); // queue[1] = maxQueue
    expect(onClose).not.toHaveBeenCalled();

    conn.send({ n: 3 }); // queue[2] > maxQueue → この接続だけ close
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0132] close 後の send は書き込まれない (closed ガード)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), maxQueue: 1 });

    writable.writeResult = false;
    conn.send({ n: 0 });
    conn.send({ n: 1 }); // queue[0]
    conn.send({ n: 2 }); // queue[1] > maxQueue → close

    const lenAfterClose = writable.written.length;
    conn.send({ n: 99 }); // close 後
    expect(writable.written.length).toBe(lenAfterClose);
  });

  it("[AUTH-0132] 遅延 drain 後はキューが順序どおり flush される", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    writable.writeResult = false;
    conn.send({ n: 1 });
    conn.send({ n: 2 });
    conn.send({ n: 3 });

    expect(writable.written).toEqual(['{"n":1}\n']); // 最初の 1 件だけ書かれた

    writable.writeResult = true;
    writable.emit("drain");

    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
  });
});

describe("[AUTH-0132] NDJSON 行フレーミング: stdio vs socket の closeWritable 分岐", () => {
  it("[AUTH-0132] stdio (closeWritable=false=既定): conn.close() は writable を end/destroy しない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), closeWritable: false });

    conn.close();

    expect(writable.ended).toBe(false);
    expect(writable.destroyed).toBe(false);
  });

  it("[AUTH-0132] socket (closeWritable=true): conn.close() は writable.end() を呼ぶ", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), closeWritable: true });

    conn.close();

    expect(writable.ended).toBe(true);
  });

  it("[AUTH-0132] 3 メソッド (status/cloud.ping/account.whoami) への応答は 1 行 JSON で届く (行プロトコル経由)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const responses = [];
    const onLine = vi.fn((_conn, raw) => {
      const parsed = JSON.parse(raw);
      responses.push(parsed);
    });
    const conn = makeLineConnection(readable, writable, { onLine });

    readable.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status" }) + "\n");
    readable.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "cloud.ping" }) + "\n");
    readable.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "account.whoami" }) + "\n");

    expect(onLine).toHaveBeenCalledTimes(3);
    expect(responses[0].method).toBe("status");
    expect(responses[1].method).toBe("cloud.ping");
    expect(responses[2].method).toBe("account.whoami");

    // 応答: conn.send で 1 行 JSON として書き込まれる
    conn.send({ jsonrpc: "2.0", id: 1, result: { connected: true } });
    expect(writable.written[0]).toMatch(/^\{.*\}\n$/);
    const resp = JSON.parse(writable.written[0].trimEnd());
    expect(resp.result.connected).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTH-0133: gRPC 汎用 Invoke の null 応答エンコード非対称
// ──────────────────────────────────────────────────────────────────────────────

describe("[AUTH-0133] gRPC Invoke null 応答エンコード非対称", () => {
  // grpc.js の 2 箇所のエンコードを純関数として模倣して非対称を検証する。
  // 実際の gRPC スタックは使わない (E2E は grpc.test.js が担う)。

  /** 型付き unary のエンコード (grpc.js:146) */
  function typedUnaryEncode(result) {
    // callback(null, { json: JSON.stringify(result ?? null) });
    return JSON.stringify(result ?? null);
  }

  /** 汎用 Invoke のエンコード (grpc.js:171) */
  function invokeEncode(out) {
    // callback(null, { json: out === null ? "" : JSON.stringify(out) });
    return out === null ? "" : JSON.stringify(out);
  }

  it("[AUTH-0133] 型付き unary: result=null → JSON.stringify(null??null) = 'null'", () => {
    expect(typedUnaryEncode(null)).toBe("null");
  });

  it("[AUTH-0133] 型付き unary: result=undefined → JSON.stringify(undefined??null) = 'null'", () => {
    expect(typedUnaryEncode(undefined)).toBe("null");
  });

  it("[AUTH-0133] 汎用 Invoke: out=null (通知) → '' (空文字列)", () => {
    expect(invokeEncode(null)).toBe("");
  });

  it("[AUTH-0133] 汎用 Invoke と型付き unary の null エンコードは非対称 ('' vs 'null')", () => {
    const invNull = invokeEncode(null);
    const typedNull = typedUnaryEncode(null);
    expect(invNull).toBe("");
    expect(typedNull).toBe("null");
    expect(invNull).not.toBe(typedNull);
  });

  it("[AUTH-0133] 汎用 Invoke: out=undefined → JSON.stringify(undefined) (非null→stringify経路)", () => {
    // out===null チェックは strict なので undefined は stringify 経路へ
    // JSON.stringify(undefined) は undefined を返す (文字列化できない)
    const encoded = invokeEncode(undefined);
    expect(encoded).toBeUndefined();
  });

  it("[AUTH-0133] 汎用 Invoke: out={...} (非 null 応答) → JSON.stringify で文字列化", () => {
    const result = { jsonrpc: "2.0", id: 1, result: { connected: true } };
    const encoded = invokeEncode(result);
    expect(encoded).toBe(JSON.stringify(result));
    expect(encoded).not.toBe("");
    expect(JSON.parse(encoded)).toEqual(result);
  });

  it("[AUTH-0133] 型付き unary: result={...} (非 null 応答) → JSON.stringify で文字列化", () => {
    const result = { connected: true, subUUID: "s" };
    const encoded = typedUnaryEncode(result);
    expect(encoded).toBe(JSON.stringify(result));
    expect(JSON.parse(encoded)).toEqual(result);
  });

  it("[AUTH-0133] '' を JSON.parse しようとすると SyntaxError になる (クライアント側の破損リスク)", () => {
    const emptyJson = invokeEncode(null); // = ''
    expect(() => JSON.parse(emptyJson)).toThrow(SyntaxError);
  });

  it("[AUTH-0133] 'null' は JSON.parse すると null になる (型付き unary の null は安全に解析できる)", () => {
    const nullJson = typedUnaryEncode(null); // = 'null'
    expect(JSON.parse(nullJson)).toBeNull();
  });

  it("[AUTH-0133] Invoke 経由での 3 メソッド (status/cloud.ping/account.whoami) の非通知結果は JSON.stringify で運ばれる", () => {
    // 3 メソッドは通知でなくリクエストに対する応答を返す → out は null にならない
    // → invokeEncode(out) で '' ではなく JSON.stringify(out) が使われる
    const rpcResponse = { jsonrpc: "2.0", id: 1, result: { version: "0.6.2" } };
    const encoded = invokeEncode(rpcResponse);
    expect(encoded).not.toBe("");
    expect(JSON.parse(encoded)).toEqual(rpcResponse);
  });

  it("[AUTH-0133] Invoke の null 経路は通知 (id なし) リクエストに対して発動する (dispatchMessage=null)", () => {
    // dispatchMessage は通知 (id なし) に対して null を返す (handleMessage:notification)
    // → out===null → callback(null, {json:''})
    const notificationOut = null; // handleMessage notification → return null
    const encoded = invokeEncode(notificationOut);
    expect(encoded).toBe("");
  });

  it("[AUTH-0133] Invoke: '' を受けたクライアントが JSON.parse すると例外 / 'null' は安全 (非対称の文書化)", () => {
    const emptyJsonStr = invokeEncode(null);   // Invoke の null 応答 = ''
    const nullJsonStr = typedUnaryEncode(null); // 型付き unary の null 応答 = 'null'

    // '' は valid JSON ではないため例外
    expect(() => JSON.parse(emptyJsonStr)).toThrow();
    // 'null' は valid JSON (null として parse できる)
    expect(() => JSON.parse(nullJsonStr)).not.toThrow();
    expect(JSON.parse(nullJsonStr)).toBeNull();
  });
});
