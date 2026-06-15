<!-- spec-domain: sharekey | prefix: SK | tests: packages/core/tests/sharekey, packages/kit/tests/cli -->

# 鍵共有 spec (SK)

鍵共有 URL (ssm://) の解析/生成、locks add --from-url、ゲスト鍵/QR、guest 鍵 sentinel を監査する。

## buildShareKeyUrl (共有 URL 生成)

### [SK-0001] buildShareKeyUrl の URL 骨格 ssm://UI?t=sk&sk=&l=&n= が biz3 generateInviteGuestQRCodeByInfo と 1:1
- surface: core
- backend: local
- command: `buildShareKeyUrl`
- branch: -
- assert: 生成 URL のスキーム/ホスト(ssm://UI)・クエリのキー順と値 (t=sk 固定, sk=base64, l=, n=encodeURIComponent) が biz3utils.js:125-134 の params 組み立てと完全一致する。t/sk/l/n の 4 param を `&` 連結し baseURL='ssm://UI' (friend QR の 'ssm://UI/' と異なりスラッシュ無し)
- ref: packages/core/src/sharekey.js:98-105; references_web/src/utils/biz3utils.js:125-134; references_web/src/constants/qrType.js:2
- kind: wire-fidelity
- status: covered
- note: t は qrMode.QR_SESAMEKEY='sk' (qrType.js:2)。baseURL='ssm://UI' でクエリ前にスラッシュ無し。検証: sharekey.js:98-104 の params 配列順 (t=sk,sk=,l=,n=) +:105 return が biz3utils.js:125(sharedKey='sk')/126(baseURL)/128-133(params)/134(return) と一致。

### [SK-0002] buildShareKeyUrl の sk バイト列レイアウト deviceModel(1B)++secretKey(16B)++pubKey++keyIndex(2B)++deviceUUID → base64
- surface: core
- backend: local
- command: `buildShareKeyUrl`
- branch: -
- assert: keydata の hex 連結順 (deviceModelHex + secretKey + sesame2PublicKey + keyIndex + deviceUUID(ハイフン除去)) と Buffer.from(hex).toString('base64') が biz3utils.js:122-124 と一致し、先頭バイトが productType になる
- ref: packages/core/src/sharekey.js:68; packages/core/src/sharekey.js:84-90; references_web/src/utils/biz3utils.js:119-124
- kind: wire-fidelity
- status: covered
- note: deviceModelHex = productType.toString(16).padStart(2,'0') (sharekey.js:68 = biz3utils.js:120 parseInt(model,10).toString(16).padStart(2,'0'))。deviceUUID は replace(/-/g,'') でハイフン除去 (sharekey.js:89 = biz3utils.js:123)。検証: sharekey.js:84-89 keydata 連結順 / 90 littleKey = biz3utils.js:122-124 と一致確認。

### [SK-0003] buildShareKeyUrl deviceModel→productType 解決が biz3 modelNameByProductType 逆引きと一致
- surface: core
- backend: local
- command: `buildShareKeyUrl` / `crypto.productTypeFromModelName`
- branch: -
- assert: deviceModel 名 (例 sesame_5→5, sesame_6→20) が productTypeFromModelName の逆引きで biz3 generateInviteGuestQRCodeByInfo の model 解決 (Object.entries(modelName).find) と同じ productType 数値になる
- ref: packages/core/src/sharekey.js:62-68; packages/core/src/crypto.js:297-310; packages/core/src/vendor/biz3/constants/sesameDeviceModel.js:1-77; references_web/src/utils/biz3utils.js:119-120
- kind: wire-fidelity
- status: covered
- note: vendor sesameDeviceModel.js は欠番 (12,34) を含む。biz3 は productType→model の map を find で逆引き (biz3utils.js:119)、kit は反転 map (crypto.js:297-301 PRODUCT_TYPE) で引く。検証: sesame_5→5 (sesameDeviceModel.js:47), sesame_6→20 (sesameDeviceModel.js:61)。biz3 の modelName=modelNameByProductType (biz3utils.js:51)、kit も同 map を反転 (crypto.js:299) するため差分なし。

### [SK-0004] buildShareKeyUrl ゲスト共有(guestKeyId)指定時 sk の secretKey 位置を上書き
- surface: core
- backend: local
- command: `buildShareKeyUrl`
- branch: guestKeyId 指定 | owner/manager(secretKey)
- assert: opts.guestKeyId 指定時は keydata の secretKey 位置 (deviceModelHex 直後 16B) へ guestKeyId を差し込み、未指定時は deviceKey.secretKey を使う (guestKeyId || secretKey) — biz3utils.js:121 と 1:1
- ref: packages/core/src/sharekey.js:71; packages/core/src/sharekey.js:84-89; references_web/src/utils/biz3utils.js:121
- kind: option-branch
- status: covered
- note: load-bearing 行 sharekey.js:71 `const secretKey = guestKeyId || deviceKey.secretKey`。biz3utils.js:121 `const secretKey = guestInfo.guestKeyId || deviceKey.secretKey` と一致確認。parse 側は guestKeyId と secretKey を区別しないため round-trip で secretKey として復元される ([[SK-0017]])。CLI は level===2 のみ guestKeyId を発行 (packages/kit/src/cli/org.js:809-810)。

### [SK-0005] buildShareKeyUrl l= は opts.keyLevel のみ・n= は name||deviceName でフォールバック補完しない (両欠落で 'undefined')
- surface: core
- backend: local
- command: `buildShareKeyUrl`
- branch: keyLevel 未指定(l=undefined) | name 指定 | deviceName フォールバック | 両欠落(n=undefined)
- assert: l= には opts.keyLevel のみ埋め deviceKey.keyLevel へフォールバックしない (未指定で 'l=undefined')、n= は (name || deviceKey.deviceName) を encodeURIComponent で符号化し両欠落時 encodeURIComponent(undefined)='undefined' になる。`|| ''` 補完を足さず biz3utils.js:127,131,132 と 1:1
- ref: packages/core/src/sharekey.js:97; packages/core/src/sharekey.js:101-103; references_web/src/utils/biz3utils.js:127; references_web/src/utils/biz3utils.js:131; references_web/src/utils/biz3utils.js:132
- kind: wire-fidelity
- status: covered
- note: 参照に無いフォールバックを置かない忠実性 (BIZ-09)。displayName = name || deviceKey.deviceName (sharekey.js:97) = biz3 name = guestInfo.employeeName || deviceKey.deviceName (biz3utils.js:127)。l= は sharekey.js:101 `l=${keyLevel}` (opts のみ) = biz3utils.js:131、n= は sharekey.js:103 = biz3utils.js:132。呼び出し側 CLI は常に level を渡す (packages/kit/src/cli/org.js:813)。

### [SK-0006] buildShareKeyUrl 未知 deviceModel は badRequest(org.sharekey.unknownDeviceModel)
- surface: core
- backend: local
- command: `buildShareKeyUrl`
- branch: deviceKey 欠落(throw) | 未知 deviceModel(throw)
- assert: deviceKey 無しで badRequest('deviceKey required')、productTypeFromModelName が null/undefined を返す deviceModel では badRequest('org.sharekey.unknownDeviceModel', {model}) を throw する (biz3 は console.error+NaN で続行するが kit は throw に強化)
- ref: packages/core/src/sharekey.js:61; packages/core/src/sharekey.js:64-66; packages/core/src/i18n/org.js:4; packages/core/src/i18n/org.js:250; references_web/src/utils/biz3utils.js:119-120
- kind: error-path
- status: covered
- note: biz3utils.js:119-120 は find が undefined→parseInt(undefined)=NaN→'NaN'.padStart で壊れた hex を作るが kit は productType==null で明示 throw (sharekey.js:64-66)。deviceKey 自体が falsy のときは sharekey.js:61 で badRequest('deviceKey required')。i18n キー確認: org.js:4 (en), :250 (ja) 'org.sharekey.unknownDeviceModel'。{model} は {model:JSON.stringify(...)} で補間。

### [SK-0007] buildShareKeyUrl 必須 hex フィールド欠落は badRequest(org.sharekey.fieldRequired,{field})
- surface: core
- backend: local
- command: `buildShareKeyUrl`
- branch: secretKey欠落 | sesame2PublicKey欠落 | keyIndex欠落 | deviceUUID欠落
- assert: secretKey(guestKeyId未指定時)/sesame2PublicKey/keyIndex/deviceUUID のいずれか falsy で badRequest('org.sharekey.fieldRequired',{field}) を throw し、壊れた base64 鍵を生成しない
- ref: packages/core/src/sharekey.js:74-82; packages/core/src/i18n/org.js:5; packages/core/src/i18n/org.js:251
- kind: error-path
- status: covered
- note: 確認済: sharekey.js:74-79 で required={secretKey,sesame2PublicKey,keyIndex,deviceUUID} を組み、:80-82 のループで falsy 時に badRequest('org.sharekey.fieldRequired',{field:k})。secretKey は :71 で guestKeyId||deviceKey.secretKey。i18n org.js:5(en)/:251(ja) に 'org.sharekey.fieldRequired' が {field} 補間付きで存在。biz3 にはこの検証が無く (欠落のまま hex 連結=biz3utils.js:122-123) 壊れた鍵を共有しうる。kit が追加した安全弁。

## parseShareKeyUrl (共有 URL 解析)

### [SK-0008] parseShareKeyUrl OS3(productType-5>=0) の byte スライス secretKey16/pubKey4/keyIndex2/deviceUUID残り が readQrcode OS3 分岐と一致
- surface: core
- backend: local
- command: `parseShareKeyUrl`
- branch: OS3 (productType-5>=0)
- assert: isSesameOs3 true 分岐で data.slice(1,17)=secretKey, slice(17,21)=sesame2PublicKey(4B), slice(21,23)=keyIndex, slice(23..)=deviceUUID のレイアウトが biz3utils.js:180-183 と 1:1
- ref: packages/core/src/sharekey.js:133-137; references_web/src/utils/biz3utils.js:179-183; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:257
- kind: wire-fidelity
- status: covered
- note: 確認済: sharekey.js:133 if(isSesameOs3(productType)), :134 slice(1,1+16), :135 slice(1+16,1+16+4), :136 slice(1+16+4,1+16+4+2), :137 slice(1+16+4+2) が biz3utils.js:180-183 と byte 単位で一致。isSesameOs3 = productType-5>=0 (sharekey.js:42-44 = biz3utils.js:103-105)。OS3 では pubKey が 4B、deviceUUID は残り全部 (=16B)。negative-fact: kit/web は deviceUUID を開放端 slice(1+16+4+2) で取り残り全部を吸収する (sharekey.js:137, biz3utils.js:183) が、Android 移植元 ScanQRcodeFG.kt:257 は固定 16B keyData.sliceArray(23..38) (index 23..38 inclusive) で切り出す。正常 payload では両者 16B で一致するが、kit の開放端 slice は末尾余剰バイトを deviceUUID に取り込みうる点が Android (16B 固定切り出し) と異なる。kit は web 方式を採用 (BIZ-09)。

### [SK-0009] parseShareKeyUrl OS2(productType-5<0) の固定 byte スライス secretKey16/pubKey64/keyIndex2/deviceUUID16 が readQrcode else 分岐と一致
- surface: core
- backend: local
- command: `parseShareKeyUrl`
- branch: OS2 (productType-5<0)
- assert: isSesameOs3 false 分岐で data.slice(1,17)=secretKey, slice(17,81)=sesame2PublicKey(64B), slice(81,83)=keyIndex, slice(83,99)=deviceUUID の固定オフセットが biz3utils.js:197-200 と 1:1
- ref: packages/core/src/sharekey.js:138-143; references_web/src/utils/biz3utils.js:196-201
- kind: payload-fidelity
- status: covered
- note: 確認済: sharekey.js:138 else, :139 slice(1,17), :140 slice(17,81)=64B, :141 slice(81,83), :142 slice(83,99) が biz3utils.js:196-201 (else 分岐) と固定オフセット一致。OS2 系 (sesame_2 等) の publicKey は 64B 固定。OS3/OS2 で先頭バイト productType により解析レイアウトが分岐する境界 ([[SK-0014]])。

### [SK-0010] parseShareKeyUrl の sk base64 デコード規則と '+'→空白の復元 (biz3utils.js:173)
- surface: core
- backend: local
- command: `parseShareKeyUrl`
- branch: sk に空白(+化け) | 正常 base64
- assert: sk 値の ' '→'+' 置換後に Buffer.from(sk,'base64') した bytes が、biz3utils.js:173-175 (sk.replace(/ /g,'+') → Buffer.from(base64)) と一致する。第2 Buffer.from(.,'hex') は Buffer 入力で encoding 無視の no-op
- ref: packages/core/src/sharekey.js:126-129; references_web/src/utils/biz3utils.js:173-175; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:149
- kind: wire-fidelity
- status: covered
- note: 確認済: sharekey.js:126 sk=skRaw.replace(/ /g,'+'), :129 data=Buffer.from(sk,'base64')。biz3utils.js:173 sk.replace(/ /g,'+'), :174 msk=Buffer.from(sk,'base64'), :175 data=Buffer.from(msk,'hex')。biz3 は Buffer.from(Buffer.from(sk,'base64'),'hex') と二重化しているが第1引数 Buffer で encoding 無視→単純コピー。kit はこの no-op を排し base64 1回 (sharekey.js:127-128 コメント)。出力 bytes は同一。negative-fact: 同一の base64 '+' 問題への対処方向が web/kit と Android で逆。kit/web は parse 後に space→'+' を復元する (sharekey.js:126, biz3utils.js:173) が、Android 移植元 ScanQRcodeFG.kt:149 は parse 前に result.replace('+','%2B').toUri() で '+' を %2B エスケープして space 化を未然に防ぐ。kit は web の方向 (space→+) を採用。

### [SK-0011] parseShareKeyUrl deviceUUID の正規表現整形 + 大文字化 (8-4-4-4-12 ハイフン挿入)
- surface: core
- backend: local
- command: `parseShareKeyUrl`
- branch: -
- assert: deviceUUIDHex を /(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/→'$1-$2-$3-$4-$5' でハイフン整形し toUpperCase した形が biz3utils.js:184,192 と一致する
- ref: packages/core/src/sharekey.js:144-146; references_web/src/utils/biz3utils.js:184; references_web/src/utils/biz3utils.js:192; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:258; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:291
- kind: wire-fidelity
- status: covered
- note: 確認済: sharekey.js:144-145 で deviceUUIDHex.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/,'$1-$2-$3-$4-$5'), :146 .toUpperCase()。biz3utils.js:184 が同正規表現の replace、:192 が deviceUUID.toUpperCase()。build 側は逆に replace(/-/g,'') でハイフン除去 (sharekey.js:89) するため round-trip で大文字+ハイフン形に復元される。negative-fact: 2 つの移植元が大小文字で直接矛盾する。biz3 web は大文字化 (biz3utils.js:192 .toUpperCase()) だが Android 移植元は OS3 ScanQRcodeFG.kt:258 / OS2 :291 とも uuidStr=...toString().lowercase() と小文字で正規化する。kit は web 側 (大文字) を採用。この大小文字は下流の lock 照合に影響する境界 (locks add --from-url の保存値; isDeviceUuidLike は /i で大小文字無視だが、保存される正規化形が Android アプリ登録分と食い違う)。

### [SK-0012] parseShareKeyUrl の返却フィールド集合と各値の出所が readQrcode qrKeyInfo と一致 (keyLevel=parseInt(l) で NaN 維持)
- surface: core
- backend: local
- command: `parseShareKeyUrl`
- branch: l 数値 | l 欠落(NaN) | l 非数値(NaN)
- assert: 返却オブジェクトのキー集合 {secretKey,keyIndex,sesame2PublicKey,keyLevel,deviceModel,deviceName,deviceUUID} と各値の出所 (deviceModel=modelNameByProductType[productType]??null, deviceName=n 生値, keyLevel=parseInt(l,10)) が biz3utils.js:185-193 qrKeyInfo と 1:1。l 欠落(null)/非数値は biz3utils.js:189 と同じく NaN を返す (null へ倒さない)
- ref: packages/core/src/sharekey.js:148-157; references_web/src/utils/biz3utils.js:185-193
- kind: wire-fidelity
- status: covered
- note: 確認済: sharekey.js:148-156 return {secretKey,keyIndex,sesame2PublicKey, :153 keyLevel=parseInt(l,10), :154 deviceModel=modelNameByProductType[productType]??null, :155 deviceName=params.get('n'), :156 deviceUUID}。biz3utils.js:185-193 qrKeyInfo と同一キー集合・同一出所 (:189 parseInt(urlParams.get('l')) は radix 明示のみ差で NaN 挙動同一)。deviceModel 未知 productType で kit は ?? null へ倒す (biz3 :190 は undefined)。deviceName は n の生値 (URLSearchParams が %xx 復号)。

### [SK-0013] parseShareKeyUrl 入力検証: url falsy / sk param 欠落で throw
- surface: core
- backend: local
- command: `parseShareKeyUrl`
- branch: url falsy(throw) | sk param 欠落(throw)
- assert: url が falsy なら badRequest('url required')、sk クエリ欠落なら badRequest('sk param not found in url') を throw する。biz3 は sk 欠落で urlParams.get('sk').replace が TypeError になる箇所を明示 throw に強化。parseShareKeyUrl は t パラメータを一切検証せず sk の有無のみで分岐する (t=friend/matter の URL でも sk があれば share-key として解釈)
- ref: packages/core/src/sharekey.js:119; packages/core/src/sharekey.js:124; packages/core/src/sharekey.js:118-129; references_web/src/utils/biz3utils.js:172-173; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:153-161
- kind: error-path
- status: covered
- note: 確認済: sharekey.js:119 が url falsy→badRequest('url required'), :124 が sk 欠落→badRequest('sk param not found in url')。biz3utils.js:173 `urlParams.get('sk').replace(/ /g,'+')` は sk null で .replace 例外→catch(error)→call(error) (biz3utils.js:215-217)。kit は事前に badRequest で明示。? 位置の検出は indexOf('?') で QR 文字列/裸クエリ双方を受ける (sharekey.js:120-121)。negative-fact: kit は t を見ず sk の有無のみで分岐し (sharekey.js:118-129 は t 未参照)、これは biz3 web readQrcode が t を見ず sk のみ読む寛容さの 1:1 移植。一方 Android ScanQRcodeFG.kt:153-161 は when(type){friend/sk/else→qrcodeNotSupport} で t を厳格振り分けし未知 t (matter 含む) を拒否する。kit が web の t-寛容を採用 (Android の t 厳格分岐とは非対称) する点は意図的。matter type の未対応は [[SK-0018]]。

### [SK-0014] isSesameOs3 判定境界 (productType - 5 >= 0) が parse の sesame2PublicKey 長 (OS3=4B / OS2=64B) を分岐する
- surface: core
- backend: local
- command: `parseShareKeyUrl` / `isSesameOs3`
- branch: productType<5→OS2(64B) | productType>=5→OS3(4B)
- assert: isSesameOs3(productType)=productType-5>=0 が biz3utils.js:103-105 と一致し、parseShareKeyUrl のレイアウト分岐 (OS3 で pubkey 4B/deviceUUID 残り全部、OS2 で pubkey 64B/deviceUUID 16B 固定) を切り替える境界値 (sesame_5=5 が OS3 最小)
- ref: packages/core/src/sharekey.js:42-44; packages/core/src/sharekey.js:133; references_web/src/utils/biz3utils.js:103-105; packages/core/src/vendor/biz3/constants/sesameDeviceModel.js:47; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:217-234; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:252-291
- kind: option-branch
- status: covered
- note: 確認済: 境界値 productType=5 (sesame_5) が OS3 側、4 以下が OS2 側。sesameDeviceModel.js:47 modelNameByProductType の `5: sesame_5`。encode 側 (sharekey.js:84-89) は productType を直接 hex 化するだけで分岐しないが decode 側 (:133-142) のみ分岐するため非対称性も境界。biz3 isSesameOs3 def は 103-105 (103 宣言/104 return/105 閉)。negative-fact: 同じ byte レイアウト分岐を kit/web は数値しきい値 `productType-5>=0` (sharekey.js:42-44, biz3utils.js:103-105) で切り替えるが、真の移植元 Android ScanQRcodeFG.kt:219 は `if (devModel.isValidModel())` のモデル whitelist (:227-234 で SS5/BiKeLock2/SSMTouchPro/SS6 系を列挙) で handleValidModel(:252 pub=sliceArray(17..20)=4B) / handleInvalidModel(:288 pub=sliceArray(17..80)=64B) を切り替え、判定根拠が異なる。kit は biz3 web を宣言上の port 元とするため挙動自体は正しいが、差分が文書化されないと将来 isValidModel 方式へ寄せる再実装で破壊検知できない。CLAUDE.md の『認証は Android アプリ方式絶対』は auth 限定で sharekey には及ばない。

## round-trip (encode↔decode 対称)

### [SK-0015] buildShareKeyUrl→parseShareKeyUrl round-trip surface-parity (OS3 / OS2): 全フィールド復元
- surface: core
- backend: local
- command: `buildShareKeyUrl` / `parseShareKeyUrl`
- branch: OS3 owner/manager(l=0/1) | OS2
- assert: build した URL を parse すると secretKey/sesame2PublicKey/keyIndex/keyLevel/deviceModel/deviceName が一致し deviceUUID は入力が小文字/dash 付きでも大文字+ハイフン形へ正規化されて復元される (encode 大文字小文字/dash 正規化を含む round-trip)
- ref: packages/core/src/sharekey.js:60-106; packages/core/src/sharekey.js:118-158; references_web/src/utils/biz3utils.js:114-213
- kind: surface-parity
- status: covered
- note: 確認済: 純ローカル round-trip。build (sharekey.js:60-106) はハイフン除去 (:89)・小文字寄せ無し、parse (:118-158) は大文字+ハイフン整形 (:144-146)。deviceModel は productType 経由で modelNameByProductType により名前へ戻る (:154)。owner/manager は guestKeyId 未指定→deviceKey.secretKey をそのまま使う経路 (:71)。OS3 分岐は productType-5>=0 (:42-44)。

### [SK-0016] buildShareKeyUrl(guestKeyId)→parseShareKeyUrl round-trip で guestKeyId が secretKey 位置に復元される (guest l=2)
- surface: core
- backend: local
- command: `buildShareKeyUrl` / `parseShareKeyUrl`
- branch: guest(l=2, guestKeyId)
- assert: guestKeyId 指定で生成した URL を parse すると secretKey フィールドに guestKeyId が、keyLevel に 2 が入る (parse 側は guestKeyId と secretKey を区別せず sk バイト位置から復元する)
- ref: packages/core/src/sharekey.js:71; packages/core/src/sharekey.js:131-138; packages/core/src/sharekey.js:153; references_web/src/utils/biz3utils.js:121; references_web/src/utils/biz3utils.js:180; references_web/src/utils/biz3utils.js:189
- kind: wire-fidelity
- status: covered
- note: 確認済: sharekey.js:71 guestKeyId||secretKey 差し込み, :133-138 OS2/OS3 分岐, :153 keyLevel=parseInt(l)。biz3utils.js:121 guestKeyId 差し込み, :180 OS3 secretKey=slice(1,17), :189 keyLevel=parseInt(l)。guest 共有は CLI org keys share-url が generateGuestQR で発行した guestKeyId を渡す ([[SK-0020]])。core 単体では guestKeyId を secretKey 位置として round-trip する境界。command は bare 関数名表記に統一。

## friend QR (社員追加)

### [SK-0017] buildFriendQrUrl の wire ssm://UI/?t=friend&friend=<subUUID 大文字> + subUUID falsy で throw
- surface: core
- backend: local
- command: `buildFriendQrUrl`
- branch: subUUID 指定 | subUUID falsy(throw)
- assert: 生成 URL が `ssm://UI/?t=friend&friend=<subUUID.toUpperCase()>` でホスト末尾スラッシュ・t/friend キー・大文字化が biz3utils.js:107-112 と一致 (share-url の 'ssm://UI?' と異なりスラッシュ有り)。subUUID falsy で badRequest('sharekey.err.subUUIDRequired') を throw (biz3 は '' を返すが kit は throw に強化)
- ref: packages/core/src/sharekey.js:177-181; packages/core/src/i18n/sharekey.js:4; packages/core/src/i18n/sharekey.js:9; references_web/src/utils/biz3utils.js:107-112; references_web/src/constants/qrType.js:3
- kind: wire-fidelity
- status: covered
- note: 確認済: qrType.js:3 QR_FRIEND='friend'。sharekey.js:163 const QR_FRIEND='friend', :180 が `ssm://UI/?t=friend&friend=${subUUID.toUpperCase()}` で biz3utils.js:111 と 1:1。throw は sharekey.js:178、biz3utils.js:108-110 `if(!userSub) return ''` を明示 throw へ。i18n キー sharekey.err.subUUIDRequired は en(i18n/sharekey.js:4)/ja(:9) 同文 'subUUID required'。share-key URL は baseURL 'ssm://UI' (スラッシュ無し) だが friend は 'ssm://UI/' (スラッシュ有り)。toUpperCase は冪等。

### [SK-0018] parseFriendQrUrl の wire: friendID を小文字で返す / t!=='friend' または friend 欠落で throw
- surface: core
- backend: local
- command: `parseFriendQrUrl`
- branch: t=friend & friend 有り(成功) | t=sk/t=matter(throw) | friend 欠落(throw) | url falsy(throw)
- assert: t==='friend' かつ friend 有りで {friendID: friend.toLowerCase()} を返す (readUserQrcode の call(null,{friendID:friendUUID.toLowerCase()}) biz3utils.js:157-159 と一致)。t!=='friend' または friend 欠落で badRequest('sharekey.err.invalidFriendQr')、url falsy で badRequest('sharekey.err.friendQrUrlRequired') を throw (biz3 の call(null) 解析失敗を throw 化)。kit は sk/friend の 2 関数のみ提供し matter QR (qrType.js:4 QR_MATTER='matter') を扱わない
- ref: packages/core/src/sharekey.js:195-207; packages/core/src/sharekey.js:203-204; packages/core/src/i18n/sharekey.js:5; packages/core/src/i18n/sharekey.js:6; references_web/src/utils/biz3utils.js:151-159; references_web/src/constants/qrType.js:4; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:153-161
- kind: wire-fidelity
- status: covered
- note: 確認済: sharekey.js:196 url falsy→friendQrUrlRequired, :203-204 `if(type!==QR_FRIEND||!friendUUID) throw invalidFriendQr`, :207 `return {friendID: friendUUID.toLowerCase()}`。biz3utils.js:151 type 取得/:153 type!==QR_FRIEND||!friendUUID→call(null)(UI で snackbar 'QRコードが正しいか確認' AddEmployee.js:395-399)/:158 friendID:friendUUID.toLowerCase()。i18n キーは i18n/sharekey.js:5(friendQrUrlRequired),:6(invalidFriendQr)。build は大文字生成・parse は小文字返却で round-trip すると入力 subUUID の小文字形になる。AddEmployee 上位経路は ORG-0014 (spec/org.md:153)。negative-fact: qrType.js:4 で QR_MATTER='matter' が第一級 type として実在し Android ScanQRcodeFG.kt:153-161 は when(type){friend/sk/else→qrcodeNotSupport} で matter 含む未知 t を明示拒否するが、kit には matter 解析関数が無く意図的に sk/friend の 2 関数のみ。parseFriendQrUrl に matter を渡すと invalidFriendQr throw (sharekey.js:203-204)。t-寛容な share-key 側は [[SK-0013]]。

## i18n

### [SK-0019] sharekey エラーカタログ完全性: friend QR (sharekey.err.*) + share URL (org.sharekey.*) キーが en/ja で揃う
- surface: core
- backend: local
- command: `buildFriendQrUrl` / `parseFriendQrUrl` / `buildShareKeyUrl`
- branch: en | ja
- assert: sharekey.js が throw する全 i18n キー (sharekey.err.subUUIDRequired/friendQrUrlRequired/invalidFriendQr は i18n/sharekey.js、org.sharekey.unknownDeviceModel/fieldRequired は i18n/org.js) が en/ja 両方に存在し変数プレースホルダ ({model}/{field}) が一致する
- ref: packages/core/src/i18n/sharekey.js:1-13; packages/core/src/i18n/org.js:3-5; packages/core/src/i18n/org.js:249-251; packages/core/src/sharekey.js:65; packages/core/src/sharekey.js:81; packages/core/src/sharekey.js:178; packages/core/src/sharekey.js:196; packages/core/src/sharekey.js:204
- kind: i18n
- status: covered
- note: 確認済: throw 箇所は sharekey.js:65(org.sharekey.unknownDeviceModel),:81(org.sharekey.fieldRequired),:178(sharekey.err.subUUIDRequired),:196(sharekey.err.friendQrUrlRequired),:204(sharekey.err.invalidFriendQr)。i18n/sharekey.js は friend QR 3 キーを en(:3-7)/ja(:8-12) で定義、i18n/org.js は org.sharekey.* 2 キーを en(:4-5)/ja(:250-251) で定義。build 系エラーは org 名前空間、friend QR は sharekey 名前空間に分かれる点に注意。両カタログを横断検証。{model}/{field} プレースホルダは org.js en/ja で一致。i18n カタログ完全性 (実値): friend QR 3 キーのうち subUUIDRequired (i18n/sharekey.js:4,9='subUUID required') と friendQrUrlRequired (:5,10='friendQrUrl required') は en/ja 同文 (英語のまま未翻訳的)、invalidFriendQr のみ en(:6)/ja(:11) で別翻訳。キー集合一致は成立するが、同文/翻訳差の着眼を補強。

## CLI (org keys share-url / locks add --from-url)

### [SK-0020] sesame org keys share-url の出力封筒 surface-parity: human は URL(+任意 QR)、--json は {ok,url,level,guestKeyId,deviceUUID}
- surface: cli
- backend: cloud, local
- command: `sesame org keys share-url`
- branch: human(URL+QR) | --json({ok,url,level,guestKeyId,deviceUUID}) | level≠2→guestKeyId:null
- assert: human 出力は url を console.log し --qr 時は QR を追記、--json 出力は {ok:true, url, level, guestKeyId: guestKeyId ?? null, deviceUUID} の封筒。level 0/1 では guestKeyId=null、level 2 では generateGuestQR 由来値が入る
- ref: packages/kit/src/cli/org.js:830-833
- kind: surface-parity
- status: covered
- note: 確認済: org.js:830-833 ctx.out(opts.json, human(:831 url console.log/:832 qrText 追記), {ok:true,url,level,guestKeyId:guestKeyId ?? null,deviceUUID:deviceKey.deviceUUID})。guestKeyId は :809-811 で level===2 のみ設定→0/1 は undefined→`?? null` で null。ORG-0101/02/03 (spec/org.md) は分岐/解決順/エラーを覆うが human↔JSON 封筒 parity (guestKeyId ?? null の null 化含む) は別観点。

### [SK-0021] locks add --from-url 優先順位 surface-parity: 明示フラグ > --from-url 由来値 > prompt(TTY) > die(必須)
- surface: cli
- backend: local
- command: `sesame locks add --from-url`
- branch: 明示フラグ優先 | --from-url補完 | prompt | die
- assert: cross-ref → 正典 [[CFG-0043]] (locks add --from-url 取り込みの ask() 優先順位ラダーは config ドメインが占有)
- ref: local-contract
- kind: option-branch
- status: waived: 重複（正典 [[CFG-0043]]）
- note: ask() の優先順位ラダー (明示フラグ > --from-url 由来 > prompt(TTY) > die(必須)) は CFG-0043 (spec/config.md:487, ref locks.js:110-116;117-124) が同一境界・同一 ref で覆う。locks add --from-url の CLI 取り込みは config ドメイン占有のため owner は CFG。本 SK-0021 は重複につき waive。

### [SK-0022] locks add --from-url の解析失敗で die(shareUrlParseFailed, exit 2)
- surface: cli
- backend: local
- command: `sesame locks add --from-url`
- branch: 解析成功 | parseShareKeyUrl throw→die(2)
- assert: cross-ref → 正典 [[CFG-0049]] (locks add --from-url 解析失敗 die(shareUrlParseFailed,2) は config ドメインが占有)
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[CFG-0049]]）
- note: parseShareKeyUrl throw→catch で die(cli.shareUrlParseFailed,2) の解析失敗 die 経路は CFG-0049 (spec/config.md:551, assert 末尾『parseShareKeyUrl 失敗時は die(shareUrlParseFailed, 2)』, ref locks.js:90-99) が同一境界・同一 ref で覆う。locks add --from-url の CLI 取り込みは config ドメイン占有のため owner は CFG。本 SK-0022 は重複につき waive。

### [SK-0023] locks add --from-url で取り込んだ secret が CLI 32hex 検証を通る surface-parity (parseShareKeyUrl→isSecretKeyLike)
- surface: cli, core
- backend: local
- command: `sesame locks add --from-url` / `parseShareKeyUrl`
- branch: OS3共有URL | guest(l=2)共有URL
- assert: cross-ref → 正典 [[CFG-0050]] (from-url secret の guest sk 位置) + [[CFG-0045]] (secret 32hex 検証)。locks add --from-url の secret 取り込み parity は config ドメインが占有
- ref: local-contract
- kind: surface-parity
- status: waived: 重複（正典 [[CFG-0050]]）
- note: parseShareKeyUrl→isSecretKeyLike(^[0-9a-f]{32}$) の round-trip parity (取り込んだ secret が CLI 32hex 検証を通る) は CFG-0050 (spec/config.md:562『parseShareKeyUrl はその値をそのまま secretKey として返し、CLI の 32hex 検証を通る』) と CFG-0045 (config.md:508 secret 32hex 検証) の合成が同一境界・同一 ref (locks.js:34-36, sharekey.js:134) で覆う。locks add --from-url の CLI 取り込みは config ドメイン占有のため owner は CFG。本 SK-0023 は重複につき waive (OS3 16B→32hex 決定論保証の独自価値分も含め CFG-0050/0045 が正典)。

## generateGuestQR (ゲスト鍵発行)

### [SK-0024] org.generateGuestQR の SDK/serve param 契約: data(required, object) と timeoutMs(optional scalar)
- surface: sdk, serve
- backend: cloud
- command: `org.generateGuestQR` / `OrgGenerateGuestQR`
- branch: -
- assert: rpc-params.generated に data(required, type object) と timeoutMs(required:false, number) が登録され、ts/py SDK が generateGuestQR({data, timeoutMs?})→Promise<unknown>/Any 署名で公開される (grpc-methods/proto の OrgGenerateGuestQR 7 op 一括 1:1 は正典 [[ORG-0105]] へ移譲)
- ref: packages/kit/src/serve/rpc-params.generated.json:877-894; packages/kit/sdk/ts/sesame-client.ts:525; packages/kit/sdk/python/sesame_client.py:1029-1031
- kind: contract-existence
- status: covered
- note: 検証済: rpc-params.generated.json:877-894 = org.generateGuestQR に data(required:true,object) + timeoutMs(required:false,number)。ts:525 generateGuestQR({data:Record<string,unknown>, timeoutMs?:number}):Promise<unknown>、py:1029-1031 def generateGuestQR(*, data:dict, timeoutMs=None)->Any を確認。戻り値 unknown/Any (guestKeyId string は core 契約 ORG-0093)。scope 限定: grpc-methods.generated OrgGenerateGuestQR (jsonFields=['data']/optionalScalars=['timeoutMs']) の主張は org スライス 7 op を一括検証する [[ORG-0105]] (spec/org.md:1199, grpc-methods.generated.json:272-334) が正典のため本エントリから外し、rpc-params + ts/py SDK 署名のみに絞る。

### [SK-0025] generateGuestQR の action 値 wire: action='biz3ManageEmployeeDevice' (messageConstants 由来) で biz3 と一致
- surface: core
- backend: cloud
- command: `org.generateGuestQR`
- branch: -
- assert: 送信フレームの action が ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE='biz3ManageEmployeeDevice' (vendor messageConstants.js:8) で、biz3 useManageGroup.js:179 の action 値と完全一致する (op='generateGuestQR' と組で)
- ref: packages/core/src/org.js:47; packages/core/src/org.js:714; packages/core/src/vendor/biz3/constants/messageConstants.js:8; references_web/src/api/useManageGroup.js:179-181; references_web/src/constants/messageConstants.js:8
- kind: wire-fidelity
- status: covered
- note: 検証済: org.js:47 ACT_EMPLOYEE_DEVICE=ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE、org.js:714 client.request({action:ACT_EMPLOYEE_DEVICE, ...data, op:'generateGuestQR'})。vendor messageConstants.js:8 と references_web messageConstants.js:8 が同一値 'biz3ManageEmployeeDevice'。biz3 reference useManageGroup.js:179-181 (action:ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE, ...data, op:'generateGuestQR') と op を含め完全一致。ORG-0093 は data spread+op+resp.data。action 文字列値の vendor↔reference 一致を独立化。

## 監査追補 v2 (dual-audit)

### [SK-0026] share-url の --level 上限検証 (level >= 自身の keyLevel) が欠落 (権限昇格共有ハザード)
- surface: cli
- backend: cloud, local
- command: `sesame org keys share-url`
- branch: level >= deviceKey.keyLevel(許可) | level < deviceKey.keyLevel(降格共有=移植元は選択肢から除外)
- assert: share-url の --level が共有者自身の keyLevel 以上であることを検証する境界が無い。移植元 MobileDeviceShareQRCode.js:43 は roleOptions を option.value >= currentDeviceKey.keyLevel でフィルタし自分より上位 (数値が小さい owner=0<manager=1<guest=2) のロールを共有候補から除外するが、CLI は org.js:775-779 で [0,1,2].includes(level) のみ検証し keyLevel 比較が無いため guest(keyLevel=2) のユーザが --level 0(owner) を発行できてしまう。期待挙動は『level >= deviceKey.keyLevel でなければ die(2)』(CLI 側に検証追加が必要)
- ref: packages/kit/src/cli/org.js:775-779; references_web/src/components/MobileDeviceShareQRCode.js:43; references_web/src/components/MobileDeviceShareQRCode.js:37-44; packages/core/src/sharekey.js:101
- kind: option-branch
- status: covered
- note: 実装疑い: CLI org.js:775-779 は [0,1,2].includes(level) のみで上限 (keyLevel) チェックを欠き、移植元の『自身以上の level しか共有不可』制約 (MobileDeviceShareQRCode.js:43 の option.value >= currentDeviceKey.keyLevel フィルタ) を未被覆=権限昇格共有の経路が開く。ORG-0101/ORG-0103 は level∈{0,1,2} の検証のみ覆う。サーバ側強制は未確認 (E2E)。app は roleOptions を keyLevel>= でフィルタ。--level 既定 '2'(guest) の無指定安全側は別境界 [[SK-0027]]。conflict 裁定: A1 (上限検証欠落=under-protected, 本エントリ) と B1 (既定 guest=safe-by-default, [[SK-0027]]) は同一 --level 検証経路 (org.js:768-779) の別境界として両方を起票。

### [SK-0027] share-url の --level 既定値 '2' (無指定で guest 共有 = generateGuestQR 起動)
- surface: cli
- backend: cloud, local
- command: `sesame org keys share-url`
- branch: --level 無指定→既定'2'(guest, generateGuestQR 呼び出し) | -l 0/1 明示 | -l 不正→die(2)
- assert: share-url は -l/--level の commander 既定値が文字列 '2' (org.js:768) のため、--level を全く渡さない裸の sesame org keys share-url は level=2(guest) と解釈され generateGuestQR (org.js:809-811 level===2) が必ず呼ばれ使い捨て guestKeyId を発行する。owner/manager 共有 (0/1) は明示が必要で、無指定は最も権限の弱い guest になる既定の安全側設計
- ref: packages/kit/src/cli/org.js:768; packages/kit/src/cli/org.js:775; packages/kit/src/cli/org.js:809-811
- kind: option-branch
- status: covered
- note: security 相: 既定が最弱権限 (guest) である点が load-bearing。org.js:768 .option("-l, --level <0|1|2>", ..., "2") で第3引数 (既定)='2'、org.js:775 parseInt→:809-811 if(level===2)→generateGuestQR。SK-0020 は level 分岐前提の封筒、ORG-0103 は不正 level→die(2) のみで無指定既定='2'→guest 分岐を双方欠く。上限検証欠落 (権限昇格ハザード) は別境界 [[SK-0026]]。
