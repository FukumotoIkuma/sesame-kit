# vendor/biz3 — 公式 biz3 由来の純定数 (原文ママ)

CANDY-HOUSE/biz.candyhouse.co (通称 "biz3", MIT) の **React 非依存・import ゼロの純定数ファイル**を原文のまま
コピーしたもの。当実装はこれらを **直接 import** して single source of truth とする
(手書きで写すと推測ミス＝定数のズレが入るため。実際 irType/productType 等で過去に発生)。

| ファイル | biz3 の元パス | 当実装での用途 |
|---|---|---|
| `constants/sesameDeviceModel.js` | `src/constants/sesameDeviceModel.js` | `crypto.js` の PRODUCT_TYPE / model 名 |
| `constants/messageConstants.js` | `src/constants/messageConstants.js` | ACTION 文字列 / WS_HEARTBEAT_INTERVAL_MS |
| `constants/cmdCode.js` | `src/constants/cmdCode.js` | item code 参照 |

## 更新方法

biz3 が定数を変えたら、元リポ (references) から再コピーするだけ:

```
cp <biz3>/src/constants/{sesameDeviceModel,messageConstants,cmdCode}.js vendor/biz3/constants/
```

`package.json` の `{"type":"module"}` は Node が ESM として解釈するために置いている
(biz3 本体は CRA で type 未指定のため、ここだけ補う)。

## 取り込んでいないもの (構造的に直接 import 不可)

- **irType** (`src/pages/personal/devices/wifi-module/ir/ir-type-list/index.js`): MUI/JSX
  コンポーネントのため import 不可。ただし中身は **5 種のみ** (air 0xc000 / tv 0x2000 /
  light 0xe000 / fan 0x8000 / learn) で、`src/crypto.js` の `IR_TYPE` に出所コメント付きで全て保持済み。
  **重要**: `learn` は ir-type-list の UI 値 `0xfeff` ではなく **実 type `0xfe00`** が正
  (`.../ir/learn/index.js:142` で保存時 `type: 0xfe00` を確認)。JSX をそのまま写すと learn が
  バグるため、手書き保持が結果的に正しい。
- **lockModelDevices** (`gUtils.js`): gConfig 等に依存するため import 不可。
  `src/config.js` の `LOCK_MODELS` に biz3 の14機種をコメント付きで手書き保持。
- **wsUrl** (`env_config.js`): biz3 は `/public` だが元実装が実機で疎通したのは
  `/production`。対立があり直接採用しないため取り込まない (config.js のコメント参照)。

ライセンスは CANDY HOUSE MIT (リポルートの `LICENSE.biz3`)。
