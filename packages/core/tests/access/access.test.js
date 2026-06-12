// access.js (cards / passcodes) の単体テスト。
// biz3ManageAccessCtlAuthData の各 op の送信フレーム正確性 (action/op/フィールド名/ネスト構造) と
// pub*LinkedIDs の async push 集約・応答パースを検証する。
// vendor reference: references_web/src/api/useManageAuthData.js
import { describe, it, expect, vi, afterEach } from "vitest";
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
  enrolledToPasscodeList,
  syncEnrolledCards,
  syncEnrolledPasscodes,
  makeBiometricsTransport,
  postAuthenticationData,
  putAuthenticationData,
  deleteAuthenticationData,
} from "../../src/access.js";

// 共有 fake (P5-7 / ARCH-16)。strict オプションで誤経路 (request 系 op が send/subscribe を
// 呼ぶ等) を throw で検知する旧 requestClient/pushClient の振る舞いを維持する。
import { mockClient, chunkMockClient } from "../helpers/mock-ws.js";

// ---------- request 系 mock client ----------
// request(frame) を記録し固定応答を返す。get 系を誤って呼んだら throw で検知。
function requestClient(reply) {
  return mockClient(reply, { strictRequestOnly: true });
}

// ---------- subscribe/send 系 mock client (getCards/getPasscodes 用) ----------
// subscribe(key, fn) でハンドラを登録、send(frame) を記録。
// テスト側から push(key, msg) で push を流せる。request を誤って呼んだら throw で検知。
function pushClient() {
  return chunkMockClient({ strictPushOnly: true });
}

const ACTION = "biz3ManageAccessCtlAuthData";

describe("makeBiometricsTransport (SigV4 + x-api-key、appidentifyid 無し — BIZ-07/バックログ8)", () => {
  // 認可方式の出典: ApiClientConfigBuilder.kt:34-46 / BaseApp.kt:95-102 /
  // app.properties:3,5 (ホスト・API key の実値)。基盤は src/aws-credentials.js + src/sigv4.js
  // (devices.js makeRegisterTransport と共通)。実機 API Gateway での受理は未検証 (§9 V5)。
  // appidentifyid: POST /device/v1/biometrics (CHAPIClient.kt:105-106) には
  // @Parameter(name="appidentifyid") が無いため付けない (バックログ8 per-op 化。
  // 全列挙表は src/aws-credentials.js makeApiGatewayTransport 冒頭)。

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

  it("既定ホスト app.candyhouse.co/prod へ SigV4 + x-api-key を付けて送る (appidentifyid は付かない)", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    const transport = makeBiometricsTransport({
      credentialsProvider: fakeCredentialsProvider,
      // 互換オプション: 受理されるが無視される (CHAPIClient.kt:105-106 にヘッダが無いため)
      appIdentifyId: "ap-northeast-1:fixed-id",
      fetchImpl,
    });

    const res = await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(res).toEqual({ status: 200, text: '{"ok":true}', json: { ok: true } });
    // baseUrl 未指定でも既定ホスト (app.properties:3) が使われる
    expect(calls[0].url).toBe("https://app.candyhouse.co/prod/device/v1/biometrics");
    const h = calls[0].init.headers;
    // SignedHeaders に appidentifyid が含まれない (参照表どおり: /device/v1/biometrics は「なし」)
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-api-key, Signature=[0-9a-f]{64}$/,
    );
    expect(h["x-api-key"]).toBe("iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k"); // app.properties:5
    expect(h.appidentifyid).toBeUndefined(); // バックログ8: 参照に存在しないヘッダは付けない
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
    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    await p;
  });

  it("pubCardLinkedIDs を deviceUUID/page で集約し、完了通知で確定する", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"] });

    // dev1 page1 (置換)
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: {
        deviceUUID: "dev1",
        page: 1,
        list: [{ cardID: "C1", name: "card1", nameUUID: "n1", cardType: 1, subUUID: "s1" }],
      },
    });
    // dev1 page2 (累積)
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: {
        deviceUUID: "dev1",
        page: 2,
        list: [{ cardID: "C2", name: "card2", nameUUID: "n2", cardType: 1, subUUID: "s2" }],
      },
    });
    // dev2 page1 — C1 を共有 (横断集約で uuids が 2件になる)
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: {
        deviceUUID: "dev2",
        page: 1,
        list: [{ cardID: "C1", name: "card1", nameUUID: "n1", cardType: 1, subUUID: "s1" }],
      },
    });

    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
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
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "OLD" }] },
    });
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "NEW" }] },
    });
    c.push(`${ACTION}:getCards`, {});
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

  describe("partialOnTimeout (BIZ-14 / バックログ6)", () => {
    afterEach(() => vi.useRealTimers());

    it("timeout 時に reject せず {partial:true, byDevice, items} で部分蓄積を返す", async () => {
      vi.useFakeTimers();
      const c = pushClient();
      const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"], timeoutMs: 500, partialOnTimeout: true });
      // dev1 の push だけ届き、dev2 と完了通知が来ないまま timeout
      c.push(`${ACTION}:pubCardLinkedIDs`, {
        data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
      });
      vi.advanceTimersByTime(500);
      const r = await p;
      expect(r.partial).toBe(true);
      expect(r.byDevice).toEqual({ dev1: [{ cardID: "C1" }] });
      expect(r.items.map((x) => x.cardID)).toEqual(["C1"]);
    });

    it("完走時は {partial:false, byDevice, items} の同 shape で返る", async () => {
      const c = pushClient();
      const p = getCards(c, { deviceUUIDs: ["dev1"], partialOnTimeout: true });
      c.push(`${ACTION}:pubCardLinkedIDs`, {
        data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
      });
      c.push(`${ACTION}:getCards`, {}); // 完了通知
      const r = await p;
      expect(r.partial).toBe(false);
      expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1"]);
    });
  });

  // ---- P3-12: 完了通知と pub の到着順序は未確認 (§9 V8) — 逆順サーバ許容 ----

  it("逆順 (完了通知 → pub) でも grace window で残 push を吸収してから確定する (P3-12)", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1"], graceMs: 50 });
    // 完了通知が先に届く (ack→pub の逆順)
    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    // grace window 内に残 push が届く
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    const r = await p;
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1"]);
    expect(r.items).toHaveLength(1);
  });

  it("完了通知時に全要求デバイスの pub が揃っていれば grace を待たず即確定する (従来動作)", async () => {
    // graceMs を timeout より長くする = 即確定でなければこのテストは timeout で落ちる構成。
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1"], timeoutMs: 200, graceMs: 60_000 });
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    c.push(`${ACTION}:getCards`, {});
    const r = await p;
    expect(r.byDevice.dev1).toHaveLength(1);
  });

  it("完了通知後も pub が来ないデバイスは grace 経過後に手持ちの結果で resolve (reject しない)", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"], graceMs: 30 });
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    c.push(`${ACTION}:getCards`, {});
    const r = await p;
    expect(r.byDevice.dev1).toHaveLength(1);
    expect(r.byDevice.dev2).toBeUndefined();
  });

  it("逆順 + 複数ページ: grace window 内の後続ページも吸収する", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1"], graceMs: 50 });
    c.push(`${ACTION}:getCards`, {});
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 2, list: [{ cardID: "C2" }] },
    });
    const r = await p;
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1", "C2"]);
  });

  // ---- P3-7: graceTimer cleanup on early finish ----

  describe("graceTimer cleanup (P3-7)", () => {
    afterEach(() => vi.useRealTimers());

    it("grace 起動後に別経路で finish されても graceTimer は Promise 解決後にクリアされる (タイマーリーク無し)", async () => {
      // 参照: useManageAuthData.js:179-185 — 完了通知は done:true をセットするのみで
      // タイマーを持たない。grace timer は kit 独自の追加であり、Promise 解決後に
      // clearTimeout する必要がある (P3-7)。
      vi.useFakeTimers();
      const c = pushClient();
      // dev1 / dev2 の 2 デバイスを要求。graceMs を短くしてタイマー動作を確認可能にする。
      const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"], graceMs: 100, timeoutMs: 1000 });

      // dev1 のデータは届く。dev2 は届かない → 完了通知時に missing=true → graceTimer 起動。
      c.push(`${ACTION}:pubCardLinkedIDs`, {
        data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
      });
      // 完了通知: dev2 欠落のため grace timer が起動する。
      c.push(`${ACTION}:getCards`, {});

      // grace 内に dev2 が到着し grace 完了を待つ。
      c.push(`${ACTION}:pubCardLinkedIDs`, {
        data: { deviceUUID: "dev2", page: 1, list: [{ cardID: "C2" }] },
      });
      // grace timer を経過させて解決させる。
      vi.advanceTimersByTime(100);
      const r = await p;
      // dev1 / dev2 ともにデータが揃っている。
      expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1"]);
      expect(r.byDevice.dev2.map((x) => x.cardID)).toEqual(["C2"]);

      // Promise 解決後: 残タイマーが 0 件 = グレースタイマーは finally でクリア済み。
      expect(vi.getTimerCount()).toBe(0);
    });

    it("timeout による reject 後も graceTimer は finally でクリアされる", async () => {
      // タイムアウトが先に発火した場合、grace timer が残存すると test に干渉する。
      vi.useFakeTimers();
      const c = pushClient();
      const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"], graceMs: 500, timeoutMs: 200 });

      // dev1 のみ届く → 完了通知で dev2 欠落 → graceTimer(500ms) 起動。
      c.push(`${ACTION}:pubCardLinkedIDs`, {
        data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
      });
      c.push(`${ACTION}:getCards`, {});

      // timeout(200ms) を先に発火させる。
      vi.advanceTimersByTime(200);
      await expect(p).rejects.toThrow(/getCards timeout/);

      // reject 後: graceTimer(500ms) は finally でクリアされており、残タイマーは 0 件。
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ---- P3-7: ページ粒度の保護範囲ドキュメント ----

  it("page≥2 が完了通知より後に届く場合は吸収されない (参照準拠: §9 V8 / useManageAuthData.js:179-185)", async () => {
    // useManageAuthData.js:179-185 は完了通知で done:true をセットするのみで
    // page≥2 の継続を待つ機構を持たない。grace window は
    // 「byDevice[u] === undefined」のデバイスのみを対象とするため、
    // page 1 が届き済みの dev1 は grace を起動せず即 finish する。
    // この挙動は参照に整合する (保護対象外と明記 — P3-7)。
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1"], graceMs: 50 });
    // page 1 が先に届く → byDevice["dev1"] が存在する状態で完了通知。
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    // 完了通知: missing=false → 即 finish。
    c.push(`${ACTION}:getCards`, {});
    const r = await p;
    // page 2 はまだ届いていないが Promise はすでに resolve 済み。
    // この後 page 2 を push しても無視される (grace 保護対象外)。
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1"]);
    expect(r.items).toHaveLength(1);
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
    c.push(`${ACTION}:pubPasscodeLinkedIDs`, {
      data: {
        deviceUUID: "dev1",
        page: 1,
        list: [{ passwordID: "P1", keyBoardPassCode: "0102", name: "pc1" }],
      },
    });
    c.push(`${ACTION}:getPasscodes`, {});
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
  // --- 後方互換パス: item 省略、直接 cardID/ownerSubUUID 指定 ---

  it("obj:{cardID, ownerSubUUID} / op:updateCardOwner (後方互換パス)", async () => {
    const c = requestClient({ success: true });
    await updateCardOwner(c, { cardID: "C1", ownerSubUUID: "sub-1" });
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { cardID: "C1", ownerSubUUID: "sub-1" }, op: "updateCardOwner" });
  });

  it("空文字 ownerSubUUID は送信する (未割当解除) (後方互換パス)", async () => {
    const c = requestClient({ success: true });
    await updateCardOwner(c, { cardID: "C1", ownerSubUUID: "" });
    expect(c.sent[0].obj).toEqual({ cardID: "C1", ownerSubUUID: "" });
  });

  it("ownerSubUUID undefined なら送信せず null (後方互換パス、biz3: 'ownerSubUUID' in item)", async () => {
    const c = requestClient({ success: true });
    expect(await updateCardOwner(c, { cardID: "C1" })).toBeNull();
    expect(c.sent).toHaveLength(0);
  });

  // --- item 透過パス (P3-5: 全フィールド透過) ---
  // 参照: useManageAuthData.js:346-353 (updateCardOwner は item をそのまま handlePutCardName へ)
  // 参照: useManageAuthData.js:331-343 (handlePutCardName は obj:{...item} で送る)
  // 参照: cards/index.js:385-396 (item = { cardID, name, cardNameUUID, ownerSubUUID, timestamp,
  //                                          cardType, stpDeviceUUID })

  it("item 透過: 全フィールドが obj に展開される (cards/index.js:385-396 相当)", async () => {
    const c = requestClient({ success: true });
    const item = {
      cardID: "C2",
      name: "Alice",
      cardNameUUID: "uuid-card-name",
      ownerSubUUID: "sub-alice",
      timestamp: 1700000000000,
      cardType: "NFC",
      stpDeviceUUID: "stp-device-uuid",
    };
    await updateCardOwner(c, { item });
    // handlePutCardName (useManageAuthData.js:331-343) は obj:{...item} をそのまま送る。
    expect(c.sent[0]).toEqual({ action: ACTION, obj: { ...item }, op: "updateCardOwner" });
  });

  it("item 透過: 空文字 ownerSubUUID は送信する (未割当解除)", async () => {
    const c = requestClient({ success: true });
    const item = { cardID: "C3", ownerSubUUID: "" };
    await updateCardOwner(c, { item });
    expect(c.sent[0].obj).toEqual({ cardID: "C3", ownerSubUUID: "" });
  });

  it("item 透過: ownerSubUUID キー不在なら送信せず null (useManageAuthData.js:348)", async () => {
    const c = requestClient({ success: true });
    // cardID のみ: 'ownerSubUUID' in item が false → 送らない
    const result = await updateCardOwner(c, { item: { cardID: "C4" } });
    expect(result).toBeNull();
    expect(c.sent).toHaveLength(0);
  });
});

// enroll → DB 同期ブリッジ。BLE 由来の enroll レコードを DB 同期 op へ委譲する糊 (P3-11)。
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// BLE NOTIFY 由来の nameUUID は hex 32 文字 (ハイフン無し) で届く (src/ble/biometric.js)。
const FW_NAME_UUID_HEX = "368154C128BC4BCDBE62F3B15C7496D0";
const FW_NAME_UUID_DASHED = "368154c1-28bc-4bcd-be62-f3b15c7496d0";

describe("enrolledToCardList", () => {
  it("record.nameUUID (ファームウェア採番) があれば新規採番せず正規化して透過する (P3-11)", () => {
    const list = enrolledToCardList([
      { cardID: "aa", cardName: "41", cardType: 1, nameUUID: FW_NAME_UUID_HEX },
    ]);
    // 小文字 + ハイフン区切り (biz3utils.insertUUIDIsolationCharacter + toLowerCase 相当)
    expect(list[0].nameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("既にハイフン付きの nameUUID は小文字化のみで透過する", () => {
    const list = enrolledToCardList([
      { cardID: "aa", nameUUID: "368154C1-28BC-4BCD-BE62-F3B15C7496D0" },
    ]);
    expect(list[0].nameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("nameUUID 欠落時のみ v4 を採番する (後方互換。ファーム不一致の可能性は JSDoc 注記)", () => {
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

describe("enrolledToPasscodeList", () => {
  it("写像は {passwordID, name, nameUUID} のみ (passwords.js:101-113 に無い keyBoardPassCode/keyBoardPassCodeNameUUID/type は送らない)", () => {
    const list = enrolledToPasscodeList([
      { cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(list[0]).toEqual({
      passwordID: "0102",
      name: "70",
      nameUUID: FW_NAME_UUID_DASHED,
    });
    expect(Object.keys(list[0]).sort()).toEqual(["name", "nameUUID", "passwordID"]);
  });

  it("nameUUID 欠落時のみ v4 を採番する", () => {
    const list = enrolledToPasscodeList([{ cardID: "0102", cardName: "70" }]);
    expect(list[0].nameUUID).toMatch(UUID_V4);
  });

  it("非配列は空配列を返す", () => {
    expect(enrolledToPasscodeList(undefined)).toEqual([]);
  });
});

describe("syncEnrolledCards", () => {
  it("タップ登録 (records): レコードごとに updateCardName へ委譲し、ack 由来 nameUUID を cardNameUUID に載せる (cards/index.js:104-136)", async () => {
    const c = requestClient({ success: true });
    const res = await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "41", cardType: 1, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].action).toBe(ACTION);
    expect(c.sent[0].op).toBe("updateCardName"); // postCards ではない
    expect(c.sent[0].obj).toMatchObject({
      cardID: "aa",
      name: "41",
      cardType: 1,
      stpDeviceUUID: "dev1",
      cardNameUUID: FW_NAME_UUID_DASHED, // ファームウェア採番値を透過
    });
    expect(typeof c.sent[0].obj.timestamp).toBe("number"); // cards/index.js:120
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
  });

  it("records 複数件は 1 件ずつ updateCardName を送る", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [
        { cardID: "aa", cardName: "41", cardType: 1 },
        { cardID: "bb", cardName: "42", cardType: 1 },
      ],
    });
    expect(c.sent).toHaveLength(2);
    expect(c.sent.map((f) => f.op)).toEqual(["updateCardName", "updateCardName"]);
    expect(c.sent.map((f) => f.obj.cardID)).toEqual(["aa", "bb"]);
  });

  it("list を渡すと一括投入経路 (postCards) へそのまま流す (ファームへ書いた nameUUID と同一前提)", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "u1", name: "x", cardType: 1 }];
    await syncEnrolledCards(c, { deviceUUID: "dev1", list });
    expect(c.sent[0].op).toBe("postCards");
    expect(c.sent[0].list).toEqual(list);
  });

  it("空 records なら何も送らず null", async () => {
    const c = requestClient({ success: true });
    expect(await syncEnrolledCards(c, { deviceUUID: "dev1", records: [] })).toBeNull();
    expect(c.sent).toHaveLength(0);
  });
});

describe("syncEnrolledPasscodes", () => {
  it("records を {passwordID, name, nameUUID} に変換し postPasscodes へ委譲する", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledPasscodes(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent[0].op).toBe("postPasscodes");
    expect(c.sent[0].deviceUUID).toBe("dev1");
    expect(c.sent[0].list[0]).toEqual({
      passwordID: "0102",
      name: "70",
      nameUUID: FW_NAME_UUID_DASHED,
    });
    // 参照 (passwords.js:101-113) に無いフィールドを送らない
    expect(c.sent[0].list[0]).not.toHaveProperty("keyBoardPassCode");
    expect(c.sent[0].list[0]).not.toHaveProperty("keyBoardPassCodeNameUUID");
    expect(c.sent[0].list[0]).not.toHaveProperty("type");
  });

  it("空 records なら null", async () => {
    const c = requestClient({ success: true });
    expect(await syncEnrolledPasscodes(c, { deviceUUID: "dev1", records: [] })).toBeNull();
  });
});

// ---------- withSuffix (BIZ-08): Kotlin の無条件連結に一致 ----------

describe("postAuthenticationData ほか (withSuffix — BIZ-08)", () => {
  /** 注入 transport: body をキャプチャして 200 を返す。 */
  function captureTransport(calls) {
    return async (req) => { calls.push(req); return { status: 200, text: "{}", json: {} }; };
  }

  it("op は operation + '_post' の無条件連結 (CHDataSynchronizeCapableImpl.kt:17)", async () => {
    const calls = [];
    await postAuthenticationData(null, {
      operation: "nfc_card", deviceID: "d1", items: [], transport: captureTransport(calls),
    });
    expect(calls[0].body.op).toBe("nfc_card_post");
  });

  it("既に '_post' で終わっていても二重連結する (Kotlin `operation += \"_post\"` と同じ)", async () => {
    const calls = [];
    await postAuthenticationData(null, {
      operation: "nfc_card_post", deviceID: "d1", items: [], transport: captureTransport(calls),
    });
    expect(calls[0].body.op).toBe("nfc_card_post_post");
  });

  it("put / delete も同様に無条件連結", async () => {
    const calls = [];
    await putAuthenticationData(null, {
      operation: "fingerprint_put", deviceID: "d1", items: [], transport: captureTransport(calls),
    });
    await deleteAuthenticationData(null, {
      operation: "palm_delete", deviceID: "d1", items: [], transport: captureTransport(calls),
    });
    expect(calls[0].body.op).toBe("fingerprint_put_put");
    expect(calls[1].body.op).toBe("palm_delete_delete");
  });

  // P3-6: フォールバック撤去 — resp.data.items を直返し
  // 参照: CHDataSynchronizeCapableImpl.kt:23 は無条件 responses.data.items を読む(フォールバックなし)
  it("data.items を直返しする (resp にフォールバックしない)", async () => {
    const items = [{ id: "card-1", type: "nfc" }];
    const transport = async () => ({ status: 200, json: { data: { items } } });
    const r = await postAuthenticationData(null, {
      operation: "nfc_card", deviceID: "d1", items: [], transport,
    });
    expect(r).toEqual(items);
  });

  it("data.items 欠落時は undefined (resp にフォールバックしない)", async () => {
    // captureTransport は json:{} を返すため data.items は存在しない
    const calls = [];
    const r = await postAuthenticationData(null, {
      operation: "nfc_card", deviceID: "d1", items: [], transport: captureTransport(calls),
    });
    expect(r).toBeUndefined();
  });
});
