// access.js (cards / passcodes) の単体テスト。
// biz3ManageAccessCtlAuthData の各 op の送信フレーム正確性 (action/op/フィールド名/ネスト構造) と
// pub*LinkedIDs の async push 集約・応答パースを検証する。
// vendor reference: references_web/src/api/useManageAuthData.js
import { describe, it, expect } from "vitest";
import {
  getCards,
  getPasscodes,
  postCards,
  postPasscodes,
  delCards,
  delPasscodes,
  clearCards,
  clearPasscodes,
  updateCardName,
  updatePasscodeName,
  updateCardOwner,
  enrolledToCardList,
  syncEnrolledCards,
  syncEnrolledPasscodes,
  makeBiometricsTransport,
} from "../../src/access.js";

// ---------- request 系 mock client ----------
// request(frame) を記録し固定応答を返す。
function requestClient(reply) {
  const sent = [];
  return {
    sent,
    async request(frame) {
      sent.push(frame);
      return reply;
    },
    // get 系を誤って呼んだら検知できるようにダミー
    send() {
      throw new Error("unexpected send() call");
    },
    subscribe() {
      throw new Error("unexpected subscribe() call");
    },
  };
}

// ---------- subscribe/send 系 mock client (getCards/getPasscodes 用) ----------
// subscribe(key, fn) でハンドラを登録、send(frame) を記録。
// テスト側から emit(key, msg) で push を流せる。
function pushClient() {
  const sent = [];
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  return {
    sent,
    subs,
    send(frame) {
      sent.push(frame);
    },
    subscribe(key, fn) {
      let set = subs.get(key);
      if (!set) {
        set = new Set();
        subs.set(key, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(key, msg) {
      const set = subs.get(key);
      if (!set) return;
      for (const fn of [...set]) fn(msg);
    },
    request() {
      throw new Error("unexpected request() call");
    },
  };
}

const ACTION = "biz3ManageAccessCtlAuthData";

describe("makeBiometricsTransport (SigV4 + x-api-key + appidentifyid — BIZ-07)", () => {
  // 認可方式の出典: ApiClientConfigBuilder.kt:34-46 / BaseApp.kt:95-102 /
  // app.properties:3,5 (ホスト・API key の実値)。基盤は src/aws-credentials.js + src/sigv4.js
  // (devices.js makeRegisterTransport と共通)。実機 API Gateway での受理は未検証 (§9 V5)。

  /** Identity Pool を経由しない注入 provider (ヘッダ検証用の固定 credentials)。 */
  const fakeCredentialsProvider = {
    getCredentials: async () => ({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "fakeSecret",
      sessionToken: "SESSION-TOKEN",
      expiration: new Date(Date.now() + 3600_000),
      identityId: "ap-northeast-1:identity",
    }),
  };

  it("既定ホスト app.candyhouse.co/prod へ SigV4 + x-api-key + appidentifyid を付けて送る", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    const transport = makeBiometricsTransport({
      credentialsProvider: fakeCredentialsProvider,
      appIdentifyId: "ap-northeast-1:fixed-id",
      fetchImpl,
    });

    const res = await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(res).toEqual({ status: 200, text: '{"ok":true}', json: { ok: true } });
    // baseUrl 未指定でも既定ホスト (app.properties:3) が使われる
    expect(calls[0].url).toBe("https://app.candyhouse.co/prod/device/v1/biometrics");
    const h = calls[0].init.headers;
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=appidentifyid;content-type;host;x-amz-date;x-amz-security-token;x-api-key, Signature=[0-9a-f]{64}$/,
    );
    expect(h["x-api-key"]).toBe("iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k"); // app.properties:5
    expect(h.appidentifyid).toBe("ap-northeast-1:fixed-id");
    expect(h["x-amz-security-token"]).toBe("SESSION-TOKEN");
    expect(calls[0].init.body).toBe('{"op":"x"}');
  });

  it("normalizes trailing slashes without regex backtracking (SigV4 経路でも同じ正規化)", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    const trailing = "/".repeat(5000);
    const transport = makeBiometricsTransport({
      baseUrl: `https://api.example.test/root${trailing}`,
      credentialsProvider: fakeCredentialsProvider,
      fetchImpl,
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });
    expect(calls[0].url).toBe("https://api.example.test/root/device/v1/biometrics");
  });

  it("getIdToken コールバック経路: Identity Pool (GetId/GetCredentialsForIdentity) を経由して署名する", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("https://cognito-identity.ap-northeast-1.amazonaws.com/")) {
        const target = init.headers["x-amz-target"];
        if (target === "AWSCognitoIdentityService.GetId") {
          return { status: 200, text: async () => JSON.stringify({ IdentityId: "ap-northeast-1:id-1" }) };
        }
        return {
          status: 200,
          text: async () => JSON.stringify({
            IdentityId: "ap-northeast-1:id-1",
            Credentials: {
              AccessKeyId: "AKFROMPOOL", SecretKey: "SK", SessionToken: "ST",
              Expiration: Date.now() / 1000 + 3600,
            },
          }),
        };
      }
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeBiometricsTransport({
      getIdToken: async () => "ID-TOKEN",
      appIdentifyId: "ap-northeast-1:x",
      fetchImpl,
    });
    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(calls).toHaveLength(3); // GetId → GetCredentialsForIdentity → API 本体
    const getIdBody = JSON.parse(calls[0].init.body);
    expect(getIdBody.Logins["cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_bY2byhlCa"]).toBe("ID-TOKEN");
    expect(calls[2].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKFROMPOOL\//);
  });

  it("rejects non-HTTPS and credential-bearing biometrics base URLs", () => {
    expect(() => makeBiometricsTransport({ baseUrl: "http://api.example.test", credentialsProvider: fakeCredentialsProvider, fetchImpl: () => {} }))
      .toThrow(/HTTPS/);
    expect(() => makeBiometricsTransport({ baseUrl: "https://user:pass@api.example.test", credentialsProvider: fakeCredentialsProvider, fetchImpl: () => {} }))
      .toThrow(/baseUrl/);
    expect(() => makeBiometricsTransport({ baseUrl: "https://api.example.test/path?x=1", credentialsProvider: fakeCredentialsProvider, fetchImpl: () => {} }))
      .toThrow(/baseUrl/);
  });

  it("互換 (非推奨): authorizationProvider / bearerToken 経路は維持される (client.js が移行するまで)", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      authorizationProvider: async () => "Bearer legacy-token",
      fetchImpl,
    });
    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });
    expect(calls[0].init.headers.authorization).toBe("Bearer legacy-token");
  });

  it("requires an explicit authorization source", () => {
    expect(() => makeBiometricsTransport({ baseUrl: "https://api.example.test", fetchImpl: () => {} }))
      .toThrow(/credentialsProvider/);
  });
});

describe("getCards", () => {
  it("送信フレームは obj.devices にカンマ連結文字列 / op:getCards", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["uuid-A", "uuid-B"] });
    // 送信直後にフレームを検証
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { devices: "uuid-A,uuid-B" },
      op: "getCards",
    });
    // 完了通知で解決させる
    c.emit(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    await p;
  });

  it("pubCardLinkedIDs を deviceUUID/page で集約し、完了通知で確定する", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"] });

    // dev1 page1 (置換)
    c.emit(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: {
        deviceUUID: "dev1",
        page: 1,
        list: [{ cardID: "C1", name: "card1", nameUUID: "n1", cardType: 1, subUUID: "s1" }],
      },
    });
    // dev1 page2 (累積)
    c.emit(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: {
        deviceUUID: "dev1",
        page: 2,
        list: [{ cardID: "C2", name: "card2", nameUUID: "n2", cardType: 1, subUUID: "s2" }],
      },
    });
    // dev2 page1 — C1 を共有 (横断集約で uuids が 2件になる)
    c.emit(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: {
        deviceUUID: "dev2",
        page: 1,
        list: [{ cardID: "C1", name: "card1", nameUUID: "n1", cardType: 1, subUUID: "s1" }],
      },
    });

    c.emit(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    const r = await p;

    expect(r.byDevice.dev1).toHaveLength(2);
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1", "C2"]);
    expect(r.byDevice.dev2).toHaveLength(1);

    // 横断集約: C1 は dev1/dev2 両方
    const c1 = r.items.filter((x) => x.cardID === "C1");
    expect(c1).toHaveLength(2); // 各 deviceUUID 分の要素が push される (biz3:170 と同じ)
    expect(c1[0].uuids.sort()).toEqual(["dev1", "dev2"]);
  });

  it("page===1 が後から来たら置換 (累積ではない)", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1"] });
    c.emit(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "OLD" }] },
    });
    c.emit(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "NEW" }] },
    });
    c.emit(`${ACTION}:getCards`, {});
    const r = await p;
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["NEW"]);
  });

  it("deviceUUIDs 空なら送信せず空を返す", async () => {
    const c = pushClient();
    const r = await getCards(c, { deviceUUIDs: [] });
    expect(c.sent).toHaveLength(0);
    expect(r).toEqual({ byDevice: {}, items: [] });
  });

  it("完了通知が来なければ timeout で reject", async () => {
    const c = pushClient();
    await expect(getCards(c, { deviceUUIDs: ["dev1"], timeoutMs: 20 })).rejects.toThrow(/getCards timeout/);
  });
});

describe("getPasscodes", () => {
  it("op:getPasscodes / 応答 op:pubPasscodeLinkedIDs を passwordID で集約", async () => {
    const c = pushClient();
    const p = getPasscodes(c, { deviceUUIDs: ["dev1"] });
    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { devices: "dev1" },
      op: "getPasscodes",
    });
    c.emit(`${ACTION}:pubPasscodeLinkedIDs`, {
      data: {
        deviceUUID: "dev1",
        page: 1,
        list: [{ passwordID: "P1", keyBoardPassCode: "0102", name: "pc1" }],
      },
    });
    c.emit(`${ACTION}:getPasscodes`, {});
    const r = await p;
    expect(r.items).toHaveLength(1);
    expect(r.items[0].passwordID).toBe("P1");
    expect(r.items[0].uuids).toEqual(["dev1"]);
  });
});

describe("postCards", () => {
  it("deviceUUID / list をトップレベルに置く (obj ラップしない)", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "n1", name: "x", cardType: 1 }];
    await postCards(c, { deviceUUID: "dev1", list });
    expect(c.sent[0]).toEqual({ action: ACTION, deviceUUID: "dev1", list, op: "postCards" });
    expect(c.sent[0]).not.toHaveProperty("obj");
  });

  it("list 空なら送信せず null", async () => {
    const c = requestClient({ success: true });
    expect(await postCards(c, { deviceUUID: "dev1", list: [] })).toBeNull();
    expect(c.sent).toHaveLength(0);
  });

  it("success:false は throw", async () => {
    const c = requestClient({ success: false, message: "nope" });
    await expect(postCards(c, { deviceUUID: "dev1", list: [{ cardID: "C1" }] })).rejects.toThrow(
      /postCards failed: nope/,
    );
  });
});

describe("postPasscodes", () => {
  it("deviceUUID / list トップレベル / op:postPasscodes", async () => {
    const c = requestClient({ success: true });
    const list = [{ passwordID: "P1" }];
    await postPasscodes(c, { deviceUUID: "dev1", list });
    expect(c.sent[0]).toEqual({ action: ACTION, deviceUUID: "dev1", list, op: "postPasscodes" });
  });

  it("list 空なら null", async () => {
    const c = requestClient({ success: true });
    expect(await postPasscodes(c, { deviceUUID: "dev1", list: [] })).toBeNull();
  });
});

describe("delCards", () => {
  // biz3 は delCards に応答ハンドラを持たない → fire-and-forget (send) で投げる。
  it("send で items をトップレベルに置く {deviceID, cardID} / op:delCards", () => {
    const c = pushClient();
    const items = [{ deviceID: "dev1", cardID: "C1" }];
    expect(delCards(c, { items })).toBe(true);
    expect(c.sent[0]).toEqual({ action: ACTION, items, op: "delCards" });
    expect(c.sent[0]).not.toHaveProperty("obj");
    expect(c.sent[0]).not.toHaveProperty("deviceUUID");
  });

  it("items 空なら送信せず false", () => {
    const c = pushClient();
    expect(delCards(c, { items: [] })).toBe(false);
    expect(c.sent).toHaveLength(0);
  });
});

describe("delPasscodes", () => {
  it("send で items トップレベル {deviceID, passwordID} / op:delPasscodes", () => {
    const c = pushClient();
    const items = [{ deviceID: "dev1", passwordID: "P1" }];
    expect(delPasscodes(c, { items })).toBe(true);
    expect(c.sent[0]).toEqual({ action: ACTION, items, op: "delPasscodes" });
  });

  it("items 空なら送信せず false", () => {
    const c = pushClient();
    expect(delPasscodes(c, { items: [] })).toBe(false);
    expect(c.sent).toHaveLength(0);
  });
});

describe("clearCards", () => {
  it("obj.devices は単一 deviceUUID 文字列 (カンマ連結しない) / op:clearCards", async () => {
    const c = requestClient({ success: true });
    await clearCards(c, { deviceUUID: "dev1" });
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { devices: "dev1" }, op: "clearCards" });
  });

  it("deviceUUID 無しなら null", async () => {
    const c = requestClient({ success: true });
    expect(await clearCards(c, { deviceUUID: "" })).toBeNull();
    expect(c.sent).toHaveLength(0);
  });
});

describe("clearPasscodes", () => {
  it("obj.devices 単一 / op:clearPasscodes", async () => {
    const c = requestClient({ success: true });
    await clearPasscodes(c, { deviceUUID: "dev1" });
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { devices: "dev1" }, op: "clearPasscodes" });
  });
});

describe("updateCardName", () => {
  it("obj に item を展開 / op:updateCardName", async () => {
    const c = requestClient({ success: true, reqContext: {} });
    const item = {
      cardID: "C1",
      name: "新名",
      cardNameUUID: "11111111-1111-4111-8111-111111111111",
      timestamp: 123,
      cardType: 1,
      stpDeviceUUID: "dev1",
    };
    await updateCardName(c, { item });
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { ...item }, op: "updateCardName" });
  });

  it("応答メッセージ (reqContext 含む) をそのまま返す", async () => {
    const reply = {
      success: true,
      reqContext: { name: "新名", stpDeviceUUID: "dev1", cardID: "C1", cardNameUUID: "u" },
    };
    const c = requestClient(reply);
    const r = await updateCardName(c, { item: { cardID: "C1" } });
    expect(r).toBe(reply);
  });
});

describe("updatePasscodeName", () => {
  it("obj に item 展開 / op:updatePasscodeName", async () => {
    const c = requestClient({ success: true });
    const item = {
      stpDeviceUUID: "dev1",
      keyBoardPassCode: "0102",
      keyBoardPassCodeNameUUID: "22222222-2222-4222-8222-222222222222",
      name: "pc",
    };
    await updatePasscodeName(c, { item });
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { ...item }, op: "updatePasscodeName" });
  });
});

describe("updateCardOwner", () => {
  it("obj:{cardID, ownerSubUUID} / op:updateCardOwner", async () => {
    const c = requestClient({ success: true });
    await updateCardOwner(c, { cardID: "C1", ownerSubUUID: "sub-1" });
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { cardID: "C1", ownerSubUUID: "sub-1" }, op: "updateCardOwner" });
  });

  it("空文字 ownerSubUUID は送信する (未割当解除)", async () => {
    const c = requestClient({ success: true });
    await updateCardOwner(c, { cardID: "C1", ownerSubUUID: "" });
    expect(c.sent[0].obj).toEqual({ cardID: "C1", ownerSubUUID: "" });
  });

  it("ownerSubUUID undefined なら送信せず null (biz3: 'ownerSubUUID' in item)", async () => {
    const c = requestClient({ success: true });
    expect(await updateCardOwner(c, { cardID: "C1" })).toBeNull();
    expect(c.sent).toHaveLength(0);
  });
});

// enroll → DB 同期ブリッジ。BLE 由来の enroll レコードを postCards/postPasscodes へ委譲する糊。
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("enrolledToCardList", () => {
  it("records ({cardID,cardName,cardType}) を list 要素 ({cardID,name,cardType,nameUUID v4}) へ写像", () => {
    const list = enrolledToCardList([{ cardID: "aa", cardName: "41", cardType: 1 }]);
    expect(list).toHaveLength(1);
    expect(list[0].cardID).toBe("aa");
    expect(list[0].name).toBe("41"); // NOTIFY 由来 hex 名をそのまま
    expect(list[0].cardType).toBe(1);
    expect(list[0].nameUUID).toMatch(UUID_V4); // 欠落 nameUUID は v4 採番
  });

  it("各要素に独立した nameUUID を採番する", () => {
    const list = enrolledToCardList([{ cardID: "a" }, { cardID: "b" }]);
    expect(list[0].nameUUID).not.toBe(list[1].nameUUID);
  });

  it("非配列は空配列を返す", () => {
    expect(enrolledToCardList(undefined)).toEqual([]);
  });
});

describe("syncEnrolledCards", () => {
  it("records を変換し postCards (deviceUUID/list トップレベル) へ委譲する", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, { deviceUUID: "dev1", records: [{ cardID: "aa", cardName: "41", cardType: 1 }] });
    expect(c.sent[0].action).toBe(ACTION);
    expect(c.sent[0].op).toBe("postCards");
    expect(c.sent[0].deviceUUID).toBe("dev1");
    expect(c.sent[0].list[0]).toMatchObject({ cardID: "aa", name: "41", cardType: 1 });
    expect(c.sent[0].list[0].nameUUID).toMatch(UUID_V4);
  });

  it("list を渡すと変換せずそのまま postCards へ流す", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "u1", name: "x", cardType: 1 }];
    await syncEnrolledCards(c, { deviceUUID: "dev1", list });
    expect(c.sent[0].list).toEqual(list);
  });

  it("空 records なら postCards へ委譲して null (list 空ガード)", async () => {
    const c = requestClient({ success: true });
    expect(await syncEnrolledCards(c, { deviceUUID: "dev1", records: [] })).toBeNull();
    expect(c.sent).toHaveLength(0);
  });
});

describe("syncEnrolledPasscodes", () => {
  it("records を変換し postPasscodes へ委譲する", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledPasscodes(c, { deviceUUID: "dev1", records: [{ cardID: "0102", cardName: "70", cardType: 0 }] });
    expect(c.sent[0].op).toBe("postPasscodes");
    expect(c.sent[0].deviceUUID).toBe("dev1");
    expect(c.sent[0].list[0]).toMatchObject({
      passwordID: "0102",
      keyBoardPassCode: "0102",
      name: "70",
      type: 0,
    });
    expect(c.sent[0].list[0].keyBoardPassCodeNameUUID).toMatch(UUID_V4);
  });

  it("空 records なら null", async () => {
    const c = requestClient({ success: true });
    expect(await syncEnrolledPasscodes(c, { deviceUUID: "dev1", records: [] })).toBeNull();
  });
});
