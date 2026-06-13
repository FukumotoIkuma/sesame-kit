<!-- [English](../en/library.md) | 日本語 -->

# ライブラリとして使う

> [English](../en/library.md) · [ドキュメント目次](./index.md)

`sesame` CLI と同じ機能を Node.js から直接呼べます。他言語から使うなら [`sesame serve`](../../README.ja.md#言語非依存バックエンド-sesame-serve) を、Node 内で使うならこちら。

## `use()` ヘルパ (auto connect/close)

```js
import { SesameHub3 } from "@sesame-kit/core";

await SesameHub3.use(async (hub) => {
  await hub.unlock("front");
  await hub.send("ac", "停止");
});
// connect / close は自動。例外時も close される。
```

設定ディレクトリを変えたい:

```js
await SesameHub3.use({ configDir: "/tmp/cfg" }, async (hub) => {...});
```

config ファイル不要で in-memory token を使いたい (他プロジェクト埋込み等):

```js
await SesameHub3.use({
  tokenStore: {
    // `sesame login` が作った token object をそのまま返してください。
    // SESAME Consumer Client の token で、ConfirmDevice 済みの
    // deviceKey/deviceGroupKey/devicePassword が揃っている必要があります。
    // 独自 store は「その値を別の場所から load/save する」だけで、旧 token を流し込んだり自作しない。
    load() { return { idToken, refreshToken, clientId: "6ialca0p8u0lsgvbmvsljfm305", deviceKey, deviceGroupKey, devicePassword }; },
    save(t) { /* persist however */ },
    clear() {}, loadPending() { return null; }, savePending() {}, clearPending() {},
  },
  config: { companyID: "ch_X", wsUrl: "wss://..." },  // companyID/wsUrl は省略可 (DEFAULT_CONFIG が補完)
}, async (hub) => {
  await hub.unlockDevice({ deviceUUID: "...", secretKey: "..." });
});
```

## Config を介さない直接 API (name lookup なし)

```js
await SesameHub3.use(async (hub) => {
  // ロック (config の locks 定義に頼らず deviceUUID + secretKey 直指定)
  await hub.unlockDevice({ deviceUUID, secretKey });
  await hub.lockDevice({ deviceUUID, secretKey });
  await hub.toggleDevice({ deviceUUID, secretKey });
  await hub.botClickDevice({ deviceUUID, secretKey });
  await hub.triggerLockDevice({ deviceUUID, secretKey, cmd: 83 });   // 生 itemCode: 83=解錠, 82=施錠, 88=トグル, 89=クリック
  // ⚠️ triggerLockRaw / triggerLockDevice(任意 cmd) は CLI/RPC 経路に意図的に非公開。
  //    誤爆リスク(任意整数 cmd をネットワーク越しに受け付ける)のため。
  //    公式アプリが使う cmd (82/83/88/89) はすべて名前付きラッパで足りる。
  //    詳細: docs/api-stability.md "Intentionally absent from CLI/RPC"

  // IR
  await hub.sendIRDirect({
    // irType はリモコン種別: 49152 (0xC000)=エアコン, 8192=TV, 32768=扇風機, 57344=照明
    hub3DeviceId, irDeviceUUID, irType: 49152, command: keyUUID, operation: "learnEmit",
  });
  const keys = await hub.getIRCodesDirect({ hub3DeviceId, irDeviceUUID });
});
```

## イベント購読 (state push)

```js
await SesameHub3.use(async (hub) => {
  // 設定名でロック状態の push を購読
  const off1 = hub.onLockStateChange("front", (msg) => {
    console.log("front state:", msg.data?.state);
  });

  // UUID 直指定でも OK
  const off2 = hub.onLockStateChangeDevice(deviceUUID, (msg) => { ... });

  // IR 学習データを受信 (内部で setIRMode + subscribeIRData を発行、unsubscribe で元に戻す)
  const offLearn = await hub.onIRLearned("livinghub3", (irData) => {
    console.log("captured:", irData);
  });

  // デバイス state 一括購読 (subscribeDevicesUpdate)
  const off3 = hub.onDeviceUpdate(
    [{ deviceUUID, deviceModel: "sesame_5_pro" }],
    (msg) => console.log(msg),
  );

  await new Promise((r) => setTimeout(r, 30_000));
  off1(); off2(); off3();
  await offLearn();
});
```

## 名前ベースの古い API (config 必須)

```js
import { SesameHub3 } from "@sesame-kit/core";

const hub = await SesameHub3.fromConfig();
await hub.connect();
try {
  await hub.unlock("front");
  await hub.send("ac", "停止");
  await hub.learnIR("ac", "強風", { onPrompt: () => console.log("ボタン押して") });
  const devs = await hub.listDevices();
  const hist = await hub.getDeviceHistory([{ deviceUUID: devs[0].deviceUUID }]);
} finally {
  await hub.close();
}
```

## 低レベル import (transport / op 関数 / crypto を直接)

メインエントリ (`"@sesame-kit/core"`) から取れるもの:

```js
import {
  Hub3WsClient,          // WebSocket + reconnect/keepalive/queue/sleep 検知
  sendIR, getIRCodes,    // IR 基本 op (named export)
  triggerLock, lockLock, lockUnlock, lockToggle, botClick,  // lock 個別関数 (named export)
  ir, devices, crypto, lock, auth,  // ← これらは namespace export (オブジェクト)
  FileTokenStore, ConfigStore, configPaths,
} from "@sesame-kit/core";

// namespace は メソッドをドット経由で呼ぶ:
crypto.cmacTime("...");          // ✅ メインから取れるのは namespace の crypto
auth.getValidIdToken(store);     // ✅ 同上
// ⚠️ import { cmacTime } from "@sesame-kit/core" は不可 (cmacTime は crypto namespace の中)
```

個別関数を named import したい場合はサブパス (`package.json` の exports map) から:

```js
import { cmacTime } from "@sesame-kit/core/crypto";   // ✅ サブパスなら named でOK
import { learnIRKey } from "@sesame-kit/core/ir";
import { lockLock } from "@sesame-kit/core/lock";
```

## エラー処理: message ではなく `err.code` で分岐する

ライブラリが throw するエラーの **message はロケール依存**です (CLI と同じ i18n 層を通るため、`--lang` / `config.uiLang` で文言が変わります)。機械的な分岐には `SesameError` の構造化フィールドを使ってください:

```js
import { SesameError } from "@sesame-kit/core";

try {
  await hub.unlock("front");
} catch (e) {
  if (e instanceof SesameError) {
    // e.code: "not_connected" | "timeout" | "rejected" | "bad_request" | "unauthenticated"
    // e.retryable: 一時的失敗 (timeout / not_connected) で true
    // e.data: 付随情報 (例: "rejected" のとき上流クラウド自身の code)
    if (e.retryable) scheduleRetry();
  }
}
```

`sesame serve` 経由でも同じ原則です: JSON-RPC エラーは (`code` から写像された) `error.data.kind` を持ちます — `error.message` は決して parse しないでください。

## TypeScript

`.d.ts` 型定義を同梱しています (`types/`、JSDoc から `tsc` で生成)。`moduleResolution: "node16" / "nodenext" / "bundler"` で
パッケージ名 import (`from "@sesame-kit/core"` / `"@sesame-kit/core/crypto"` 等) すれば型が効きます:

```ts
import { SesameHub3 } from "@sesame-kit/core";
await SesameHub3.use(async (hub) => {
  await hub.unlockDevice({ deviceUUID: "...", secretKey: "..." });  // 引数が型チェックされる
});
```

型は `npm run build:types` で再生成できます (ソースの JSDoc を編集したら実行)。
