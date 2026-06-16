// ACC-0019〜ACC-0039 対象の単体テスト (統合版: writer A + B を精査し最良を採用)
// spec: spec/access.md — 対象 ID 18 件
// 実装: packages/core/src/access.js
//
// 規約:
//   - 各 it タイトル先頭に [ACC-XXXX] を置く
//   - assert は spec の assert フィールドに従う (実装に歪めない)
//   - ネットワーク/実機なし、すべて mock / 純関数

import { describe, it, expect } from "vitest";
import {
  updatePasscodeName,
  updateCardOwner,
  enrolledToCardList,
  enrolledToPasscodeList,
  postAuthenticationData,
  putAuthenticationData,
  deleteAuthenticationData,
  updateAuthenticationName,
  makeBiometricsTransport,
} from "../../src/access.js";
import { mockClient } from "../helpers/mock-ws.js";

// ---------------------------------------------------------------------------
// 共有ヘルパー
// ---------------------------------------------------------------------------

/** 同期 (request/response) op 用 mock client */
function requestClient(reply) {
  return mockClient(reply, { strictRequestOnly: true });
}

/**
 * 注入 transport: req をキャプチャして 200 + optional json を返す。
 * @param {any[]} calls 呼び出し記録先配列
 * @param {{ json?: object }} [opts]
 */
function captureTransport(calls, { json = {} } = {}) {
  return async (req) => {
    calls.push(req);
    return { status: 200, text: JSON.stringify(json), json };
  };
}

/** SigV4 用 fake credentials provider */
const fakeCredentialsProvider = {
  getCredentials: async () => ({
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "fakeSecret",
    sessionToken: "SESSION-TOKEN",
    expiration: new Date(Date.now() + 3_600_000),
    identityId: "ap-northeast-1:identity",
  }),
};

const ACTION = "biz3ManageAccessCtlAuthData";

// BLE NOTIFY 由来 nameUUID (hex 32 文字)
const FW_UUID_HEX    = "368154C128BC4BCDBE62F3B15C7496D0";
const FW_UUID_HEX_LC = "368154c128bc4bcdbe62f3b15c7496d0";
const FW_UUID_DASHED = "368154c1-28bc-4bcd-be62-f3b15c7496d0";

// ---------------------------------------------------------------------------
// ACC-0019: updatePasscodeName — obj:{...item} で op='updatePasscodeName' を送る
// ---------------------------------------------------------------------------

describe("updatePasscodeName (ACC-0019)", () => {
  it(
    "[ACC-0019] updatePasscodeName が updateCardName と同型 (obj:{...item}) で op='updatePasscodeName' を送る — 6フィールド item を透過",
    async () => {
      const c = requestClient({ success: true });
      const item = {
        stpDeviceUUID: "dev-uuid-1",
        keyBoardPassCode: "010203",
        keyBoardPassCodeNameUUID: "22222222-2222-4222-8222-222222222222",
        name: "パスコード名",
        timestamp: 1700000000000,
        type: 2,
      };
      await updatePasscodeName(c, { item });

      expect(c.sent).toHaveLength(1);
      expect(c.sent[0].action).toBe(ACTION);
      expect(c.sent[0].op).toBe("updatePasscodeName");
      // obj は item の全フィールドを透過する (obj:{...item})
      expect(c.sent[0].obj).toEqual({ ...item });
      // obj でラップされ、トップレベルには list/deviceUUID は無い
      expect(c.sent[0]).not.toHaveProperty("list");
      expect(c.sent[0]).not.toHaveProperty("deviceUUID");
    },
  );

  it(
    "[ACC-0019] timestamp/type も呼出側が載せれば obj に透過して送られる (obj:{...item} 透過の副証)",
    async () => {
      const item = { keyBoardPassCode: "0304", name: "x", keyBoardPassCodeNameUUID: "uuid", timestamp: 9999, type: 2 };
      const c = requestClient({ success: true });
      await updatePasscodeName(c, { item });
      expect(c.sent[0].obj.timestamp).toBe(9999);
      expect(c.sent[0].obj.type).toBe(2);
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0020: updateCardOwner — 'ownerSubUUID' in item 時のみ送信
// ---------------------------------------------------------------------------

describe("updateCardOwner (ACC-0020)", () => {
  it(
    "[ACC-0020] item に ownerSubUUID キーが在る時だけ {action,obj:{...item},op:'updateCardOwner'} を送り、無ければ null を返す",
    async () => {
      const item = {
        cardID: "C2",
        name: "Alice",
        cardNameUUID: "uuid-card-name",
        ownerSubUUID: "sub-alice",
        timestamp: 1700000000000,
        cardType: 1,
        stpDeviceUUID: "stp-dev",
      };
      const c = requestClient({ success: true });
      await updateCardOwner(c, { item });

      expect(c.sent).toHaveLength(1);
      expect(c.sent[0].action).toBe(ACTION);
      expect(c.sent[0].op).toBe("updateCardOwner");
      expect(c.sent[0].obj).toEqual({ ...item });

      // ownerSubUUID キーが存在しない item → null / 送信しない
      const c2 = requestClient({ success: true });
      const result = await updateCardOwner(c2, { item: { cardID: "C3", name: "x" } });
      expect(result).toBeNull();
      expect(c2.sent).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0021: updateCardOwner — ownerSubUUID='' vs undefined 境界
// ---------------------------------------------------------------------------

describe("updateCardOwner ownerSubUUID 境界 (ACC-0021)", () => {
  it(
    "[ACC-0021] ownerSubUUID='' は送信 (未割当解除) / undefined キー不在なら送信しない (null)",
    async () => {
      // item 透過パス: '' は 'ownerSubUUID' in item が true → 送信
      const c1 = requestClient({ success: true });
      await updateCardOwner(c1, { item: { cardID: "C4", ownerSubUUID: "" } });
      expect(c1.sent).toHaveLength(1);
      expect(c1.sent[0].obj.ownerSubUUID).toBe("");

      // item 透過パス: キー不在 → null / 送信しない
      const c2 = requestClient({ success: true });
      const r2 = await updateCardOwner(c2, { item: { cardID: "C5" } });
      expect(r2).toBeNull();
      expect(c2.sent).toHaveLength(0);

      // 後方互換パス: ownerSubUUID='' → 送信
      const c3 = requestClient({ success: true });
      await updateCardOwner(c3, { cardID: "C6", ownerSubUUID: "" });
      expect(c3.sent).toHaveLength(1);
      expect(c3.sent[0].obj.ownerSubUUID).toBe("");

      // 後方互換パス: ownerSubUUID=undefined → null / 送信しない
      const c4 = requestClient({ success: true });
      const r4 = await updateCardOwner(c4, { cardID: "C7" });
      expect(r4).toBeNull();
      expect(c4.sent).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0024: normalizeNameUUID (enrolledToCardList / enrolledToPasscodeList 経由)
// ---------------------------------------------------------------------------

describe("normalizeNameUUID / enrolledToCardList (ACC-0024)", () => {
  it(
    "[ACC-0024] NOTIFY 由来 32hex nameUUID を小文字化し 8-4-4-4-12 区切りへ整形する (insertUUIDIsolationCharacter 相当)",
    () => {
      // 32hex (ハイフン無し、大文字) → 8-4-4-4-12 小文字ハイフン区切り
      const cardList = enrolledToCardList([
        { cardID: "aa", cardName: "card1", cardType: 1, nameUUID: FW_UUID_HEX },
      ]);
      expect(cardList[0].nameUUID).toBe(FW_UUID_DASHED);

      // 32hex 小文字も同様
      const cardList2 = enrolledToCardList([
        { cardID: "bb", cardName: "card2", cardType: 1, nameUUID: FW_UUID_HEX_LC },
      ]);
      expect(cardList2[0].nameUUID).toBe(FW_UUID_DASHED);

      // 既にハイフン付き (大文字) → 小文字化のみ (整形変換は 32hex 限定)
      const cardList3 = enrolledToCardList([
        { cardID: "cc", cardName: "card3", cardType: 0, nameUUID: "368154C1-28BC-4BCD-BE62-F3B15C7496D0" },
      ]);
      expect(cardList3[0].nameUUID).toBe(FW_UUID_DASHED);

      // 欠落 → generateUUID() (v4 採番、format のみ検証)
      const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const cardList4 = enrolledToCardList([
        { cardID: "dd", cardName: "card4", cardType: 0 },
      ]);
      expect(cardList4[0].nameUUID).toMatch(UUID_V4);

      // null も欠落扱い
      const cardList5 = enrolledToCardList([
        { cardID: "ee", cardName: "card5", cardType: 0, nameUUID: null },
      ]);
      expect(cardList5[0].nameUUID).toMatch(UUID_V4);

      // passcode 経路でも同じ整形
      const pList = enrolledToPasscodeList([
        { cardID: "0102", cardName: "70", nameUUID: FW_UUID_HEX },
      ]);
      expect(pList[0].nameUUID).toBe(FW_UUID_DASHED);
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0026: postAuthenticationData — POST body wire
// ---------------------------------------------------------------------------

describe("postAuthenticationData wire (ACC-0026)", () => {
  it(
    "[ACC-0026] POST /device/v1/biometrics へ body {op:'nfc_card_post', deviceID, items} を送る (CHDataSynchronizeCapableImpl.kt:17)",
    async () => {
      const calls = [];
      await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "dev-001",
        items: [{ id: "card-x" }],
        transport: captureTransport(calls),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].path).toBe("/device/v1/biometrics");
      expect(calls[0].body.op).toBe("nfc_card_post");
      expect(calls[0].body.deviceID).toBe("dev-001");
      expect(calls[0].body.items).toEqual([{ id: "card-x" }]);
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0027: postAuthenticationData — resp?.data?.items 直返し (フォールバックなし)
// ---------------------------------------------------------------------------

describe("postAuthenticationData response unwrap (ACC-0027)", () => {
  it(
    "[ACC-0027] 応答 unwrap は resp?.data?.items のみ — resp へのフォールバックなし (CHDataSynchronizeCapableImpl.kt:23)",
    async () => {
      // data.items が存在する場合 → 直返し
      const items = [{ id: "c1" }];
      const r1 = await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "d",
        items: [],
        transport: async () => ({ status: 200, json: { data: { items } }, text: "" }),
      });
      expect(r1).toEqual(items);

      // data.items が欠落 → undefined (resp 自体にはフォールバックしない)
      const r2 = await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "d",
        items: [],
        transport: async () => ({ status: 200, json: { ok: true }, text: '{"ok":true}' }),
      });
      expect(r2).toBeUndefined();

      // data はあるが items キー自体が無い場合も undefined
      const r3 = await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "d",
        items: [],
        transport: async () => ({ status: 200, json: { data: {} }, text: "" }),
      });
      expect(r3).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0028: putAuthenticationData — op='operation_put'
// ---------------------------------------------------------------------------

describe("putAuthenticationData wire (ACC-0028)", () => {
  it(
    "[ACC-0028] PUT body の op が operation+'_put' の無条件連結 (CHDataSynchronizeCapableImpl.kt:32)",
    async () => {
      const calls = [];
      await putAuthenticationData(null, {
        operation: "fingerprint",
        deviceID: "d2",
        items: [],
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("fingerprint_put");
      expect(calls[0].body.deviceID).toBe("d2");
      expect(calls[0].body.items).toEqual([]);
    },
  );

  it(
    "[ACC-0028] 既に '_put' で終わっていても二重連結する (Kotlin `operation += \"_put\"` 無条件連結の再現)",
    async () => {
      const calls = [];
      await putAuthenticationData(null, {
        operation: "fingerprint_put",
        deviceID: "d2",
        items: [],
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("fingerprint_put_put");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0029: deleteAuthenticationData — op='operation_delete'
// ---------------------------------------------------------------------------

describe("deleteAuthenticationData wire (ACC-0029)", () => {
  it(
    "[ACC-0029] DELETE body の op が operation+'_delete' の無条件連結、items がトップレベル (CHDataSynchronizeCapableImpl.kt:44)",
    async () => {
      const calls = [];
      await deleteAuthenticationData(null, {
        operation: "palm",
        deviceID: "d3",
        items: [{ x: 1 }],
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("palm_delete");
      expect(calls[0].body.deviceID).toBe("d3");
      expect(calls[0].body.items).toEqual([{ x: 1 }]);
    },
  );

  it(
    "[ACC-0029] 既に '_delete' で終わっていても二重連結する",
    async () => {
      const calls = [];
      await deleteAuthenticationData(null, {
        operation: "palm_delete",
        deviceID: "d3",
        items: [],
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("palm_delete_delete");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0030: withSuffix は無条件連結 (BIZ-08)
// ---------------------------------------------------------------------------

describe("withSuffix 無条件連結 (ACC-0030)", () => {
  it(
    "[ACC-0030] 既に '_post' 終端の operation でも二重連結する (Kotlin `operation += \"_post\"` と同挙動)",
    async () => {
      const calls = [];
      await postAuthenticationData(null, {
        operation: "nfc_card_post",
        deviceID: "d",
        items: [],
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("nfc_card_post_post");

      // put でも同様
      const calls2 = [];
      await putAuthenticationData(null, {
        operation: "face_put",
        deviceID: "d",
        items: [],
        transport: captureTransport(calls2),
      });
      expect(calls2[0].body.op).toBe("face_put_put");

      // delete でも同様
      const calls3 = [];
      await deleteAuthenticationData(null, {
        operation: "passcode_delete",
        deviceID: "d",
        items: [],
        transport: captureTransport(calls3),
      });
      expect(calls3[0].body.op).toBe("passcode_delete_delete");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0031: items 非配列は [] に正規化
// ---------------------------------------------------------------------------

describe("items 非配列正規化 (ACC-0031)", () => {
  it(
    "[ACC-0031] items が非配列 (null/undefined/文字列/数値) の場合 body.items は [] に正規化される",
    async () => {
      // post: null → []
      const callsPost = [];
      await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "d",
        items: null,
        transport: captureTransport(callsPost),
      });
      expect(callsPost[0].body.items).toEqual([]);

      // post: undefined (省略) → []
      const callsPost2 = [];
      await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "d",
        transport: captureTransport(callsPost2),
      });
      expect(callsPost2[0].body.items).toEqual([]);

      // put: undefined → []
      const callsPut = [];
      await putAuthenticationData(null, {
        operation: "fingerprint",
        deviceID: "d",
        items: undefined,
        transport: captureTransport(callsPut),
      });
      expect(callsPut[0].body.items).toEqual([]);

      // put: 文字列 → []
      const callsPut2 = [];
      await putAuthenticationData(null, {
        operation: "fingerprint",
        deviceID: "d",
        items: "not-array",
        transport: captureTransport(callsPut2),
      });
      expect(callsPut2[0].body.items).toEqual([]);

      // delete: 数値 → []
      const callsDel = [];
      await deleteAuthenticationData(null, {
        operation: "palm",
        deviceID: "d",
        items: 42,
        transport: captureTransport(callsDel),
      });
      expect(callsDel[0].body.items).toEqual([]);

      // 配列はそのまま送る (正規化は非配列のみ)
      const callsArr = [];
      const items = [{ id: "x" }, { id: "y" }];
      await postAuthenticationData(null, {
        operation: "nfc_card",
        deviceID: "d",
        items,
        transport: captureTransport(callsArr),
      });
      expect(callsArr[0].body.items).toEqual(items);
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0032: makeBiometricsTransport — 既定ホスト / SigV4 + x-api-key / appidentifyid 無し
// ---------------------------------------------------------------------------

describe("makeBiometricsTransport defaults (ACC-0032)", () => {
  it(
    "[ACC-0032] 既定ホストは https://app.candyhouse.co/prod / SigV4+x-api-key / appidentifyid ヘッダ無し (CHAPIClient.kt:105-106)",
    async () => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { status: 200, text: async () => "{}" };
      };
      const transport = makeBiometricsTransport({
        credentialsProvider: fakeCredentialsProvider,
        appIdentifyId: "ap-northeast-1:some-id", // 互換受理・無視
        fetchImpl,
      });
      await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

      // 既定ホスト
      expect(calls[0].url).toBe("https://app.candyhouse.co/prod/device/v1/biometrics");

      const h = calls[0].init.headers;
      // SigV4 署名
      expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\//);
      // x-api-key は付与される
      expect(h["x-api-key"]).toBeDefined();
      // appidentifyid は付けない (CHAPIClient.kt:105-106)
      expect(h["appidentifyid"]).toBeUndefined();
      expect(h.authorization).not.toMatch(/appidentifyid/);
    },
  );

  it(
    "[ACC-0032] apiKey オプションでカスタム x-api-key を設定できる",
    async () => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { status: 200, text: async () => "{}" };
      };
      const transport = makeBiometricsTransport({
        credentialsProvider: fakeCredentialsProvider,
        apiKey: "custom-api-key",
        fetchImpl,
      });
      await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });
      expect(calls[0].init.headers["x-api-key"]).toBe("custom-api-key");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0033: makeBiometricsTransport — 認可ソース未指定で badRequest
// ---------------------------------------------------------------------------

describe("makeBiometricsTransport 認可ソース未指定 (ACC-0033)", () => {
  it(
    "[ACC-0033] credentialsProvider/getIdToken/authorization/bearerToken/authorizationProvider が全て無いとき badRequest を throw",
    () => {
      expect(() =>
        makeBiometricsTransport({
          baseUrl: "https://api.example.test",
          fetchImpl: () => {},
        }),
      ).toThrow(/credentialsProvider|authorization/i);
    },
  );

  it(
    "[ACC-0033] authorization 文字列を渡せばエラーにならない (互換経路)",
    () => {
      expect(() =>
        makeBiometricsTransport({
          baseUrl: "https://api.example.test",
          authorization: "Bearer token",
          fetchImpl: () => {},
        }),
      ).not.toThrow();
    },
  );

  it(
    "[ACC-0033] bearerToken を渡せばエラーにならない (互換経路)",
    () => {
      expect(() =>
        makeBiometricsTransport({
          baseUrl: "https://api.example.test",
          bearerToken: "some-token",
          fetchImpl: () => {},
        }),
      ).not.toThrow();
    },
  );

  it(
    "[ACC-0033] authorizationProvider 関数を渡せばエラーにならない (互換経路)",
    () => {
      expect(() =>
        makeBiometricsTransport({
          baseUrl: "https://api.example.test",
          authorizationProvider: async () => "Bearer token",
          fetchImpl: () => {},
        }),
      ).not.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0034: normalizeBiometricsBaseUrl — 非HTTPS/credential付きURLを拒否
// ---------------------------------------------------------------------------

describe("normalizeBiometricsBaseUrl バリデーション (ACC-0034)", () => {
  const opts = { credentialsProvider: fakeCredentialsProvider, fetchImpl: () => {} };

  it(
    "[ACC-0034] http:// URL は badRequest を throw (HTTPS 必須)",
    () => {
      expect(() =>
        makeBiometricsTransport({ ...opts, baseUrl: "http://api.example.test" }),
      ).toThrow(/HTTPS/i);
    },
  );

  it(
    "[ACC-0034] username:password 付き URL は badRequest を throw",
    () => {
      expect(() =>
        makeBiometricsTransport({ ...opts, baseUrl: "https://user:pass@api.example.test" }),
      ).toThrow(/baseUrl/i);
    },
  );

  it(
    "[ACC-0034] query string 付き URL は badRequest を throw",
    () => {
      expect(() =>
        makeBiometricsTransport({ ...opts, baseUrl: "https://api.example.test/path?q=1" }),
      ).toThrow(/baseUrl/i);
    },
  );

  it(
    "[ACC-0034] hash 付き URL は badRequest を throw",
    () => {
      expect(() =>
        makeBiometricsTransport({ ...opts, baseUrl: "https://api.example.test/path#frag" }),
      ).toThrow(/baseUrl/i);
    },
  );

  it(
    "[ACC-0034] 不正 URL 文字列 (parse 不可) は throw",
    () => {
      expect(() =>
        makeBiometricsTransport({ ...opts, baseUrl: "not-a-url-at-all" }),
      ).toThrow();
    },
  );

  it(
    "[ACC-0034] trailing slash は正規化されて URL に重複しない",
    async () => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url });
        return { status: 200, text: async () => "{}" };
      };
      const transport = makeBiometricsTransport({
        ...opts,
        baseUrl: "https://api.example.test/root///",
        fetchImpl,
      });
      await transport({ method: "POST", path: "/device/v1/biometrics", body: {} });
      expect(calls[0].url).toBe("https://api.example.test/root/device/v1/biometrics");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0035: assertHttpOk — 非2xx で rejected エラー (status 付き)
// ---------------------------------------------------------------------------

describe("assertHttpOk / postBiometrics HTTP エラー (ACC-0035)", () => {
  it(
    "[ACC-0035] HTTP 400 は rejected エラーを throw し status:400 が付く",
    async () => {
      const transport400 = async () => ({
        status: 400,
        json: { message: "bad request detail" },
        text: '{"message":"bad request detail"}',
      });
      await expect(
        postAuthenticationData(null, {
          operation: "nfc_card", deviceID: "d", items: [],
          transport: transport400,
        }),
      ).rejects.toMatchObject({ data: { status: 400 } });

      await expect(
        postAuthenticationData(null, {
          operation: "nfc_card", deviceID: "d", items: [],
          transport: transport400,
        }),
      ).rejects.toThrow(/bad request detail/);
    },
  );

  it(
    "[ACC-0035] HTTP 500 は rejected エラーを throw",
    async () => {
      const transport500 = async () => ({
        status: 500,
        json: null,
        text: "internal error text",
      });
      await expect(
        postAuthenticationData(null, {
          operation: "nfc_card", deviceID: "d", items: [],
          transport: transport500,
        }),
      ).rejects.toThrow(/internal error text/);
    },
  );

  it(
    "[ACC-0035] HTTP 200 は正常終了する (2xx は throw しない)",
    async () => {
      await expect(
        postAuthenticationData(null, {
          operation: "nfc_card", deviceID: "d", items: [],
          transport: async () => ({ status: 200, json: { data: { items: [] } }, text: "" }),
        }),
      ).resolves.toEqual([]);
    },
  );

  it(
    "[ACC-0035] HTTP 201 も 2xx なので throw しない",
    async () => {
      await expect(
        postAuthenticationData(null, {
          operation: "nfc_card", deviceID: "d", items: [],
          transport: async () => ({ status: 201, json: { data: { items: [{ id: "x" }] } }, text: "" }),
        }),
      ).resolves.toEqual([{ id: "x" }]);
    },
  );

  it(
    "[ACC-0035] status が undefined/非number の場合は postBiometrics が bypass して undefined を返す (assertHttpOk は呼ばれない)",
    async () => {
      // postBiometrics:253 if(!res||typeof res.status!=='number') return res — status 欠落は bypass 経路 (ACC-0084).
      // assertHttpOk が呼ばれないため rejection ではなく resolve される。resp?.data?.items → undefined。
      const transportNoStatus = async () => ({ json: null, text: "" });
      const result = await postAuthenticationData(null, {
        operation: "nfc_card", deviceID: "d", items: [],
        transport: transportNoStatus,
      });
      expect(result).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0036: updateAuthenticationName(kind:'card') — 既定 op とフィールド集合
// ---------------------------------------------------------------------------

describe("updateAuthenticationName kind=card (ACC-0036)", () => {
  it(
    "[ACC-0036] kind='card' の既定 op は 'nfc_card_putname' (CHAuthenticationNameRequest.kt:23 と一致)",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "card",
        cardID: "C1",
        cardType: 1,
        cardNameUUID: "uuid-card",
        subUUID: "sub1",
        stpDeviceUUID: "stp1",
        name: "card-name",
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("nfc_card_putname");
    },
  );

  it(
    "[ACC-0036] kind='card' のフィールド集合: cardType/cardNameUUID/cardID/subUUID/stpDeviceUUID/name/timestamp が含まれる",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "card",
        cardID: "C1",
        cardType: 2,
        cardNameUUID: "11111111-1111-4111-8111-111111111111",
        subUUID: "sub-uuid",
        stpDeviceUUID: "stp-dev",
        name: "card name",
        timestamp: 1700000001000,
        transport: captureTransport(calls),
      });
      const body = calls[0].body;
      expect(body.op).toBe("nfc_card_putname");
      expect(body).toHaveProperty("cardType", 2);
      expect(body).toHaveProperty("cardNameUUID", "11111111-1111-4111-8111-111111111111");
      expect(body).toHaveProperty("cardID", "C1");
      expect(body).toHaveProperty("subUUID", "sub-uuid");
      expect(body).toHaveProperty("stpDeviceUUID", "stp-dev");
      expect(body).toHaveProperty("name", "card name");
      expect(body).toHaveProperty("timestamp", 1700000001000);
    },
  );

  it(
    "[ACC-0036] kind='card' で op 明示指定すると既定 'nfc_card_putname' を上書きできる",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "card",
        cardID: "C1",
        op: "custom_op",
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("custom_op");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0037: updateAuthenticationName — face/fingerPrint/palm/passcode の既定 op とフィールド
// ---------------------------------------------------------------------------

describe("updateAuthenticationName kind=face/fingerPrint/palm/passcode (ACC-0037)", () => {
  const common = { name: "test", subUUID: "s", stpDeviceUUID: "dev", timestamp: 1700000000000 };

  it(
    "[ACC-0037] kind='face' の既定 op は 'face_putname'、フィールドに faceNameUUID/faceID/type が含まれる",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "face",
        faceID: "F1",
        faceNameUUID: "face-uuid",
        type: 1,
        ...common,
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("face_putname");
      expect(calls[0].body).toHaveProperty("faceID", "F1");
      expect(calls[0].body).toHaveProperty("faceNameUUID", "face-uuid");
      expect(calls[0].body).toHaveProperty("type", 1);
    },
  );

  it(
    "[ACC-0037] kind='fingerPrint' の既定 op は 'fingerprint_putname'、フィールドに fingerPrintNameUUID/fingerPrintID が含まれる",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "fingerPrint",
        fingerPrintID: "FP1",
        fingerPrintNameUUID: "fp-uuid",
        type: 2,
        ...common,
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("fingerprint_putname");
      expect(calls[0].body).toHaveProperty("fingerPrintID", "FP1");
      expect(calls[0].body).toHaveProperty("fingerPrintNameUUID", "fp-uuid");
    },
  );

  it(
    "[ACC-0037] kind='palm' の既定 op は 'palm_putname'、フィールドに palmNameUUID/palmID が含まれる",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "palm",
        palmID: "PL1",
        palmNameUUID: "palm-uuid",
        type: 3,
        ...common,
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("palm_putname");
      expect(calls[0].body).toHaveProperty("palmID", "PL1");
      expect(calls[0].body).toHaveProperty("palmNameUUID", "palm-uuid");
    },
  );

  it(
    "[ACC-0037] kind='passcode' の既定 op は 'passcode_putname'、フィールドに keyBoardPassCodeNameUUID/keyBoardPassCode が含まれる",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        kind: "passcode",
        keyBoardPassCode: "010203",
        keyBoardPassCodeNameUUID: "pc-uuid",
        type: 0,
        ...common,
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("passcode_putname");
      expect(calls[0].body).toHaveProperty("keyBoardPassCode", "010203");
      expect(calls[0].body).toHaveProperty("keyBoardPassCodeNameUUID", "pc-uuid");
    },
  );

  it(
    "[ACC-0037] 各 kind の既定 op が互いに異なる (合計 5 種)",
    async () => {
      const ops = [];
      for (const [kind, extra] of [
        ["card", {}],
        ["face", {}],
        ["fingerPrint", {}],
        ["palm", {}],
        ["passcode", {}],
      ]) {
        const calls = [];
        await updateAuthenticationName(null, {
          kind,
          ...extra,
          transport: captureTransport(calls),
        }).catch(() => {});
        if (calls[0]) ops.push(calls[0].body.op);
      }
      expect(new Set(ops).size).toBe(5);
      expect(ops).toContain("nfc_card_putname");
      expect(ops).toContain("face_putname");
      expect(ops).toContain("fingerprint_putname");
      expect(ops).toContain("palm_putname");
      expect(ops).toContain("passcode_putname");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0038: updateAuthenticationName — request 直指定はバイパス
// ---------------------------------------------------------------------------

describe("updateAuthenticationName request bypass (ACC-0038)", () => {
  it(
    "[ACC-0038] params.request があれば authenticationNameRequest を呼ばず {...request} をそのまま POST する",
    async () => {
      const calls = [];
      const customRequest = {
        op: "custom_op",
        cardID: "C99",
        name: "custom name",
        timestamp: 9999,
      };
      await updateAuthenticationName(null, {
        request: customRequest,
        transport: captureTransport(calls),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ ...customRequest });
      expect(calls[0].body.op).toBe("custom_op");
    },
  );

  it(
    "[ACC-0038] request 直指定では kind が無くてもエラーにならない",
    async () => {
      const calls = [];
      await expect(
        updateAuthenticationName(null, {
          request: { op: "some_op", name: "x" },
          transport: captureTransport(calls),
        }),
      ).resolves.not.toThrow();
      expect(calls[0].body.op).toBe("some_op");
    },
  );

  it(
    "[ACC-0038] request=undefined の場合は kind から組み立てる (バイパスしない)",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        request: undefined,
        kind: "face",
        faceID: "F-test",
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("face_putname");
    },
  );

  it(
    "[ACC-0038] request=null でも kind が有れば正常に組み立てる (null は falsy → kind 分岐)",
    async () => {
      const calls = [];
      await updateAuthenticationName(null, {
        request: null,
        kind: "palm",
        palmID: "P-test",
        transport: captureTransport(calls),
      });
      expect(calls[0].body.op).toBe("palm_putname");
    },
  );
});

// ---------------------------------------------------------------------------
// ACC-0039: updateAuthenticationName — kind/request 共に無しで badRequest
// ---------------------------------------------------------------------------

describe("updateAuthenticationName kindRequired エラー (ACC-0039)", () => {
  it(
    "[ACC-0039] request が無く kind が不正な値のとき badRequest('access.err.kindRequired') を throw",
    async () => {
      await expect(
        updateAuthenticationName(null, {
          kind: "unknown_kind",
          transport: captureTransport([]),
        }),
      ).rejects.toThrow(/kind/i);
    },
  );

  it(
    "[ACC-0039] request が無く kind も無い (undefined) とき badRequest を throw",
    async () => {
      await expect(
        updateAuthenticationName(null, {
          transport: captureTransport([]),
        }),
      ).rejects.toThrow(/kind/i);
    },
  );
});
