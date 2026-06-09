// `sesame ble` の生体一覧コレクタ (collectBiometricList) の単体テスト。
// GET 要求後にデバイスが publish (START → NOTIFY×N → END) を返す設計を、delegate を
// 撃つ fake cmds で再現し、END 確定 / timeout 確定 / 複数レコード / 単一オブジェクトを検証。
import { describe, it, expect } from "vitest";
import { collectBiometricList, formatRecord, BIO_LIST } from "../../src/cli/ble.js";

/** registerDelegate で delegate を捕捉し、getter 呼び出しで script を流す fake。 */
function makeCmds(getterName, fire) {
  let delegate = null;
  return {
    registerDelegate(d) { delegate = d; return () => { delegate = null; }; },
    [getterName]: () => { fire(delegate); return Promise.resolve(); },
  };
}

describe("collectBiometricList", () => {
  it("card: START → NOTIFY×2 → END で 2 レコードを {id,name,type} で返す", async () => {
    const spec = BIO_LIST.card;
    const cmds = makeCmds(spec.getter, (d) => {
      d.onCardReceiveStart(undefined);
      d.onCardReceive(undefined, "01", Buffer.from("Alice"), 1);
      d.onCardReceive(undefined, "02", Buffer.from("Bob"), 2);
      d.onCardReceiveEnd(undefined);
    });
    const recs = await collectBiometricList(cmds, spec, 1000);
    expect(recs).toEqual([
      { id: "01", name: "Alice", type: 1 },
      { id: "02", name: "Bob", type: 2 },
    ]);
  });

  it("face: single レコードはパース済みオブジェクトをそのまま積む", async () => {
    const spec = BIO_LIST.face;
    const obj = { faceID: 7, name: "X" };
    const cmds = makeCmds(spec.getter, (d) => {
      d.onFaceReceiveStart(undefined);
      d.onFaceReceive(undefined, obj);
      d.onFaceReceiveEnd(undefined);
    });
    const recs = await collectBiometricList(cmds, spec, 1000);
    expect(recs).toEqual([obj]);
  });

  it("END が来なくても timeout で収集済みを返す", async () => {
    const spec = BIO_LIST.passcode;
    const cmds = makeCmds(spec.getter, (d) => {
      d.onKeyBoardReceiveStart(undefined);
      d.onKeyBoardReceive(undefined, "AA", Buffer.from("pin"), 0);
      // END を送らない → timeout 待ち
    });
    const start = Date.now();
    const recs = await collectBiometricList(cmds, spec, 30);
    expect(recs).toEqual([{ id: "AA", name: "pin", type: 0 }]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("getter が reject しても publish/timeout で確定する (送信失敗を握りつぶさず待つ)", async () => {
    const spec = BIO_LIST.card;
    let delegate = null;
    const cmds = {
      registerDelegate(d) { delegate = d; return () => {}; },
      cardGet() {
        // 先に END を撃ってから reject (ack 失敗でも収集は END 駆動)。
        delegate.onCardReceiveEnd(undefined);
        return Promise.reject(new Error("ack failed"));
      },
    };
    const recs = await collectBiometricList(cmds, spec, 1000);
    expect(recs).toEqual([]);
  });
});

describe("formatRecord", () => {
  it("{id,name,type} は tab 区切り", () => {
    expect(formatRecord({ id: "01", name: "Alice", type: 1 })).toBe("01\tAlice\ttype=1");
  });
  it("オブジェクト (face/palm) は JSON", () => {
    expect(formatRecord({ faceID: 7 })).toBe('{"faceID":7}');
  });
});
