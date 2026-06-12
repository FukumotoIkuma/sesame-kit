// src/serve/framing/ndjson.js (makeLineConnection) の境界テスト (REFACTORING_PLAN P5-7 / ARCH-17)。
// stdio / Unix socket が共有する NDJSON Connection の防御要所を直接検証する:
//   - maxLine 超過 (改行が来ないまま 1 行が上限超過) → DoS とみなし切断
//   - 出力背圧: write が false を返したら queue に積み、drain で順序を保って flush
//   - maxQueue 超過 (追いつけない購読者) → その接続だけ close
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { makeLineConnection } from "../../src/serve/framing/ndjson.js";

/**
 * write の戻り値 (背圧) とイベント発火をテスト側から制御できる最小 fake writable。
 * PassThrough だと highWaterMark を跨ぐデータ量の調整が要るので、戻り値を直接制御する。
 */
function fakeWritable() {
  /** @type {string[]} */
  const written = [];
  /** @type {Record<string, Function>} */
  const handlers = {};
  return {
    written,
    writeResult: true, // テスト側から false に切り替えて背圧を疑似発生させる
    ended: false,
    destroyed: false,
    /** @param {string} s */
    write(s) {
      written.push(s);
      return this.writeResult;
    },
    /** @param {string} ev @param {Function} fn */
    on(ev, fn) {
      handlers[ev] = fn;
    },
    /** @param {string} ev */
    emit(ev) {
      handlers[ev]?.();
    },
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

describe("makeLineConnection: 行分割の基本", () => {
  it("改行区切りで onLine が呼ばれ、空行はスキップされる", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('{"a":1}\n\n{"b":2}\n');
    expect(onLine).toHaveBeenCalledTimes(2);
    expect(onLine.mock.calls[0][1]).toBe('{"a":1}');
    expect(onLine.mock.calls[1][1]).toBe('{"b":2}');
  });

  it("チャンク跨ぎの 1 行は連結してから onLine に渡す", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('{"a":');
    expect(onLine).not.toHaveBeenCalled();
    readable.write("1}\n");
    expect(onLine).toHaveBeenCalledExactlyOnceWith(expect.anything(), '{"a":1}');
  });
});

describe("makeLineConnection: maxLine 超過 (OOM DoS 防御)", () => {
  it("改行の無い行が maxLine を超えたら切断し、以後の入力を無視する", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine, onClose, maxLine: 16, closeWritable: true });

    readable.write("x".repeat(17)); // 改行なしで上限超過
    expect(onClose).toHaveBeenCalledTimes(1);
    // writable を所有する場合 (socket) は graceful end ではなく強制 destroy
    expect(writable.destroyed).toBe(true);

    // 切断後に改行を送っても onLine は呼ばれない (closed ガード)
    readable.write("\n");
    expect(onLine).not.toHaveBeenCalled();
  });

  it("closeWritable=false (stdio: stdout 共有) では writable を destroy しない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose, maxLine: 16, closeWritable: false });

    readable.write("x".repeat(17));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writable.destroyed).toBe(false);
    expect(writable.ended).toBe(false);
  });

  it("maxLine 以内の行は通常どおり処理される (境界値)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine, onClose, maxLine: 16 });

    readable.write("x".repeat(16) + "\n"); // 改行で確定すれば inbuf は空に戻る
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("makeLineConnection: 出力背圧 (write/drain)", () => {
  it("write が false を返したら以後は queue に積み、drain で順序どおり flush する", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    writable.writeResult = false; // 背圧発生
    conn.send({ n: 1 }); // 書き込まれるが false → draining
    conn.send({ n: 2 }); // queue
    conn.send({ n: 3 }); // queue
    expect(writable.written).toEqual(['{"n":1}\n']);

    writable.writeResult = true;
    writable.emit("drain"); // queue を順に flush
    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);

    // drain 後は直接 write に戻る
    conn.send({ n: 4 });
    expect(writable.written).toHaveLength(4);
  });

  it("drain 中に再び write が false を返したら flush を中断し、残りは次の drain まで保持する", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    writable.writeResult = false;
    conn.send({ n: 1 });
    conn.send({ n: 2 });
    conn.send({ n: 3 });

    // drain したが 1 件書いた時点でまた背圧 (writeResult は false のまま)
    writable.emit("drain");
    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n']);

    writable.writeResult = true;
    writable.emit("drain");
    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
  });

  it("queue が maxQueue を超えた遅い接続はその接続だけ close される", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), onClose, maxQueue: 2 });

    writable.writeResult = false;
    conn.send({ n: 0 }); // 直接 write (false → draining)
    conn.send({ n: 1 }); // queue[0]
    conn.send({ n: 2 }); // queue[1]
    expect(onClose).not.toHaveBeenCalled();
    conn.send({ n: 3 }); // queue[2] > maxQueue → close
    expect(onClose).toHaveBeenCalledTimes(1);

    // close 後の send は無視される (closed ガード)
    conn.send({ n: 4 });
    expect(writable.written).toEqual(['{"n":0}\n']);
  });
});

describe("makeLineConnection: close の冪等性", () => {
  it("close は二度呼んでも onClose は 1 回だけ", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    conn.close();
    conn.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("readable の end/error でも close される", async () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    readable.end(); // PassThrough の 'end' は非同期発火
    await new Promise((r) => setImmediate(r));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
