<!-- spec-domain: keystore | prefix: KS | tests: packages/kit/tests/serve, packages/core/tests -->

# 個人鍵ストア spec (KS, @experimental)

keystore.* (list/put/remove) を biz3 web (useDeveloper / 個人鍵ストア REST) に照らして監査する。@experimental 面。

## contract

keystore 3 メソッド (list/put/remove) が serve registry・stability・SDK(ts/py)・gRPC proto に 1:1 で存在し、experimental 安定度で露出する契約面を固定する。

### [KS-0001] keystore.list/put/remove が serve registry に 1:1 で存在 (@experimental)
- surface: serve
- backend: cloud
- command: keystore.list / keystore.put / keystore.remove
- branch: -
- assert: buildRegistry() に keystore.list/put/remove の 3 メソッドが keyStoreEntries() 経由で登録され、各 summary/params/result 宣言が存在する(registry パッチ方式禁止)
- ref: packages/kit/src/serve/entries/device.js:270-344; packages/kit/src/serve/registry.js:342
- kind: contract-existence
- status: covered
- note: registry.js:342 が keyStoreEntries() を Object.entries で reg.set 反復し buildRegistry に組み込む(確認)。device.js:262-264 の『buildRegistry に直接接続しない』は keyStoreEntries 関数自身が buildRegistry を呼ばない意で、登録自体は registry.js:342 が行う(矛盾なし)。

### [KS-0002] keystore 3 メソッドの x-stability=experimental (provenance unverified)
- surface: serve
- backend: cloud
- command: keystore.list / keystore.put / keystore.remove
- branch: -
- assert: 正典 [[CTR-0032]] を参照 (STABLE_METHODS 非掲載 → stabilityOf=experimental・provenanceOf=unverified の experimental 表示機構)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0032]]）
- note: stabilityOf(keystore.*)=experimental かつ STABLE_METHODS 非掲載という experimental 表示機構の不変条件 (stability.js:57) は contract.md [[CTR-0032]] が正典。keystore @experimental が stable へ昇格していない KS 固有の理由 (実 API Gateway 受理未検証) は [[KS-0011]] (waived) が保持する。なお [[KS-0001]] (keyStoreEntries() registry 結線・summary/params/result 宣言, registry.js:342) は CTR-0032 (registry.js:380 OpenRPC 射影) と ref が異なり重複しないため残置。

### [KS-0003] keystore 3 メソッドが SDK(ts/py) に生成され署名が registry params と一致
- surface: sdk
- backend: cloud
- command: keystore.list / keystore.put / keystore.remove
- branch: ts | py
- assert: ts sesame-client.ts と py sesame_client.py の keystore.{list,put,remove} メソッド署名(必須/任意パラメータ集合)が serve registry の params 宣言と 1:1 一致する
- ref: packages/kit/sdk/ts/sesame-client.ts:492-499; packages/kit/sdk/python/sesame_client.py:964-974; packages/kit/src/serve/entries/device.js:278-333
- kind: contract-existence
- status: covered
- note: py 行番号修正: _Keystore クラスは :960-974 で list def は :964(旧 :966 は list 本文行)→ :964-974。registry params は list(:278-280)/put(:294-303)/remove(:331-333) を全網羅するため device.js を :278-333 に拡張。ts put 署名 {deviceUUID,deviceModel,keyIndex,secretKey,sesame2PublicKey,deviceName?,keyLevel,appIdentifyId?} と py 同形・registry が 1:1 一致(確認)。

### [KS-0004] keystore 3 メソッドが grpc-methods.generated / proto に存在 (gRPC framing 露出)
- surface: serve, sdk
- backend: cloud
- command: keystore.list / keystore.put / keystore.remove
- branch: -
- assert: grpc-methods.generated.json と sesame.proto に keystore.list/put/remove が出力され、CONTRACT_VERSION のメソッド数(205)に keystore 3 件が算入される
- ref: packages/kit/src/serve/grpc-methods.generated.json:1888-1903; packages/kit/src/serve/sesame.proto:385-389; packages/kit/tests/serve/contract-fingerprint.test.js:83-85
- kind: contract-existence
- status: covered
- note: grpc-methods.generated.json は KeystoreList(method=keystore.list :1888)/KeystorePut(:1895)/KeystoreRemove(:1903) を出力(確認)。assert は proto も主張するが proto 未参照だったため sesame.proto:385-389(rpc KeystoreList/Put/Remove)を追加。CONTRACT_VERSION='1.4.0'(jsonrpc.js:53)、test:83-85 が 205=202+keystore3 を機械確認(確認)。

### [KS-0005] client._keyStoreTransport が registerBaseUrl / tokenStore / config を結線
- surface: core
- backend: cloud
- command: SesameClient.keyStoreList/Put/Remove
- branch: appIdentifyId 注入 | 省略(config 解決)
- assert: client の keyStore* が _keyStoreTransport で baseUrl=config.registerBaseUrl, tokenStore, config, configStore, appIdentifyId を makeKeyStoreTransport に渡し、devices.getDevicesList/putKey/removeKey へ委譲する結線
- ref: packages/core/src/client.js:1245-1294
- kind: contract-existence
- status: covered
- note: 確認済: 1245-1253 _keyStoreTransport が baseUrl=this._config.registerBaseUrl, tokenStore, config, configStore, appIdentifyId を makeKeyStoreTransport へ。1263-1266 keyStoreList→getDevicesList、1277-1280 keyStorePut→putKey、1291-1294 keyStoreRemove→removeKey 委譲。行ズレなし。

## surface

core 直呼び・serve RPC・SDK 経由が同一 wire と同一封筒を生む surface-parity を固定する。

### [KS-0006] keystore 3 操作が core/serve(全 framing)/sdk で同一封筒・同一結果 (serve 宣言 7 フィールド部分集合の範囲で surface-parity)
- surface: core, serve, sdk
- backend: cloud
- command: keyStoreList/Put/Remove / keystore.list/put/remove
- branch: core-direct | serve-rpc(rank/subUUID/stateInfo 脱落) | sdk-generated
- assert: serve が宣言する 7 フィールド (deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/deviceName/keyLevel) 部分集合の範囲で、core 直呼び・serve RPC・SDK 経由が同じ transport wire(method/path/body) と結果封筒(CHUserKey[] / server response) を生む。rank/subUUID/stateInfo を含む CHUserKey は serve RPC では脱落するため (core-direct のみ送出) この 3 フィールドでは parity が成立しない
- ref: packages/core/src/client.js:1263-1294; packages/kit/src/serve/entries/device.js:282-342; packages/kit/src/serve/entries/device.js:312-321; packages/kit/sdk/ts/sesame-client.ts:492-499
- kind: surface-parity
- status: covered
- note: 補正: serve put handler (device.js:312-321) は body を 7 フィールドで再構築し rank/subUUID/stateInfo を落とす (params 宣言 device.js:294-303 にもそれらは無く RPC 経路では受理すらされない) 一方、core keyStorePut(key) (client.js:1277-1279) は受け取った CHUserKey を devices.putKey へ素通し (devices.js:831 で body:key を JSON.stringify) するため、rank≠null を含む入力では両面の wire body が一致しない。実装バグではなく serve が意図的に rank 等を露出しない設計のため、assert を 7 フィールド部分集合の範囲に scope 限定。serve の field-drop negative-fact は [[KS-0031]] が単独固定。

## wire

REST メッセージ形 (method/path/header/body) と応答正規化が CHAPIClient.kt と一致する境界を固定する。

### [KS-0007] keystore.list → GET /device/list (method/path/appidentifyid ヘッダ wire 固定)
- surface: core, serve
- backend: cloud
- command: keyStoreList / getDevicesList / keystore.list
- branch: -
- assert: getDevicesList が transport を {method:'GET', path:'/device/list'} で呼び(body 無し)、makeKeyStoreTransport 由来 transport が appidentifyid ヘッダ付き SigV4+x-api-key で送る形が CHAPIClient.getDevicesList(@Operation GET /device/list, @Parameter appidentifyid header) と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:35-39; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:105-106; packages/core/src/devices.js:807-813; packages/core/src/aws-credentials.js:580-595
- kind: wire-fidelity
- status: covered
- note: appidentifyid ヘッダ名は小文字 (aws-credentials.js:595 headers.appidentifyid)。GET に body を付けない (devices.js:809)。CHAPIClient.kt の getDevicesList は @Operation(36)+fun(37)+@Parameter appidentifyid(38)+return Array<CHUserKey>(39)、コメントを含めると 35-39。

### [KS-0008] keystore.put → PUT /device (method/path + body=CHUserKey object wire 固定)
- surface: core, serve
- backend: cloud
- command: keyStorePut / putKey / keystore.put
- branch: -
- assert: putKey が transport を {method:'PUT', path:'/device', body:CHUserKey} で呼び、body は CHUserKey オブジェクトそのまま(transport 側 JSON.stringify)である形が CHAPIClient.putKey(@Operation PUT /device, body:CHUserKey) と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:29-33; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:102-103; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:342-348; packages/core/src/devices.js:828-834
- kind: wire-fidelity
- status: covered
- note: ScanQRcodeFG.kt:342-348 が CHAPIClientBiz.putKey(cheyKeyToUserKey(...)) を呼ぶ実呼び出し。devices.js:831 で body:key を渡し transport (aws-credentials.js:585) が JSON.stringify(object)。

### [KS-0009] keystore.remove → DELETE /device (body は deviceUUID の JSON 文字列リテラル)
- surface: core, serve
- backend: cloud
- command: keyStoreRemove / removeKey / keystore.remove
- branch: -
- assert: removeKey が transport を {method:'DELETE', path:'/device', body:'<uuid>'} で呼び、HTTP body が JSON 文字列リテラル '"<uuid>"' になる形が CHAPIClient.removeKey(body:String, Kotlin→Gson→JSON string) と一致する (keyId = targetDevice.deviceId.toString())
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:42-46; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:108-109; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/model/CHDeviceViewModel.kt:567; packages/core/src/devices.js:851-860; packages/core/src/aws-credentials.js:585
- kind: wire-fidelity
- status: covered
- note: makeApiGatewayTransport が body!=null で JSON.stringify(body) するため、文字列 'uuid' → '"uuid"' が正準 (devices.js:854-857, aws-credentials.js:585)。removeKey 関数本体は devices.js:851-860 (851 開始, 860 閉じ括弧)。CHDeviceViewModel.kt:567 が removeKey(targetDevice.deviceId.toString()) の実呼び出し。

### [KS-0010] keystore.put deviceName 省略時 null 正規化 (serve handler)
- surface: serve
- backend: cloud
- command: keystore.put
- branch: deviceName-present | deviceName-omitted
- assert: keystore.put handler が deviceName 省略時 null をセットして hub.keyStorePut に渡す形が CHUserKey.deviceName(nullable String?) と一致する
- ref: packages/kit/src/serve/entries/device.js:319; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:42
- kind: wire-fidelity
- status: covered
- note: 確認済: device.js:319 が deviceName: ctx.params.deviceName ?? null、CHUserKey.kt:42 が var deviceName: String? (nullable)。行ズレなし。

### [KS-0011] 実機 API Gateway での keystore REST 受理 (SigV4+x-api-key+appidentifyid 認可)
- surface: core
- backend: cloud
- command: getDevicesList / putKey / removeKey
- branch: -
- assert: 実 API Gateway が keystore REST(GET /device/list・PUT /device・DELETE /device) を SigV4+x-api-key+appidentifyid で受理し CHUserKey[] / server response を返す往復
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:22-46; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:36-47; packages/core/src/devices.js:736-763
- kind: wire-fidelity
- status: waived: 実 API Gateway 受理は SigV4+x-api-key+appidentifyid を通す実クラウド往復でしか検証不能 (REFACTORING_PLAN P3-2/R3:CLOUD-P-03 §9 登録, @experimental, 同 line 26)。
- note: 検証済: CHAPIClient.kt:22-46 が POST(22-26)/PUT(29-32)/GET list(36-39)/DELETE(42-45) を appidentifyid ヘッダ付き CHUserKey[] 返しで宣言; CHUserKey.kt:36-47 が応答 DTO 形; devices.js:736-763 makeKeyStoreTransport が SigV4+x-api-key+appidentifyid transport を構築。修正: 元 devices.js:716-718 は auth コメント+@experimental 注のみで往復実装を支持せず → 実装関数 736-763 へ置換し CHUserKey.kt を追加。assert を実 op パス (/device/list, /device PUT/DELETE) に明確化。未確認: devices.js の in-code 注 '§9 V15' は誤マップ(V15-V19 表で V15=biz3 del/R3:CLOUD-P-01)。keystore は P3-2(R3:CLOUD-P-03)で §9 へ汎用登録(line 214 受け入れ基準)であり固有 V 番号は未割当 — status 出典を P3-2/§9 に補正。

## payload

putKey body の CHUserKey フィールド集合/型と keyLevel 規約を CHUserKey.kt data class に照らす。

### [KS-0012] CHUserKey 同期形 — putKey body のフィールド集合/型が CHUserKey.kt data class と一致
- surface: core
- backend: cloud
- command: putKey
- branch: -
- assert: putKey に渡す CHUserKey が {deviceUUID,deviceModel,keyIndex,secretKey,sesame2PublicKey,deviceName?,keyLevel,rank?,subUUID?,stateInfo?} のキー集合・型(keyLevel:number)で、CHUserKey.kt:36-47 の data class フィールド順/nullable と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:36-47; packages/core/src/devices.js:784-795
- kind: payload-fidelity
- status: covered
- note: JSDoc typedef CHUserKey (devices.js:784-795)。CHUserKey.kt 上では deviceName(:42)/rank(:44) が nullable(?), subUUID(:45 String="")/stateInfo(:46 StateInfo=StateInfo()) は非 nullable だが既定値ありで省略可。よって kit 側 typedef では rank は nullable、subUUID/stateInfo は省略可(optional)として扱うのが正確。

### [KS-0013] keyLevel=2 は kit 側規約 (owner 相当は未検証, app register-time owner=0)
- surface: core, cli
- backend: cloud
- command: putKey / locks add --push
- branch: owner(level=2)
- assert: locks add --push が putKey に渡す CHUserKey の keyLevel を 2 固定で構築する (locks.js:158) のは kit 側の規約であり、参照アプリの register-time owner は setLevel(0) で owner=0 (ScanNewDeviceFG.kt:169-173)・getLevel 既定 -1 (utils.kt:244-246) のため『2=owner 相当』は未確認 (UI ゲート getLevel()==2 は level 2 を特別扱いする UI であって register-time owner=0 とは別概念)
- ref: _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/ScanNewDeviceFG.kt:169-173; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/ssm2/utils.kt:244-246; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/DeviceListFG.kt:270; packages/kit/src/cli/locks.js:150-159
- kind: payload-fidelity
- status: waived: 固定 2 が owner 相当かは app の register owner=0 と相違し実検証不能 (kit 側規約・E2E)。UI ゲート getLevel()==2 は register-time owner=0 とは別概念のため owner-parity を確立しない。
- note: 補正: 旧 assert は『2=owner 相当』を確定事実と断定していたが、app の register-time owner は setLevel(0)=owner=0 (ScanNewDeviceFG.kt:169-173) で getLevel 既定 -1 (utils.kt:244-246) のため矛盾。getLevel()==2 は DeviceListFG.kt:270,286,312,327 等の owner 専用 UI ゲートで実在するが、これは『level 2 を特別扱いする UI』であって register owner=0 とは別概念。kit の locks.js:158 keyLevel:2 は『add --push は owner キーを登録する』という kit 側規約に留まる。config.md [[CFG-0056]] が owner=0 の negative-fact を正典として captured (payload-fidelity の正典先候補は CFG-0056)。

## transport

makeKeyStoreTransport の per-op ヘッダ切り分け・appidentifyid 解決順序・固定ヘッダを CHAPIClient.kt / AppIdentifyIdUtil.kt に照らす。

### [KS-0014] makeKeyStoreTransport は appidentifyid をサインしたヘッダにのせるが register/sign エンドポイントには付けない (per-op 切り分け)
- surface: core
- backend: cloud
- command: makeKeyStoreTransport / makeRegisterTransport
- branch: keystore(appidentifyid あり) | register/sign(appidentifyid なし)
- assert: makeKeyStoreTransport は appidentifyid ヘッダを付与し makeRegisterTransport は付与しない切り分けが CHAPIClient.kt の @Parameter(appidentifyid) 有無表(/device 系・/device/list は あり、/device/v1/** は なし)と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:22-46; packages/core/src/aws-credentials.js:499-536; packages/core/src/devices.js:738-763; packages/core/src/devices.js:621-669
- kind: wire-fidelity
- status: covered
- note: CHAPIClient.kt 全 @Operation を確認: appidentifyid あり=/device CRUD(22-46)・/device/list(36-39)・/friend(49-53)・/friend/token(56-60)・/web_route(63-67) のみ。/device/v1/**(70-143) と /device/infor(120-121) には無い。makeKeyStoreTransport(devices.js:738-763) は appIdentifyId:appId(759) を渡し、makeRegisterTransport(devices.js:648-670, doc 621-627) は渡さず既定 null=ヘッダ無し。aws-credentials.js:595 で appIdentifyId 真値時のみ headers.appidentifyid を付与。makeApiGatewayTransport のヘッダ構成 (x-api-key+SigV4+per-op appidentifyid) 自体は汎用基盤として [[AUTH-0079]] が正典。本エントリは『makeKeyStoreTransport が値を渡す / makeRegisterTransport が渡さない』keystore vs register の呼び分け branch に scope を絞り固有性を保持。

### [KS-0015] appidentifyid 値解決順序 (明示 > config 保存値 > 新規生成 'ap-northeast-1:<id>')
- surface: core
- backend: cloud
- command: makeKeyStoreTransport / resolveAppIdentifyId
- branch: explicit | config-stored | generated
- assert: 正典 [[AUTH-0075]] を参照 (resolveAppIdentifyId/generateAppIdentifyId の解決順序は汎用 transport 基盤)
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[AUTH-0075]]）
- note: resolveAppIdentifyId/generateAppIdentifyId は keystore 専用ではなく汎用 aws-credentials transport 基盤関数のため、解決順序 (明示 > config > 生成 'ap-northeast-1:<id>' + 書き戻し) の固定は auth.md [[AUTH-0075]] が正典。keystore transport が resolveAppIdentifyId を経由して appidentifyid を付ける結線点 (devices.js:753-755) は [[KS-0014]]/[[KS-0005]] が保持する。

### [KS-0016] keystore transport の x-api-key + content-type 固定 (apiKeyId は使わない)
- surface: core
- backend: cloud
- command: makeKeyStoreTransport
- branch: -
- assert: keystore transport が x-api-key=API_GATEWAY_API_KEY と content-type:application/json を常時付け、biz3 WebAPI proxy の apiKeyId(dev console 発行) とは無関係である境界が ApiClientFactory.apiKey()/BaseApp.kt の API_GATEWAY_API_KEY と一致する
- ref: packages/core/src/devices.js:738-763; packages/core/src/aws-credentials.js:76-77; packages/core/src/aws-credentials.js:586-595; packages/core/src/devices.js:471-486; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/base/BaseApp.kt:100; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/ApiClientConfigBuilder.kt:34-41
- kind: wire-fidelity
- status: covered
- note: 個人鍵ストア REST は SigV4+x-api-key+appidentifyid。WebAPI proxy(invokeWebAPI) の apiKeyId とは別経路(DEV ドメイン側)。command の本体は devices.js:738 makeKeyStoreTransport で、ヘッダ生成は委譲先 aws-credentials.js:586-595 makeApiGatewayTransport(行番号修正: const は :77, doc は :76)。x-api-key 既定値の出所として BaseApp.kt:100(BuildConfig.API_GATEWAY_API_KEY)・ApiClientConfigBuilder.kt:34-41(ApiClientFactory.apiKey())を追加。x-api-key+SigV4 のヘッダ生成機構自体は [[AUTH-0079]] が正典。本エントリは『x-api-key(API_GATEWAY_API_KEY) は biz3 WebAPI proxy の apiKeyId(dev console 発行) とは無関係』という keystore 固有の negative-fact に scope を絞り保持。

## validation

put/remove の必須パラメータ検証と transport 構築の認証必須を、handler/core 層の早期 throw として固定する。

### [KS-0017] keystore.put 必須パラメータ検証 (deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey + keyLevel)
- surface: serve
- backend: cloud
- command: keystore.put
- branch: missing-need-field | missing-keyLevel
- assert: keystore.put handler が need() で 5 必須鍵素材を検証し、keyLevel===undefined||null を別途 INVALID_PARAMS/BAD_PARAMS で弾き hub 未呼び出しになる(keyLevel は falsy=0 を通すため need とは別判定)
- ref: packages/kit/src/serve/entries/device.js:294-311
- kind: error-path
- status: covered
- note: keyLevel は数値 0 を弾かないため need() ではなく undefined/null 判定 (device.js:309-311)。need()(registry-helpers.js:32-38) は undefined/null/'' を弾くが 0 は通すため keyLevel を別判定する設計(確認)。throw(:310) は hub.keyStorePut(:322) より前で hub 未呼び出し(確認)。

### [KS-0018] putKey/removeKey の deviceUUID 必須 (core層 bad_request, transport 未呼び出し)
- surface: core
- backend: cloud
- command: putKey / removeKey
- branch: put-no-uuid | remove-empty-uuid
- assert: putKey は key.deviceUUID 欠落、removeKey は空 deviceUUID で bad_request(domain.devices.deviceUUIDRequired) を投げ transport を呼ばない
- ref: packages/core/src/devices.js:830; packages/core/src/devices.js:853
- kind: error-path
- status: covered
- note: 確認済: devices.js:830 `if (!key?.deviceUUID) throw badRequest("domain.devices.deviceUUIDRequired")` は transport 呼び出し(831行)の前。devices.js:853 同様(857行 transport の前)。キーは domain.js:87/202 に存在。

### [KS-0019] keystore transport 構築の認証必須 (credentialsProvider か tokenStore のいずれか)
- surface: core
- backend: cloud
- command: makeKeyStoreTransport
- branch: no-auth | no-fetch
- assert: makeKeyStoreTransport が credentialsProvider/tokenStore 双方欠落で registerAuthRequired、fetchImpl 非関数で registerFetchRequired を投げる
- ref: packages/core/src/devices.js:748; packages/core/src/devices.js:749
- kind: error-path
- status: covered
- note: 確認済: devices.js:748 `if (!credentialsProvider && !tokenStore) throw badRequest("domain.devices.registerAuthRequired")`、749 `if (typeof fetchImpl !== "function") throw badRequest("domain.devices.registerFetchRequired")`。元の refs は 748-749 範囲表記だったため境界2行に分割。

## error

非2xx 応答の status 付き throw と、未認証 daemon の requireAuth ガードを固定する。

### [KS-0020] keystore REST 非2xx 応答は assertHttpOk で status 付き throw
- surface: core
- backend: cloud
- command: getDevicesList / putKey / removeKey
- branch: 4xx | 5xx
- assert: transport 応答が非 OK のとき assertHttpOk が関数名(getDevicesList/putKey/removeKey)と status コードを含めて throw する
- ref: packages/core/src/devices.js:600; packages/core/src/devices.js:810; packages/core/src/devices.js:832; packages/core/src/devices.js:858
- kind: error-path
- status: covered
- note: 確認済: assertHttpOk 定義は devices.js:600-608、メッセージ template `domain.devices.registerHttpError` = `{op} failed: HTTP {status} {detail}` で op ラベルと status を含む。呼出は 810(getDevicesList)/832(putKey)/858(removeKey)。assert が op ラベル+status を述べるため定義行 600 を refs に追加。

### [KS-0021] keystore RPC は requireAuth 必須 (未認証 daemon で throw, hub 未呼び出し)
- surface: serve
- backend: cloud
- command: keystore.list / keystore.put / keystore.remove
- branch: unauthed
- assert: 各 keystore.* handler が冒頭 requireAuth(ctx.daemon) を呼び、authState=expired もしくは hub 未接続の daemon で throw して hub.keyStore* を呼ばない
- ref: packages/kit/src/serve/entries/device.js:284; packages/kit/src/serve/entries/device.js:307; packages/kit/src/serve/entries/device.js:338; packages/kit/src/serve/registry-helpers.js:55
- kind: error-path
- status: covered
- note: 確認済: device.js:284/307/338 で各 handler 冒頭 requireAuth(ctx.daemon)。requireAuth 実装(registry-helpers.js:55-)は authState==="expired" もしくは hub.connected=false で RpcError を throw。assert の『authState 未設定で throw』は不正確(実装は expired 判定 + hub 未接続判定)なため文言を実装に合わせ補正、requireAuth 定義行を refs に追加。

## response

getDevicesList の配列正規化と put/remove の応答素通しを CHAPIClient.kt 戻り型に照らす。

### [KS-0022] getDevicesList 応答正規化 (非配列/null は [] に化ける契約)
- surface: core
- backend: cloud
- command: getDevicesList
- branch: array | empty-array | non-array/null
- assert: getDevicesList が res.json を Array.isArray で判定し、配列なら素通し、非配列/null は [] を返す(CHAPIClient.kt:39 Array<CHUserKey> 戻り型に空配列で合わせる)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:36-39; packages/core/src/devices.js:811; packages/core/src/devices.js:812
- kind: wire-fidelity
- status: covered
- note: 確認済: devices.js:812 `return Array.isArray(res.json) ? res.json : []`。CHAPIClient.kt の `): Array<CHUserKey>` 戻り型は line 39(38 は param)なので assert 内行番号を 38→39 に修正。

### [KS-0023] putKey/removeKey 応答素通し (json があれば json, 無ければ text)
- surface: core
- backend: cloud
- command: putKey / removeKey
- branch: json-body | text-body
- assert: putKey/removeKey が res.json!=null なら json、それ以外は res.text を返す(CHAPIClient.kt の戻り型 Any に対し応答を加工しない)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:29-33; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:42-46; packages/core/src/devices.js:833; packages/core/src/devices.js:859
- kind: wire-fidelity
- status: covered
- note: 確認済: devices.js:833 (putKey) `return res.json != null ? res.json : res.text`。removeKey の同一 return は line 859(858 は assertHttpOk)なので removeKey ref を 858-859→859 に修正。CHAPIClient.kt putKey `): Any` は line 33、removeKey `): Any` は line 46(各 29-33/42-46 範囲)で確認。

## cli

locks add --push 同期と locks sync-from-account 取り込みのオプション分岐・終了コード・出力封筒を固定する。

### [KS-0024] locks add --push → putKey 同期 (CHUserKey 構築 + level=2)
- surface: cli
- backend: cloud
- command: sesame locks add --push
- branch: --push 指定 | 省略(同期しない)
- assert: locks add に --push を渡すとローカル登録後 makeKeyStoreTransport+putKey で個人鍵ストアへ同期し、CHUserKey を {deviceUUID,deviceModel,keyIndex,secretKey,sesame2PublicKey,deviceName,keyLevel:2} で構築する形が CHAPIClientBiz.putKey + cheyKeyToUserKey と一致する
- ref: packages/kit/src/cli/locks.js:145-161; packages/kit/src/cli/locks.js:285; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:10-21; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/menu/ScanQRcodeFG.kt:342-348
- kind: option-branch
- status: covered
- note: 確認済: locks.js:145 `if (opts.push)` → 149 makeKeyStoreTransport → 151-159 CHUserKey 構築(158 keyLevel:2) → 160 putKey。--push option は locks.js:285。SDK 側 cheyKeyToUserKey(CHUserKey.kt:10-21)は deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/nickName/level の順で構築、CHAPIClientBiz.putKey(:102-103)経由で送信、ScanQRcodeFG.kt:342-348 が両者を結線。assert のフィールド集合と一致。元の locks.js refs 開始行 143(コメント行)を実コード開始 145 に補正、cheyKeyToUserKey 定義行を refs に追加。正典: locks add --push の CLI option-branch は keystore ドメインが正典 (本エントリ)。config.md CFG-0055 は locks 管理側の重複起票 (相手側で waive 対象)。

### [KS-0025] locks add --push 同期失敗はローカル登録成功に影響させない (警告継続)
- surface: cli
- backend: cloud
- command: sesame locks add --push
- branch: push-fail | push-ok
- assert: putKey が throw しても catch して cli.warnLockPushFailed 警告で継続し、catch 後に無条件で実行される成功封筒 out({ok:true...}) によりローカル addLock の成功(終了コード 0)を覆さない
- ref: packages/kit/src/cli/locks.js:160-172
- kind: error-path
- status: covered
- note: 行修正: 旧 160-166 は putKey→warn のみ。catch 閉じ(167)と、catch を抜けて無条件実行される成功封筒(170-172)まで含めて 160-172 に拡張。これが「addLock 成功(exit 0)を覆さない」=die せず 170-172 に到達することの直接証拠。

### [KS-0026] locks sync-from-account → getDevicesList 取り込み (既存 deviceUUID 上書きせず追加のみ)
- surface: cli
- backend: cloud
- command: sesame locks sync-from-account
- branch: new-key-add | existing-skip
- assert: sync-from-account が getDevicesList で取得した CHUserKey[] のうちローカルに無い deviceUUID のみ addLock し、既存は skip、name は deviceName||deviceUUID にフォールバックする形が CHAPIClientBiz.getDevicesList と一致する
- ref: packages/kit/src/cli/locks.js:230-264; packages/kit/src/cli/locks.js:297; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:105-106
- kind: option-branch
- status: covered
- note: 確認済: 248-249 で既存 deviceUUID skip、250 で name=key.deviceName||key.deviceUUID フォールバック、245-260 で未存在のみ addLock。297 が sync-from-account 登録、CHAPIClientBiz.kt:105-106 が getDevicesList(identifyId()) 委譲。行ズレなし。正典: sync-from-account の取り込み分岐は keystore ドメインが正典 (本エントリ)。config.md CFG-0063 は重複起票 (相手側で waive 対象)。getDevicesList の wire 形は [[KS-0007]] が保持。

### [KS-0027] locks sync-from-account 取得失敗は exit 1 / config 未初期化は exit 2
- surface: cli
- backend: cloud
- command: sesame locks sync-from-account
- branch: fetch-fail(exit1) | no-config(exit2)
- assert: getDevicesList が throw した場合 cli.syncFromAccountFailed で exit 1、configStore.exists()=false なら cli.configNotInitialized で exit 2 になる終了コード契約
- ref: packages/kit/src/cli/locks.js:231-242
- kind: error-path
- status: covered
- note: 確認済: 232 が die(configNotInitialized, 2)、240 が die(syncFromAccountFailed, 1)。範囲 231-242 が両分岐を包含。行ズレなし。

### [KS-0028] locks sync-from-account の --json 出力封筒 {ok,total,added}
- surface: cli
- backend: cloud
- command: sesame locks sync-from-account --json
- branch: --json | human
- assert: isJsonMode() のとき {ok:true,total,added} を出力し、human モードでは cli.syncFromAccountDone({total,added}) を表示する出力分岐
- ref: packages/kit/src/cli/locks.js:261-263
- kind: option-branch
- status: covered
- note: 確認済: 261-263 で out(isJsonMode(), human=syncFromAccountDone({total,added}), json={ok:true,total,added})。行ズレなし。

## i18n

keystore/locks 同期 CLI の i18n カタログ完全性 (en/ja) を固定する。

### [KS-0029] keystore/locks 同期 CLI の i18n カタログ完全性 (6 キー en/ja)
- surface: cli
- backend: local
- command: locks add --push / locks sync-from-account
- branch: en | ja
- assert: cli.optLockPush/okLockPushed/warnLockPushFailed/descLockSyncFromAccount/syncFromAccountFailed/syncFromAccountDone が en/ja でキー名素通しせず自然文言で、補間トークン({name}/{message}/{total}/{added}) が展開される
- ref: packages/kit/src/i18n/cli.js:319-324; packages/kit/src/i18n/cli.js:740-745; packages/kit/tests/serve/keystore-rpc.test.js:172-202
- kind: i18n
- status: covered
- note: 出典置換: 旧 refs(テスト 172-202 + locks.js 呼出 161-166/240-262)はカタログの自然文言/補間を直接示さない(テストは存在確認のみ)。一次源 packages/kit/src/i18n/cli.js:319-324(en)/740-745(ja) を追加。確認済: 全6キーが両ロケールで自然文、{name}(320/741)/{message}(321,323/742,744)/{total}+{added}(324/745) を含む。テスト ref はガード(キー名素通し検出)の副次証拠として残置。

## 監査追補 v2 (dual-audit)

dual-audit (A/B 二系統 + 人間裁定) で追加された境界。negative-fact (未移植/payload-drop) と serve handler 正規化を固定する。

### [KS-0030] POST /device バルク鍵アップロード (updateKeys/upLoadKeys) は未移植 (単件 putKey で代替)
- surface: core, serve, cli
- backend: cloud
- command: updateKeys / upLoadKeys (POST /device) / keystore.upload
- branch: -
- assert: CHAPIClient.updateKeys (POST /device, body=List<CHUserKey>, returns Array<CHUserKey>) のバルク鍵アップロードを sesame-kit は core/serve/cli いずれにも実装せず spec も持たない。keystore は put(単件)/list/remove の 3 メソッドのみで、一括 PUT は意図的に未移植 (単件 putKey で代替) という negative-fact を記録する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:22-26; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:99-100; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/model/CHDeviceViewModel.kt:102-108; _sesame_sdk_ref/app/src/main/java/co/utils/recycle/DeviceListAdapter.kt:97; packages/core/src/aws-credentials.js:506; packages/core/src/devices.js:807-860
- kind: contract-existence
- status: waived: バルク updateKeys (POST /device List<CHUserKey>) は未移植 — 単件 putKey (PUT /device) で代替する設計判断。コードが存在しないためテスト対象外の negative-fact。
- note: CHAPIClient.kt:22-26 が POST /device updateKeys(appidentifyid, body:List<CHUserKey>): Array<CHUserKey> を宣言 (単件 putKey は PUT /device → Any で別オペ・戻り型も Array vs Any と異なる)。CHAPIClientBiz.kt:99-100 upLoadKeys が委譲、app では saveKeysToServer (CHDeviceViewModel.kt:102-108) と DeviceListAdapter.kt:97 が実呼び出し。packages/ では updateKeys/upLoadKeys は aws-credentials.js:506 の per-op 表コメント (/device (updateKeys) POST あり :22-26) のみにヒットし実装は無い。devices.js には putKey(PUT 単件)/getDevicesList(GET)/removeKey(DELETE) のみ実装。[[KS-0001]]/[[KS-0004]] が keystore を 3 メソッドに固定する一方、4 番目の SDK メソッド (バルク upload) を提供しない negative-fact を本エントリが補完。

### [KS-0031] keystore.put serve handler が rank/subUUID/stateInfo を CHUserKey body へ転送せず 7 フィールドに切り詰める (payload-drop)
- surface: serve
- backend: cloud
- command: keystore.put
- branch: rank/subUUID/stateInfo 省略 (常時)
- assert: keystore.put handler が構築する CHUserKey は {deviceUUID,deviceModel,keyIndex,secretKey,sesame2PublicKey,deviceName,keyLevel} の 7 フィールドのみで、CHUserKey.kt:43-46 の rank/subUUID/stateInfo は params にも body にも含めず常に欠落する (送信時 server 側 default に委ねる) negative-fact
- ref: packages/kit/src/serve/entries/device.js:294-321; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:43-46
- kind: payload-fidelity
- status: covered
- note: device.js:294-303 の keystore.put params は deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/deviceName/keyLevel/appIdentifyId のみで rank/subUUID/stateInfo を受け付けず、device.js:313-321 の key 構築も 7 フィールド(deviceName ?? null 含む)に限定。CHUserKey.kt:44-46 は rank:Int?=null / subUUID:String="" / stateInfo:StateInfo=StateInfo() を持つ。rank/subUUID/stateInfo は server 側 default で埋まるため実害は小さいが、[[KS-0010]] (deviceName null 正規化) と並ぶ serve handler の payload 正規化境界として固定。同じ field-drop 境界は [[KS-0006]] (core-direct vs serve-rpc の surface-parity 補正) と [[KS-0012]] (core typedef は rank/subUUID/stateInfo を持つ) が別角度から参照。
