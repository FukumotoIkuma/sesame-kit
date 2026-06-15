<!-- spec-domain: access | prefix: ACC | tests: packages/core/tests/access, packages/kit/tests/cli, packages/kit/tests/serve -->

# アクセス制御(カード/パスコード/認証データ) spec (ACC)

access.* (カード/パスコード CRUD・一括登録・認証データ・所有者更新) を biz3 web (useManageAuthData) に照らして監査する。

## cards-get

### [ACC-0001] getCards 送信フレーム = {action:'biz3ManageAccessCtlAuthData', obj:{devices:'uuid1,uuid2'}, op:'getCards'}
- surface: core
- backend: cloud
- command: access.getCards
- branch: deviceUUIDs複数(カンマ連結)
- assert: getCards が送る WS フレームの action/op/obj.devices(カンマ連結文字列) が biz3 getAuthenticationData の生成フレームと一致する
- ref: packages/core/src/access.js:318-322; references_web/src/api/useManageAuthData.js:54-62; packages/core/src/vendor/biz3/constants/messageConstants.js:9
- kind: wire-fidelity
- status: planned
- note: obj.devices は devices.map(d=>d.deviceUUID).join(',')。配列ではなく文字列。検証済: access.js:320 sendFrame / useManageAuthData.js:54 join(',') / messageConstants.js:9 BIZ3_MANAGE_AC_AUTHDATA='biz3ManageAccessCtlAuthData'。行番号ズレなし。

### [ACC-0002] getCards: pubCardLinkedIDs push を page で集約 (page===1置換/他累積)
- surface: core
- backend: cloud
- command: access.getCards
- branch: page===1 | page>1(累積)
- assert: op='pubCardLinkedIDs' の data{deviceUUID,page,list} を biz3 handleDeviceCardData と同じく page===1 で置換・それ以外で累積する
- ref: packages/core/src/access.js:332-342; references_web/src/api/useManageAuthData.js:116-131
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js:341 byDevice[deviceUUID]=page===1?[...list]:[...current,...list] が biz3:126 newItemsList=page===1?[...list]:[...currentItems,...list] と一致。行番号ズレなし。

### [ACC-0003] getCards: items 集約 (cardID 単位に uuids 群を付与)
- surface: core
- backend: cloud
- command: access.getCards
- branch: -
- assert: byDevice の list を cardID 単位に集約し各要素へ uuids(該当 deviceUUID 群)を付与する形が biz3 nfcCards useMemo と一致する
- ref: packages/core/src/access.js:371-385; references_web/src/api/useManageAuthData.js:155-174
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js:371-385 aggregate() が cardIDMap(Set)で deviceUUID を集約し card.uuids=Array.from(...) を付与 = biz3:160-173 nfcCards useMemo と同型。kind は payload-fidelity ではない — _format.md §4 で payload-fidelity は BLE バイト列専用、本件は WS 受信データの集約形につき wire-fidelity 維持。行番号ズレなし。

### [ACC-0004] getCards: 完了通知 op='getCards'(data無し) で確定・欠落時 grace window
- surface: core
- backend: cloud
- command: access.getCards
- branch: 全デバイス揃う即確定 | 欠落あり grace吸収
- assert: 完了通知 op='getCards' を受けて確定し、要求 deviceUUID に欠落があれば graceMs だけ残 push を吸収してから resolve する(到着順序未確認 §9 V8)
- ref: packages/core/src/access.js:349-356; references_web/src/api/useManageAuthData.js:179-185
- kind: wire-fidelity
- status: planned
- note: 完了通知/pub push の到着順序は参照から導出不能。逆順サーバで空成功にならないことを検証。検証済: access.js:350 key=`${ACTION}:${op}`、352 missing 判定、354 graceTimer=setTimeout(finish,graceMs)。biz3:183-185 は完了通知で done:true にするのみ(grace 無し=逸脱は §9 V8 で実機確認待ち)。§9 V8='access getCards 完了通知と pub の到着順序' は v3 line 621 で繰越明記(v2 commit 4860ed3 §9 表に実在)。行番号ズレなし。

### [ACC-0005] getCards: deviceUUIDs 空なら送信せず空集合を返す
- surface: core
- backend: cloud
- command: access.getCards
- branch: deviceUUIDs=[] | partialOnTimeout有無
- assert: deviceUUIDs が非配列/空なら WS を送らず {byDevice:{},items:[]}(partialOnTimeout時は partial:false 付与) を返す
- ref: packages/core/src/access.js:299-301; references_web/src/api/useManageAuthData.js:51-53
- kind: option-branch
- status: planned
- note: biz3 getAuthenticationData も !devices.length で return。検証済: access.js:300 return partialOnTimeout?{partial:false,byDevice:{},items:[]}:{byDevice:{},items:[]} / useManageAuthData.js:51-52 if(!devices.length){return;}。行番号ズレなし。

### [ACC-0006] getCards: timeout 時 reject / partialOnTimeout 時は部分結果 resolve
- surface: core
- backend: cloud
- command: access.getCards
- branch: 既定(reject) | partialOnTimeout=true(部分resolve)
- assert: 完了通知未達で timeoutMs 経過時、既定は opTimeout で reject し、partialOnTimeout=true なら {partial:true,byDevice,items} で resolve する
- ref: packages/core/src/access.js:322-328; packages/core/src/util.js:147-154; packages/core/src/access.js:402-411
- kind: error-path
- status: planned
- note: BIZ-14。参照 UI は pub push を都度反映するため部分蓄積が残るパターンに整合。検証済: access.js:322 onTimeout=()=>timeoutError(t('access.err.opTimeout',{op})), 323 partialOnTimeout, 326-328 result()。reject vs partial-resolve の実体は util.js:147-154 (partialOnTimeout 時 {...result(),partial:true} resolve / 既定 finish(onTimeout()) reject)。getCards 転送は 402-411。BIZ-14 は util.js/access.js コメント・tests に実在。reject 機構の出典強化のため util.js:147-154 を ref に追加。

## passcodes-get

### [ACC-0007] getPasscodes 送信フレーム = op:'getPasscodes', pub op='pubPasscodeLinkedIDs', idKey='passwordID'
- surface: core
- backend: cloud
- command: access.getPasscodes
- branch: -
- assert: getPasscodes が getCards と同型で op='getPasscodes'/pubOp='pubPasscodeLinkedIDs'/集約キー='passwordID' を使い biz3 passcodes useMemo と一致する
- ref: packages/core/src/access.js:428-438; references_web/src/api/useManageAuthData.js:134-153; references_web/src/api/useManageAuthData.js:189-191
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js:431 op='getPasscodes', 432 pubOp=PUB_PASSCODE_LINKED_IDS(='pubPasscodeLinkedIDs' @ access.js:52), 433 idKey='passwordID'。biz3:138 passwordID 集約 / 189-191 case PubedPasscodeLinkedDeviceIDs='pubPasscodeLinkedIDs'。集約キー=passwordID の主張は wire-fidelity 内に留まる(payload-fidelity は BLE 専用語彙のため不可)。行番号ズレなし。

## cards-post

### [ACC-0008] postCards 送信フレーム = {action, deviceUUID, list, op:'postCards'} (obj ラップ無し)
- surface: core
- backend: cloud
- command: access.postCards
- branch: -
- assert: postCards は obj でラップせず deviceUUID と list をトップレベルに置く非対称フレームが biz3 postCards と一致する
- ref: packages/core/src/access.js:473-476; references_web/src/api/useManageAuthData.js:379-394
- kind: wire-fidelity
- status: planned
- note: getCards/clearCards の obj ラップと混同しない非対称構造。biz3 frame は 384-389、callback 全体 379-394。

### [ACC-0009] postCards: list 空(<1)なら送信せず null を返す
- surface: core
- backend: cloud
- command: access.postCards
- branch: list.length<1 | list非配列 | 通常
- assert: list が非配列 or length<1 なら WS を送らず null を返す(biz3 postCards の list.length<1 return と一致)
- ref: packages/core/src/access.js:474; references_web/src/api/useManageAuthData.js:381-383
- kind: option-branch
- status: planned
- note: core は Array.isArray ガードを追加(biz3 は list.length<1 のみ)。biz3 の弱い検証を包含する superset。

## passcodes-post

### [ACC-0010] postPasscodes 送信フレーム = {action, deviceUUID, list, op:'postPasscodes'} (obj ラップ無し)
- surface: core
- backend: cloud
- command: access.postPasscodes
- branch: list空(null返却) | 通常
- assert: postPasscodes が postCards と同型(obj ラップ無し・トップレベル deviceUUID/list)で op='postPasscodes' を送り list 空なら null を返す
- ref: packages/core/src/access.js:490-493; references_web/src/api/useManageAuthData.js:396-411
- kind: wire-fidelity
- status: planned
- note: biz3 frame は 401-406、callback 全体 396-411。

### [ACC-0011] postPasscodes list 要素 = {passwordID,name,nameUUID}(insertUUIDIsolationCharacter整形)
- surface: core
- backend: cloud
- command: access.postPasscodes
- branch: -
- assert: postPasscodes の list 要素が biz3 passwords serverList の {...item, nameUUID:insertUUIDIsolationCharacter(item.nameUUID.toLowerCase())} 形(passwordID/name/nameUUID)と一致する
- ref: packages/core/src/access.js:486-487; references_web/src/pages/biz/access-control/password/passwords.js:103-108; references_web/src/utils/biz3utils.js:236-238
- kind: payload-fidelity
- status: planned
- note: kind を wire-fidelity→payload-fidelity に修正(フレーム封筒でなく list 要素フィールド内容を主張するため)。serverList map は passwords.js:103-108(uploadPasswordBatch 戻り {...item} を spread し nameUUID のみ insertUUIDIsolationCharacter 再整形)。keyBoardPassCode/keyBoardPassCodeNameUUID/type は postPasscodes には載らない(updatePasscodeName 用)。

## cards-del

### [ACC-0012] delCards: fire-and-forget send {action, items, op:'delCards'} (deviceID/cardID)
- surface: core
- backend: cloud
- command: access.delCards
- branch: -
- assert: delCards は items 配列をトップレベルに置き send(request しない)で投げる。biz3 は応答 case が空で待たない fire-and-forget
- ref: packages/core/src/access.js:514-518; references_web/src/api/useManageAuthData.js:355-365; references_web/src/api/useManageAuthData.js:265-267
- kind: wire-fidelity
- status: planned
- note: items 要素は {deviceID,cardID}(deviceUUID ではなく deviceID)。client.send は transport.js:284 に実在。biz3 応答 case 'delCards' は 265-267 で空コメントのみ=無視。

### [ACC-0013] delCards: items 空なら送信せず false / 非空で true
- surface: core
- backend: cloud
- command: access.delCards
- branch: items空(false) | items非空(true送信)
- assert: items が非配列 or 空なら send せず false を返し、非空なら send して true を返す(biz3 !items.length return と一致)
- ref: packages/core/src/access.js:515-517; references_web/src/api/useManageAuthData.js:356-358
- kind: option-branch
- status: planned
- note: biz3 は !items || !items.length チェック(356-358)。core は Array.isArray + length===0 で同等。

## passcodes-del

### [ACC-0014] delPasscodes: fire-and-forget send {action, items, op:'delPasscodes'} (deviceID/passwordID)
- surface: core
- backend: cloud
- command: access.delPasscodes
- branch: items空(false) | 非空(true)
- assert: delPasscodes が delCards と同型の fire-and-forget(send)で op='delPasscodes' を投げ items 要素 {deviceID,passwordID}・items 空で false を返す
- ref: packages/core/src/access.js:534-538; references_web/src/api/useManageAuthData.js:367-377; references_web/src/api/useManageAuthData.js:272-273
- kind: wire-fidelity
- status: planned
- note: biz3 では delPasscodes 専用 case が無く default(272-273) 落ち=応答無視。deletePasscodes 実体は 367-377。

## cards-clear

### [ACC-0015] clearCards 送信フレーム = {action, obj:{devices:<単一uuid文字列>}, op:'clearCards'}
- surface: core
- backend: cloud
- command: access.clearCards
- branch: -
- assert: clearCards の obj.devices は単一 deviceUUID 文字列(getCards のカンマ連結ではない)で biz3 clearCards フレームと一致する
- ref: packages/core/src/access.js:552-555; references_web/src/api/useManageAuthData.js:295-311; references_web/src/api/useManageAuthData.js:54
- kind: wire-fidelity
- status: planned
- note: 確認済: access.js:554 frame obj:{devices:deviceUUID}(単一文字列)。getCards のカンマ連結は useManageAuthData.js:54 `devices.map(...).join(',')` で対照。biz3 clearCards は同 303 で obj:{devices:deviceUUID} を送る。

### [ACC-0016] clearCards: deviceUUID 無しなら送信せず null
- surface: core
- backend: cloud
- command: access.clearCards
- branch: deviceUUID欠落(null) | 通常
- assert: !deviceUUID なら WS を送らず null を返す(biz3 clearCards の !deviceUUID return と一致)
- ref: packages/core/src/access.js:553; references_web/src/api/useManageAuthData.js:297-299
- kind: option-branch
- status: planned
- note: 確認済: access.js:553 `if(!deviceUUID) return null;`。biz3 297-299 は bare `return;`(undefined)で送信しない=送らない挙動は一致、null は core 側の選択(assert もそう帰属)。

## passcodes-clear

### [ACC-0017] clearPasscodes 送信フレーム = {action, obj:{devices:<単一uuid>}, op:'clearPasscodes'}
- surface: core
- backend: cloud
- command: access.clearPasscodes
- branch: deviceUUID欠落(null) | 通常
- assert: clearPasscodes が clearCards と同型(単一 deviceUUID 文字列の obj.devices)で op='clearPasscodes' を送る。biz3 関数名 clearPasswords だが op は clearPasscodes
- ref: packages/core/src/access.js:568-571; references_web/src/api/useManageAuthData.js:313-329
- kind: wire-fidelity
- status: planned
- note: 確認済: access.js:569 !deviceUUID guard / 570 frame。biz3 は関数名 clearPasswords(313)だが op:'clearPasscodes'(323)、obj:{devices:deviceUUID}(321 単一文字列)。応答 case も clearPasscodes(269)。

## cards-name

### [ACC-0018] updateCardName 送信フレーム = {action, obj:{...item}, op:'updateCardName'}
- surface: core
- backend: cloud
- command: access.updateCardName
- branch: -
- assert: updateCardName は item を obj に展開して送る(biz3 handlePutCardName)。item は {cardID,name,cardNameUUID,timestamp,cardType,stpDeviceUUID}
- ref: packages/core/src/access.js:594-596; references_web/src/api/useManageAuthData.js:331-344; references_web/src/pages/biz/access-control/cards/cards.js:221-231
- kind: wire-fidelity
- status: planned
- note: 確認済: access.js:595 obj:{...item}。biz3 では公開 updateCardName(476)→updateItemName(431-474)→handlePutCardName(331-344, frame obj:{...item}) と多段だが、フレーム送出は handlePutCardName が担い ref で支持される。応答は reqContext echo(192-234)。呼出元 cards.js:221-231 の param(222-230)は実際には ownerSubUUID(226)も含む 7 フィールド(updateCardOwner と共有, line 233)で、本 assert の 6 フィールドは name-op の関連サブセット。BLE v4 化前段(SSM_OS3_CARD_CHANGE=107, useManageAuthData.js:438-451)は本関数の責務外。

## passcodes-name

### [ACC-0019] updatePasscodeName 送信フレーム = {action, obj:{...item}, op:'updatePasscodeName'}
- surface: core
- backend: cloud
- command: access.updatePasscodeName
- branch: -
- assert: updatePasscodeName が updateCardName と同型(obj:{...item})で op='updatePasscodeName' を送る。item は引用元 passworddetails.js updatePasscodeItem の param {keyBoardPassCode,name,keyBoardPassCodeNameUUID,timestamp,type,stpDeviceUUID}(6フィールド)に整合する。obj:{...item} は item を素通しするため timestamp/type も呼出側が載せれば送られる
- ref: packages/core/src/access.js:615-617; references_web/src/api/useManageAuthData.js:331-344; references_web/src/pages/biz/access-control/password/passworddetails.js:181-189
- kind: wire-fidelity
- status: planned
- note: 確認済: access.js:616 obj:{...item} op:updatePasscodeName。送出は handlePutCardName(331-344)。item フィールドの一次出典を、応答側 stateMap(useManageAuthData.js:201-210)から実呼出元 passworddetails.js:181-189(param={keyBoardPassCode,name,keyBoardPassCodeNameUUID,timestamp,type,stpDeviceUUID}→updatePasswordName)へ置換(stateMap は response キーで弱い)。旧 assert は timestamp(:185)/type(:186)を落とした 4 フィールドだったが引用元は 6 フィールドのため補正。core の updatePasscodeName は obj:{...item} 透過なので CLI が --json で timestamp/type を渡せば送られる。biz3 公開名は updatePasswordName(477)だが op は updatePasscodeName(UPDATE_CONFIGS.password:423)。

## cards-owner

### [ACC-0020] updateCardOwner: 'ownerSubUUID' in item の時だけ送信 {action,obj:{...item},op:'updateCardOwner'}
- surface: core
- backend: cloud
- command: access.updateCardOwner
- branch: item透過(正規) | item省略(合成)
- assert: item に ownerSubUUID キーが在る時だけ obj:{...item} を送り、無ければ null を返す(biz3 'ownerSubUUID' in item ガードと一致)
- ref: packages/core/src/access.js:642-656; references_web/src/api/useManageAuthData.js:346-353; references_web/src/pages/biz/access-control/cards/cards.js:221-233
- kind: wire-fidelity
- status: planned
- note: 確認済: access.js:645-655 item 透過パス、649 `if(!('ownerSubUUID' in item)) return null;`、652 obj:{...item}。biz3 updateCardOwner(346-353)は 'ownerSubUUID' in item(348)の時だけ handlePutCardName('updateCardOwner', item)(349)、無ければ何もしない(send なし)。呼出元 cards.js:221-233 は param={cardID,name,cardNameUUID,ownerSubUUID,timestamp,cardType,stpDeviceUUID} 全フィールド(222-230)を渡し、233 で updateCardOwner(param) を呼ぶ。

### [ACC-0021] updateCardOwner: ownerSubUUID='' は送信(未割当解除) / undefined は送信しない
- surface: core
- backend: cloud
- command: access.updateCardOwner
- branch: ownerSubUUID='' (送信) | undefined (null)
- assert: ownerSubUUID が空文字 '' でも送信して未割当解除し、undefined(キー不在)なら送らず null を返す境界が biz3 と一致する
- ref: packages/core/src/access.js:649; packages/core/src/access.js:662; references_web/src/api/useManageAuthData.js:348
- kind: option-branch
- status: planned
- note: 確認済: access.js:649 は item 透過パスのキー存在ガード('ownerSubUUID' in item)で '' は通過し送信、662 は後方互換パスの `if(ownerSubUUID===undefined) return null;`。biz3 348 `if('ownerSubUUID' in item)` も値ではなくキー存在判定なので '' は送信される=境界一致。

## passcode-id-format

### [ACC-0022] formatPasscodeID: PIN 各桁を 2 桁 hex 大文字へ ('123'→'010203')
- surface: core
- backend: local
- command: crypto.formatPasscodeID
- branch: -
- assert: formatPasscodeID の各桁→2桁hex大文字変換('123'→'010203')。重複につき [[CRY-0013]] を正典
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0013]]）
- note: crypto.js:171-179 の純暗号変換は spec/crypto.md:155-164 の CRY-0013 が一意担当面(_format.md §4 で crypto-vector は CRY ドメイン)。CRY-0013 は '123'/'0'/'9'/'0123456789'/数値123/'' を網羅し test 付帯の superset。本 ID は欠番にせず保持し、access の passcode 整形依存は [[CRY-0013]] をリンク参照する。

### [ACC-0023] formatPasscodeID: 数値入力・各桁独立変換のエッジ (9→'09', 10→'0100')
- surface: core
- backend: local
- command: crypto.formatPasscodeID
- branch: 文字列入力 | 数値入力
- assert: 数値入力・各桁独立変換のエッジ(9→'09', 10→'0100')。重複につき [[CRY-0013]] を正典
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0013]]）
- note: ACC-0022 と同じく crypto.js:171-179 の formatPasscodeID KAT で spec/crypto.md:155-164 の CRY-0013 と完全重複。数値/文字列の各桁独立変換は CRY-0013 のベクタ集合に内包される。本 ID は欠番にせず保持し [[CRY-0013]] を正典としてリンク参照する。

## name-uuid-normalize

### [ACC-0024] normalizeNameUUID: 32hex を 8-4-4-4-12 へ整形・小文字化 (insertUUIDIsolationCharacter 相当)
- surface: core
- backend: local
- command: enrolledToCardList / enrolledToPasscodeList
- branch: 32hex(整形) | 既ハイフン(小文字のみ) | 非文字列/空(null)
- assert: NOTIFY 由来 hex nameUUID を小文字化し 32hex のみ 8-4-4-4-12 区切りへ整形する処理が biz3utils insertUUIDIsolationCharacter と一致する
- ref: packages/core/src/access.js:826-833; references_web/src/utils/biz3utils.js:236-238; references_web/src/pages/biz/access-control/cards/cards.js:110-112
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js:830-831 の置換正規表現 (\w{8})(\w{4})(\w{4})(\w{4})(\w{12}) は biz3utils.js:237 insertUUIDIsolationCharacter と同一。cards.js:112 が insertUUIDIsolationCharacter(item.nameUUID.toLowerCase()) で toLowerCase+整形の参照経路を裏付け。

## name-uuid-v4

### [ACC-0025] isUuidV4: version/variant byte 判定 (非v4で BLE 前段警告)
- surface: core, cli
- backend: local
- command: crypto.isUuidV4 / access cards name
- branch: v4(送信のみ) | 非v4(警告 stderr)
- assert: isUuidV4 の version/variant バイト判定(byte6&0xf0===0x40 かつ byte8&0xc0===0x80)。重複につき [[CRY-0011]] を正典
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0011]]）
- note: isUuidV4 のバイト判定 KAT(crypto.js:197-213; biz3utils.js:435-453)は spec/crypto.md:129-138 の CRY-0011 と同 ref・同 kind・同主張で完全重複。CRY-0011 は v4/v1/全ゼロ/variant≠0x80/非16B/falsy を網羅し test 付帯の superset。本 ID は欠番にせず保持し crypto-vector 部は [[CRY-0011]] を正典としてリンク参照する。access 固有の『非v4→stderr 警告して続行』分岐(access.js:925-933 の syncEnrolledCards / cli passcodes・cards name)は ACC-0043 / ACC-0064 / ACC-0078 が担当する。

## auth-data-rest

### [ACC-0026] postAuthenticationData → POST /device/v1/biometrics body {op:`${operation}_post`, deviceID, items}
- surface: core
- backend: cloud
- command: access.postAuthenticationData / postAuthenticationData
- branch: -
- assert: POST /device/v1/biometrics へ送る body の op が operation+'_post' の無条件連結、deviceID/items がトップレベルに載る形が Kotlin SDK CHDataSynchronizeCapableImpl.postAuthenticationData(operation += "_post") と一致する
- ref: packages/core/src/access.js:681-691; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/baseCapbale/CHDataSynchronizeCapableImpl.kt:16-29; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:105-106
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js L684 op=withSuffix(_post), L685 deviceID, L686 items, L691 return resp?.data?.items (関数は L681-691)。kt:16-29=postAuthenticationData, kt:17=operation+='_post'。CHAPIClient.kt:105-106=@Operation(path=/device/v1/biometrics, POST)+fun biometricsOperation。既存テスト packages/core/tests/access/access.test.js:797 が op 連結を同観点 (untagged=planned)。

### [ACC-0027] postAuthenticationData が response.data.items を直返し (resp フォールバックしない)
- surface: core
- backend: cloud
- command: postAuthenticationData
- branch: data.items 有 | data.items 欠落(undefined)
- assert: 応答 unwrap が resp?.data?.items のみで CHDataSynchronizeCapableImpl.kt:23 `responses.data.items` と一致し、欠落時に resp 自体へフォールバックしない (undefined になる)
- ref: packages/core/src/access.js:688-691; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/baseCapbale/CHDataSynchronizeCapableImpl.kt:19-24
- kind: payload-fidelity
- status: planned
- note: 検証済: access.js L691 return resp?.data?.items (?? resp フォールバック撤去のコメント L689-690)。kt:23 responses.data.items (無条件)。既存テスト packages/core/tests/access/access.test.js:827(data.items 直返し), :836(欠落時 undefined) が同観点 (untagged=planned)。

### [ACC-0028] putAuthenticationData → body op が operation+'_put'
- surface: core
- backend: cloud
- command: access.putAuthenticationData / putAuthenticationData
- branch: -
- assert: body.op が operation+'_put' の無条件連結 (二重連結含む) で CHDataSynchronizeCapableImpl.putAuthenticationData(operation += "_put") と一致
- ref: packages/core/src/access.js:700-708; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/baseCapbale/CHDataSynchronizeCapableImpl.kt:31-41
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js L703 op=withSuffix(_put), L704 deviceID, L705 items (関数 L700-708)。kt:31-41=putAuthenticationData, kt:32=operation+='_put'。

### [ACC-0029] deleteAuthenticationData → body op が operation+'_delete'
- surface: core
- backend: cloud
- command: access.deleteAuthenticationData / deleteAuthenticationData
- branch: -
- assert: body.op が operation+'_delete' の無条件連結で CHDataSynchronizeCapableImpl.deleteAuthenticationData(operation += "_delete") と一致、items はトップレベル
- ref: packages/core/src/access.js:716-724; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/baseCapbale/CHDataSynchronizeCapableImpl.kt:43-54
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js L719 op=withSuffix(_delete), L720 deviceID, L721 items (関数 L716-724)。kt:43-54=deleteAuthenticationData, kt:44=deleteReq.operation+='_delete'。

### [ACC-0030] withSuffix は条件分岐せず無条件連結 (BIZ-08, 既に _post 終端でも二重連結)
- surface: core
- backend: local
- command: withSuffix (内部)
- branch: 通常 operation | 既に suffix 付き operation
- assert: operation に既に '_post' が付いていても二重連結する Kotlin の `request.operation += "_post"` 挙動を再現し、条件分岐で抑止しない
- ref: packages/core/src/access.js:236-247; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/baseCapbale/CHDataSynchronizeCapableImpl.kt:17,32,44
- kind: wire-fidelity
- status: planned
- note: 検証済: access.js L236-247 = withSuffix の doc コメント+本体, L246 `return `${operation}${suffix}`` で条件分岐なし。kt:17(_post),32(_put),44(_delete) いずれも `operation += ...` 無条件。既存テスト packages/core/tests/access/access.test.js:805 (既に _post でも二重連結=nfc_card_post_post) が同観点 (untagged=planned)。

### [ACC-0031] postAuthenticationData: items 非配列は [] に正規化して送る
- surface: core
- backend: cloud
- command: postAuthenticationData / putAuthenticationData / deleteAuthenticationData
- branch: items 配列 | items 非配列/欠落
- assert: params.items が配列でない場合 body.items に空配列を入れる (Array.isArray ? items : []) で常に items キーを持つ
- ref: packages/core/src/access.js:686,705,721
- kind: option-branch
- status: planned
- note: 検証済: L686/705/721 いずれも `items: Array.isArray(params.items) ? params.items : []`。参照は型 (List 非 null) で保証するため空配列正規化は kit 側の防御で local-contract 寄りだが、純ローカル判定でない (cloud 送信値の形を規定) ため出典なしの local-contract には置換せず実装行参照を維持。

## biometrics-transport

### [ACC-0032] makeBiometricsTransport 既定ホストは app.properties:3 の prod / SigV4+x-api-key, appidentifyid 無し
- surface: core
- backend: cloud
- command: makeBiometricsTransport
- branch: credentialsProvider 経路 | getIdToken 経路
- assert: 既定 baseUrl が https://app.candyhouse.co/prod、認可が SigV4(Identity Pool 一時 credentials)+x-api-key で、biometricsOperation(body) に appidentifyid ヘッダを付けない (CHAPIClient.kt:105-106 は appidentifyid 引数を持たない)
- ref: packages/core/src/access.js:177-205; packages/core/src/aws-credentials.js:79; _sesame_sdk_ref/app.properties:3; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:105-106
- kind: wire-fidelity
- status: planned
- note: 検証OK: access.js:178 既定=DEFAULT_CH_API_BASE_URL, aws-credentials.js:79='https://app.candyhouse.co/prod', app.properties:3=prod URL, CHAPIClient.kt:105='@Operation(path="/device/v1/biometrics",POST)'/:106='fun biometricsOperation(body:Any)' に appidentifyid 無し(他EP :24/31/38/44/51/58/65 のみ付与)。既存 access.test.js:66 が同観点。@experimental 実機 API Gateway 受理は未検証 (§9 V4/V5)

### [ACC-0033] makeBiometricsTransport: 認可ソース未指定で badRequest
- surface: core
- backend: local
- command: makeBiometricsTransport
- branch: 認可ソース無し
- assert: credentialsProvider/getIdToken/authorization/bearerToken/authorizationProvider が全て無い場合 badRequest('access.err.biometricsAuthorizationRequired') を throw
- ref: packages/core/src/access.js:207-210
- kind: error-path
- status: planned
- note: 検証OK: access.js:208-209 が当該 guard で throw badRequest('access.err.biometricsAuthorizationRequired')。i18n キー実在 (i18n/access.js:108 en / :218 ja)

### [ACC-0034] normalizeBiometricsBaseUrl: 非HTTPS/credential付きURLを拒否
- surface: core
- backend: local
- command: makeBiometricsTransport
- branch: 非https | username/password/search/hash 付き | 不正URL
- assert: http:/credential付き/不正 baseUrl で badRequest を throw し、trailing slash を正規化する (REST ルート確定の境界)
- ref: packages/core/src/access.js:123-137
- kind: error-path
- status: planned
- note: refs修正: 元 '123-137,147' の :147 を除去 (access.js:147 は assertHttpOk の throw で normalize を支持しない)。normalize は 123-137 完結 (:131 https チェック, :132-134 username/password/search/hash 拒否, :135-136 trailing slash 正規化, :129 不正URL→badRequest)。i18n キー実在 (i18n/access.js:106-107)。既存 access.test.js:147 が同観点

### [ACC-0035] assertHttpOk: 非2xx で rejected(status 付き) を throw
- surface: core
- backend: cloud
- command: postBiometrics (内部)
- branch: 2xx | 非2xx | status 欠落
- assert: HTTP status が 200-299 外で rejected エラー(status メタ付き)を投げ、json.message/text/JSON 文字列の優先順で detail を組む異常系封筒が成立する
- ref: packages/core/src/access.js:139-148,250-256
- kind: error-path
- status: planned
- note: 検証OK: access.js:142 が 200-299 外判定, :143-145 detail を json.message→text→JSON.stringify の優先順で組み, :146 throw rejected(..,{status}) で status メタ付与, status 欠落時は 'HTTP ?' / status:null。:251-254 postBiometrics が transport 後 assertHttpOk を呼ぶ

## update-auth-name

### [ACC-0036] updateAuthenticationName(kind:'card') が CHAuthenticationNameRequest.card の既定 op 'nfc_card_putname' とフィールドを再現
- surface: core
- backend: cloud
- command: access.updateAuthenticationName / updateAuthenticationName
- branch: kind=card | request 直指定
- assert: kind='card' で組む body の op 既定値 'nfc_card_putname' と cardType/cardNameUUID/cardID/subUUID/stpDeviceUUID/name/timestamp キー集合が CHAuthenticationNameRequest.card companion と一致する
- ref: packages/core/src/access.js:734-757; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHAuthenticationNameRequest.kt:15-24
- kind: wire-fidelity
- status: planned
- note: 検証OK: access.js:751-757 card ブランチ {cardType, cardNameUUID, cardID, op:'nfc_card_putname'(:755), ...common(subUUID/stpDeviceUUID/name/timestamp :744-747)}。Kotlin companion card() :16-24 (op 既定 :23='nfc_card_putname', 引数 cardType/cardNameUUID/subUUID/stpDeviceUUID/name/cardID + timestamp(System.currentTimeMillis()))。キー集合一致 (順序は JSON で非依存)

### [ACC-0037] updateAuthenticationName(kind:'face'|'fingerPrint'|'palm'|'passcode') の既定 op とフィールド集合
- surface: core
- backend: cloud
- command: updateAuthenticationName
- branch: kind=face | fingerPrint | palm | passcode
- assert: 各 kind の既定 op (face_putname/fingerprint_putname/palm_putname/passcode_putname) と {type, *NameUUID, *ID} のフィールド命名が CHAuthenticationNameRequest の各 companion と一致する
- ref: packages/core/src/access.js:758-789; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHAuthenticationNameRequest.kt:26-86
- kind: wire-fidelity
- status: planned
- note: 検証OK + refs修正: Kotlin ref を '26-83'→'26-86' に拡張 (keyBoardPassCode companion の構築が :86 まで続くため)。access.js:758-789 各ブランチの op 既定 (face_putname:763 / fingerprint_putname:771 / palm_putname:779 / passcode_putname:787) と {type, faceNameUUID/fingerPrintNameUUID/palmNameUUID/keyBoardPassCodeNameUUID, faceID/fingerPrintID/palmID/keyBoardPassCode} が Kotlin companion face()/fingerPrint()/palm()/keyBoardPassCode() (:26-86, op 既定 :33/:43/:64/:74) のフィールド命名と一致

### [ACC-0038] updateAuthenticationName: request 直指定は body をそのまま送る (組み立てバイパス)
- surface: core
- backend: cloud
- command: updateAuthenticationName
- branch: request 有 | request 無し+kind
- assert: params.request があれば authenticationNameRequest を呼ばず {...request} をそのまま POST する (CHDataSynchronizeCapableImpl が data.request を透過するのと同じ)
- ref: packages/core/src/access.js:734-738; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/baseCapbale/CHDataSynchronizeCapableImpl.kt:56-68
- kind: option-branch
- status: planned
- note: 検証OK: access.js:736 'params.request ? {...params.request} : authenticationNameRequest(params)' で request 有なら組み立てバイパスし :737 そのまま POST。Kotlin CHDataSynchronizeCapableImpl.updateAuthenticationName :56-68 が when で内側 data.request (CHCardNameRequest 等) を取り出し :68 CHAPIClientBiz.updateAuthenticationName(authData) へ透過 (=事前構築 request を素通し) と同型

### [ACC-0039] updateAuthenticationName: kind/request 共に無しで badRequest('kindRequired')
- surface: core
- backend: local
- command: updateAuthenticationName
- branch: kind 不正/無し かつ request 無し
- assert: request が無く kind が card/face/fingerPrint/palm/passcode 以外なら badRequest('access.err.kindRequired') を throw
- ref: packages/core/src/access.js:790-792
- kind: error-path
- status: planned
- note: 確認済: updateAuthenticationName は params.request が falsy のときのみ authenticationNameRequest() を呼び (access.js:736)、その switch default が access.js:790-792 で throw する

### [ACC-0040] updateAuthenticationName: timestamp 既定は Date.now()、cardType は cardType??type??0
- surface: core
- backend: local
- command: authenticationNameRequest (内部)
- branch: timestamp 指定 | 未指定 / cardType 指定 | type 指定 | 既定0
- assert: timestamp 未指定で Date.now() を採番 (Kotlin System.currentTimeMillis() 相当)、cardType は cardType→type→0 のフォールバック順で解決する
- ref: packages/core/src/access.js:742,752; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHAuthenticationNameRequest.kt:24
- kind: option-branch
- status: planned
- note: 確認済: access.js:742 now=params.timestamp??Date.now(); access.js:752 cardType:params.cardType??params.type??0; Kt:24 card() factory が System.currentTimeMillis() を埋める

## enroll-sync-cards

### [ACC-0041] syncEnrolledCards(records) はレコード毎に updateCardName へ委譲 (biz3 タップ登録経路)
- surface: core
- backend: cloud
- command: syncEnrolledCards
- branch: records 経路 | list 経路
- assert: records 経路でレコードごとに updateCardName を送り、cardNameUUID に ack 由来(ファーム採番)nameUUID・timestamp=Date.now()・stpDeviceUUID=deviceUUID を載せる形が cards.js addCard→updateCardName(new Date().getTime()) と一致する
- ref: packages/core/src/access.js:908-947; references_web/src/pages/biz/access-control/cards/cards.js:221-238
- kind: wire-fidelity
- status: planned
- note: 行番号修正 220-233→221-238 (addCard 本体は 221-238、updateCardName 呼び出しは 231 で旧範囲の外だった)。access.js JSDoc は cards/index.js を引くが実ファイルは cards/cards.js (参照リネーム)。既存 access.test.js:713

### [ACC-0042] syncEnrolledCards(list) は postCards へそのまま流す (一括投入経路)
- surface: core
- backend: cloud
- command: syncEnrolledCards
- branch: list 配列 | records
- assert: list を渡すと records を無視し postCards(deviceUUID,list) へ透過する (cards.js sendDataToSesameTouchPro→postCards の一括投入経路と同じ、nameUUID 採番しない)
- ref: packages/core/src/access.js:908-912; references_web/src/pages/biz/access-control/cards/cards.js:105-118
- kind: option-branch
- status: planned
- note: 確認済: access.js:910-912 Array.isArray(list) なら postCards へ即委譲。cards.js:105-118 が buildNameUUIDMappedDataList→uploadCardBatch→postCards の一括投入経路

### [ACC-0043] syncEnrolledCards: 非 v4 nameUUID 検出時に stderr 警告 (BLE composite はスキップ)
- surface: core
- backend: cloud
- command: syncEnrolledCards
- branch: nameUUID v4 | 非v4
- assert: 非 v4 nameUUID で stderr に SSM_OS3_CARD_CHANGE(107) 警告を出すが処理は止めず WS 送信は通常通り行う (biz3 updateItemName の isUUIDV4 二段 composite を kit はオプトインとして素通し)
- ref: packages/core/src/access.js:918-933; references_web/src/api/useManageAuthData.js:431-473
- kind: option-branch
- status: planned
- note: refs 修正 431-473 (updateItemName 関数境界。isUUIDV4 判定は 438、非v4 二段 composite は 440-471)。既存テスト syncEnrolledCards-v4-warn.test.js が同観点 (untagged=planned)。@experimental §9 V17

### [ACC-0044] syncEnrolledPasscodes は postPasscodes 委譲のみ (kit 設計判断で updateCardName 経路を持たない)
- surface: core
- backend: cloud
- command: syncEnrolledPasscodes
- branch: records 経路 | list 経路
- assert: records を enrolledToPasscodeList で {passwordID,name,nameUUID} に写像し postPasscodes へ委譲する。kit は card の updateCardName 相当のタップ名同期経路を持たず postPasscodes 一本に統一する設計判断
- ref: packages/core/src/access.js:963-966; references_web/src/pages/biz/access-control/password/passwords.js:94-115; references_web/src/pages/biz/access-control/password/passwords.js:188-200
- kind: wire-fidelity
- status: planned
- note: 未確認→訂正: 旧 assert『passwords.js は card のような updateCardName 経路を持たず postPasscodes のみ』は誤り。passwords.js:188-200 updatePasscodeItem→updatePasswordName が cards.js addCard→updateCardName と同型のタップ名同期経路として実在する (manualAdd の PASSCODE_CHANGE callback 経由)。よって『web に経路が無い』根拠を撤回し、postPasscodes 一本化は kit 側の意図的簡素化と位置付けた。passwords.js:94-115 は bulk(postPasscodes)経路、188-200 は web 側 tap 経路 (kit 非ミラー)

## enroll-map

### [ACC-0045] enrolledToCardList: record.nameUUID(ファーム採番) を正規化透過、欠落時のみ v4 採番
- surface: core
- backend: local
- command: enrolledToCardList
- branch: nameUUID 有(hex32) | ハイフン付き | 欠落
- assert: 32hex は insertUUIDIsolationCharacter 同形の小文字ハイフン区切りへ整形して透過し、欠落時のみ generateUUID() を採番する (ファームと DB の nameUUID 一致不変条件)
- ref: packages/core/src/access.js:826-861; references_web/src/utils/biz3utils.js:236-238; references_web/src/pages/biz/access-control/cards/cards.js:110-113
- kind: payload-fidelity
- status: planned
- note: 確認済: normalizeNameUUID (access.js:826-833) が 32hex を /^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/ で整形 (biz3utils.js:236-238 insertUUIDIsolationCharacter と同形)、欠落時 access.js:859 generateUUID()。cards.js:110-113 が toLowerCase()+insertUUIDIsolationCharacter で送る。既存 access.test.js:654-684

### [ACC-0046] enrolledToPasscodeList: 写像は {passwordID,name,nameUUID} のみ (keyBoardPassCode系は送らない)
- surface: core
- backend: local
- command: enrolledToPasscodeList
- branch: passwordID 有 | cardID フォールバック
- assert: postPasscodes 参照経路に無い keyBoardPassCode/keyBoardPassCodeNameUUID/type を含めず {passwordID,name,nameUUID} のみへ写像し、passwordID は passwordID→cardID フォールバックで解決する
- ref: packages/core/src/access.js:876-887; references_web/src/pages/biz/access-control/password/passwords.js:101-113
- kind: payload-fidelity
- status: planned
- note: 既存テスト: packages/core/tests/access/access.test.js:690 ([689] 行の note パスを実在の access/ サブディレクトリへ修正; 内容は assert を支持)。name 解決は r.name ?? r.cardName ?? nameUUID の順で、両名称欠落時には nameUUID 文字列を表示名へ流用する kit 独自フォールバック(access.js:883)であり参照(passwords.js serverList は {passwordID,name} で nameUUID を name に流用しない)には存在しない。対照的に enrolledToCardList(access.js:857)は name=r.cardName 固定でフォールバック無しの非対称。

## client-register

### [ACC-0047] client.registerCards は syncEnrolledCards(records) へ配線 (一覧→DB同期 facade)
- surface: sdk, core
- backend: cloud
- command: SesameHub3.registerCards
- branch: -
- assert: registerCards(deviceUUID,cards) が _ensureConnected 後に access.syncEnrolledCards(ws,{deviceUUID,records}) へ委譲し、BLE 読み取り形 {cardID,cardName?,cardType?,nameUUID?} をそのまま records として渡す
- ref: packages/core/src/client.js:970-976; packages/core/src/access.js:908-947
- kind: contract-existence
- status: planned

### [ACC-0048] client.registerPasscodes は syncEnrolledPasscodes(records) へ配線 (SURF-04 対称)
- surface: sdk, core
- backend: cloud
- command: SesameHub3.registerPasscodes
- branch: -
- assert: registerPasscodes(deviceUUID,passcodes) が access.syncEnrolledPasscodes(ws,{deviceUUID,records}) へ委譲する registerCards 対称契約が成立する
- ref: packages/core/src/client.js:992-995; packages/core/src/access.js:963-966
- kind: contract-existence
- status: planned

## serve-register

### [ACC-0049] serve access.registerCards エントリの params/handler が hub.registerCards に 1:1
- surface: serve
- backend: cloud
- command: access.registerCards (RPC)
- branch: -
- assert: deviceUUID/cards を required で宣言し requireAuth→need(['deviceUUID','cards'])→hub.registerCards(deviceUUID,cards) を呼ぶ registry エントリが存在する (registry が deviceEntriesPre を set)
- ref: packages/kit/src/serve/entries/device.js:94-102; packages/kit/src/serve/registry.js:337
- kind: contract-existence
- status: planned

### [ACC-0050] serve access.registerPasscodes エントリの params/handler が hub.registerPasscodes に 1:1
- surface: serve
- backend: cloud
- command: access.registerPasscodes (RPC)
- branch: -
- assert: deviceUUID/passcodes を required で宣言し requireAuth→need→hub.registerPasscodes(deviceUUID,passcodes) を呼ぶ registry エントリが存在する
- ref: packages/kit/src/serve/entries/device.js:106-114
- kind: contract-existence
- status: planned

## serve-auth-data

### [ACC-0051] serve access.postAuthenticationData エントリの params/handler が hub.postAuthenticationData に 1:1
- surface: serve
- backend: cloud
- command: access.postAuthenticationData (RPC)
- branch: -
- assert: operation/deviceID/items を required・baseUrl を optional で宣言し requireAuth→need(['operation','deviceID','items'])→hub.postAuthenticationData(params) を呼ぶ accessAuthEntries が存在し registry に set される
- ref: packages/kit/src/serve/entries/device.js:352-357; packages/kit/src/serve/registry.js:341
- kind: contract-existence
- status: planned

### [ACC-0052] serve access.put/deleteAuthenticationData エントリ存在と 1:1 配線
- surface: serve
- backend: cloud
- command: access.putAuthenticationData / access.deleteAuthenticationData (RPC)
- branch: put | delete
- assert: 両エントリが operation/deviceID/items を required で宣言し requireAuth→need→hub.put/deleteAuthenticationData(params) へ配線される (post と同型)
- ref: packages/kit/src/serve/entries/device.js:358-369
- kind: contract-existence
- status: planned

### [ACC-0053] serve access.updateAuthenticationName エントリは request/kind+全フィールドを optional で受ける
- surface: serve
- backend: cloud
- command: access.updateAuthenticationName (RPC)
- branch: request 直指定 | kind+個別フィールド
- assert: request/kind/各 *NameUUID/*ID/cardType/type/op 等を全て optional で宣言し need() を呼ばず hub.updateAuthenticationName(params) へ素通しする (kind 検証は core 側 authenticationNameRequest が担う)
- ref: packages/kit/src/serve/entries/device.js:370-397; packages/core/src/access.js:734-737,741,790-791
- kind: surface-parity
- status: planned
- note: device.js:370-396 で全 params required:false・handler は requireAuth 後 need() 無しで hub.updateAuthenticationName(params) を呼ぶ。kind 検証は core access.js:741 authenticationNameRequest の switch default(:790-791)が badRequest('access.err.kindRequired') で担保 — assert の core 帰属を裏付けるため core ref を追加。

## serve-parity

### [ACC-0054] serve registry: access.* 11 op が NAMESPACE_OPS から自動公開される
- surface: serve
- backend: cloud
- command: access.getCards/getPasscodes/postCards/postPasscodes/delCards/delPasscodes/clearCards/clearPasscodes/updateCardName/updatePasscodeName/updateCardOwner
- branch: -
- assert: serve registry が access モジュールの NAMESPACE_OPS(11 op)を access.<op> として 1:1 で reg.set し、捏造 op を増やさない
- ref: packages/kit/src/serve/registry.js:287-303; packages/core/src/access.js:972-976
- kind: contract-existence
- status: planned
- note: syncEnrolledCards/Passcodes は委譲糊で allowlist に載らない。検証済: registry.js:97 NS_MODULES に access 同梱、288-303 の for ループが ${ns}.${op} を reg.set(handler は hub[ns][op] へ委譲)。access.js:972-976 は厳密に 11 op の配列。行範囲を reg.set+handler 全体(287-303)へ修正。

### [ACC-0055] serve: access.delCards/delPasscodes の戻り(boolean)が全 framing で同一封筒になる
- surface: serve
- backend: cloud
- command: access.delCards / access.delPasscodes
- branch: items空(false) | 非空(true)
- assert: fire-and-forget な delCards/delPasscodes の boolean 戻りが serve の各 framing(jsonrpc/grpc 等)で同じ結果封筒に包まれる
- ref: packages/core/src/access.js:514-518; packages/kit/src/serve/registry.js:287-303
- kind: surface-parity
- status: planned
- note: 検証済(構造): access.js:514-518 delCards / 534- delPasscodes は items 空で false、非空で send 後 true を返す boolean 契約。registry.js:288-303 は単一 handler(hub[ns][op] の戻り値)を全 framing 共通で返すため封筒包みは framing 層(packages/kit/src/serve/framing/{grpc,http,ndjson,ws,...}.js)が担う。封筒同一性は cross-framing の実行時性質で、ここでは「同一値が同一 handler 経由で各 framing に入る」構造的根拠まで支持。完全な封筒一致は runtime 検証要。

## serve-error

### [ACC-0056] access.* RPC は未認証で NOT_AUTHENTICATED 封筒を返す (requireAuth)
- surface: serve
- backend: cloud
- command: access.registerCards / access.postAuthenticationData ほか
- branch: 未認証 | cloud 未接続 | 認証済み
- assert: daemon 未認証で RpcError(kind:NOT_AUTHENTICATED)、cloud 未接続で CONNECTION_LOST を投げる共通エラー封筒が全 access.* handler の先頭 requireAuth で成立する
- ref: packages/kit/src/serve/entries/device.js:101,356; packages/kit/src/serve/registry-helpers.js:55-62
- kind: error-path
- status: planned
- note: device.js:101(access.registerCards handler)・:356(access.postAuthenticationData handler)が冒頭で requireAuth(daemon) を呼ぶ。requireAuth 本体は registry-helpers.js:55-62 (authState==='expired'→NOT_AUTHENTICATED :56-57 / !hub.connected→CONNECTION_LOST :59-60、関数末尾の } は 62 行)。範囲を 55-61→55-62 に補正。

### [ACC-0057] access.* RPC は必須欠落で INVALID_PARAMS/BAD_PARAMS を返す (need)
- surface: serve
- backend: cloud
- command: access.registerCards / access.postAuthenticationData
- branch: deviceUUID 欠落 | items/cards 欠落
- assert: need() が欠落キー検出時 RpcError(code:INVALID_PARAMS, kind:BAD_PARAMS, message=serve.missingParam) を投げる契約が成立する
- ref: packages/kit/src/serve/entries/device.js:101,356; packages/kit/src/serve/registry-helpers.js:32-38
- kind: error-path
- status: planned
- note: device.js:101 は need(params,['deviceUUID','cards'])、:356 は need(params,['operation','deviceID','items'])。need 本体は registry-helpers.js:32-38 で、欠落(undefined/null/'')時に throw new RpcError(t('serve.missingParam'),{code:RPC.INVALID_PARAMS,kind:KIND.BAD_PARAMS}) を投げる(:35)。throw を含む範囲に補正 32-36→32-38。

## sdk-parity

### [ACC-0058] SDK(ts/py): access.* 11 op の生成シグネチャが core 契約と一致
- surface: sdk
- backend: cloud
- command: access.getCards/postCards/delCards/clearCards/updateCardName/updateCardOwner/getPasscodes/postPasscodes/delPasscodes/clearPasscodes/updatePasscodeName
- branch: ts | py
- assert: 生成 ts/py SDK が access.* 11 op を core の params 形(deviceUUIDs/list/items/item/deviceUUID/ownerSubUUID 等)で 1:1 公開し method 名・引数が一致する
- ref: packages/kit/sdk/ts/sesame-client.ts:172-206; packages/kit/sdk/python/sesame_client.py:330-396
- kind: contract-existence
- status: planned
- note: 検証済: ts は readonly access={...}(172- )内に 11 op 全て(getCards:deviceUUIDs, postCards:list, delCards:items, updateCardName:item, updateCardOwner:item/cardID/ownerSubUUID 等)を含む。py は class _Access(330- clearCards 〜 396 updatePasscodeName)に同 11 op。両 SDK は 11 op を 1:1 公開(register*/postAuthenticationData 等の追加 op も併存するが assert は『11 op が存在し形一致』を主張し成立)。py 範囲を class 本体先頭(330)起点へ修正。

## sdk-contract

### [ACC-0059] gRPC 生成契約に access auth-data/register の 4+2 メソッドが存在する
- surface: sdk
- backend: cloud
- command: access.postAuthenticationData / putAuthenticationData / deleteAuthenticationData / updateAuthenticationName / registerCards / registerPasscodes
- branch: -
- assert: grpc-methods.generated.json に当該 6 メソッドが registry と 1:1 で生成されている (sdk 面の存在性)
- ref: packages/kit/src/serve/grpc-methods.generated.json:1613-1626; packages/kit/src/serve/grpc-methods.generated.json:1831-1886
- kind: contract-existence
- status: planned
- note: AccessRegisterCards(:1613-1619)・AccessRegisterPasscodes(:1620-1626) と AccessPostAuthenticationData(:1831-1839)/Put(:1840-1848)/Delete(:1849-1857)/UpdateAuthenticationName(:1858-1886) を実在確認。元 ref 1614-1621/1832-1859 はメソッド定義ブロックを途中で切っていたためエントリ全体を含む範囲へ補正。

## cli-list

### [ACC-0060] cli access cards ls: --device 正規化(variadic/カンマ連結)→ getCards
- surface: cli
- backend: cloud
- command: sesame access cards ls --device <uuid...>
- branch: --device指定 | 対話選択 | 非対話で必須エラー(exit 2)
- assert: --device の variadic/カンマ連結を deviceUUID 配列へ正規化し、未指定かつ非対話なら deviceRequired で exit 2 する
- ref: packages/kit/src/cli/access.js:73-110; packages/kit/src/cli/access.js:231-258
- kind: option-branch
- status: planned
- note: 確認済: normalizeDevices(76-79 で flatMap+split(',') 分解), resolveDeviceUUIDs 非対話 deviceRequired exit2 (108), 対話 selectFromList (101-106), variadic '<uuid...>' (234)。第1 ref は両ヘルパ(73-80,92-110)を内包。

### [ACC-0061] cli access cards ls --json: items/byDevice を JSON 封筒で出力
- surface: cli
- backend: cloud
- command: sesame access cards ls
- branch: --json(JSON封筒) | 人間表示 | 0件
- assert: --json 指定時に {ok,count,items,byDevice} を出力し、非 --json では foundCards/noCards の人間表示に分岐する
- ref: packages/kit/src/cli/access.js:244-256
- kind: option-branch
- status: planned
- note: 確認済: ctx.out の jsonObj が {ok,count,items,byDevice}(256), 人間側 noCards(246)/foundCards(249)。byDevice 由来は core/access.js:294-328 (getCards 戻り {byDevice,items})。

## cli-rm

### [ACC-0062] cli access cards rm: --json 必須・配列検証 (exit 2)
- surface: cli
- backend: cloud
- command: sesame access cards rm --json <items>
- branch: --json欠落(exit2) | 非配列(exit2) | 正常send
- assert: --json 欠落で jsonRequired・パース結果が非配列で items.notArray を exit 2 で die し、配列なら delCards へ渡し sent(boolean) を反映する
- ref: packages/kit/src/cli/access.js:261-284; packages/core/src/access.js:514-518
- kind: error-path
- status: planned
- note: 確認済: jsonRequired exit2(269), items.notArray exit2(275), delCards→sent boolean(279-282)。delCards が boolean を返す根拠 (core/access.js:514-518, items 空で false/送信で true) を第2 ref に追加。

## cli-clear

### [ACC-0063] cli access cards clear: 対話 confirm 拒否で中止(送信なし)
- surface: cli
- backend: cloud
- command: sesame access cards clear --device <uuid>
- branch: confirm承認(clear) | 拒否(aborted) | 非対話(無確認実行)
- assert: 対話可能時は clearConfirm を出し拒否なら送信せず中止、承認/非対話なら clearCards を呼ぶ分岐が成立する
- ref: packages/kit/src/cli/access.js:287-310
- kind: option-branch
- status: planned
- note: 確認済: canPrompt 時 clearConfirm(299), 拒否で aborted を出し return(301-303 送信なし), 承認/非対話で clearCards(305)。

## cli-name

### [ACC-0064] cli access cards name: 非v4 cardNameUUID で警告 stderr 後に続行
- surface: cli
- backend: cloud
- command: sesame access cards name --json <item>
- branch: --json欠落(exit2) | v4(無警告) | 非v4(警告+続行)
- assert: --json 欠落で exit 2、cardNameUUID/nameUUID が非 v4 のとき stderr 警告を出すが処理は中断せず updateCardName を呼ぶ
- ref: packages/kit/src/cli/access.js:312-344; references_web/src/api/useManageAuthData.js:431-471
- kind: error-path
- status: planned
- note: 確認済: jsonRequired exit2(320), nameUUID=cardNameUUID??nameUUID(330), 非 v4 で stderr 警告のみ(331-338), 中断せず updateCardName(339)。biz3 出典は updateItemName 全体で isUUIDV4 分岐の先頭(431)から含めるよう 438-471→431-471 に補正。

## cli-owner

### [ACC-0065] cli access cards owner: ownerSubUUID undefined で必須エラー / '' で解除送信
- surface: cli
- backend: cloud
- command: sesame access cards owner <cardID> [ownerSubUUID]
- branch: 引数あり | 対話入力 | undefined非対話(exit2) | ''(解除)
- assert: ownerSubUUID 省略かつ非対話なら ownerSubUUIDRequired で exit 2、'' を渡せば未割当解除として updateCardOwner を送る境界が biz3 ガードに整合する
- ref: packages/kit/src/cli/access.js:346-368; references_web/src/api/useManageAuthData.js:346-353
- kind: option-branch
- status: planned
- note: 確認済: undefined+対話で promptText(353-358), undefined のまま非対話で ownerSubUUIDRequired exit2(359-361), '' は undefined ではないため通過し updateCardOwner(363)。biz3 updateCardOwner の 'ownerSubUUID' in item ガード(348)に整合('' は in 真)。

## cli-post

### [ACC-0066] cli access passcodes post: 空 list で emptyList 表示(null 戻り)
- surface: cli
- backend: cloud
- command: sesame access passcodes post --device <uuid> --json <list>
- branch: --json欠落(exit2) | 非配列(exit2) | 空list(null表示) | 正常
- assert: postPasscodes が null(list空)を返したら post.emptyList、それ以外は posted を表示する分岐と --json/配列検証の exit 2 が成立する
- ref: packages/kit/src/cli/access.js:571-598; packages/core/src/access.js:490-493
- kind: option-branch
- status: planned
- note: 確認済: passcodes post コマンドは 571-598 (jsonRequired exit2:579, list.notArray exit2:585, resp===null→emptyList:595)。core postPasscodes は list<1 で null(491)。両 ref 正確。

## cli-enroll

### [ACC-0067] cli access cards enroll: 複数タップ集約 → hub.registerCards 一括登録
- surface: cli
- backend: ble, cloud
- command: sesame access cards enroll --device <uuid>
- branch: 対話(promptText) | 非対話(timeout 待ち)
- assert: BLE cardModeSet(1)→registerDelegate.onCardReceive で収集→cardModeSet(0)→unsub の順で取りこぼさず、収集レコードを hub.registerCards(deviceUUID,records) へ渡す配線が成立する
- ref: packages/kit/src/cli/access.js:145-213,405-430
- kind: option-branch
- status: planned
- note: runBleEnroll(:145-213) が registerDelegate(collect)(:176-178)→modeSet(bio,1)(:180)→対話 promptText(:182)/非対話 setTimeout(:184-186)→finally で modeSet(bio,0)(:189)→unsub()(:190) の順を実装。cards enroll 配線は :405-430 で delegateFor が onCardReceive(:419)・register が hub.registerCards(:422)。既存 access-enroll.test.js:60 が同観点 ([ID] タグ無し=planned 整合)。検証済み。

### [ACC-0068] cli access passcodes enroll: onKeyBoardReceive 収集 → hub.registerPasscodes (SURF-04 対称)
- surface: cli
- backend: ble, cloud
- command: sesame access passcodes enroll --device <uuid>
- branch: 対話 | 非対話
- assert: passcodeModeSet で register モードにし onKeyBoardReceive で {cardID,cardName,cardType} を収集→hub.registerPasscodes へ渡す、cards enroll と同型の delegate 差し替え経路が成立する
- ref: packages/kit/src/cli/access.js:543-569
- kind: option-branch
- status: planned
- note: passcodes enroll(:543-569)が runBleEnroll を kind 差し替えで共有: hasCapability=passcodeModeSet(:551)・delegateFor onKeyBoardReceive→collect(cardID,{cardID,cardName,cardType})(:557-558)・modeSet=passcodeModeSet(:560)・register=hub.registerPasscodes(:561)。cards enroll と同型を確認。検証済み。

### [ACC-0069] cli enroll: 同一 id 重複排除と 0 件時 enrolled:0 早期return
- surface: cli
- backend: ble
- command: sesame access cards enroll / passcodes enroll
- branch: 重複 id | 0 件 | 1 件以上
- assert: collected Map で同一 id を重複排除し、records 0 件なら register を呼ばず {ok:true,enrolled:0,deviceUUID} を出力する
- ref: packages/kit/src/cli/access.js:171,176-178,202-206
- kind: option-branch
- status: planned
- note: collected Map 宣言(:171)・collect が id 有り時 collected.set(id,record)(:176-178)で重複排除、records=[...collected.values()](:202)が 0 件なら register 未呼び出しで ctx.out(...,{ok:true,enrolled:0,deviceUUID})(:204) を return。元 ref 171-178 は Map 宣言(171)と collect(176-178)の間に連続しない行を含むため 171,176-178 に補正。検証済み。

### [ACC-0070] cli enroll: bioCaps 限定ビューに能力メソッドが無い機種は die(2)
- surface: cli
- backend: ble
- command: sesame access cards enroll / passcodes enroll
- branch: biometric ゲッタ throw | cardModeSet/passcodeModeSet 不在 | 能力あり
- assert: ble.biometric ゲッタ throw もしくは hasCapability(cardModeSet/passcodeModeSet 未定義) で notCapableKey を die(2) し op を捏造しない
- ref: packages/kit/src/cli/access.js:162-169,415-416,551; packages/core/src/ble/index.js:512-555
- kind: error-path
- status: planned
- note: 検証済: access.js:164-169 が ble.biometric (index.js:512-526 で badRequest throw) を catch し notCapableKey die(2)。bioCaps 限定ビュー (index.js:533-535) は集合外 capability のメソッドを bind しないため cardModeSet/passcodeModeSet 不在で hasCapability=false→die(2)。415-416/551 の hasCapability 配線も一致。

### [ACC-0071] cli enroll: secretKey 欠落/デバイス未発見/BLE 失敗の終了コード
- surface: cli
- backend: ble
- command: sesame access cards enroll / passcodes enroll
- branch: deviceNotFound die(2) | noSecretKey die(2) | bleFailed die(1)
- assert: クラウド一覧に無い/secretKey 無しは die(2)、connect/modeSet 例外は modeSet(0)+close 後始末後 die(1) という終了コード分岐が成立する
- ref: packages/kit/src/cli/access.js:152-156,192-200
- kind: error-path
- status: planned
- note: 検証済: 152-156 が listDevices→find 無し deviceNotFound die(2)/secretKey 無し noSecretKey die(2)。192-200 の catch が modeSet(0)+ble.close()後 bleFailed die(1)、finally でも close()。i18n キー (access.js i18n:83-86) 実在。

## cli-auth-data

### [ACC-0072] cli access auth-data post: operation/device-id/items 必須検証と die(2)
- surface: cli
- backend: cloud
- command: sesame access auth-data post --operation --device-id --items
- branch: operation 欠落 | device-id 欠落 | items 欠落 | items 非JSON | items 非配列
- assert: operation/deviceId/items のいずれか欠落で die(2)、items JSON parse 失敗で undefined→return、非配列で die(2) し、揃えば hub.postAuthenticationData へ渡す (serve need() と同型)
- ref: packages/kit/src/cli/access.js:609-629; packages/kit/src/serve/entries/device.js:352-357
- kind: error-path
- status: planned
- note: 検証済: 618-620 が operation/deviceId/items 欠落 die(2)、621-622 parseJson 失敗 undefined→return (ctx.js:237-243)、623 非配列 die(2)、624 hub.postAuthenticationData。serve は device.js:356 で need(params,[operation,deviceID,items])。ref device.js を 352-357 (entry+handler) に補正 (元 356 は handler 行のみ)。

### [ACC-0073] cli access auth-data put/delete: post と同型の必須検証
- surface: cli
- backend: cloud
- command: sesame access auth-data put / delete
- branch: put | delete / 必須欠落 | 非配列
- assert: put/delete も operation/deviceId/items 必須検証→hub.put/deleteAuthenticationData の post 対称配線が成立する
- ref: packages/kit/src/cli/access.js:631-673
- kind: surface-parity
- status: planned
- note: 検証済: put(632-651)/delete(654-673) とも 640-645/662-667 で post と同一の必須+非配列検証、646/668 で hub.putAuthenticationData/deleteAuthenticationData。

### [ACC-0074] cli access auth-data name: kind 省略可、--json で残りフィールド合成
- surface: cli
- backend: cloud
- command: sesame access auth-data name --kind <kind> --json <fields>
- branch: kind 指定 | kind 省略(request 直指定) | --json 無し
- assert: kind 省略可で --json の fields を {kind, ...extra} に合成し hub.updateAuthenticationName へ渡す (core が request 有れば kind 無しでも動く分岐に対応)
- ref: packages/kit/src/cli/access.js:679-696; packages/core/src/access.js:734-738
- kind: option-branch
- status: planned
- note: 検証済: 688-690 が --json 無しなら {} で extra、{kind:subOpts.kind, ...extra} を合成し 691 で updateAuthenticationName。core access.js:736 が params.request ? {...request} : authenticationNameRequest(params) で request 有れば kind 不要。

### [ACC-0075] cli auth-data 系の --json 出力封筒 (ctx.out human/json 分岐)
- surface: cli
- backend: cloud
- command: sesame access auth-data post/put/delete/name
- branch: --json 有 | 無し(human)
- assert: --json 時は {ok,operation,deviceID,response} 等の構造化封筒、非 --json 時は t() の人間向けメッセージという ctx.out の二分岐が全 auth-data サブコマンドで成立する
- ref: packages/kit/src/cli/access.js:625-628,647-650,669-672,692-694
- kind: surface-parity
- status: planned
- note: 検証済: post/put/delete は ctx.out(opts.json, ()=>console.log(t(...)), {ok,operation,deviceID,response})。name(692-694) は {ok,kind,response} (deviceID でなく kind) だが assert の '等' が許容。ctx.out 二分岐は全 4 サブコマンドで成立。

### [ACC-0076] cli auth-data は withAccount でなく withHub を使う (余分な GetLoginUser 往復なし)
- surface: cli
- backend: cloud
- command: sesame access auth-data * / cards|passcodes *
- branch: -
- assert: access 系は送信フレームに companyID/subUUID を載せないため ctx.withHub(connect→fn→close) を使い refreshAccount/biz3GetLoginUser 往復を避ける配線が成立する
- ref: packages/kit/src/cli/access.js:12-23,616,639,661,685; packages/kit/src/cli/ctx.js:118-135,219-222
- kind: surface-parity
- status: planned
- note: local-contract 寄り (kit 内設計の不変)。検証済: access.js 全 action が ctx.withHub (12-15 コメントが理由を明記)。ctx.js:118-135 で withHub=connect→fn→close、219-222 で withAccount のみ refreshAccount() (client.js:446 = biz3GetLoginUser, account.js:10) を追加実行。ctx 供給は cli.js でなく ctx.js だが ref 行は正。

## cli-i18n

### [ACC-0077] cli access: ja/en メッセージカタログ完全性 (access.* キー)
- surface: cli
- backend: local
- command: sesame access *
- branch: ja | en
- assert: CLI access コマンドが参照する access.* i18n キー(cmd/opt/err/prompt/出力文言)が各ロケールカタログ(en/ja)で欠落なく一致する
- ref: packages/kit/src/cli/access.js:98-693; packages/core/src/i18n/access.js:3-222
- kind: i18n
- status: planned
- note: 行番号修正: CLI の t("access.*") 消費は L98 (registerAccessCommands より前のヘルパ access.err.noDevices/prompt.pickDevice/err.deviceRequired/cards.enroll.*) から L693 まで。元 ref 219-697 は先頭ヘルパ群を取りこぼし末尾は閉じ括弧。カタログは en(3-112)/ja(113-222) 各101キーで authData 含め parity 確認済。

## 監査追補 v2 (dual-audit)

### [ACC-0078] cli access passcodes name: 非v4 keyBoardPassCodeNameUUID の v4 警告分岐が未実装 (cards name の ACC-0064 と非対称)
- surface: cli
- backend: cloud
- command: sesame access passcodes name --json <item>
- branch: v4(無警告) | 非v4(警告すべきだが現状は無警告)
- assert: passcodes name は keyBoardPassCodeNameUUID/nameUUID が非 v4 のとき biz3 updateItemName(UPDATE_CONFIGS.password, SSM_OS3_PASSCODE_CHANGE) の BLE 前段に対応する v4 警告を stderr に出すべきだが、現状 CLI は isUuidV4 判定を行わず警告しない (cards name は行う) 非対称を文書化する
- ref: packages/kit/src/cli/access.js:513-531; packages/kit/src/cli/access.js:331-338; references_web/src/api/useManageAuthData.js:431-471; packages/core/src/i18n/access.js:36
- kind: option-branch
- status: planned
- note: 実装疑い: cli passcodes name action(cli/access.js:513-531)が isUuidV4 を一切呼ばず非v4警告を出さない。cards name(:331-338)は警告する。i18n access.opt.passcodes.name.json(i18n/access.js:36 en/:146 ja)はヘルプ上 v4 を要求するのに実コードに警告が無い。参照 useManageAuthData.js:438 updateItemName は card/password 両方に isUUIDV4 を適用(別タスクで修正)。本来あるべき正しい挙動(=passcodes name も非v4で警告)を assert とした。ACC-0064(cards name)/ACC-0025(crypto-vector 正典 [[CRY-0011]])と相補。

### [ACC-0079] postAuthenticationData の wire キー(op/deviceID/items)正準出典 = AuthenticationDataWrapper.kt の @SerializedName
- surface: core, serve, cli
- backend: cloud
- command: access.postAuthenticationData / putAuthenticationData / deleteAuthenticationData
- branch: -
- assert: POST /device/v1/biometrics body の wire キーが op/deviceID/items であることの正準出典は AuthenticationDataWrapper.kt:6-8 の @SerializedName("op")/("deviceID")/("items") であり(Kotlin property operation/credentialList が wire 上 op/items に化ける)、これが ACC-0026/0028/0029 の body.op='operation+suffix' 主張の機械検証根拠となる
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/AuthenticationDataWrapper.kt:6-8; packages/core/src/access.js:683-687
- kind: wire-fidelity
- status: planned
- note: 検証済: AuthenticationDataWrapper.kt:5-8 で @SerializedName("op") var operation / ("deviceID") val deviceID / ("items") val credentialList を実在確認。ACC-0026/0028/0029 は CHDataSynchronizeCapableImpl.kt/CHAPIClient.kt のみ ref とし『op』が wire 名である @SerializedName 根拠を欠いていたため、その ref-boundary を本エントリで補完。access.js:684 が body.op を送る fidelity を支える唯一の出典。

### [ACC-0080] makeBiometricsTransport 互換(非推奨)経路: Authorization ヘッダのみ(x-api-key/SigV4 無し)で fetch
- surface: core
- backend: cloud
- command: makeBiometricsTransport
- branch: authorization | bearerToken('Bearer '連結) | authorizationProvider(都度解決)
- assert: credentialsProvider/getIdToken が無く authorization/bearerToken/authorizationProvider のいずれかがある場合、transport は SigV4/x-api-key を付けず Authorization ヘッダのみ(bearerToken は 'Bearer '+token に整形)で fetch する非推奨経路に分岐する。参照 SDK にこの REST 認可は存在しない negative fact を併記する
- ref: packages/core/src/access.js:207-227; packages/core/src/access.js:74-80
- kind: wire-fidelity
- status: planned
- note: @experimental/非推奨。検証済: access.js:213-214 auth=authorization||(bearerToken?`Bearer ${bearerToken}`:await authorizationProvider())、:215-222 で content-type+authorization ヘッダのみ(x-api-key も SigV4 も無し)。access.js:74-80 JSDoc が『参照 SDK に idToken Bearer の REST 認可は存在せず実 API Gateway には拒否される』と negative fact を明記。ACC-0032(SigV4 経路)/ACC-0033(認可ソース全欠で badRequest)とは別境界(:207-227)。bearerToken の 'Bearer '前置整形が特に未テスト。

### [ACC-0081] makeBiometricsTransport: appIdentifyId/config/configStore を受理して無視する (appidentifyid 非付与の negative fact)
- surface: core
- backend: cloud
- command: makeBiometricsTransport
- branch: appIdentifyId 指定 | config 指定 | configStore 指定(いずれも無視)
- assert: appIdentifyId/config/configStore を渡しても /device/v1/biometrics には appidentifyid ヘッダを付けず、これらは互換受理のみで無視される(CHAPIClient.kt:105-106 biometricsOperation に appidentifyid 引数が無い negative fact の回帰ガード)
- ref: packages/core/src/access.js:177-204; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:105-106
- kind: option-branch
- status: planned
- note: 検証済: access.js:177-186 の destructure は appIdentifyId/config/configStore を受け取らず(JSDoc :74-76 で『互換・無視』を宣言)、:200-201 コメントで appIdentifyId を makeApiGatewayTransport へ渡さない(既定 null=ヘッダ無し)。旧実装が常時付与していた逸脱を撤去した経緯の回帰防止。ACC-0032 に内包しうるが入力オプション分岐としては別エントリ。ACC-0080(:207-227)/ACC-0083(:187)とは別境界(SigV4 経路 :177-204)。

### [ACC-0082] withSuffix: operation 欠落で badRequest('operationRequired') を throw (post/put/delete 共通)
- surface: core
- backend: local
- command: postAuthenticationData / putAuthenticationData / deleteAuthenticationData
- branch: operation 有 | operation 欠落(throw)
- assert: operation が falsy のとき withSuffix が badRequest('access.err.operationRequired') を throw し、_post/_put/_delete の body を組まずに中断する (kit 側入力検証。参照は型で非null保証)
- ref: packages/core/src/access.js:244-247; packages/core/src/access.js:684,703,719; packages/core/src/i18n/access.js:110,220
- kind: error-path
- status: planned
- note: 検証済: access.js:245 if(!operation) throw badRequest("access.err.operationRequired") が post/put/delete の 3 経路(684/703/719 が withSuffix を呼ぶ)で発火。JSDoc(:241)も『operation 欠落時の throw は kit 側入力検証(参照は型で非null保証)』と明示。i18n キー access.err.operationRequired は en:110/ja:220 に実在。ACC-0030(withSuffix 無条件二重連結)/ACC-0031(items 非配列正規化)とは別系統の異常系で、serve 経路の need() は ACC-0057 が拾うが core/sdk 直叩きは本 throw が唯一の終端。

### [ACC-0083] makeBiometricsTransport: fetchImpl 非関数 guard (fetchRequired)
- surface: core
- backend: local
- command: makeBiometricsTransport
- branch: fetchImpl 関数 | 非関数(throw)
- assert: fetchImpl (既定 globalThis.fetch) が関数でない場合 badRequest('access.err.fetchRequired') を throw し transport を構築しない
- ref: packages/core/src/access.js:187; packages/core/src/i18n/access.js:109,219
- kind: error-path
- status: planned
- note: 検証済: access.js:187 if(typeof fetchImpl!=="function") throw badRequest("access.err.fetchRequired")。globalThis.fetch が無い実行環境(古い Node)で transport 構築前に発火する唯一の前段 guard。i18n キー access.err.fetchRequired は en:109/ja:219 に実在。ACC-0033(認可ソース未指定)/ACC-0034(baseUrl 検証)と同じ makeBiometricsTransport 異常系群を完備させる(:187 は最前段 guard)。

### [ACC-0084] postBiometrics: 注入 transport が unwrap 済み body(status 非number)を返す bypass 分岐
- surface: core
- backend: cloud
- command: postBiometrics (内部)
- branch: transport が {status,text,json} 返却(assertHttpOk経由) | 既に unwrap 済み body 返却(bypass)
- assert: transport の戻りが res.status を持たない (テスト/注入 transport が unwrap 済み body を返す) 場合は assertHttpOk をスキップしてその body をそのまま返す
- ref: packages/core/src/access.js:250-256
- kind: option-branch
- status: planned
- note: 検証済: access.js:253 if(!res||typeof res.status!=="number") return res; の早期 return。resolveBiometricsTransport(:231-233)が transport 注入を許すため、テスト/特殊環境で status 無しの body が返ると HTTP 検証を経ずに透過する経路が実在し、post/put/delete/updateAuthenticationName 全 4 REST op の戻り解釈に影響する。ACC-0035(assertHttpOk 非2xx reject)とは別の内部境界(postBiometrics :253)。
