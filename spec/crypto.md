<!-- spec-domain: crypto | prefix: CRY | tests: packages/core/tests/crypto, packages/core/tests/sigv4 -->

# 暗号プリミティブ KAT spec (CRY)

暗号プリミティブ(AES-CMAC/ECDH/SRP math/HKDF/SigV4 canonical/UUID・履歴整形)を**固定入力→固定出力の既知応答ベクタ(KAT)**として監査する。認証フロー内での使用は auth.md(AUTH)、ここはフローから切り離した KAT に限定し二重起票しない。

## aes-cmac

### [CRY-0001] aesCmac RFC 4493 §4 全既知応答ベクタ(Example 1-4 / K1・K2 経路網羅)
- surface: core
- backend: local
- command: `aesCmac`
- branch: len=0(空, K2) | len=16(完全1ブロック, K1) | len=40(不完全最終, K2 パディング) | len=64(完全4ブロック, K1)
- assert: 共通鍵 K=2b7e1516…4f3c と RFC 4493 §4 の M64 に対し aesCmac の出力が Example1(空)=bb1d6929e95937287fa37d129b756746, Example2(16B)=070a16b46b4d4144f79bdd9dd04a287c, Example3(40B)=dfa66747de9ae63030ca32611497c827, Example4(64B)=51f0bebf7e3b9d92fc49741779363cfe と一致する。len<16/40 の不完全最終ブロックは M_last=(M_n||0x80||0…)^K2、len%16==0 完全経路は M_last=M_n^K1、IV=0 の AES-128-CBC 最終ブロックが MAC。kit は 16B フル MAC を返す(RFC4493 フル値で検証)一方、biz3 references_web/src/utils/Cmac.js:139 の aesCmac は uint8ArrayToHexString(result).substring(0,8) で先頭4B(8hex)に切り詰めるため、biz3 との等価性は『先頭4B』に限定される(cmacTime 経路でのみ完全一致)
- ref: packages/core/src/aes-cmac.js:44-84; packages/core/src/aes-cmac.js:22-37; references_web/src/utils/Cmac.js:139; packages/core/tests/crypto/aes-cmac.test.js:22-45
- kind: crypto-vector
- status: planned
- note: 検証済(実測 4 ベクタ一致)。aes-cmac.js:22-37 が subkey 生成 (L=AES(K,0^128)→dbl で K1/K2, dbl は左1bit シフト+MSB 立ちで RB=0x87 XOR), :44-84 が aesCmac 本体 (n=max(1,ceil(len/16)), head=n-1 ブロック, last=完全→^K1/不完全→0x80 パディング^K2, IV=0 CBC で (head||last) を流し最終暗号ブロック=MAC)。test:22-45 が Example1-4。biz3 references_web/src/utils/Cmac.js:112-140 も同 RFC4493 (subkey 27-41) を Web Crypto 上で実装。RFC 4493 Figure 2 逐次 AES と CBC 連鎖が等価。【v2 追補】biz3 一致主張の scope を assert 本文へ昇格: Cmac.js:139 `return uint8ArrayToHexString(result).substring(0, 8)` で biz3 aesCmac は 4B(8hex)のみ返すため、kit の 16B フル MAC(aes-cmac.js:83)とは先頭4Bのみ等価。CMAC フル KAT は RFC4493 内部出典で担保(実装バグではない)。

### [CRY-0002] aesCmac 戻り値型・入力非破壊・Uint8Array 受理の境界
- surface: core
- backend: local
- command: `aesCmac`
- branch: Buffer 入力 | Uint8Array 入力 | 入力非破壊
- assert: 戻り値は常に 16B Buffer (旧 node-aes-cmac の hex/Buffer 揺れを排除)。Uint8Array 入力でも Buffer と同一 MAC (070a16b4…)。入力メッセージは XOR で in-place 破壊されない
- ref: packages/core/src/aes-cmac.js:44-52; packages/core/src/aes-cmac.js:70-71; packages/core/tests/crypto/aes-cmac.test.js:47-71
- kind: crypto-vector
- status: planned
- note: 検証済 (Uint8Array 入力で 070a16b4…4a287c 一致を実測)。:44-52 が署名+key/msg 正規化 (Buffer/Uint8Array→Buffer), :70-71 が last=Buffer.from(msg.subarray(...)) コピーで原 msg を保護する K1 経路。test:47-71 が「16B Buffer 戻り(47-51)/Uint8Array 同一 MAC(53-56)/非破壊(67-71)」を網羅。MAC バイト列でなく契約(型・非破壊)の固定。

### [CRY-0003] aesCmac 鍵長/非バイト列メッセージの明示エラー
- surface: core
- backend: local
- command: `aesCmac`
- branch: key≠16B | key 非バイト列 | message 非バイト列
- assert: 鍵が 15B/17B/文字列のとき /16-byte/ で throw、message が文字列のとき /Buffer/ で throw する。黙って誤 MAC を返さない
- ref: packages/core/src/aes-cmac.js:45-52; packages/core/tests/crypto/aes-cmac.test.js:58-65
- kind: crypto-vector
- status: planned
- note: 検証済。:45-48 が key 16B 検証 (throw "…16-byte Buffer…"), :49-52 が message Buffer/Uint8Array 検証 (throw "…Buffer/Uint8Array…")。test:58-65 が 15B/17B/文字列 key→/16-byte/, 文字列 msg→/Buffer/ を確認 (29 件 test 全 pass)。KAT 入力前提 (16B 鍵) の境界防壁。

## cmacTime

### [CRY-0004] cmacTime 時刻パッキング既知ベクタ (4B LE → 上位3B → CMAC[0..7])
- surface: core
- backend: local
- command: `cmacTime`
- branch: ts=1700000000 | ts=0(epoch) | 異なる鍵
- assert: ts=floor(Date.now()/1000) を 4B LE で書き subarray(1,4) の上位 3B を AES-CMAC した先頭 8 hex を返す。固定 ts・固定鍵で aesCmac 独立計算と一致 (ts=1700000000→b40bcb3c / ts=0→71d22718, key=0123…cdef ts=1234567890→a0c0ba15)。biz3 Cmac.cmacTime と同一手順 (setUint32 LE→slice(1,4)→aesCmac→substring(0,8))
- ref: packages/core/src/crypto.js:55-73; references_web/src/utils/Cmac.js:142-149; packages/core/tests/crypto/cmacTime.test.js:194-216
- kind: crypto-vector
- status: planned
- note: 検証済 (独立計算スライス: ts=1700000000→b40bcb3c, ts=0→71d22718, key0123…cdef/ts=1234567890→a0c0ba15)。crypto.js:55-73 が cmacTime 全体 (writeUInt32LE→subarray(1,4)→aesCmac→slice(0,8))。Cmac.js:142-149 が biz3 cmacTime (setUint32(0,date,true) LE→slice(1,4)→aesCmac, 8hex 切詰は biz3 側 aesCmac 内 substring(0,8) だが出力 8hex=先頭4B は同一→同型)。test:194-216 が「aesCmac 独立計算と一致」3 ケース。フェイクタイマで ts 固定し決定的ベクタ化。

### [CRY-0005] cmacTime 256秒粒度 (上位3B採用) の境界
- surface: core
- backend: local
- command: `cmacTime`
- branch: +255s(同値) | +256s(変化) | 同時刻反復(決定的)
- assert: 上位 3B = floor(ts/256) 相当のため 256s 境界をまたがない限り署名不変。+255s で同値、+256s で変化、同時刻反復で決定的に同値となる
- ref: packages/core/src/crypto.js:66-72; packages/core/tests/crypto/cmacTime.test.js:112-157
- kind: crypto-vector
- status: planned
- note: LE で index0 が最下位なので subarray(1,4) が ts>>8 に相当。256s 粒度の固定。【監査訂正】ref を 121-157→112-157 に拡張: branch の '同時刻反復(決定的)' を支える deterministic-repeat テスト (it '同じ時刻なら…' ) は cmacTime.test.js:112-119 にあり、旧範囲 121-157 (+255s/+256s/+1s のみ) では未カバーだった。crypto.js:66-72 と aesCmac 独立計算一致は :194-216 でも担保。74/74 テスト pass で実証。

### [CRY-0006] cmacTime 戻り値フォーマット・鍵正規化・鍵長エラー
- surface: core
- backend: local
- command: `cmacTime`
- branch: 8hex 形式 | 大文字/小文字 hex 同値 | 非32hex/非文字列 throw
- assert: 戻り値は常に /^[0-9a-f]{8}$/。大文字 hex 鍵と小文字 hex 鍵で同一署名 (Buffer.from('hex') が両受理)。32文字でない/非hex/非文字列 secretKey は /secretKey must be a 32-char hex string/ で throw しエラー文に length を含む
- ref: packages/core/src/crypto.js:56-65; packages/core/src/crypto.js:72; packages/core/tests/crypto/cmacTime.test.js:47-107; packages/core/tests/crypto/cmacTime.test.js:183-188
- kind: crypto-vector
- status: planned
- note: 16B(32hex) secretKey 前提の入力境界。biz3 は web crypto で同等の鍵 import。【監査確認】全 ref 実在・支持確認: crypto.js:56-65 が型/長さ/非hex の 3 ガード (エラー文に length 含む), :72 が slice(0,8) 8hex 出力。test:47-107 = 入力バリデーション(47-86, length=31 検証は 82-85) + 戻り値フォーマット(88-107)。test:183-188 = 大文字/小文字 hex 同値テスト。実テスト pass で実証。

## uuid-history

### [CRY-0007] uuidToHistoryBase64 prefix+16B → base64 既知ベクタ
- surface: core
- backend: local
- command: `uuidToHistoryBase64`
- branch: default prefix 000c | custom prefix(0001/ffff/空) | ハイフン有無
- assert: (prefix bytes ++ uuid 16B) を base64 化。default '000c' で 18B→24文字、decode 先頭 2B が 0x00 0x0c、残り 16B が uuid バイト列に一致。ハイフン有無・大小で同値。biz3 uuidBuffer と一致
- ref: packages/core/src/crypto.js:126-133; references_web/src/utils/biz3utils.js:455-459; packages/core/tests/crypto/uuidToHistoryBase64.test.js:21-105
- kind: crypto-vector
- status: planned
- note: biz3 utils.uuidBuffer(uuid,prefix='000c') の 1:1 移植。history フィールド (biz3TriggerLocker) に乗る整形。【監査確認】全 ref 実在・支持確認: biz3utils.js:455-459 が uuidBuffer(prefix+uuid.replace→Buffer.from hex→base64) で crypto.js:126-133 と 1:1。test:21-105 が default/custom(0001/ffff/空)/ハイフン有無/大小/全0/全F/round-trip を網羅。実テスト pass で実証。

### [CRY-0008] uuidToHistoryBase64 長さ/型エラーと非hex打ち切り挙動の固定
- surface: core
- backend: local
- command: `uuidToHistoryBase64`
- branch: 非文字列 throw | 32hex以外 throw | 非hex文字は length のみ検証(打ち切り)
- assert: 非文字列で /uuid required \(string\)/、ハイフン除去後 32hex でないと /got len=N/ で throw。32文字だが非hex (z×32) は length チェックのみ通過し Buffer.from の打ち切りで prefix のみ出力 (現状挙動の回帰固定)
- ref: packages/core/src/crypto.js:127-132; packages/core/tests/crypto/uuidToHistoryBase64.test.js:107-168
- kind: crypto-vector
- status: planned
- note: 実装は hex 妥当性まで検証せず length のみ。Buffer.from(hex) 打ち切り挙動を明示固定。【監査確認】ref 実在・支持確認: crypto.js:127 (非文字列 throw 'uuid required (string)'), :129-131 (len!=32 throw 'got len='). test:107-151 = エラー系 (型/null/空/31/33/ハイフン除去後 len), test:153-168 = z×32 打ち切りで decoded[0]=0x00,decoded[1]=0x0c (prefix のみ)。ref 範囲 107-168 が両ブロックを正しく包含。実テスト pass で実証。

## normalize-uuid

### [CRY-0009] normalizeUuid ハイフン除去+小文字化の照合用正規化
- surface: core
- backend: local
- command: `normalizeUuid`
- branch: 大文字/小文字 × ハイフン有無 | 非文字列入力
- assert: s.replace(/-/g,'').toLowerCase() で 32文字小文字 hex を返す。大文字/小文字・ハイフン有無の 4 形態が同一値に正規化され比較一致。非文字列(null/undefined/数値)は '' を返す (空安全)
- ref: packages/core/src/crypto.js:153-155; packages/core/tests/crypto/normalizeUuid.test.js:23-66
- kind: crypto-vector
- status: planned
- note: 純ローカル正規化 (照合・フィルタ用)。鍵導出用 raw hex には使わない (stripDashes 別実装)。client/lock/iot 等 14箇所の統合先。【監査確認】ref 実在・支持確認: crypto.js:153-155 が typeof === 'string' ? replace(/-/g,'').toLowerCase() : ''。test:23-49 = 正常系 (大小×ハイフン 4 形態同値, 空文字), test:51-66 = 空安全 (null/undefined/数値 → '')。ref 範囲 23-66 が両ブロックを包含。実テスト pass で実証。

## hex-to-uuid

### [CRY-0010] hexToUuid 32hex → 8-4-4-4-12 ダッシュ整形 (noHashtoUUID)
- surface: core
- backend: local
- command: `hexToUuid`
- branch: 32hex 正常 | 非32hex/非hex/空 throw | normalize 往復べき等
- assert: 32桁 hex を 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' 小文字に整形 (a0b1…8899→a0b1c2d3-e4f5-0011-2233-445566778899)。31/33/空/非hex は hexToBuf 経由で throw。SDK noHashtoUUID の substring(0..7)/(8..11)/… 区切りと一致
- ref: packages/core/src/crypto.js:228-231; _sesame_sdk_ref/app/src/main/java/co/utils/DataExtention.kt:29-37; packages/core/tests/crypto/normalizeUuid.test.js:68-112
- kind: crypto-vector
- status: planned
- note: DataExtention.kt:29-37 noHashtoUUID (32文字検証 + 8-4-4-4-12 区切り)。crypto.js コメントは 41-46 と記すが実体は 29-37。transport/wm2/hub3 の 3 重実装統合先。【監査確認】全 ref 実在・支持確認: DataExtention.kt:29-37 (app/co/utils) が length!=32 throw + substring(0..7)/(8..11)/(12..15)/(16..19)/(20..tmp) 区切りで assert を直接支持。crypto.js:218 コメントの '41-46' は別ファイル (sesame-sdk/.../utils/DataExtention.kt:41) を指しており、app/co/utils 版の実体は 29-37。test:68-112 = hexToUuid 正常系(KAT a0b1…→a0b1c2d3-… は 79-81)+異常系。実テスト pass で実証。

## is-uuid-v4

### [CRY-0011] isUuidV4 version/variant バイト判定 (byte6&0xf0==0x40, byte8&0xc0==0x80)
- surface: core
- backend: local
- command: `isUuidV4`
- branch: v4(true) | v1/全ゼロ(version≠0x40) | variant≠0x80 | 非16B | falsy
- assert: 16B に正規化後 byte[6]&0xf0===0x40 かつ byte[8]&0xc0===0x80 のみ true。v4(550e8400-…-41d4-a716-…)=true、v1(…11d4…)/全ゼロ=false、variant 7716=false、非16B(deadbeef)/falsy(null/''/undefined)=false。biz3 isUUIDV4 と一致
- ref: packages/core/src/crypto.js:197-213; references_web/src/utils/biz3utils.js:435-453; _sesame_sdk_ref/app/src/main/java/co/utils/DataExtention.kt:38-60; packages/core/tests/crypto/isUuidV4.test.js:38-90
- kind: crypto-vector
- status: planned
- note: biz3utils.js:435-453 の 1:1 移植。文字列はハイフン除去後 Buffer.from(hex) 変換、Buffer/Uint8Array 直受理。【監査確認】全 ref 実在・支持確認: biz3utils.js:435-453 が isUUIDV4 (falsy→false, string→Buffer.from(replace hex), length!=16→false, byte[6]&0xf0===0x40 && byte[8]&0xc0===0x80) で crypto.js:197-213 と 1:1。test:38-90 が v4(str/hex/Buffer)/v1/全0/null/undefined/''/4B/7B/variant!=0x80 を網羅。実テスト pass で実証。【v2 追補】SDK Kotlin 一次出典 _sesame_sdk_ref/app/src/main/java/co/utils/DataExtention.kt:38-60 String.isUUIDv4() を ref 追加(DataExtention.kt:59 が byteArray[6].and(0xF0)==0x40 && byteArray[8].and(0xC0)==0x80 と同一バイト判定)。biz3(web)に加え SDK(Kotlin) ground truth でも移植忠実性を裏取り。

## generate-uuid

### [CRY-0012] generateUUID 大文字 v4 形式の契約
- surface: core
- backend: local
- command: `generateUUID`
- branch: 形式(8-4-4-4-12 大文字) | v4 version/variant | 一意性
- assert: randomUUID().toUpperCase() で大文字 v4 UUID を返す。形式 /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/ を満たし isUuidV4(出力)=true。biz3 generateUUID と同一の大文字化
- ref: packages/core/src/crypto.js:32-34; references_web/src/utils/biz3utils.js:269-280
- kind: crypto-vector
- status: planned
- note: 検証済: crypto.js:33 return randomUUID().toUpperCase()。biz3utils.js:271 も window.crypto.randomUUID().toUpperCase() (フォールバックも 4xxx/yxxx で v4 + toUpperCase, :273-279)。乱数出力なので固定ベクタ不可だが形式・v4 性・大文字化を契約ベクタとして固定 (keyUUID 形式一致のため)。

## format-passcode-id

### [CRY-0013] formatPasscodeID 各桁→2桁hex大文字 既知ベクタ
- surface: core
- backend: local
- command: `formatPasscodeID`
- branch: 文字列入力 | 数値入力(toString) | 空文字
- assert: 各桁を parseInt(d,10).toString(16) の 2 桁ゼロ詰め大文字で連結。'123'→'010203'、'0'→'00'、'9'→'09'、'0123456789'→'00010203040506070809'、数値 123→'010203'、''→''。biz3 formatPasscodeID と一致
- ref: packages/core/src/crypto.js:171-179; references_web/src/utils/biz3utils.js:262-267; packages/core/tests/crypto/formatPasscodeID.test.js:14-49
- kind: crypto-vector
- status: planned
- note: 検証済: crypto.js:175-178 は biz3utils.js:263-266 の 1:1 移植 (Array.from(String(p)).map(d=>('0'+parseInt(d,10).toString(16)).slice(-2)).join('').toUpperCase())。各桁を 10 進整数として読む点が固定。test:16-49 が全ベクタ ('123'→'010203' / '0'→'00' / '9'→'09' / '0123456789'→… / 数値 123 / '' ) を確認。

## ir-type

### [CRY-0014] IR_TYPE / parseIrType wire 値マッピングと解決の既知ベクタ
- surface: core
- backend: local
- command: `parseIrType / IR_TYPE`
- branch: 数値素通し | エイリアス(大小/trim) | 数値文字列 | 未知エイリアス throw | 非string/number throw
- assert: IR_TYPE={ac:0xc000,tv:0x2000,light:0xe000,fan:0x8000,learn:0xfe00} (frozen)。parseIrType は数値素通し、'ac'/'AC'/' tv '→wire値、'49152'→49152、未知 'fridge' は候補付きで throw、null/{} は /must be a string or number/。learn 実type は 0xFE00 (UI 値 0xFEFF ではない)
- ref: packages/core/src/crypto.js:261-290; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:137-142; references_web/src/api/useRemoteCtrl.js:228; packages/core/tests/crypto/parseIrType.test.js:5-48
- kind: crypto-vector
- status: planned
- note: 検証済: crypto.js:261-267 IR_TYPE (ac=0xc000/tv=0x2000/light=0xe000/fan=0x8000/learn=0xfe00, Object.freeze)、:281-290 parseIrType。プリセット値は ir-type-list/index.js:22-49 (メニュー値=実type, ただし learn メニュー値=0xfeff:46)。learn 実type 0xFE00 は learn/index.js:137-142 (model:'Learn', type:0xfe00)・useRemoteCtrl.js:228 (type===0xfe00) で確証。i18n エラーキー domain.crypto.unknownIrType は i18n/domain.js:114,229 に実在し 'Unknown irType "{value}"...({aliases})' で test:40-41 の /Unknown irType "fridge"/ と /ac, tv/ に一致。【ref 修正】旧 'references_web/src/api/learn/index.js:142' は未確認 (api/learn ディレクトリ不在)。正しい出典は references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:137-142。補助出典 references_web/src/api/useRemoteCtrl.js:228 も確認済。

## hex-codec

### [CRY-0015] hexToBuf 検証付き hex→Buffer デコードの境界
- surface: core
- backend: local
- command: `hexToBuf`
- branch: 偶数長正常 | 空文字(0B) | 奇数長 throw | 非hex throw | bytes 長不一致 throw
- assert: 偶数長 hex を Buffer に変換、''→0B。奇数長は /even-length/、非hex文字は /non-hex characters found/、{bytes:n} 指定でデコード後バイト長不一致は /expected n byte/ で throw。Buffer.from の黙った切り詰めを防ぐ
- ref: packages/core/src/crypto.js:89-104
- kind: crypto-vector
- status: planned
- note: 検証済 (local-contract): crypto.js:93-95 偶数長検証→/even-length/、:96-98 /^[0-9a-fA-F]*$/→/non-hex characters found/、:99 ''→0B、:100-102 {bytes} 不一致→`expected ${bytes} byte(s)`(/expected n byte/)。biometric/iot/transport/cli の 4+ 実装統合先 (P5-4/ARCH-08)。鍵/UUID デコードの入力健全性土台。

### [CRY-0016] bufToHex Buffer/Uint8Array→小文字hex と型エラー
- surface: core
- backend: local
- command: `bufToHex`
- branch: Buffer 入力 | Uint8Array 入力 | 非バイト列 throw
- assert: Buffer/Uint8Array を小文字 hex 文字列に変換 (SDK toHexString 相当)。非 Buffer/Uint8Array は /buf must be a Buffer\/Uint8Array/ で throw。hexToBuf との往復一致
- ref: packages/core/src/crypto.js:111-116
- kind: crypto-vector
- status: planned
- note: 検証済 (local-contract): crypto.js:112-114 が !Buffer.isBuffer && !(instanceof Uint8Array)→/buf must be a Buffer\/Uint8Array/、:115 Buffer.from(buf).toString('hex')(小文字)。hexToBuf(:89-104) の逆方向で往復一致。MAC/UUID バイト列の hex 表現固定。

## HKDF

### [CRY-0017] HKDF(SHA-256) 'Caldera Derived Key' 16B 導出が Hkdf.java の extract→expand と一致
- surface: core
- backend: local
- command: `computeHkdf (device-srp.js 内部) / srpPasswordSecrets`
- branch: -
- assert: 固定 ikm(=padHex(S)) と固定 salt(=padHex(u)) に対し PRK=HMAC-SHA256(salt, ikm)、OKM=HMAC-SHA256(PRK, 'Caldera Derived Key' || 0x01)[0..15] が Hkdf.java の init(extract)+deriveKey(T_1=mac(info||1))(expand) と一致する固定 KAT。length=16<=macLen のため 1 ブロックで完結する境界。
- ref: packages/core/src/device-srp.js:148-152; packages/core/src/device-srp.js:127; _aws_sdk_ref/Hkdf.java:64-86; _aws_sdk_ref/Hkdf.java:146-181; _aws_sdk_ref/CognitoUser.java:4093-4095
- kind: crypto-vector
- status: planned
- note: 検証済: device-srp.js:149 PRK=createHmac(sha256,salt).update(ikm)、:150 INFO_BITS||[1]、:151 subarray(0,16)。:127 INFO_BITS='Caldera Derived Key'。Hkdf.java:75-76 extract (realSalt 鍵で ikm を doFinal=PRK)、:164-174 deriveKey ループ(t||info||i)、length=16<=32(macLen) で i=1 のみ=1 ブロック。salt 空時 0 埋め分岐 (Hkdf.java:70-73) は padHex(u) 非空のため非該当。CognitoUser.java:4093-4094 hkdf.init(s.toByteArray(),u.toByteArray())+deriveKey(DERIVED_KEY_INFO,DERIVED_KEY_SIZE)。DERIVED_KEY_INFO/SIZE は CognitoUser.java:4026-4027。フロー非依存の純 KAT (in-flow 利用は auth.md AUTH-0027)。

### [CRY-0018] HKDF k = H(N,g)(SRP-6a 乗数 K)が padHex(N)||padHex(g) の SHA-256 で Java の KK と一致する固定値
- surface: core
- backend: local
- command: `__srpTest.K (device-srp.js)`
- branch: -
- assert: K = SHA-256(padHex(N) || padHex(G)) を BigInt 化した固定値が、Java AuthenticationHelper の KK = H(N.toByteArray() || G.toByteArray()) とバイト等価である(3072-bit group・G=2 固定の派生定数 KAT)。
- ref: packages/core/src/device-srp.js:124; packages/core/src/device-srp.js:86-91; _aws_sdk_ref/CognitoUser.java:4042-4058
- kind: crypto-vector
- status: planned
- note: 検証済: device-srp.js:124 K=BigInt('0x'+hexHash(padHex(N)+padHex(G)))。padHex(:86-91) は先頭高ビット時 '00' 前置で Java の toByteArray() 符号バイトと等価。CognitoUser.java:4052-4054 static ブロックが md.update(N.toByteArray()).digest(GG.toByteArray()) → KK=new BigInteger(1, digest)。N_HEX(device-srp.js:24-40)=CognitoUser.java:4005 HEX_N と同一 (3072-bit, G=2)。純定数 KAT。

## SRP

### [CRY-0019] SRP-6a x = H(padHex(salt) || H(firstId secondId ':' password)) の固定ベクタ計算
- surface: core
- backend: local
- command: `srpPasswordSecrets`
- branch: -
- assert: 固定 (firstId, secondId, password, salt) に対し passwordHash=SHA-256('{firstId}{secondId}:{password}')、x=SHA-256(padHex(salt) || passwordHash) を BigInt 化した値が、getPasswordAuthenticationKey の x=H(salt.toByteArray() | H(poolName|userId|':'|password)) とバイト等価である固定 KAT。
- ref: packages/core/src/device-srp.js:206-207; _aws_sdk_ref/CognitoUser.java:4074-4083; _aws_sdk_ref/CognitoDeviceHelper.java:400-404
- kind: crypto-vector
- status: planned
- note: 検証済: device-srp.js:206 passwordHash=sha256Hex(`${firstId}${secondId}:${password}`)、:207 x=BigInt(hexHash(padHex(salt)+passwordHash))。AWS CognitoUser.java:4076-4079 update(poolName)(userId)(':')+digest(password)=userIdHash、:4082-4083 update(salt.toByteArray())+digest(userIdHash)=x。CognitoDeviceHelper.java:400-404 getUserIdHash も同連結 poolName|userName|':'|password。inner-hash は 64hex=32B 固定なので Buffer 連結が Java バイト並びと一致(device-srp.js:181-185 の根拠)。行番号ズレ無し。in-flow SRP は auth.md。

### [CRY-0020] SRP-6a u = H(padHex(A) || padHex(B)) の固定ベクタ計算
- surface: core
- backend: local
- command: `calculateU (__srpTest 経由) / srpPasswordSecrets`
- branch: -
- assert: 固定 (A, B) に対し u = SHA-256(padHex(A) || padHex(B)) を BigInt 化した値が、getPasswordAuthenticationKey の u = H(A.toByteArray() | B.toByteArray()) とバイト等価である固定 KAT(u≠0 ガードは別 ID)。
- ref: packages/core/src/device-srp.js:138-140; _aws_sdk_ref/CognitoUser.java:4066-4069
- kind: crypto-vector
- status: planned
- note: 検証済: device-srp.js:139 calculateU=BigInt('0x'+hexHash(padHex(A)+padHex(B)))。AWS CognitoUser.java:4067-4069 update(A.toByteArray())+digest(B.toByteArray())=u。padHex(device-srp.js:86-91)の符号バイト規約(高位ビット時 00 前置)が toByteArray() と等価。calculateU は __srpTest(device-srp.js:280)で export 済(確認済)。u==0 throw は auth.md AUTH-0058(error-path)。行番号ズレ無し。

### [CRY-0021] SRP-6a S = (B - k·g^x)^(a + u·x) mod N の固定ベクタ計算(クライアント共有秘密)
- surface: core
- backend: local
- command: `srpPasswordSecrets`
- branch: -
- assert: 固定 (firstId, secondId, password, B, salt, a, A) に対し x/u/g^x を導出した上で S=(B - K·g^x)^(a + u·x) mod N(負値は modPow 内で正規化)を返す sValue が、getPasswordAuthenticationKey の s 計算と数式・バイト等価である固定 KAT。
- ref: packages/core/src/device-srp.js:206-216; packages/core/src/device-srp.js:52-61; _aws_sdk_ref/CognitoUser.java:4084-4085
- kind: crypto-vector
- status: planned
- note: 検証済: device-srp.js:208 gModPowXN=modPow(G,x,N)、:210 base=serverB-K*gModPowXN、:211 sValue=modPow(base,a+U*x,N)、:212-215 hkdf。modPow(:52-61)が負 base を ((base%mod)+mod)%mod で正規化し Java の .mod(N) と一致。AWS CognitoUser.java:4084-4085 s=(B.subtract(KK.multiply(GG.modPow(x,N))).modPow(a.add(u.multiply(x)),N)).mod(N)。sValue は __srpTest サーバ役シミュレーションで検証可能。純 KAT。行番号ズレ無し。

### [CRY-0022] device SRP verifier = g^x mod N (3072-bit) の固定 salt/password ベクタ
- surface: core
- backend: local
- command: `generateDeviceVerifier (verifier 数式) / calcVerifier 相当`
- branch: salt 先頭 0x00(<16B) | salt 先頭 0x80(17B)
- assert: 固定 (deviceGroupKey, deviceKey, devicePassword, salt) に対し fullHash=SHA-256('{group}{key}:{password}')、x=SHA-256(padHex(salt)||fullHash)、verifier=g^x mod N を base64 化した値が、CognitoDeviceHelper.deviceSRP.calcVerifier (verifier=GG.modPow(x,N)) と数式等価である固定 KAT(salt の符号バイト分岐で 15/16/17B を決定的に検証)。
- ref: packages/core/src/device-srp.js:102-115; _aws_sdk_ref/CognitoDeviceHelper.java:370-391; _aws_sdk_ref/CognitoDeviceHelper.java:347-373
- kind: crypto-vector
- status: planned
- note: 検証済: device-srp.js:104 fullHash、:107 x=BigInt(hexHash(saltHex+fullHash))、:108 verifierHex=padHex(modPow(G,x,N))、:112 base64。randomBytes 固定注入(device-srp.test.js が node:crypto を部分モック)で salt/verifier は決定的 KAT。AWS CognitoDeviceHelper.java:370-375 deviceSRP コンストラクタ、:383-391 calcVerifier=update(salt)+update(userIdHash)→x→GG.modPow(x,N)。SALT_LENGTH_BITS=128(:347)・BigInteger(128,rand)(:373)。salt 符号バイト分岐を実機検証: 16B 高位ビット salt→padHex 17B、16B 低位/15B→16B(padHex:86-91 と一致確認)。in-flow ConfirmDevice 同型主張は auth.md AUTH-0035(本 ID は固定 salt の x/verifier 数式 KAT に限定)。行番号ズレ無し。

### [CRY-0023] PASSWORD_CLAIM_SIGNATURE = HMAC-SHA256(hkdf, id1|id2|secretBlock|timestamp) の固定ゴールデン署名 KAT
- surface: core
- backend: local
- command: `devicePasswordSignature / respondToPasswordVerifier 署名コア`
- branch: user(poolName|userId) | device(deviceGroupKey|deviceKey)
- assert: 固定 (poolName/group, userId/key, password, salt, B, secretBlock, timestamp, 固定 a/A) から導出した hkdf を鍵に HMAC-SHA256(hkdf, id1 || id2 || base64decode(secretBlock) || timestamp) を base64 化した署名が、独立再実装のゴールデン値とバイト一致する固定 M1 相当 KAT(1bit 差で実機ログイン不能)。
- ref: packages/core/src/device-srp.js:260-268; packages/core/src/auth.js:504-512; packages/core/tests/auth/user-srp-vector.test.js:58-60; _aws_sdk_ref/CognitoUser.java:3618-3633; _aws_sdk_ref/CognitoUser.java:3702-3714
- kind: crypto-vector
- status: planned
- note: 検証済(テスト 11 件 pass): device-srp.js:261-267 device 署名 HMAC(hkdf).update(group)(key)(b64decode secretBlock)(timestamp).digest('base64')。auth.js:507-512 user 署名 HMAC(hkdf).update(poolName)(userIdForSRP)(b64decode secretBlock)(timestamp)。user-srp-vector.test.js:59 GOLDEN_SIGNATURE='mvQ3Gy+v1fqNsbxv8tgnpjOfGqXfKOXYbV3XFzTqLGQ='(統合前独立再実装由来の固定アンカー)、実 assert は同ファイル:115 expect(...PASSWORD_CLAIM_SIGNATURE).toBe(GOLDEN_SIGNATURE)。AWS user CognitoUser.java:3621-3633(poolId.split('_')[1]|userIdForSRP|secretBlock|date)、device:3702-3714(deviceGroupKey|deviceKey|secretBlock|date)。ChallengeResponses のキー集合/wire 形は auth.md AUTH-0012/AUTH-0026(本 ID は署名バイト KAT のみ、二重起票回避)。行番号ズレ無し。

## SigV4

### [CRY-0024] SigV4 canonical request 構築が IAM ListUsers 既知ベクタ(20150830T123600Z/AKIDEXAMPLE)と一致
- surface: core
- backend: local
- command: `signRequest (canonicalRequest)`
- branch: -
- assert: 固定 method/url/headers/body/date で生成した canonicalRequest が AWS General Reference IAM ListUsers 例の 6 行(METHOD/URI/query/canonicalHeaders/signedHeaders/payloadHash)と一致し、その SHA-256 hex が f536975d... と一致する固定 KAT。
- ref: packages/core/src/sigv4.js:202-211; packages/core/src/sigv4.js:72-101; packages/core/tests/sigv4/sigv4.test.js:53-71
- kind: crypto-vector
- status: planned
- note: 検証済(テスト pass): sigv4.js:203 payloadHash=sha256Hex(body??'')、:204-211 canonicalRequest=[method,canonicalUriOf(u.pathname),canonicalQueryOf,canonicalHeaders,signedHeaders,payloadHash].join('\n')。canonicalUriOf(:72-75)/canonicalQueryOf(:83-91)/canonicalHeaderValue(:98-101)、いずれも 72-101 内。sigv4.test.js:54-66 期待 6 行、:69 expect(sha256Hex(canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59')=AWS doc 転記。空ボディ sha256=e3b0c442...(test.js:27 EMPTY_SHA256)、固定鍵 AKIDEXAMPLE(test.js:23)。純ローカル KAT(date 注入口あり)。行番号ズレ無し。

### [CRY-0025] SigV4 string-to-sign(AWS4-HMAC-SHA256\namzDate\nscope\ncreqHash)が ListUsers 既知ベクタと一致
- surface: core
- backend: local
- command: `signRequest (stringToSign)`
- branch: -
- assert: 固定入力で生成した stringToSign が 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/iam/aws4_request\nf536975d...' の 4 行と一致する固定 KAT(credentialScope=date/region/service/aws4_request の連結を含む)。
- ref: packages/core/src/sigv4.js:213-220; packages/core/src/sigv4.js:23; packages/core/tests/sigv4/sigv4.test.js:73-82
- kind: crypto-vector
- status: planned
- note: 検証済(テスト pass): sigv4.js:214 credentialScope=`${dateStamp}/${region}/${service}/aws4_request`、:215-220 stringToSign=[ALGORITHM,amzDate,credentialScope,sha256Hex(canonicalRequest)].join('\n')。ALGORITHM='AWS4-HMAC-SHA256'(:23)。sigv4.test.js:74-81 expect(stringToSign).toBe([...4 行...])=AWS doc 転記(:76-79)。純 KAT。行番号ズレ無し。

### [CRY-0026] SigV4 署名鍵導出 kSigning = HMAC連鎖(AWS4secret→date→region→service→aws4_request)が doc 掲載 hex と一致
- surface: core
- backend: local
- command: `deriveSigningKey`
- branch: -
- assert: 固定 (secretAccessKey, dateStamp=20150830, region=us-east-1, service=iam) で deriveSigningKey の 4 段 HMAC-SHA256 連鎖が doc 掲載の c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9 と一致する固定 KAT。
- ref: packages/core/src/sigv4.js:123-128; packages/core/tests/sigv4/sigv4.test.js:84-93
- kind: crypto-vector
- status: planned
- note: 確認済。sigv4.js:124-127 kDate=HMAC('AWS4'+secret,date)→kRegion→kService→HMAC(kService,'aws4_request') を実コードで確認。期待 hex は sigv4.test.js:92 で AWS doc 転記、deriveSigningKey は KAT 用に export 済(sigv4.js:118-123 JSDoc)。vitest 実行で test pass を確認。

### [CRY-0027] SigV4 最終 signature/Authorization が ListUsers 及び test-suite(get/post-vanilla)既知ベクタと一致
- surface: core
- backend: local
- command: `signRequest (signature, authorization)`
- branch: IAM ListUsers(出典A) | get-vanilla | post-vanilla(出典B)
- assert: 固定入力で signature=HMAC(signingKey, stringToSign) の hex が ListUsers=5d672d79..., get-vanilla=5fa00fa3..., post-vanilla=5da7c1a2... と一致し、Authorization='AWS4-HMAC-SHA256 Credential=.../scope, SignedHeaders=..., Signature=...' の組み立てが一致する固定 KAT。
- ref: packages/core/src/sigv4.js:229-243; packages/core/tests/sigv4/sigv4.test.js:95-178
- kind: crypto-vector
- status: planned
- note: 確認済。sigv4.js:229 signature=HMAC(signingKey).update(stringToSign).hex、:231-233 authorization 組立、:235-243 return を確認。期待値 ListUsers 5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7(test:96-97)、get-vanilla 5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31(test:142-144)、post-vanilla 5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b(test:174-176)。get/post-vanilla はテスト内独立 HMAC 連鎖(test:34-39 independentSignature)とも突き合わせ。AWS SigV4 test suite(service='service')相当。純 KAT。vitest pass 確認。

## ECDH

### [CRY-0028] ECDH P-256 raw 共有秘密(X 座標 32B)が NIST 既知ベクタと一致
- surface: core
- backend: local
- command: `ecdhSharedSecret / ecdhSecretPre16`
- branch: full(32B) | pre16(16B)
- assert: 固定 dA(秘密) と固定 QB(相手公開 X‖Y 64B)に対し ecdhSharedSecret の生出力(KDF 無し ECDH = 共有点 X 座標 32B)が NIST P-256 ベクタ Z=46fc6210...997bd7b と一致し、pre16 がその先頭 16B と一致する固定 KAT。
- ref: packages/core/src/crypto.js:421-448; packages/core/tests/crypto/ecdh.test.js:121-147; packages/core/src/crypto.js:386-419
- kind: crypto-vector
- status: planned
- note: 確認済。crypto.js:421-425 ecdhSharedSecret=computeSecret(toUncompressedPoint(remote))、:447-448 pre16=Buffer.from(...subarray(0,16)) の独立コピー、:386-409 toUncompressedPoint(64B raw に 0x04 前置)を実コード確認。NIST ベクタ dA=7d7dc5f7...、QBx=700c48f7...、QBy=db71e509...、Z=46fc62106420ff012e54a434fbdd2d25ccc5852060561e68040dd7778997bd7b(ecdh.test.js:127-130,137)。SDK 原典は _sesame_sdk_ref に実在: EccKey.kt:27-33 ecdh()=fixheader(DataExtention.kt:61 末尾0004)+remote 64B、CHHub3Device.kt:201 EccKey.ecdh(payload).sliceArray(0..15)=pre16。Node 04||64B computeSecret 等価を確認。OS3 register 配線の実機 token16 一致は別途(crypto.js:319-321 未検証注記)。vitest pass 確認。

## serverAuth

### [CRY-0029] register priKey = CMAC('Sesame2_key_pair',e) || CMAC(oneKey,e) の固定 e ゴールデン KAT
- surface: core
- backend: local
- command: `deriveRegisterPriKey`
- branch: -
- assert: 固定 e=00112233...eeff に対し oneKey=AES-CMAC('Sesame2_key_pair', e)、twoKey=AES-CMAC(oneKey, e)、priKey=oneKey||twoKey(32B)が c3f6cacdb3ef42b307e657c8f0d2af10c28dfcd64c076dccf9259652c91c8a18 と一致する固定 KAT(可変長 e 受理・空 e 明示エラーの境界含む)。
- ref: packages/core/src/crypto.js:604-625; packages/core/tests/crypto/serverauth.test.js:89-131; packages/core/src/aes-cmac.js:44-84; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHServerAuth.kt:43-50
- kind: crypto-vector
- status: planned
- note: 確認済: crypto.js:621 keyBytes='Sesame2_key_pair'、:622-624 oneKey/twoKey/concat を実コード確認。ゴールデン c3f6cacdb3ef42b307e657c8f0d2af10c28dfcd64c076dccf9259652c91c8a18(serverauth.test.js:94-96)。CMAC は内製 aes-cmac.js(RFC4493)。原典 CHServerAuth.kt は _sesame_sdk_ref/.../os2/CHServerAuth.kt に実在し、:43('Sesame2_key_pair')・:45-50(oneKey=AesCmac(keyBytes).computeMac(e), twoKey=AesCmac(oneKey).computeMac(e), priKey=oneKey+twoKey)が本実装と完全一致。よって SDK ソースとの移植忠実性は照合済。残る未確認は実機(OS2)wire の priKey 由来 sig1/token16 のバイト一致のみ。純 KAT。vitest pass 確認。

### [CRY-0030] register sig1/pubkey/st が固定 (ak,n,e,serverToken) でゴールデンベクタと一致(ECDH+CMAC 合成 KAT)
- surface: core
- backend: local
- command: `getRegisterKey`
- branch: serverToken 注入(決定) | 省略(4B 乱数)
- assert: 固定 (ak,n,e,serverToken=deadbeef) に対し pubkey=priKey の P-256 公開鍵 X‖Y(64B, prefix 無し)、secret=ECDH(priKey, SERVER_AUTH_PUBKEY)[0..15]、sig1=AES-CMAC(secret, b64decode(ak)||serverToken||b64decode(n))[0..3] が {sig1:'1xo/Zw==', st:'3q2+7w==', pubkey:'wUSqynjp...'} とバイト一致する固定 KAT。
- ref: packages/core/src/crypto.js:655-725; packages/core/src/crypto.js:525-526; packages/core/tests/crypto/serverauth.test.js:133-175; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHServerAuth.kt:41-65
- kind: crypto-vector
- status: planned
- note: 確認済: crypto.js:681 priKey=deriveRegisterPriKey(e)、:689 pubkey=getPublicKey().subarray(1)(64B=SDK drop(27))、:693 secret=ecdhSecretPre16(ecdh,SERVER_AUTH_PUBKEY)、:707 sig1=aesCmac(secret,msg).subarray(0,4)、:709-713 return{sig1,st,pubkey} を実コード確認。getRegisterKey 本体は 655-725(候補の 655-790 は makeLocalRegisterServer:761-792 を含む過大範囲だったため 655-725 に修正)。SERVER_AUTH_PUBKEY(crypto.js:525-526)=04a040fcc7...。ゴールデン serverauth.test.js:136-142(sig1='1xo/Zw==', st='3q2+7w==', pubkey='wUSqynjpOdJC...')。CHServerAuth.kt:28-29 serverKey='04a040fcc7…' が SERVER_AUTH_PUBKEY と完全一致、:53 secret=ecdh.take(16)、:58 sessionToken=serverToken+decode(n)、:60 msg=decode(ak)+sessionToken、:62 sig1=...slice(0..3)、:138 drop(27) も本実装と一致。SDK ソース移植忠実性は照合済で、残る未確認は実機(OS2 SESAME2/3/4)register キャプチャによる sig1/pubkey wire バイト一致のみ。純 KAT。vitest pass 確認。

### [CRY-0031] register priKey スカラ境界 [1,n-1] 判定が P-256 位数で Node setPrivateKey と同一に倒れる KAT
- surface: core
- backend: local
- command: `assertValidP256Scalar`
- branch: s==0 | s==n | s==n+1 | s==0xFF..FF | s==1 | s==n-1
- assert: 32B priKey スカラ s が 0 もしくは n(P256_ORDER)以上のとき throw、1<=s<=n-1 で受理する境界が、Node createECDH('prime256v1').setPrivateKey の受理範囲(SDK JCA の [1,n-1])とビット境界で一致する固定 KAT(mod n 還元はしない)。
- ref: packages/core/src/crypto.js:585-594; packages/core/src/crypto.js:556-558; packages/core/tests/crypto/serverauth.test.js:237-279
- kind: crypto-vector
- status: planned
- note: 確認済。crypto.js:586-587 s=BigInt('0x'+hex)、s===0n||s>=P256_ORDER で throw を実コード確認。P256_ORDER=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551(:556-558)。境界 0/n/n+1/0xFF..FF=拒否、1/n-1=受理(serverauth.test.js:240-278)、:265-277 で Node setPrivateKey と同境界に倒れることを直接突き合わせ。SDK JCA 経路の実測根拠は crypto.js:564-575 JSDoc(s==0→POINT_INFINITY, s==n→not invertible, s>n→InvalidKeyException [1,n-1]; mod n 還元せず)。原典 priKeyToPubKey は CHServerAuth.kt:113-148 に実在(s=ecPrivateKey.s で multiply(G,s))。還元すると別鍵を生む退行のため不実施。純境界 KAT。vitest pass 確認。

## 監査追補 v2 (dual-audit)

### [CRY-0032] cognitoTimestamp 'EEE MMM d HH:mm:ss UTC yyyy' 固定書式 KAT (Java SimpleDateFormat バイト一致)
- surface: core
- backend: local
- command: `cognitoTimestamp`
- branch: 日<10 (非0詰め) | 時分秒0詰め | 月名/曜日名境界
- assert: cognitoTimestamp(固定 Date) が 'EEE MMM d HH:mm:ss UTC yyyy'(曜日3字/月名3字/日は0詰めしない/HH:mm:ss は0詰め/UTC/yyyy)を Java SimpleDateFormat('EEE MMM d HH:mm:ss z yyyy', Locale.US)+setTimeZone(UTC) とバイト一致する固定 KAT。PASSWORD_CLAIM_SIGNATURE の署名対象なので 1 文字差で実機ログイン不能(日<10 の非0詰めが Java 'd' と一致する境界が要)。
- ref: packages/core/src/device-srp.js:271-276; packages/core/tests/auth/user-srp-vector.test.js:60-113; _aws_sdk_ref/CognitoUser.java:3627-3631
- kind: crypto-vector
- status: planned
- note: missing-method 回復(作成時 API 障害で取りこぼし)。device-srp.js:271-276 cognitoTimestamp が WEEK_DAYS/MONTHS(:129-130)+getUTCDate(非0詰め)+p()で時分秒0詰め+'UTC'+getUTCFullYear。user-srp-vector.test.js:60,113 が FIXED_TIMESTAMP='Wed Mar 4 02:03:04 UTC 2026' を固定検証。固定入力→固定文字列の純 KAT なので CRY が正典。in-flow 用途(署名連結の timestamp 位置)は auth.md AUTH-0059 が flow 側で被覆(本 ID は固定書式 KAT に限定し二重起票回避)。

### [CRY-0033] SigV4 sessionToken(x-amz-security-token) 署名対象化 と canonicalQuery キー→値バイト順ソートの分岐 KAT
- surface: core
- backend: local
- command: `signRequest (canonicalRequest)`
- branch: sessionToken あり (x-amz-security-token を SignedHeaders/canonicalHeaders に含む) | sessionToken 無し | query 有 (キー→値バイト順ソート) | query 無
- assert: credentials.sessionToken 指定時に x-amz-security-token が小文字 header として canonicalHeaders/SignedHeaders に追加され署名対象になること、URLSearchParams が rfc3986Encode 後にキー→値バイト順ソートで canonicalQuery 化されることを、固定入力 KAT として検証する(Identity Pool 一時 credentials の署名境界)。
- ref: packages/core/src/sigv4.js:194; packages/core/src/sigv4.js:83-91; packages/core/src/sigv4.js:196-200
- kind: crypto-vector
- status: planned
- note: missing-branch 回復。sigv4.js:194 `if (credentials.sessionToken) headerMap['x-amz-security-token']=credentials.sessionToken` で security-token が署名対象に入り、:196-200 で signedHeaders/canonicalHeaders に組み込む。:83-91 canonicalQueryOf が rfc3986Encode 後にキー→値バイト順ソート。CRY-0024(ListUsers 単一ヘッダ集合, branch:-)はこの分岐を持たず欠落していた。flow 内 cloud 用途(Identity Pool 一時 credentials を使う署名)は auth.md AUTH-0078 が担当し、固定入力 KAT は本 ID に集約(README:75-76 境界に整合、AUTH-0078 は flow 用途へ縮約)。

### [CRY-0034] SRP-6a A = g^a mod N (A%N!=0 リトライ・3072-bit group G=2) の modPow 数式 KAT
- surface: core
- backend: local
- command: `generateEphemeralA / __srpTest.modPow`
- branch: 通常 | A%N==0 リトライ (理論境界)
- assert: 固定 a(テスト注入 or __srpTest.modPow 直接呼び)に対し A=modPow(G,a,N) が AuthenticationHelper の A=GG.modPow(a,N) と数式・バイト等価で、A.mod(N)==0 のときリトライする 3072-bit group(G=2) 契約。a=BigInt(randomBytes(128))%N の生成範囲も固定する。
- ref: packages/core/src/device-srp.js:158-165; _aws_sdk_ref/CognitoUser.java:3984-3988; _aws_sdk_ref/CognitoUser.java:4025
- kind: crypto-vector
- status: planned
- note: missing-method 回復。device-srp.js:158-165 generateEphemeralA は export 済の SRP プリミティブ(do{a=BigInt(randomBytes(128))%N; A=modPow(G,a,N)}while(A%N===0n))。CognitoUser.java:3984-3988 AuthenticationHelper ctor do{a=BigInteger(EPHEMERAL_KEY_LENGTH,SECURE_RANDOM).mod(N); A=GG.modPow(a,N)}while(A.mod(N)==ZERO) と同型(EPHEMERAL_KEY_LENGTH=1024, :4025)。CRY は x/u/S/verifier の KAT(CRY-0019..0022)を持つが A=g^a の modPow 数式 KAT が欠落していた。flow 値(SRP_A=A.toString(16) wire)は auth.md(spec/auth.md:69-75)が別境界で保持。乱数 a のため固定ベクタは __srpTest.modPow 直接呼びで a 固定して取得(別境界=二重起票回避)。
