// packages/core/tests/_spec/co-c0.test.js
// Spec-driven tests for CO-0004 through CO-0021 (company domain).
// Each it() title is prefixed with its spec ID.  Tests are TDD: assertions
// follow the spec contract (spec/company.md).  Where the implementation
// currently diverges from spec the test is expected to be red.
// No network / real device / BLE access — all pure-function or mock-based.
//
// 実装参照:
//   packages/core/src/company.js     — 4 op 本体
//   packages/core/src/client.js      — _bindNs companyID/subUUID 自動注入
//   packages/kit/src/cli/company.js  — registerCompanyCommands (CO-0014)
//   packages/kit/src/serve/rpc-params.generated.json (CO-0016)
//
// i18n: setup.i18n.js により ja 固定。
//   companyID required    → company.err.companyIDRequired → "companyID required"
//   name required         → company.err.nameRequired       → "name required"
//   employeeEmail required → company.err.employeeEmailRequired
//   subUUID required      → company.err.subUUIDRequired
//   getPaymentConfig の companyID バリデーションはリテラル t("companyID required") を使う
//   (i18n キーではないため ja でも "companyID required" がそのまま返る)。

import { describe, it, expect, vi } from "vitest";

import {
  NAMESPACE_OPS,
  getCompanies,
  updateCompanyName,
  addCompany,
  getPaymentConfig,
} from "../../src/company.js";
import { SesameError, ERR } from "../../src/errors.js";
import { mockClient } from "../helpers/mock-ws.js";

// ─── CO-0004: NAMESPACE_OPS allowlist ─────────────────────────────────────────

describe("[CO-0004] NAMESPACE_OPS allowlist が 4 op 限定 (getLoginUser は account.js へ分離)", () => {
  it("[CO-0004] NAMESPACE_OPS は ['getCompanies','updateCompanyName','addCompany','getPaymentConfig'] の 4 件のみで getLoginUser を含まない", () => {
    const expected = ["getCompanies", "updateCompanyName", "addCompany", "getPaymentConfig"];
    expect(NAMESPACE_OPS).toEqual(expected);
    expect(NAMESPACE_OPS).toHaveLength(4);
    expect(NAMESPACE_OPS).not.toContain("getLoginUser");
    expect(NAMESPACE_OPS).not.toContain("biz3GetLoginUser");
  });

  it("[CO-0004] NAMESPACE_OPS は配列である", () => {
    expect(Array.isArray(NAMESPACE_OPS)).toBe(true);
  });

  it("[CO-0004] NAMESPACE_OPS の件数は正確に 4", () => {
    expect(NAMESPACE_OPS).toHaveLength(4);
  });
});

// ─── CO-0005: _bindNs companyID/subUUID 自動注入 ──────────────────────────────

describe("[CO-0005] hub.company.* が companyID/subUUID を自動注入 (params で上書き可)", () => {
  // _bindNs は client.js で実装。
  // out[name] = (params = {}) => fn(ws, { companyID, subUUID, ...params })
  // params が後勝ちするため明示 companyID で上書き可能であることを検証する。

  it("[CO-0005] _bindNs は {companyID, subUUID, ...params} の形で op 関数を呼ぶ (params 後勝ち)", async () => {
    const companyID = "default-cmp";
    const subUUID = "default-sub";
    const ws = mockClient({ success: true, data: [] });

    // _bindNs 相当の注入ロジック
    const injected = (params = {}) => getCompanies(ws, { companyID, subUUID, ...params });

    // 既定注入の確認: getCompanies はフレームに companyID を乗せないが呼び出し自体は成立する
    await injected();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual({ action: "biz3ManageCompany", op: "get" });
  });

  it("[CO-0005] params.companyID を明示すると後勝ちで上書きされる (getPaymentConfig で確認)", async () => {
    const companyID = "default-cmp";
    const subUUID = "default-sub";
    const ws = mockClient({ success: true, data: { level: 1 } });

    // _bindNs 相当: getPaymentConfig(ws, {companyID:'default-cmp', ...params})
    // params={companyID:'explicit-cmp'} を渡すと explicit が後勝ちする
    const injected = (params = {}) => getPaymentConfig(ws, { companyID, subUUID, ...params });

    await injected({ companyID: "explicit-cmp" });
    expect(ws.sent[0].companyID).toBe("explicit-cmp");
  });

  it("[CO-0005] updateCompanyName にも companyID が自動注入される", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_AUTO", name: "test" } });
    const ns = (params = {}) =>
      updateCompanyName(c, { companyID: "ch_AUTO", subUUID: "sub-AUTO", ...params });
    await ns({ name: "test" });
    // obj にネストされた companyID が ch_AUTO であること
    expect(c.sent[0].obj.companyID).toBe("ch_AUTO");
  });

  it("[CO-0005] addCompany に subUUID が自動注入される", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_NEW" } });
    const ns = (params = {}) =>
      addCompany(c, { companyID: "ch_AUTO", subUUID: "sub-AUTO", ...params });
    await ns({ name: "NewCo", employeeEmail: "e@example.com" });
    expect(c.sent[0].subUUID).toBe("sub-AUTO");
  });
});

// ─── CO-0006: getCompanies 送信フレーム ─────────────────────────────────────

describe("[CO-0006] getCompanies → biz3ManageCompany get フレーム (フラット, companyID/email/obj 無し)", () => {
  it("[CO-0006] 送信フレームのキー集合が {action, op} のみで companyID/email/obj を含まない", async () => {
    const c = mockClient({ success: true, data: [] });
    await getCompanies(c);

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame).toEqual({ action: "biz3ManageCompany", op: "get" });
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("email");
    expect(frame).not.toHaveProperty("obj");
    expect(Object.keys(frame).sort()).toEqual(["action", "op"].sort());
  });

  it("[CO-0006] action が 'biz3ManageCompany' で op が 'get'", async () => {
    const c = mockClient({ success: true, data: [] });
    await getCompanies(c);
    expect(c.sent[0].action).toBe("biz3ManageCompany");
    expect(c.sent[0].op).toBe("get");
  });
});

// ─── CO-0007: getCompanies 応答パース ────────────────────────────────────────

describe("[CO-0007] getCompanies 応答パース (message.data 配列をそのまま返す / 非配列は [])", () => {
  it("[CO-0007] 応答 data が配列のときそのまま返す (obj ラップしない)", async () => {
    const companies = [
      { companyID: "ch_A", name: "会社A" },
      { companyID: "ch_B", name: "会社B" },
    ];
    const c = mockClient({ success: true, data: companies });
    const r = await getCompanies(c);
    expect(r).toEqual(companies);
    expect(Array.isArray(r)).toBe(true);
  });

  it("[CO-0007] data が欠落 (undefined) のとき [] を返す", async () => {
    const c = mockClient({ success: true });
    expect(await getCompanies(c)).toEqual([]);
  });

  it("[CO-0007] data が null (非配列) のとき [] を返す", async () => {
    const c = mockClient({ success: true, data: null });
    expect(await getCompanies(c)).toEqual([]);
  });

  it("[CO-0007] data がオブジェクト (非配列) のとき [] を返す (obj ラップしない)", async () => {
    const c = mockClient({ success: true, data: { companies: [] } });
    expect(await getCompanies(c)).toEqual([]);
  });

  it("[CO-0007] data が空配列のとき [] を返す", async () => {
    const c = mockClient({ success: true, data: [] });
    expect(await getCompanies(c)).toEqual([]);
  });

  it("[CO-0007] data が文字列のとき [] を返す", async () => {
    const c = mockClient({ success: true, data: "not-an-array" });
    expect(await getCompanies(c)).toEqual([]);
  });
});

// ─── CO-0008: getCompanies 応答要素フィールド集合 ────────────────────────────

describe("[CO-0008] getCompanies 応答要素フィールド集合 (companyID/name/feeLevel/tag/isSesameApp/employeeEmail)", () => {
  it("[CO-0008] 各要素が companyID/name/feeLevel{subscriptionId,isRootUser,level}/tag[]/isSesameApp/employeeEmail を保持する", async () => {
    const company = {
      companyID: "cmp-001",
      name: "テスト会社",
      feeLevel: { subscriptionId: "sub_1", isRootUser: true, level: 3 },
      tag: ["オーナー"],
      isSesameApp: false,
      employeeEmail: "owner@example.com",
    };
    const c = mockClient({ success: true, data: [company] });
    const r = await getCompanies(c);
    expect(r).toHaveLength(1);
    const el = r[0];
    // companyID: 後続 priorityCompany/updateName/getPaymentConfig の一次データ
    expect(el.companyID).toBe("cmp-001");
    expect(el.name).toBe("テスト会社");
    // feeLevel.subscriptionId: priorityCompany の subscriptionId 合成に使う
    expect(el.feeLevel).toEqual({ subscriptionId: "sub_1", isRootUser: true, level: 3 });
    expect(el.feeLevel.subscriptionId).toBe("sub_1");
    // feeLevel.isRootUser: priorityCompany の isSesameApp 経路で使う
    expect(el.feeLevel.isRootUser).toBe(true);
    // feeLevel.level: level 最大選択に使う
    expect(el.feeLevel.level).toBe(3);
    // tag[0]==='オーナー': isOwner 判定
    expect(el.tag).toEqual(["オーナー"]);
    // isSesameApp: priorityCompany 分岐
    expect(el.isSesameApp).toBe(false);
    // employeeEmail: priorityCompany.employeeEmail で読まれる
    expect(el.employeeEmail).toBe("owner@example.com");
  });

  it("[CO-0008] tag[0]==='オーナー' で isOwner 判定の一次データとして使用可能", async () => {
    const ownerCompany = { companyID: "c1", tag: ["オーナー"] };
    const nonOwnerCompany = { companyID: "c2", tag: ["Member"] };
    const c = mockClient({ success: true, data: [ownerCompany, nonOwnerCompany] });
    const r = await getCompanies(c);
    expect(Array.isArray(r[0].tag) && r[0].tag[0] === "オーナー").toBe(true);
    expect(Array.isArray(r[1].tag) && r[1].tag[0] === "オーナー").toBe(false);
  });

  it("[CO-0008] getCompanies は応答要素を変形せず透過する", async () => {
    const elements = [
      {
        companyID: "ch_X",
        name: "Foo",
        feeLevel: { subscriptionId: "sub_x", isRootUser: false, level: 1 },
        tag: [],
        isSesameApp: true,
      },
    ];
    const c = mockClient({ success: true, data: elements });
    const r = await getCompanies(c);
    expect(r[0]).toStrictEqual(elements[0]);
  });

  it("[CO-0008] subUUID は getCompanies 応答要素フィールドとして確認されていない (透過テスト)", async () => {
    // core は data を変換せずそのまま返す (subUUID が含まれていれば透過する)
    const company = { companyID: "c1", name: "テスト", subUUID: "u-extra" };
    const c = mockClient({ success: true, data: [company] });
    const r = await getCompanies(c);
    expect(r[0].subUUID).toBe("u-extra");
  });
});

// ─── CO-0009: getCompanies success:false 拒否 ─────────────────────────────────

describe("[CO-0009] getCompanies success:false 拒否 → SesameError(REJECTED) を throw", () => {
  it("[CO-0009] 応答 success:false のとき SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = mockClient({ success: false, message: "denied" });
    let err;
    try {
      await getCompanies(c);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.retryable).toBe(false);
  });

  it("[CO-0009] エラーメッセージは 'getCompanies failed: <message>' の形式", async () => {
    const c = mockClient({ success: false, message: "access denied" });
    await expect(getCompanies(c)).rejects.toThrow(/getCompanies failed: access denied/);
  });

  it("[CO-0009] message が undefined のときも throw する (JSON stringify fallback)", async () => {
    const c = mockClient({ success: false });
    await expect(getCompanies(c)).rejects.toThrow(/getCompanies failed/);
  });

  it("[CO-0009] 成功 (success:true) では throw しない", async () => {
    const c = mockClient({ success: true, data: [] });
    await expect(getCompanies(c)).resolves.toEqual([]);
  });
});

// ─── CO-0010: updateCompanyName フレーム ─────────────────────────────────────

describe("[CO-0010] updateCompanyName → updateName フレーム (companyID/name を obj にネスト)", () => {
  it("[CO-0010] 送信フレームは {action:'biz3ManageCompany', obj:{companyID,name}, op:'updateName'}", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "新社名" } });
    await updateCompanyName(c, { companyID: "ch_A", name: "新社名" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageCompany",
      obj: { companyID: "ch_A", name: "新社名" },
      op: "updateName",
    });
  });

  it("[CO-0010] companyID/name はトップレベルに置かない (obj 内のみ)", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "名前" } });
    await updateCompanyName(c, { companyID: "ch_A", name: "名前" });
    const frame = c.sent[0];
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("name");
    expect(frame.obj.companyID).toBe("ch_A");
    expect(frame.obj.name).toBe("名前");
  });

  it("[CO-0010] op は 'updateName'", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "X" } });
    await updateCompanyName(c, { companyID: "ch_A", name: "X" });
    expect(c.sent[0].op).toBe("updateName");
  });

  it("[CO-0010] action が 'biz3ManageCompany'", async () => {
    const c = mockClient({ success: true, data: { companyID: "c1", name: "n" } });
    await updateCompanyName(c, { companyID: "c1", name: "n" });
    expect(c.sent[0].action).toBe("biz3ManageCompany");
  });
});

// ─── CO-0011: updateCompanyName 応答 data ────────────────────────────────────

describe("[CO-0011] updateCompanyName 応答 data {companyID,name} を返す / 欠落時 undefined (捏造しない)", () => {
  it("[CO-0011] 応答 data === {companyID,name} をそのまま返す", async () => {
    const data = { companyID: "ch_A", name: "新社名" };
    const c = mockClient({ success: true, data });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "新社名" });
    expect(r).toEqual(data);
  });

  it("[CO-0011] data 欠落時は入力値で補完せず undefined を返す (BIZ-10: 応答捏造禁止)", async () => {
    const c = mockClient({ success: true });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "新社名" });
    expect(r).toBeUndefined();
  });

  it("[CO-0011] data が null のとき null/undefined のいずれかを返す (捏造しない)", async () => {
    const c = mockClient({ success: true, data: null });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "X" });
    // null は falsy なため undefined と同様に扱われる — 捏造しない境界のみ検証
    expect(r == null).toBe(true);
  });
});

// ─── CO-0012: updateCompanyName 必須検証 ─────────────────────────────────────

describe("[CO-0012] updateCompanyName 必須検証 (companyID 必須 / name は null・undefined のみ拒否, 空文字許容)", () => {
  it("[CO-0012] companyID 欠落で SesameError(code=bad_request) + 'companyID required' を throw し送信しない", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await updateCompanyName(c, { name: "新名前" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0012] companyID が空文字で 'companyID required' を throw する (falsy)", async () => {
    const c = mockClient({ success: true });
    await expect(updateCompanyName(c, { companyID: "", name: "名前" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0012] name が null で SesameError(code=bad_request, message ~ /name required/) を throw する", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await updateCompanyName(c, { companyID: "ch_A", name: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/name required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0012] name が undefined で 'name required' を throw する", async () => {
    const c = mockClient({ success: true });
    await expect(updateCompanyName(c, { companyID: "ch_A" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0012] name が空文字 '' は送信許容 (null/undefined のみ拒否)", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "" } });
    await updateCompanyName(c, { companyID: "ch_A", name: "" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].obj).toEqual({ companyID: "ch_A", name: "" });
  });
});

// ─── CO-0013: addCompany フレーム ─────────────────────────────────────────────

describe("[CO-0013] addCompany → add フレーム (name/employeeEmail/subUUID をフラット展開, obj/companyID 無し)", () => {
  it("[CO-0013] 送信フレームは {action:'biz3ManageCompany', name, employeeEmail, subUUID, op:'add'} フラット", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_NEW" } });
    await addCompany(c, { name: "NewCo", employeeEmail: "e@example.com", subUUID: "sub-1" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageCompany",
      name: "NewCo",
      employeeEmail: "e@example.com",
      subUUID: "sub-1",
      op: "add",
    });
  });

  it("[CO-0013] フレームに obj ラップが無く companyID が無い", async () => {
    const c = mockClient({ success: true, data: { companyID: "new", name: "n" } });
    await addCompany(c, { name: "n", employeeEmail: "e@x.com", subUUID: "u-x" });
    const frame = c.sent[0];
    expect(frame).not.toHaveProperty("obj");
    expect(frame).not.toHaveProperty("companyID");
    expect(frame.name).toBe("n");
    expect(frame.employeeEmail).toBe("e@x.com");
    expect(frame.subUUID).toBe("u-x");
    expect(frame.op).toBe("add");
    expect(frame.action).toBe("biz3ManageCompany");
  });

  it("[CO-0013] op は 'add'", async () => {
    const c = mockClient({ success: true, data: null });
    await addCompany(c, { name: "N", employeeEmail: "e@example.com", subUUID: "u" });
    expect(c.sent[0].op).toBe("add");
  });
});

// ─── CO-0014: addCompany 引数の出所 ─────────────────────────────────────────

describe("[CO-0014] addCompany 引数の出所 (employeeEmail/subUUID は login customerInfo 由来)", () => {
  // cli/company.js: withAccount が供給する customerInfo.employeeEmail/subUUID を渡す
  // layout/index.js: gStripe.customerInfo.employeeEmail/subUUID を渡す
  // core 側のユニットテストとして: addCompany が employeeEmail/subUUID をフレームにそのまま
  // 乗せることで呼び出し元が渡す customerInfo 由来の値が正しくサーバに届く経路を検証する。

  it("[CO-0014] addCompany は渡された employeeEmail を変形せずフレームに乗せる", async () => {
    const c = mockClient({ success: true, data: null });
    const employeeEmail = "user@candyhouse.co";
    await addCompany(c, { name: "Co", employeeEmail, subUUID: "sub-uuid-1" });
    expect(c.sent[0].employeeEmail).toBe(employeeEmail);
  });

  it("[CO-0014] addCompany は渡された subUUID を変形せずフレームに乗せる", async () => {
    const c = mockClient({ success: true, data: null });
    const subUUID = "550e8400-e29b-41d4-a716-446655440000";
    await addCompany(c, { name: "Co", employeeEmail: "e@example.com", subUUID });
    expect(c.sent[0].subUUID).toBe(subUUID);
  });

  it("[CO-0014] customerInfo 経由で供給された値が送信フレームに反映される (CLI 経路の代理確認)", async () => {
    // layout/index.js と cli/company.js の両方で employeeEmail/subUUID は
    // getLoginUser 応答の customerInfo から取る。addCompany はそれをそのままフレームに載せる。
    const customerInfo = { employeeEmail: "owner@example.com", subUUID: "sub-from-login" };
    const c = mockClient({ success: true, data: { companyID: "ch_NEW" } });
    await addCompany(c, {
      name: "MyCo",
      employeeEmail: customerInfo.employeeEmail,
      subUUID: customerInfo.subUUID,
    });
    expect(c.sent[0].employeeEmail).toBe("owner@example.com");
    expect(c.sent[0].subUUID).toBe("sub-from-login");
  });

  it("[CO-0014] CLI company add が withAccount で取得した customerInfo.employeeEmail/subUUID を addCompany に渡す", async () => {
    const { Command } = await import("commander");
    const { registerCompanyCommands } = await import("../../../kit/src/cli/company.js");

    const addedParams = [];
    const hub = {
      company: {
        addCompany: vi.fn(async (params) => {
          addedParams.push(params);
          return { companyID: "new-id", name: params.name };
        }),
        getCompanies: vi.fn(async () => []),
        updateCompanyName: vi.fn(async () => ({})),
        getPaymentConfig: vi.fn(async () => null),
      },
    };

    const customerInfo = { employeeEmail: "owner@example.com", subUUID: "sub-uuid-001" };

    const ctx = {
      out: vi.fn(),
      die: vi.fn((msg, code) => { const e = new Error(msg); e.exitCode = code; throw e; }),
      canPrompt: () => false,
      withHub: (fn) => fn(hub, { opts: {} }),
      withAccount: (fn) => fn(hub, { opts: {}, customerInfo }),
      prompts: {
        selectFromList: vi.fn(),
        promptText: vi.fn(),
        confirm: vi.fn(),
        promptLine: vi.fn(),
      },
      parseJson: (raw) => JSON.parse(raw),
    };

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerCompanyCommands(program, ctx);

    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["company", "add", "新会社"], { from: "user" });
    vi.restoreAllMocks();

    expect(hub.company.addCompany).toHaveBeenCalledTimes(1);
    const callArg = addedParams[0];
    expect(callArg.employeeEmail).toBe("owner@example.com");
    expect(callArg.subUUID).toBe("sub-uuid-001");
    expect(callArg.name).toBe("新会社");
  });

  it("[CO-0014] customerInfo.employeeEmail/subUUID 欠落時は die(missingCustomerInfo, 1) で終了コード 1", async () => {
    const { Command } = await import("commander");
    const { registerCompanyCommands } = await import("../../../kit/src/cli/company.js");

    const hub = {
      company: { addCompany: vi.fn() },
    };

    const customerInfo = {}; // employeeEmail/subUUID が欠落

    let dieCode = null;
    const ctx = {
      out: vi.fn(),
      die: (msg, code) => {
        dieCode = code;
        const e = new Error(msg);
        e.exitCode = code;
        throw e;
      },
      canPrompt: () => false,
      withAccount: (fn) => fn(hub, { opts: {}, customerInfo }),
      prompts: {},
      parseJson: (raw) => JSON.parse(raw),
    };

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerCompanyCommands(program, ctx);

    await expect(
      program.parseAsync(["company", "add", "新会社"], { from: "user" }),
    ).rejects.toThrow();

    expect(dieCode).toBe(1);
    expect(hub.company.addCompany).not.toHaveBeenCalled();
  });
});

// ─── CO-0015: addCompany 必須検証 ────────────────────────────────────────────

describe("[CO-0015] addCompany 必須検証 (name/employeeEmail/subUUID すべて必須)", () => {
  it("[CO-0015] name 欠落で SesameError(code=bad_request) + 'name required' を throw し送信しない", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await addCompany(c, { employeeEmail: "e@example.com", subUUID: "u" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/name required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0015] name が空文字で 'name required' を throw する (falsy)", async () => {
    const c = mockClient({ success: true });
    await expect(addCompany(c, { name: "", employeeEmail: "e@example.com", subUUID: "u" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0015] employeeEmail 欠落で SesameError(code=bad_request) + 'employeeEmail required' を throw し送信しない", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await addCompany(c, { name: "n", subUUID: "u" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/employeeEmail required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0015] employeeEmail が空文字で 'employeeEmail required' を throw する", async () => {
    const c = mockClient({ success: true });
    await expect(addCompany(c, { name: "n", employeeEmail: "", subUUID: "u" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0015] subUUID 欠落で SesameError(code=bad_request) + 'subUUID required' を throw し送信しない", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await addCompany(c, { name: "n", employeeEmail: "e@example.com" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0015] subUUID が空文字で 'subUUID required' を throw する", async () => {
    const c = mockClient({ success: true });
    await expect(addCompany(c, { name: "n", employeeEmail: "e@example.com", subUUID: "" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0015] name/employeeEmail/subUUID すべて揃えば throw しない", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_X" } });
    const r = await addCompany(c, { name: "N", employeeEmail: "e@example.com", subUUID: "u" });
    expect(r).not.toBeUndefined();
  });
});

// ─── CO-0016: addCompany subUUID required の core↔SDK/proto 不一致 ───────────

describe("[CO-0016] addCompany subUUID required の core↔SDK/proto 不一致 (core 必須 vs 生成 optional)", () => {
  // rpc-params.generated.json: subUUID { required: false, desc: 'auto-injected by the daemon...' }
  // proto: optional string subUUID
  // core company.js: subUUID 欠落で throw
  // → core は必須 / SDK・proto は optional という境界差異を固定する

  it("[CO-0016] core addCompany は subUUID 省略で SesameError(bad_request) を throw する (core 直叩き = 必須)", async () => {
    const c = mockClient({ success: true });
    await expect(
      addCompany(c, { name: "N", employeeEmail: "e@example.com" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0016] rpc-params.generated.json の company.addCompany で subUUID が required:false (daemon 自動注入)", async () => {
    const rpcParams = (
      await import("../../../kit/src/serve/rpc-params.generated.json", { assert: { type: "json" } })
    ).default;

    expect(rpcParams).toHaveProperty("company.addCompany");
    const params = rpcParams["company.addCompany"];
    const subUUIDParam = params.find((p) => p.name === "subUUID");
    expect(subUUIDParam).toBeDefined();
    expect(subUUIDParam.required).toBe(false);
  });

  it("[CO-0016] rpc-params の name と employeeEmail は required:true (core と一致)", async () => {
    const rpcParams = (
      await import("../../../kit/src/serve/rpc-params.generated.json", { assert: { type: "json" } })
    ).default;

    const params = rpcParams["company.addCompany"];
    const nameParam = params.find((p) => p.name === "name");
    const emailParam = params.find((p) => p.name === "employeeEmail");
    expect(nameParam.required).toBe(true);
    expect(emailParam.required).toBe(true);
  });

  it("[CO-0016] rpc-params の subUUID desc には 'auto-injected' の記述がある", async () => {
    const rpcParams = (
      await import("../../../kit/src/serve/rpc-params.generated.json", { assert: { type: "json" } })
    ).default;

    const params = rpcParams["company.addCompany"];
    const subUUIDParam = params.find((p) => p.name === "subUUID");
    expect(subUUIDParam.desc).toMatch(/auto-injected/i);
  });
});

// ─── CO-0017: addCompany 応答 data ───────────────────────────────────────────

describe("[CO-0017] addCompany 応答 data (新規 company) を返す / 欠落時 null", () => {
  it("[CO-0017] 応答 data をそのまま返す", async () => {
    const created = { companyID: "ch_NEW", name: "NewCo" };
    const c = mockClient({ success: true, data: created });
    const r = await addCompany(c, { name: "NewCo", employeeEmail: "e@example.com", subUUID: "u" });
    expect(r).toEqual(created);
  });

  it("[CO-0017] data 欠落時は null を返す (undefined ではなく null)", async () => {
    const c = mockClient({ success: true });
    const r = await addCompany(c, { name: "N", employeeEmail: "e@example.com", subUUID: "u" });
    expect(r).toBeNull();
  });

  it("[CO-0017] data が null のときも null を返す", async () => {
    const c = mockClient({ success: true, data: null });
    const r = await addCompany(c, { name: "n", employeeEmail: "e@x.com", subUUID: "u" });
    expect(r).toBeNull();
  });

  it("[CO-0017] success:false で 'addCompany failed: <message>' を throw する", async () => {
    const c = mockClient({ success: false, message: "dup company" });
    await expect(
      addCompany(c, { name: "N", employeeEmail: "e@example.com", subUUID: "u" }),
    ).rejects.toThrow(/addCompany failed: dup company/);
  });
});

// ─── CO-0018: getPaymentConfig フレーム ──────────────────────────────────────

describe("[CO-0018] getPaymentConfig → getPaymentConfig フレーム (companyID をトップレベルに置く)", () => {
  it("[CO-0018] 送信フレームは {action:'biz3ManageCompany', companyID, op:'getPaymentConfig'}", async () => {
    const c = mockClient({ success: true, data: { config: "basic", isYear: false } });
    await getPaymentConfig(c, { companyID: "ch_A" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageCompany",
      companyID: "ch_A",
      op: "getPaymentConfig",
    });
  });

  it("[CO-0018] companyID はトップレベル直置き (obj ラップしない)", async () => {
    const c = mockClient({ success: true, data: {} });
    await getPaymentConfig(c, { companyID: "ch_A" });
    const frame = c.sent[0];
    expect(frame.companyID).toBe("ch_A");
    expect(frame).not.toHaveProperty("obj");
    expect(frame.op).toBe("getPaymentConfig");
    expect(frame.action).toBe("biz3ManageCompany");
  });

  it("[CO-0018] op は 'getPaymentConfig'", async () => {
    const c = mockClient({ success: true, data: null });
    await getPaymentConfig(c, { companyID: "ch_A" });
    expect(c.sent[0].op).toBe("getPaymentConfig");
  });
});

// ─── CO-0019: getPaymentConfig 応答ルーティング ──────────────────────────────

describe("[CO-0019] getPaymentConfig 応答ルーティング (switch case 無し→invokeCallbacks 委譲)", () => {
  // web の handleCompaniesResponse switch に getPaymentConfig case が無く invokeCallbacks 委譲。
  // lib は client.request (action+op 一致応答待ち) で同期受けする。

  it("[CO-0019] getPaymentConfig は mockClient (request ベース) で正常動作する (同期応答待ち)", async () => {
    const config = {
      config: "premium",
      isYear: true,
      time: "2025-01",
      total: 9800,
      level: 3,
      nextPrice: 8000,
    };
    const c = mockClient({ success: true, data: config });
    const r = await getPaymentConfig(c, { companyID: "ch_A" });
    expect(c.sent).toHaveLength(1);
    expect(r).toMatchObject({ config: "premium", isYear: true });
  });

  it("[CO-0019] フレームの action+op が一致することで応答を受け取れる経路 (action='biz3ManageCompany', op='getPaymentConfig')", async () => {
    const c = mockClient({ success: true, data: { level: 1 } });
    await getPaymentConfig(c, { companyID: "ch_X" });
    expect(c.sent[0].action).toBe("biz3ManageCompany");
    expect(c.sent[0].op).toBe("getPaymentConfig");
  });

  it("[CO-0019] getPaymentConfig の送信は request (1回) のみ", async () => {
    const c = mockClient({ success: true, data: { level: 3 } }, { strictRequestOnly: true });
    await getPaymentConfig(c, { companyID: "cmp-test" });
    expect(c.sent).toHaveLength(1);
  });
});

// ─── CO-0020: getPaymentConfig 応答 data 形状 ────────────────────────────────

describe("[CO-0020] getPaymentConfig 応答 data 形状 {config,isYear,time,total,level,nextPrice,nextEndDate}", () => {
  it("[CO-0020] 応答 data をそのまま返す (consumer は setPaymentConfig({...res.data}))", async () => {
    const data = {
      config: "basic",
      isYear: false,
      time: "2025-01",
      total: 4900,
      level: 1,
      nextPrice: 5800,
      nextEndDate: "2026-01-01",
    };
    const c = mockClient({ success: true, data });
    const r = await getPaymentConfig(c, { companyID: "ch_A" });
    expect(r).toEqual(data);
  });

  it("[CO-0020] nextEndDate を含む data を落とさずに返す (core の JSDoc cast に nextEndDate が欠けていても透過すべき)", async () => {
    const data = {
      config: "pro",
      isYear: true,
      time: "2025-03",
      total: 9800,
      level: 3,
      nextPrice: 12000,
      nextEndDate: "2026-03-31",
    };
    const c = mockClient({ success: true, data });
    const r = await getPaymentConfig(c, { companyID: "ch_A" });
    expect(r).toHaveProperty("nextEndDate", "2026-03-31");
  });

  it("[CO-0020] data 欠落時は null を返す", async () => {
    const c = mockClient({ success: true });
    const r = await getPaymentConfig(c, { companyID: "ch_A" });
    expect(r).toBeNull();
  });

  it("[CO-0020] data が null のときも null を返す", async () => {
    const c = mockClient({ success: true, data: null });
    const r = await getPaymentConfig(c, { companyID: "ch_A" });
    expect(r).toBeNull();
  });

  it("[CO-0020] success:false で 'getPaymentConfig failed: <message>' を throw する", async () => {
    const c = mockClient({ success: false, message: "no config" });
    await expect(getPaymentConfig(c, { companyID: "ch_A" })).rejects.toThrow(/getPaymentConfig failed: no config/);
  });
});

// ─── CO-0021: getPaymentConfig 必須検証 ─────────────────────────────────────

describe("[CO-0021] getPaymentConfig 必須検証 (companyID 必須)", () => {
  // company.js:139: badRequest('companyID required') — i18n key ではなくリテラル文字列
  // t() は未知キーをそのまま返すため、メッセージは 'companyID required' になる

  it("[CO-0021] companyID 欠落で SesameError(code=bad_request) + 'companyID required' を throw し送信しない", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await getPaymentConfig(c, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0021] companyID が null で throw する", async () => {
    const c = mockClient({ success: true });
    await expect(getPaymentConfig(c, { companyID: null })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0021] companyID が空文字で throw する", async () => {
    const c = mockClient({ success: true });
    await expect(getPaymentConfig(c, { companyID: "" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0021] companyID が undefined で throw する (params 自体欠落と同等)", async () => {
    const c = mockClient({ success: true });
    await expect(getPaymentConfig(c, { companyID: undefined })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[CO-0021] companyID が存在すれば throw しない", async () => {
    const c = mockClient({ success: true, data: null });
    await expect(getPaymentConfig(c, { companyID: "ch_A" })).resolves.toBeNull();
  });

  it("[CO-0021] getPaymentConfig の companyID エラーはリテラル文字列 (i18n key ではなく 'companyID required' 直書き)", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await getPaymentConfig(c, {});
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/companyID required/);
  });
});
