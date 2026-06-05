<!-- [English](./library.md) | 日本語 -->

# ライブラリとして使う

> English: [library.md](./library.md)

`sesame` CLI と同じ機能を Node.js から直接呼べる。他言語から使うなら [`sesame serve`](../README.ja.md#言語非依存バックエンド-sesame-serve) を、Node 内で使うならこちら。

## 一番楽な形: `use()` ヘルパ (auto connect/close)

```js
import { SesameHub3 } from "sesame-kit";

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
    // load() が返す idToken は実際の Cognito 由来の JWT である必要があります:
    //   - exp クレーム (UNIX秒) が「現在時刻 + 60秒」より先 でないと毎回 refresh が走る
    //   - sub クレーム が UUID 形式。ロック操作の history (誰が操作したか) に使われるため必須。
    // → 通常は `sesame login` で取得し FileTokenStore に保存された値をそのまま使う。
    //   独自 store は「その値を別の場所から load/save する」だけで、idToken を自作しない。
    load() { return { idToken, refreshToken, clientId: "6ialca0p8u0lsgvbmvsljfm305" }; },
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
  await hub.triggerLockDevice({ deviceUUID, secretKey, cmd: 83 });   // 任意 cmd

  // IR
  await hub.sendIRDirect({
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
import { SesameHub3 } from "sesame-kit";

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

メインエントリ (`"sesame-kit"`) から取れるもの:

```js
import {
  Hub3WsClient,          // WebSocket + reconnect/keepalive/queue/sleep 検知
  sendIR, getIRCodes,    // IR 基本 op (named export)
  triggerLock, lockLock, lockUnlock, lockToggle, botClick,  // lock 個別関数 (named export)
  ir, devices, crypto, lock, auth,  // ← これらは namespace export (オブジェクト)
  FileTokenStore, ConfigStore, configPaths,
} from "sesame-kit";

// namespace は メソッドをドット経由で呼ぶ:
crypto.cmacTime("...");          // ✅ メインから取れるのは namespace の crypto
auth.getValidIdToken(store);     // ✅ 同上
// ⚠️ import { cmacTime } from "sesame-kit" は不可 (cmacTime は crypto namespace の中)
```

個別関数を named import したい場合はサブパス (`package.json` の exports map) から:

```js
import { cmacTime } from "sesame-kit/crypto";   // ✅ サブパスなら named でOK
import { learnIRKey } from "sesame-kit/ir";
import { lockLock } from "sesame-kit/lock";
```

## TypeScript

`.d.ts` 型定義を同梱しています (`types/`、JSDoc から `tsc` で生成)。`moduleResolution: "node16" / "nodenext" / "bundler"` で
パッケージ名 import (`from "sesame-kit"` / `"sesame-kit/crypto"` 等) すれば型が効きます:

```ts
import { SesameHub3 } from "sesame-kit";
await SesameHub3.use(async (hub) => {
  await hub.unlockDevice({ deviceUUID: "...", secretKey: "..." });  // 引数が型チェックされる
});
```

型は `npm run build:types` で再生成できます (ソースの JSDoc を編集したら実行)。
