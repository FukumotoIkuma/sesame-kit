<!-- spec-domain: lock | prefix: LOCK | tests: packages/core/tests/lock, packages/core/tests/lock-manager, packages/kit/tests/cli -->

# lock 操作 spec (LOCK)

lock/unlock/toggle/click/autolock/status を cloud(biz3TriggerLocker)と BLE(OS3/OS2)の双方で、経路選択(auto/--ble-only/--cloud-only)・機種能力・面横断(cli/serve/sdk/core)まで監査する。BLE セッション確立等の汎用プロトコルは ble-os3.md/ble-os2.md へ。

## biz3TriggerLocker frame

クラウド制御命令 `biz3TriggerLocker` の送信フレーム形と各フィールド (action/cmd/sign/history/device_id) の生成規則を biz3 web (sendCommandToWM2) に照らして固定する。

### [LOCK-0001] triggerLock → biz3TriggerLocker フレーム形 (op フィールド無し)
- surface: core
- backend: cloud
- command: `lock.triggerLock` / `lock.lockLock` / `lock.lockUnlock`
- branch: -
- assert: 送信フレームのキー集合が {action:"biz3TriggerLocker", cmd, sign, history, device_id} で op フィールドを含まない (biz3 sendCommandToWM2 と同形)
- ref: packages/core/src/lock.js:89; references_web/src/api/useIotCtrl.js:41-48
- kind: wire-fidelity
- status: covered
- note: 候補テスト triggerLock.test.js:131 はキー存在を確認するが op 不在は未アサート。op 不在の境界はまだ planned。[ID] タグ付与後に covered へ昇格。

### [LOCK-0002] action は vendor 定数 BIZ3_TRIGGER_LOCKER 文字列リテラル
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: -
- assert: frame.action が 'biz3TriggerLocker' (ACTION_TYPES.BIZ3_TRIGGER_LOCKER) のリテラルと一致する
- ref: packages/core/src/lock.js:31; packages/core/src/vendor/biz3/constants/messageConstants.js:16; references_web/src/constants/messageConstants.js:16
- kind: wire-fidelity
- status: covered
- note: lock.js:31 TRIGGER_ACTION = ACTION_TYPES.BIZ3_TRIGGER_LOCKER / vendor:16 BIZ3_TRIGGER_LOCKER:'biz3TriggerLocker' / web:16 同値 — 全 ref 実在確認。

### [LOCK-0003] history = subUUID の 18B base64 (prefix 000c) タグ
- surface: core
- backend: cloud
- command: `lock.triggerLock` / `crypto.uuidToHistoryBase64`
- branch: -
- assert: frame.history が uuidToHistoryBase64(subUUID) = base64('000c'+32hex) で biz3 utils.uuidBuffer と一致する (24 文字 base64)
- ref: packages/core/src/lock.js:134; packages/core/src/crypto.js:126-133; references_web/src/utils/biz3utils.js:455-458; references_web/src/api/useIotCtrl.js:39-40
- kind: wire-fidelity
- status: covered
- note: CMAC/base64 ベクタは crypto.md と重複しうるが、ここは history 載せ位置の境界。crypto.js:126-133 uuidToHistoryBase64 / biz3utils.js:455-458 uuidBuffer (prefix '000c'+strip-hyphen→hex→base64) / useIotCtrl.js:39-40 (subUUID→uuidBuffer) すべて一致確認。

### [LOCK-0004] sign = cmacTime(secretKey) 8hex (256秒粒度時刻 CMAC)
- surface: core
- backend: cloud
- command: `lock.triggerLock` / `crypto.cmacTime`
- branch: -
- assert: frame.sign が cmacTime(secretKey) の 4B/8hex で、biz3 Cmac.cmacTime (UNIX秒4B LE の index1-3 を CMAC) と同じ生成規則
- ref: packages/core/src/lock.js:133; packages/core/src/crypto.js:55-73; references_web/src/utils/Cmac.js:142-149; references_web/src/api/useIotCtrl.js:38
- kind: wire-fidelity
- status: covered
- note: 時刻依存のため値固定は crypto.md (CRY) のベクタ側。ここはフレーム配置の一致。Cmac.js:142-149 cmacTime (setUint32 LE→slice(1,4)=上位3B→aesCmac→8hex) と crypto.js:55-73 が一致、useIotCtrl.js:38 で sign に載る — 全 ref 確認。

### [LOCK-0005] device_id は入力 deviceUUID をそのまま (大小/ハイフン変換なし)
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: -
- assert: frame.device_id が引数 deviceId 文字列を無加工で載せる (iot 経路の uppercase 正規化とは異なり biz3TriggerLocker は素通し: sendCommandToWM2 は device_id をそのまま渡す)
- ref: packages/core/src/lock.js:89; references_web/src/api/useIotCtrl.js:46
- kind: wire-fidelity
- status: covered
- note: iot.js の buildIotPayload(:170 deviceId.toUpperCase()) と対照。lock 経路は無加工が正準。lock.js:89 request({...device_id: deviceId}) / useIotCtrl.js:46 device_id(shorthand 素通し) を確認。対照の iot.js:170 uppercase も実在確認。

## cmd codes

各動詞ラッパが biz3TriggerLocker に載せる cmd コード (ITEM_CODES) と上書き契約。

### [LOCK-0006] lockLock cmd=82 (LOCK)
- surface: core
- backend: cloud
- command: `lock.lockLock`
- branch: -
- assert: frame.cmd === 82 (ITEM_CODES.LOCK) を送る
- ref: packages/core/src/lock.js:145; packages/core/src/itemcodes.js:34
- kind: wire-fidelity
- status: covered
- note: 候補テスト triggerLock.test.js:286。lock.js:145 lockLock(cmd: CMD.LOCK) / itemcodes.js:34 LOCK:82 (crypto.js:238 で ITEM_CODES as CMD) を確認。[ID] タグ付与後に covered へ昇格。

### [LOCK-0007] lockUnlock cmd=83 (UNLOCK)
- surface: core
- backend: cloud
- command: `lock.lockUnlock`
- branch: -
- assert: frame.cmd === 83 (ITEM_CODES.UNLOCK) を送る
- ref: packages/core/src/lock.js:147; packages/core/src/itemcodes.js:35
- kind: wire-fidelity
- status: covered
- note: 候補テスト triggerLock.test.js:289。lock.js:147 lockUnlock(cmd: CMD.UNLOCK) / itemcodes.js:35 UNLOCK:83 を確認。[ID] タグ付与後に covered へ昇格。

### [LOCK-0008] lockToggle cmd=88 (TOGGLE, cloud 合成命令)
- surface: core
- backend: cloud
- command: `lock.lockToggle`
- branch: -
- assert: frame.cmd === 88 (ITEM_CODES.TOGGLE) を送る。cloud のみのサーバ判定反転 (biz3 web のデフォルト cmd=88)
- ref: packages/core/src/lock.js:149; packages/core/src/itemcodes.js:40; references_web/src/api/useIotCtrl.js:37
- kind: wire-fidelity
- status: covered
- note: lock.js:149 lockToggle→CMD.TOGGLE; itemcodes.js:40 TOGGLE:88; useIotCtrl.js:37 sendCommandToWM2 default cmd=88。対応する未タグ test: triggerLock.test.js:292 (要 [ID] 付与で covered 昇格)。

### [LOCK-0009] botClick cmd=89 (CLICK / BOT_CLICK)
- surface: core
- backend: cloud
- command: `lock.botClick`
- branch: -
- assert: frame.cmd === 89 (ITEM_CODES.CLICK) を送る (biz3 web 呼称 BOT_CLICK)
- ref: packages/core/src/lock.js:151; packages/core/src/itemcodes.js:41
- kind: wire-fidelity
- status: covered
- note: lock.js:151 botClick→CMD.CLICK; itemcodes.js:41 CLICK:89 (コメントに biz3 呼称 BOT_CLICK 明記)。対応する未タグ test: triggerLock.test.js:295。

### [LOCK-0010] wrapper の cmd は呼び出し元 cmd を上書きする
- surface: core
- backend: cloud
- command: `lock.lockLock` / `lock.lockUnlock` / `lock.lockToggle` / `lock.botClick`
- branch: -
- assert: 各 wrapper が triggerLock に渡す cmd で params.cmd を強制上書きする (誤った cmd 混入を防ぐ)
- ref: packages/core/src/lock.js:145-151
- kind: option-branch
- status: covered
- note: lock.js:145-151 各 wrapper は { ...p, cmd: CMD.X } で展開後に cmd を上書き (spread 末尾)。対応する未タグ test: triggerLock.test.js:298。

## ack correlation

ack ({code,data,success}) の相関規則・並行リクエストの FIFO・送信前購読確立を固定する。

### [LOCK-0011] 同期 ack {code:200,data:{},success:true} で resolve
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: -
- assert: サーバの即時 ack {action:'biz3TriggerLocker',code:200,data:{},success:true} 受信で resolve し pending/state 購読が解放される
- ref: packages/core/src/lock.js:87-99
- kind: wire-fidelity
- status: covered
- note: lock.js:89 client.request() の then で msg.success!==false なら succeed(msg) (98), cleanup で unsubState (72)。対応する未タグ test: triggerLock.test.js:157。

### [LOCK-0012] ack 相関キーは biz3TriggerLocker: (op 空) で FIFO
- surface: core
- backend: cloud
- command: `lock.triggerLock` / `transport.request`
- branch: -
- assert: request の相関キーが `biz3TriggerLocker:` (action+空op) で生成され、受信側 _onMessage も同キーで FIFO 1件解決する (op 無し ack を取りこぼさない)
- ref: packages/core/src/lock.js:31-34,89; packages/core/src/transport.js:262-278; packages/core/src/transport.js:527-533
- kind: wire-fidelity
- status: covered
- note: キー生成規則 `${action}:${op||""}`: 送信側 transport.js:263, 受信側 _onMessage transport.js:527。lock.js:31 TRIGGER_ACTION='biz3TriggerLocker' (vendor messageConstants.js:16 で確認), op 無しなので key='biz3TriggerLocker:'。

### [LOCK-0013] 並行 2 コマンドは送信順=解決順 (FIFO) で別 ack を受ける
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: concurrent
- assert: ack に相関情報が無い (op/cmd echo 無し) ため、並行 2 リクエストは transport の FIFO pending で送信順に解決され取り違えない (P3-6 回帰)
- ref: packages/core/src/lock.js:87-89; packages/core/src/transport.js:526-533,553-557
- kind: idempotency
- status: covered
- note: transport.js:553-557 _registerPending が key 毎の queue 末尾に push (送信順), :526-533 _onMessage が queue.shift() で先頭 1 件のみ解決 = FIFO。対応する未タグ test: triggerLock.test.js:173。

### [LOCK-0014] 並行時 片方 success:false なら その 1 件だけ reject
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: concurrent | success:false
- assert: 並行 2 件のうち先着 ack が success:false でも FIFO 先頭の 1 件のみ reject され、もう一方は次 ack で resolve する
- ref: packages/core/src/lock.js:91-99; packages/core/src/transport.js:526-533
- kind: idempotency
- status: covered
- note: lock.js:91-95 msg.success===false で当該 promise のみ fail(REJECTED), transport.js:530 queue.shift() は先頭 1 resolver のみ解決するため後続は次 ack 待ち。対応する未タグ test: triggerLock.test.js:187。

### [LOCK-0015] ack は cmd/deviceUUID を問わず resolve (data:{} 許容)
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: empty-data
- assert: ack に cmd echo / deviceUUID が無く data:{} 空でも success!==false なら resolve する (ack は相関を持たない契約)
- ref: packages/core/src/lock.js:90-98
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:165; lock.js:90-98 = request().then で success!==false なら succeed(msg)。[ID] タグ付与後に covered へ昇格。

### [LOCK-0016] 送信時点で state 購読と ack pending が両方張られる
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: -
- assert: 送信 (request) 前に pubDeviceStateChange 購読を張り、その後 request が pending を登録 (購読が揃ってから送信する契約)
- ref: packages/core/src/lock.js:78-89
- kind: idempotency
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:143; lock.js:81-85=subscribe(STATE_EVENT_KEY) 先張り → 87-89=client.request() が送信+pending 登録。[ID] タグ付与後に covered へ昇格。

## state push aux

ack とは別に pubDeviceStateChange push を補助解決経路として扱う際の deviceUUID 照合・二重解決ガード。

### [LOCK-0017] pubDeviceStateChange (data.deviceUUID 一致) でも resolve
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: state-push
- assert: 補助系: 購読キー biz3TriggerLocker:pubDeviceStateChange の push が来て data.deviceUUID が target と一致すれば resolve する (vendor は message.data を pubDeviceStateChange で消費)
- ref: packages/core/src/lock.js:36,78-85; references_web/src/api/useIotCtrl.js:11,17-22
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:198; lock.js:36=STATE_EVENT_KEY, 81-85=subscribe+一致判定。useIotCtrl.js:11=PubedDeviceStateChange 定数, 17-22=action=biz3TriggerLocker & op=pubDeviceStateChange 時に message.data を updateDeviceState へ消費。[ID] タグ付与後に covered へ昇格。

### [LOCK-0018] state push の deviceUUID 照合は normalizeUuid (大小/ハイフン吸収)
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: state-push | uuid-normalize
- assert: push の data.deviceUUID をハイフン除去+小文字化して target と比較し、大文字/ハイフン付き UUID でも一致する
- ref: packages/core/src/lock.js:82-84; packages/core/src/crypto.js:153-155
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:215; lock.js:82=normalizeUuid(msg.data.deviceUUID), 83=不一致 return。crypto.js:153-155=normalizeUuid (replace(/-/g)+toLowerCase)。[ID] タグ付与後に covered へ昇格。

### [LOCK-0019] 別 deviceUUID の state push は無視 (ack 無ければ timeout)
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: state-push | mismatch
- assert: data.deviceUUID が target と不一致の push は無視され resolve しない (誤デバイスの push で誤解決しない)
- ref: packages/core/src/lock.js:82-84
- kind: idempotency
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:221; lock.js:83 = if (incoming && incoming !== target) return; で succeed しない。[ID] タグ付与後に covered へ昇格。

### [LOCK-0020] state push 先行解決後の request timeout は reject に化けない
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: state-push | late-timeout
- assert: 補助 push で done 済みなら、後から来る request の timeout は無視され reject に化けない (二重解決ガード done)
- ref: packages/core/src/lock.js:74-76,100-103
- kind: idempotency
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:206; lock.js:74-76=succeed/fail の done ガード, 100-103=.catch 冒頭 if (done) return; → timeout を無視。[ID] タグ付与後に covered へ昇格。

## error path

triggerLock の異常系 (success:false/timeout/未接続) と SesameError 封筒契約。

### [LOCK-0021] ack success:false で REJECTED reject (code/message 反映)
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: success:false
- assert: ack.success===false で SesameError(code=ERR.REJECTED, retryable:false, data.upstreamCode=msg.code) を投げ、文言に cmd/code/message を含む
- ref: packages/core/src/lock.js:91-97
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ) triggerLock.test.js:230 と :270; lock.js:91-97 = success===false で fail(SesameError code=ERR.REJECTED retryable:false data.upstreamCode=msg.code, 文言に cmd/code/message)。[ID] タグ付与後に covered へ昇格。

### [LOCK-0022] timeout 10s 経過で TIMEOUT reject し pending/購読解放
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: timeout
- assert: DEFAULT_TIMEOUT_MS=10000 (または指定 timeoutMs) で ack が来なければ SesameError(code=TIMEOUT, retryable:true) を投げ、pending と state 購読を解放する
- ref: packages/core/src/lock.js:37,103-105; packages/core/src/transport.js:271-274
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): triggerLock.test.js:238,265。

### [LOCK-0023] timeout 文言に cmd と device を含む
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: timeout
- assert: timeout エラー文言が domain.lock.timeout で cmd と正規化 device を埋め込む (TRANSPORT_ERR.TIMEOUT を lock 文言へ写像)
- ref: packages/core/src/lock.js:103-105; packages/core/src/transport.js:73
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): triggerLock.test.js:245。文言定義 i18n/domain.js:48 'triggerLock timeout (cmd={cmd}, device={device})'。

### [LOCK-0024] 非 TIMEOUT の transport エラーはそのまま伝播
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: transport-closed
- assert: request の reject が TRANSPORT_ERR.TIMEOUT 以外 (CLOSED 等) のとき timeout 文言へ写像せず Error をそのまま fail に渡す
- ref: packages/core/src/lock.js:100-108; packages/core/src/transport.js:73,81
- kind: error-path
- status: covered

### [LOCK-0025] 未接続 (getStatus!=='open') は queue せず即 NOT_CONNECTED
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: not-connected
- assert: client.getStatus() が 'open' でなければ sign の署名期限切れ回避のため queue せず即 SesameError(code=NOT_CONNECTED, retryable:true) を投げる (Review H-3)
- ref: packages/core/src/lock.js:64-67
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): triggerLock.test.js:116,259。

### [LOCK-0026] getStatus 未実装でも落ちず送信まで走る
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: no-getStatus
- assert: client.getStatus が未実装 (undefined) のときは接続チェックをスキップして送信まで進む (timeout で reject)
- ref: packages/core/src/lock.js:65
- kind: option-branch
- status: covered
- note: 既存テスト(要[ID]タグ): triggerLock.test.js:121。

## arg validation

triggerLock の引数必須検証と例外型 (SesameError) 封筒。

### [LOCK-0027] triggerLock 引数必須 (deviceId/secretKey/subUUID/cmd)
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: missing-deviceId | missing-secretKey | missing-subUUID | non-number-cmd
- assert: deviceId/secretKey/subUUID 欠落、cmd が number でない場合は送信前に SesameError(code=BAD_REQUEST) を投げる
- ref: packages/core/src/lock.js:126-131
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): triggerLock.test.js:97-109。

### [LOCK-0028] throw されるのは SesameError インスタンス
- surface: core
- backend: cloud
- command: `lock.triggerLock`
- branch: -
- assert: lock 系のエラーはすべて SesameError インスタンス (code/retryable/data を持つ封筒) で投げられる
- ref: packages/core/src/lock.js:127,92,104; packages/core/src/errors.js:47
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): triggerLock.test.js:278。errors.js の path を SesameError class 定義行 (errors.js:47) に補正。

## botClickScript

Bot2 台本 click (RUN_SCRIPT_0+index) の cmd 規則と範囲検証。

### [LOCK-0029] botClickScript cmd=170+scriptIndex (RUN_SCRIPT_0)
- surface: core
- backend: cloud
- command: `lock.botClickScript`
- branch: index=0..9
- assert: frame.cmd === BOT2_ITEM_CODE_RUN_SCRIPT_0(170)+scriptIndex を biz3TriggerLocker に乗せる (CHSesameBot2Device.click(index) の cloud 1:1)
- ref: packages/core/src/lock.js:168-172; packages/core/src/itemcodes.js:53-55; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:73-89; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:47
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ): botClickScript.test.js:56,65。SDK 出典 CHSesameBot2Device.kt:73-89 (click(index): itemCode=RUN_SCRIPT_0.value+index、BLE不可時 cmdSesame) / SesameProtocols.kt:47 (170u..179u)。

### [LOCK-0030] botClickScript scriptIndex 範囲外/非整数は BAD_REQUEST
- surface: core
- backend: cloud
- command: `lock.botClickScript`
- branch: index<0 | index>9 | non-integer
- assert: scriptIndex が 0..9 整数でなければ送信前に SesameError(code=BAD_REQUEST, domain.lock.scriptIndexRange) を投げる (台本は最大 10 本)
- ref: packages/core/src/lock.js:169-171; packages/core/src/i18n/domain.js:54
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): botClickScript.test.js:72-77 が it.each([-1,10,1.5,NaN,"0"]) で範囲外・非整数・非数値を網羅し送信前 throw (client.sent.length===0) を検証済。i18n キー domain.lock.scriptIndexRange は domain.js:54(en)/169(ja) に実在。assert は lock.js:169-171 の Number.isInteger/0..9 ガードと一致。

## triggerItemCommand

任意 ItemCode を同型フレームで送る汎用レール (CHAPIClientBiz.cmdSesame 1:1)。

### [LOCK-0031] triggerItemCommand 汎用レール (任意 ItemCode を同型フレームで送る)
- surface: core
- backend: cloud
- command: `lock.triggerItemCommand`
- branch: payload
- assert: frame が {action,cmd,sign:cmacTime(secretKey),history:base64(payload),device_id} で lock/unlock と同型。CHAPIClientBiz.cmdSesame と一致 (msg=時刻CMAC を sign、payload を history へ base64)
- ref: packages/core/src/lock.js:202-226; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:160-170
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:73-86 (cmd=11/device_id/sign string/history==payload/op 無し を検証)。SDK 出典 CHAPIClientBiz.cmdSesame:162-169 (msg=UInt24時刻, keyCheck=AesCmac(secretKey).computeMac(msg)[0..3]=sign, historytag.base64Encode()=history)。

### [LOCK-0032] triggerItemCommand payload 省略時は subUUID の history タグ
- surface: core
- backend: cloud
- command: `lock.triggerItemCommand`
- branch: subUUID-fallback
- assert: payload 未指定で subUUID 指定なら history=uuidToHistoryBase64(subUUID)、両方無ければ BAD_REQUEST (domain.lock.payloadOrSubUUID)
- ref: packages/core/src/lock.js:210-217; packages/core/src/i18n/domain.js:55
- kind: option-branch
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:88,107。assert は lock.js:210-217 の history 分岐 (payload!=null→base64 / else subUUID→uuidToHistoryBase64 / else throw payloadOrSubUUID) と一致。i18n キー domain.lock.payloadOrSubUUID は domain.js:55(en)/170(ja) に実在。

### [LOCK-0033] triggerItemCommand 必須検証 (deviceId/secretKey/cmd)
- surface: core
- backend: cloud
- command: `lock.triggerItemCommand`
- branch: missing-deviceId | missing-secretKey | non-number-cmd
- assert: deviceId/secretKey 欠落・cmd 非 number は送信前に BAD_REQUEST
- ref: packages/core/src/lock.js:205-207
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:119-123 (それぞれ /deviceId required/ /secretKey required/ /cmd required/ を rejects.toThrow で検証)。assert は lock.js:205-207 の 3 ガードと一致。

### [LOCK-0034] triggerItemCommand ack success:false で reject / 未対応 cmd は timeout
- surface: core
- backend: cloud
- command: `lock.triggerItemCommand`
- branch: success:false | server-unsupported-timeout
- assert: ack.success===false で reject、ack が来ない (サーバ非対応の兆候) は timeout で reject する
- ref: packages/core/src/lock.js:219-226; packages/core/src/lock.js:91-104
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:96,102。success===false reject は lock.js:91-97 (dispatchTrigger 内 request().then)、timeout 写像は lock.js:103-104 (err.code===TRANSPORT_ERR.TIMEOUT→domain.lock.timeout)。

## autolock

setAutolock の 2B LE payload・範囲検証・cloud では実機未反映の負の事実・CLI 非公開。

### [LOCK-0035] setAutolock cmd=11 / payload=2byte LE 秒数
- surface: core
- backend: cloud
- command: `lock.setAutolock`
- branch: seconds
- assert: frame.cmd===AUTOLOCK(11) で history=base64([sec&0xff,(sec>>8)&0xff]) (2byte LE)、戻り値 {ack,cmd:11,seconds}。SDK delay.toShort().toReverseBytes() と一致
- ref: packages/core/src/lock.js:242-250; packages/core/src/itemcodes.js:22
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:130 (history base64==[300&0xff,(300>>8)&0xff]=0x2c,0x01) と :141。assert は lock.js:247 payload=[sec&0xff,(sec>>8)&0xff] / lock.js:249 return {ack,cmd:CMD.AUTOLOCK,seconds} / itemcodes.js:22 AUTOLOCK:11 と一致。

### [LOCK-0036] setAutolock seconds=0 で無効化 (payload 00 00)
- surface: core
- backend: cloud
- command: `lock.setAutolock`
- branch: seconds=0
- assert: seconds=0 は autolock 無効化で payload が 00 00 (autolock_jp.md: 遅延時間 0 = 自動施錠無効)
- ref: packages/core/src/lock.js:247-248
- kind: wire-fidelity
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:141。

### [LOCK-0037] setAutolock seconds 範囲外/非整数は BAD_REQUEST (送信前)
- surface: core
- backend: cloud
- command: `lock.setAutolock`
- branch: seconds<0 | seconds>65535 | non-integer
- assert: seconds が 0..65535 整数でなければ送信前に SesameError(BAD_REQUEST, domain.lock.secondsRange)
- ref: packages/core/src/lock.js:243-245
- kind: error-path
- status: covered
- note: 既存テスト(要[ID]タグ): autolock.test.js:148。

### [LOCK-0038] autolock はクラウドでは実機未反映 (ack のみ) の事実
- surface: core
- backend: cloud
- command: `lock.setAutolock` / `lock.triggerItemCommand`
- branch: cloud-autolock
- assert: biz3TriggerLocker は cmd=11 に success:true を返すが実機 autolock 設定は変化しない (biz3 web は autolock cmd を 'Unsupported' とし設定系クラウド送信路を持たない=公式アプリは BLE 直送)
- ref: packages/core/src/lock.js:182-189,228-235; references_web/src/api/useIotCtrl.js:217-218
- kind: wire-fidelity
- status: waived: 実機 autolock 反映の有無は実機/実クラウド往復でしか検証できない (フレーム生成自体は別 spec で検証)
- note: 境界=「cloud では設定系が実機反映されない」という負の事実。フレーム正しさは setAutolock spec 側 [[LOCK-0035]]。useIotCtrl.js:217-218 = default:/console.warn('Unsupported cmd for iotPayload') で IoT cmd に autolock 不在を確認。

### [LOCK-0039] triggerItemCommand/setAutolock は CLI 非公開
- surface: cli
- backend: cloud
- command: `sesame <device> autolock <sec>`
- branch: cloud-route-blocked
- assert: autolock はクラウド能力に含まれず (devicemodel cloud[] に autolock 無し)、pickTransport が autolock を BLE 必須として cloud では選ばない。triggerItemCommand 汎用レールは CLI に露出しない
- ref: packages/core/src/lock.js:235; packages/core/src/ble/devicemodel.js:38-39,83,87; packages/kit/src/cli/lock-ops.js:117-118
- kind: option-branch
- status: covered
- note: autolock の BLE 実機反映は ble-os2.md/ble-os3.md 側。ここは cloud では送られない境界。devicemodel.js:83/87 = LOCK5/SESAME2 の cloud:[lock,unlock,toggle] に autolock 無し・ble:[...autolock] のみ。lock-ops.js:118 = autolock は cloud 不可なので BLE。

## cloud status

クラウド status 取得の 2 経路 (getDeviceStatus / webapiDeviceState) と strict success・apiKeyId 必須。

### [LOCK-0040] status クラウド取得 (getDeviceStatus / biz3ManageDevice)
- surface: core
- backend: cloud
- command: `client.getDeviceStatus` / `devices.getDeviceStatus`
- branch: -
- assert: frame {action:'biz3ManageDevice', op:'getDeviceStatus', deviceUUID} を request し、resp.data 配列の先頭要素 (無ければ null) を返す (vendor は data[0] のみ消費)
- ref: packages/core/src/devices.js:123-130; references_web/src/api/useManageDevice.js:374-382; references_web/src/api/useManageDevice.js:83-84
- kind: wire-fidelity
- status: covered
- note: devices.md と境界が重なるが lock スライスの status 取得経路として索引化。useManageDevice.js:374-382 = getDeviceStatus(action:BIZ3_MANAGE_DEVICE, op:'getDeviceStatus', deviceUUID)、:83-84 = setDeviceStatus(data?.length>0 ? data[0] : null)。

### [LOCK-0041] getDeviceStatus は strict success 検証
- surface: core
- backend: cloud
- command: `devices.getDeviceStatus`
- branch: success-strict
- assert: 応答に success が無い/false なら assertSuccess(strict:true) で reject する (webapi proxy の非 strict と対照)
- ref: packages/core/src/devices.js:128
- kind: error-path
- status: covered
- note: devices.js:128 = assertSuccess(resp, 'getDeviceStatus', {strict:true})。

### [LOCK-0042] status クラウド取得 (webapiDeviceState / webapi_ssm_shadow_get)
- surface: core
- backend: cloud
- command: `client.webapiDeviceState` / `devices.webapiDeviceState`
- branch: -
- assert: webapiDeviceState op=webapi_ssm_shadow_get/query={device_id}。webapi ドメインと重複につき [[WEB-0006]] を正典とする
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[WEB-0006]]）
- note: 正典: spec/webapi.md WEB-0006。webapi(biz3InvokeWebAPIs/webapi_*) は WEB ドメインが所有

### [LOCK-0043] webapiDeviceState は apiKeyId 必須 (未設定で BAD_REQUEST)
- surface: core
- backend: cloud
- command: `client.webapiDeviceState`
- branch: missing-apiKeyId
- assert: webapiDeviceState apiKeyId 未解決で BAD_REQUEST。webapi ドメインと重複につき [[WEB-0014]] を正典とする
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[WEB-0014]]）
- note: 正典: spec/webapi.md WEB-0014。webapi(biz3InvokeWebAPIs/webapi_*) は WEB ドメインが所有

## cloud route CLI

CLI の cloud 経路解決 (auto/--cloud-only)・cloud 不可 op の die・cloud ログイン必須。

### [LOCK-0044] CLI auto/--cloud-only は lock/unlock/toggle/click を cloud で運ぶ
- surface: cli
- backend: cloud
- command: `sesame <device> lock|unlock|toggle|click`
- branch: auto | --cloud-only
- assert: pickTransport が cloud で運べる op (cloud[] に在る lock/unlock/toggle/click) を auto/--cloud-only で 'cloud' に解決し、runCloudOp が hub の lock/unlock/toggle/botClick を呼ぶ
- ref: packages/kit/src/cli/lock-ops.js:97-119,221-237; packages/core/src/ble/devicemodel.js:83-84
- kind: option-branch
- status: covered
- note: click/bot は cloud で botClick(89) に写像 (lock-ops.js:231; CMD.CLICK=89=crypto.js:236)。pickTransport の auto は line 118 `allowed.includes("cloud") ? "cloud" : "ble"`、--cloud-only は line 113-115。devicemodel.js:83 LOCK5 cloud=[lock,unlock,toggle], :84 BOT2 cloud=[click]。

### [LOCK-0045] CLI --cloud-only で cloud 不可 op は opNotOverCloud で die(2)
- surface: cli
- backend: cloud
- command: `sesame <device> autolock --cloud-only`
- branch: --cloud-only | op-not-cloud
- assert: cloud[] に無い op (autolock) を --cloud-only で要求すると die(cli.opNotOverCloud, exit 2)
- ref: packages/kit/src/cli/lock-ops.js:113-115; packages/core/src/ble/devicemodel.js:83
- kind: error-path
- status: covered
- note: lock-ops.js:114 `if (!allowed.includes("cloud")) { die(t("cli.opNotOverCloud", {op}), 2); }`。devicemodel.js:83 LOCK5 は autolock を ble[] のみに持ち cloud[] には含まない。

### [LOCK-0046] CLI cloud op 実行は cloud ログイン必須
- surface: cli
- backend: cloud
- command: `sesame <device> unlock --cloud-only`
- branch: no-cloud-session
- assert: transport==='cloud' かつ cloud セッション未確立なら die(cli.cloudNotLoggedIn, exit 2)
- ref: packages/kit/src/cli/lock-ops.js:323-327
- kind: error-path
- status: covered
- note: lock-ops.js:323 `// transport === "cloud"`、324 `if (!hasCloudSession(program)) {`、325 `die(t("cli.cloudNotLoggedIn"), 2);`。

## cloud status CLI

CLI status は cloud 既定で getDeviceStatus を呼び secretKey を出力から落とす。

### [LOCK-0047] CLI status は cloud で getDeviceStatus、secretKey を出力から落とす
- surface: cli
- backend: cloud
- command: `sesame <device> status`
- branch: auto/--cloud-only | --json
- assert: status は cloud 既定 (getDeviceStatus) で取得し sanitizeStatus が secretKey を除去、fmtCloudStatus が state/pos/battery を整形する。--json では status を封筒に載せる
- ref: packages/kit/src/cli/lock-ops.js:103-105,128-134,141-145,223-227
- kind: option-branch
- status: covered
- note: mech を持たない型 (hub/biometric/wifi) は noTransportForOp で die(2) (lock-ops.js:104 `if (!capabilitiesForModel(model).mechKind) { die(t("cli.noTransportForOp",{op}),2); }`)。103-105 status branch (auto/--cloud-only→cloud)、128-134 fmtCloudStatus、141-145 sanitizeStatus、223-227 runCloudOp status 経路 (line 226 で {status:safe} を封筒に載せる)。

## surface parity

name 解決経路と direct (config-less) 経路の同一フレーム性・subUUID 未取得時の NOT_CONNECTED。

### [LOCK-0048] name-based と direct (config-less) で同一 cmd フレームになる
- surface: core
- backend: cloud
- command: `lockManager.unlock` / `lockManager.unlockDevice`
- branch: name-based | direct
- assert: config 名前解決経路 (lockManager.unlock) と直接 deviceUUID/secretKey 経路 (unlockDevice) が同じ triggerLock フレーム (cmd/sign/history/device_id) を生成する
- ref: packages/core/src/lock-manager.js:82-86,142,65-72,134-138; packages/core/src/lock.js:125-147; packages/core/src/client.js:1352
- kind: surface-parity
- status: covered
- note: name-based unlock=lock-manager.js:82-86 → lockUnlock(lock.js:147) → triggerLock(lock.js:125-142); direct unlockDevice=lock-manager.js:142 → triggerDevice(134-138) → triggerLock。両経路とも triggerLock が cmacTime(secretKey)=sign / uuidToHistoryBase64(subUUID)=history / device_id を組み立て (lock.js:89,133-141)、cmd=83 で同一フレーム。client.js:1352 は direct unlockDevice の薄い委譲ラッパ。

### [LOCK-0049] lockManager は subUUID 未取得時 NOT_CONNECTED
- surface: core
- backend: cloud
- command: `lockManager.unlock` / `lockManager.triggerDevice`
- branch: no-subUUID
- assert: subUUID アクセサが null を返すと SesameError(code=NOT_CONNECTED, retryable:true) を投げる (connect 前の操作を弾く)
- ref: packages/core/src/lock-manager.js:66-67,136-137
- kind: error-path
- status: covered
- note: lock-manager.js:66-67 (_lockParams, name-based unlock 経由) / 136-137 (triggerDevice) の双方で subUUID null → SesameError(NOT_CONNECTED, retryable:true)。

## lock-manager entry解決

config の name 解決 (default.lock / 単一locks fallback) と entry 必須フィールド検査。

### [LOCK-0050] lock-manager の name 解決 (default.lock / 単一locks fallback) と必須フィールド検査
- surface: core
- backend: local
- command: `LockManager.resolveLock` / `_lockParams`
- branch: name指定 | name省略→default.lock | locks単一→それ | 未解決→reject | deviceUUID欠落→reject | secretKey欠落→reject
- assert: resolveByName が name→locks/default.lock を解決し、deviceUUID/secretKey 欠落時に BAD_REQUEST を投げる (BLE 動詞へ渡す entry={deviceId,secretKey} の解決契約)
- ref: packages/core/src/lock-manager.js:53-72; packages/core/src/resolve.js:31-39
- kind: option-branch
- status: covered
- note: lock-manager 自体は WS(cloud)経路。entry 解決ロジックは BLE ファサード呼び出しの前段と共通な local 契約。resolve.js:31-39 = resolveByName(chosen=name||defaultName||単一fallback; !chosen→noneSpecified; !entry→unknown、いずれも badRequest)。lock-manager.js:53-58=resolveLock→resolveByName 委譲, :65-72=_lockParams(subUUID/deviceUUID/secretKey 欠落で BAD_REQUEST)。

## OS3 lock/unlock wire

OS3 (SesameOS3) 送信フレーム = [itemCode]++data (op_code 無し)、click の index 規則。

### [LOCK-0051] OS3 lock の ItemCode と送信フレーム (item=82, [item]++data, op_code 無し)
- surface: core
- backend: ble
- command: `SesameBle.lock(tag)`
- branch: tag省略 | tag指定(Buffer)
- assert: lock の送信フレームが buildSendFrame(LOCK=82, historyTagBLE(tag)) = [0x52]++data で、op_code を付与しない (OS3 は item_code++data)。SesameItemCode.lock=82u と一致
- ref: packages/core/src/ble/index.js:934; packages/core/src/ble/protocol.js:330; packages/core/src/itemcodes.js:34; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:177-187; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:36
- kind: payload-fidelity
- status: covered
- note: 送信フレームに op_code を含まない点が OS2 との差 [[LOCK-0058]]。SesameOS3Payload.toDataWithHeader()=[itemCode]++data (CHSesameOS3.kt:495-499) / index.js:934 は session.request(LOCK,...) 経由で session.js:503 が buildSendFrame を呼ぶ。CHSesame5Device.kt lock の BLE 直結分岐は 177-187。

### [LOCK-0052] OS3 unlock の ItemCode と送信フレーム (item=83)
- surface: core
- backend: ble
- command: `SesameBle.unlock(tag)`
- branch: tag省略 | tag指定(Buffer)
- assert: unlock の送信フレームが buildSendFrame(UNLOCK=83, historyTagBLE(tag)) で、SesameItemCode.unlock=83u と一致 (CHSesame5Device.kt unlock の SesameOS3Payload(unlock.value, historyTagBLE))
- ref: packages/core/src/ble/index.js:940; packages/core/src/itemcodes.js:35; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:156-166; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:36
- kind: payload-fidelity
- status: covered
- note: CHSesame5Device.kt:156-159 が sendCommand(SesameOS3Payload(unlock.value, historyTagBLE)) (unlock 関数は 147-166)。SesameProtocols.kt:36 に unlock(83u)。itemcodes.js:35=UNLOCK:83。

### [LOCK-0053] OS3 click (Bot) の ItemCode (item=89) と RUN_SCRIPT_0(170)+index 規則
- surface: core
- backend: ble
- command: `SesameBle.click(tag)` / `SesameBle script.click(index)`
- branch: index無し(89) | index指定(170+index)
- assert: 単純 click は CLICK=89、index 指定 click は BOT2_ITEM_CODE_RUN_SCRIPT_0(170)+index の itemCode を送る (CHSesameBot2Device.kt:73-97 の itemCode 選択ロジックと一致)
- ref: packages/core/src/ble/index.js:946; packages/core/src/itemcodes.js:41; packages/core/src/itemcodes.js:55-64; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:73-97; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:36; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:47
- kind: payload-fidelity
- status: covered
- note: CHSesameBot2Device.kt click 関数全体は 73-97 (sendCommand は 91-96)。SesameProtocols.kt:36 は click(89u)、RUN_SCRIPT_0(170u) は :47。itemcode 選択は kt:75-80 (BOT2_ITEM_CODE_RUN_SCRIPT_0.value+index)。index.js:946 は単純 click(89) のみ送出 (index 付き click は Bot2 module 由来) ── index 規則は SDK 側で確認。

## OS3 history tag

OS3 historyTagBLE のバイト列 ([0x00,0x0E] 前置 + 20B 切詰め) と型検証。

### [LOCK-0054] OS3 historyTagBLE のバイト列 ([0x00,0x0E] 前置 + 20B 切詰め)
- surface: core
- backend: ble
- command: `historyTagBLE(tag)`
- branch: tag省略(typeのみ2B) | tag指定 | tag>18B(20B切詰め)
- assert: historyTagBLE が enumTo16BitBE(NAME_UUID_TYPE_ANDROID_USER_BLE_UUID=14 → [0x00,0x0E]) ++ tag を 20B に切詰めるバイト列を返す (CHDBModel.kt:37-42 + SesameProtocols.kt:70 と一致)
- ref: packages/core/src/ble/protocol.js:358-364; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/db/model/CHDBModel.kt:37-42; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/db/model/CHDBModel.kt:51-57; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:69-71
- kind: payload-fidelity
- status: covered
- note: CHDBModel.kt:37-42 が historyTagBLE (enumTo16BitBE(BLE_UUID=14)++histag を take(20))、:51-57 が enumTo16BitBEByteArray ([shr8, val] = 14→[0x00,0x0E])。SesameProtocols.kt:69-71 が NAME_UUID_TYPE_ANDROID_USER_BLE_UUID(14U)。protocol.js:363 が Buffer.from([0x00,0x0e])++tag を subarray(0,20)。現行 test tests/ble/protocol.test.js:129-134 が観点をカバー (status は未タグのため planned)。

### [LOCK-0055] OS3 historyTagBLE に非バイト列 (string) を渡すと reject
- surface: core
- backend: ble
- command: `historyTagBLE(tag)`
- branch: string渡し | number渡し
- assert: tag が Buffer/Uint8Array 以外 (string 等) のとき throw する (type=0x000E は UUID バイト列前提のため utf8 文字列は不整合)。SDK は ByteArray? のみ受ける
- ref: packages/core/src/ble/protocol.js:359-362; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/db/model/CHDBModel.kt:37-42
- kind: error-path
- status: covered
- note: protocol.js:360-362 が tag==null→空、Buffer/Uint8Array→受理、それ以外→throw t('ble.historyTagBuffer')。CHDBModel.kt:37-42 の SDK 署名 historyTagBLE(histag_: ByteArray? = null) が ByteArray? 限定を支持。tests/ble/protocol.test.js:135-137 に文字列 throw テスト実在 (planned 維持)。

## OS3 toggle

OS3 toggle のクライアント側 lock/unlock 判定 (mechStatus.isInLockRange)。

### [LOCK-0056] OS3 toggle のクライアント側 lock/unlock 判定 (mechStatus.isInLockRange)
- surface: core
- backend: ble
- command: `SesameBle.toggle(tag)`
- branch: lastStatus=locked→unlock | lastStatus=unlocked→lock | lastStatus未取得→status()待ち
- assert: toggle は直近 mechStatus が state=locked なら UNLOCK(83)、それ以外なら LOCK(82) を送る (CHSesame5Device.kt:128-145: deviceStatus==Locked→unlock else lock とクライアント判定が一致)
- ref: packages/core/src/ble/index.js:953-962; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:128-145
- kind: payload-fidelity
- status: covered
- note: index.js:953-962 が lastStatus 無しなら status() 待ち→state===MECH_STATE.LOCKED(="locked", protocol.js:697)→UNLOCK else LOCK。CHSesame5Device.kt:130-134 が deviceStatus==CHDeviceStatus.Locked→unlock else lock。OS3 にサーバ判定 toggle(88) 経路はあるが BLE 直結はクライアント判定。

## OS3 autolock

OS3 autolock の 2B LE payload・範囲検証・成功時 mechSetting 局所更新。

### [LOCK-0057] OS3 autolock の ItemCode (item=11) と 2B LE payload
- surface: core
- backend: ble
- command: `SesameBle.autolock(seconds)` / `session.autolock`
- branch: seconds=正常 | seconds=0(無効化)
- assert: autolock の送信が buildSendFrame(AUTOLOCK=11, autolockData(seconds)) で、autolockData が writeUInt16LE の 2B (= delay.toShort().toReverseBytes()) と一致。0 は [0,0] で無効化
- ref: packages/core/src/ble/index.js:971; packages/core/src/ble/session.js:539-549; packages/core/src/ble/protocol.js:371-378; packages/core/src/itemcodes.js:22; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:96-105
- kind: payload-fidelity
- status: covered
- note: index.js:971 → session.js:539-541 (autolockData→request(AUTOLOCK)) + 542-547 が mechSetting.autoLockSecond 局所更新 (CHSesame5Device.kt:102 準拠)。protocol.js:371-378 が writeUInt16LE 2B (0..65535 検証)。itemcodes.js:22=AUTOLOCK:11。CHSesame5Device.kt:99 が SesameOS3Payload(autolock.value, delay.toShort().toReverseBytes())。tests/ble/protocol.test.js:138-143 が 2B LE と 0 を観測。OS2 は 24B (createHistag 連結) で差 [[LOCK-0064]]。

### [LOCK-0058] OS3 autolockData の範囲/非整数 reject (0..65535 / 整数)
- surface: core
- backend: ble
- command: `autolockData(seconds)`
- branch: 負値 | >65535 | 非整数(小数) | NaN
- assert: seconds が 0..65535 の整数でないとき throw (writeUInt16LE 範囲外を事前に弾く)。UShort 範囲と一致
- ref: packages/core/src/ble/protocol.js:372-374; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:99
- kind: error-path
- status: covered
- note: protocol.js:372-374 が Number.isInteger && 0..0xffff の範囲チェック throw。SDK:99 は delay.toShort().toReverseBytes() で 2B LE 化し UShort 範囲を裏付ける。

### [LOCK-0059] OS3 autolock 成功時 lastMechSetting.autoLockSecond 局所更新
- surface: core
- backend: ble
- command: `session.autolock(seconds)`
- branch: キャッシュ既存 | キャッシュ未初期化(新規作成)
- assert: autolock 成功 (resultCode==0) 時に _lastMechSetting.autoLockSecond=seconds を局所更新する (CHSesame5Device.kt:102 mechSetting?.autoLockSecond=delay.toShort() と同じ局所更新)
- ref: packages/core/src/ble/session.js:539-549; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:96-105
- kind: payload-fidelity
- status: covered
- note: session.js:543-547 で既存マージ/未初期化時 lock=unlock=0 で新規作成。await this.request は _resolvePending(session.js:1008) が resultCode!=0 で reject するため到達は成功時のみで assert と整合。SDK:102 で mechSetting?.autoLockSecond=delay.toShort()。

## OS3 mech status

OS3 mechStatus (7B lock / 3B bot) のビットレイアウト・長さ分岐・state 2 値判定・batteryRaw 素通し。

### [LOCK-0060] OS3 7B mechStatus (lock) のビットレイアウト解釈
- surface: core
- backend: ble
- command: `parseMechStatus(buf)`
- branch: flags bit1=lockRange | bit3=critical | bit4=stop | bit5=batCritical
- assert: 7B で batteryRaw=u16LE[0..1], target=i16LE[2..3](-32768→null), position=i16LE[4..5], flags=data[6] の bit1 isInLockRange / bit3 isCritical / bit4 isStop / bit5 isBatteryCritical を CHSesame5MechStatus(CHSesame5.kt:24-32) と一致して解釈
- ref: packages/core/src/ble/protocol.js:733-750; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame5.kt:24-32
- kind: payload-fidelity
- status: covered
- note: protocol.js:734-746 で readUInt16LE(0)/readInt16LE(2)→-32768=null/readInt16LE(4)/flags=buf[6] と and 2/8/16/32。SDK CHSesame5.kt:25-31 の position/target/flags(2,8,16,32) と一致。

### [LOCK-0061] OS3 3B mechStatus (bot/bike) のビットレイアウトと interface 既定値
- surface: core
- backend: ble
- command: `parseMechStatus(buf)`
- branch: flags bit1=lockRange | bit2=stop
- assert: 3B で batteryRaw=u16LE[0..1], flags=data[2] の bit1 isInLockRange/bit2 isStop。position/target=0, isCritical=null, isBatteryCritical=false の interface 既定値が CHSesameBot2MechStatus(CHSesameBot2.kt:123-126)+CHDeivceProtocols.kt:335-348 と一致
- ref: packages/core/src/ble/protocol.js:762-779; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:123-126; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHDeivceProtocols.kt:335-348
- kind: payload-fidelity
- status: covered
- note: protocol.js:763-776 で flags=buf[2], and 2(lockRange)/and 4(stop), target=0/position=0/isCritical=null/isBatteryCritical=false。SDK CHSesameBot2.kt:124-126(flags and 2 / and 4) と CHDeivceProtocols.kt:335-348(position=0,target=0,isBatteryCritical=false,isCritical=null) の interface 既定に一致。

### [LOCK-0062] OS3 mechStatus の長さ分岐 (7B=lock / 3B=bot) と不正長 reject
- surface: core
- backend: ble
- command: `parseMechStatus(buf)`
- branch: len=3→bot | len>=7→lock | それ以外→throw | 非Buffer→throw
- assert: publish payload 長で具象クラスを選ぶ SDK (CHSesame5Device.kt:213-216 / CHSesameBot2Device.kt:58-61) に倣い len=3/>=7 で分岐し、その他長や非Buffer は throw する
- ref: packages/core/src/ble/protocol.js:722-727; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:58-61; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:213-216
- kind: error-path
- status: covered
- note: protocol.js:723-726 で 非Buffer throw / len==3→bot / len>=7→lock / else throw。SDK CHSesameBot2Device.kt:58-61 が size>=7→CHSesame5MechStatus, size==3→CHSesameBot2MechStatus の明示的長さ分岐。CHSesame5Device.kt:215 は 7B mechStatus を一律 CHSesame5MechStatus で読む補強出典。

### [LOCK-0063] OS3 mechStatus state は isInLockRange 単独判定 (unlock-range/moved 無し)
- surface: core
- backend: ble
- command: `parseMechStatus(buf).state`
- branch: isInLockRange→locked | else→unlocked
- assert: OS3 は施錠/解錠を isInLockRange の有無のみで 2 値判定し、中間 moved も unlock-range ビットも持たない (CHSesame5.kt / CHDeivceProtocols.kt:343-344 isInUnlockRange=!isInLockRange と一致)
- ref: packages/core/src/ble/protocol.js:740; packages/core/src/ble/protocol.js:767; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHDeivceProtocols.kt:341-344
- kind: payload-fidelity
- status: covered
- note: OS2 は moved を持つ点が差 [[LOCK-0071]]。

### [LOCK-0064] OS3 lock mechStatus の batteryRaw=data[0..1] u16LE を素通し
- surface: core
- backend: ble
- command: `parseMechStatus(buf).batteryRaw`
- branch: -
- assert: OS3 lock の電池電圧 ADC 生値を data[0..1] u16LE のまま batteryRaw で返す (CHSesame5Device.kt:217 reportBatteryData が payload[0..1] を hex 化して送るのと同じ生値域)。換算式は本体に無い
- ref: packages/core/src/ble/protocol.js:734; packages/core/src/ble/protocol.js:706; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:217
- kind: payload-fidelity
- status: covered
- note: protocol.js:734 = readUInt16LE(0)→batteryRaw、:706 = 「data[0..1]:電池電圧 ADC 生値…batteryRaw として返すのみ」コメント、CHSesame5Device.kt:217 = reportBatteryData(payload.sliceArray(0..1).toHexString())。全一致。

## OS3 capability gate

OS3 _assertOp による動詞×機種ガードと autolock の over-exposure 回避設計。

### [LOCK-0065] OS3 _assertOp による lock/unlock/click/toggle/autolock の機種別ガード
- surface: core
- backend: ble
- command: `SesameBle.lock/unlock/toggle/click/autolock`
- branch: LOCK5(lock/unlock/toggle/autolock) | BOT2(click) | BIKE2/3(unlock) | Bot で lock→reject
- assert: 各動詞が caps.ble に含まれない機種で BAD_REQUEST を投げる。能力表 (devicemodel.js:83-86 ble[]) が SDK の機種別 op 非対称 (LOCK5=lock/unlock/toggle/autolock, Bot=click, Bike=unlock) と一致
- ref: packages/core/src/ble/index.js:802-812; packages/core/src/ble/devicemodel.js:83-86; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame5.kt:13-21
- kind: option-branch
- status: covered
- note: index.js:803 で !caps.ble.includes(op)→badRequest。各公開メソッド lock(934)/unlock(940)/click(946)/toggle(954)/autolock(971) が _assertOp を呼ぶ。devicemodel.js:83-86 で LOCK5.ble=[lock,unlock,toggle,autolock]/BOT2.ble=[click]/BIKE2,BIKE3.ble=[unlock]。CHSesame5.kt:13-19 が LOCK5 の lock/unlock/toggle/autolock 宣言。

### [LOCK-0066] OS3 autolock の over-exposure 回避 (_assertLock5 ではなく ble[] 露出)
- surface: core
- backend: ble
- command: `SesameBle.autolock(seconds)`
- branch: LOCK5/SESAME2→許可 | Bot/Bike/biometric→reject
- assert: autolock は LOCK5 と OS2 SESAME2/4 のみ caps.ble に含まれ、Bot/Bike/biometric では _assertOp("autolock") が reject する (autolock 能力は OS2 も持つため _assertLock5 では弾けない設計と一致)
- ref: packages/core/src/ble/index.js:819; packages/core/src/ble/index.js:971; packages/core/src/ble/devicemodel.js:83; packages/core/src/ble/devicemodel.js:87
- kind: option-branch
- status: covered
- note: index.js:819 の _assertLock5 コメントが over-exposure 設計理由を述べ、index.js:971 autolock() が実際に _assertOp("autolock") で gate。devicemodel.js:83 LOCK5・:87 SESAME2 の ble[] に autolock 在。

## OS2 lock/unlock wire

OS2 (SesameOS2) 送信フレーム = [op_code,item_code]++data (OP.ASYNC 先頭) と click。

### [LOCK-0067] OS2 lock の OP/ItemCode と送信フレーム (OP.ASYNC, item=82, [op,item]++data)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.lock(tag)`
- branch: tag省略 | tag指定(Buffer)
- assert: OS2 lock が buildSendFrame(OP.ASYNC=6, LOCK=82, createHistag(tag)) = [0x06,0x52]++data で op_code を先頭に含む (CHSesame2Device.kt:185 SSM2OpCode.async, lock と一致)
- ref: packages/core/src/ble/os2/index.js:158; packages/core/src/ble/os2/protocol.js:219-220; packages/core/src/ble/protocol.js:34-36; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:180-193
- kind: payload-fidelity
- status: covered
- note: OS2 送信フレームは op_code 含む。OS3 との差 [[LOCK-0051]]。os2/index.js:158 lock()→OP.ASYNC,ITEM.LOCK。os2/protocol.js:35 で親 protocol.js の OP を再エクスポートし OS2 path の OP は protocol.js:34-36 (ASYNC=0x06 が :36) が正準。buildSendFrame は os2/protocol.js:219-220。LOCK=82 は itemcodes.js:34。CHSesame2Device.kt:185 = SSM2Payload(async, lock, createHistag)。

### [LOCK-0068] OS2 unlock の OP/ItemCode (OP.ASYNC, item=83)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.unlock(tag)`
- branch: tag省略 | tag指定(Buffer)
- assert: OS2 unlock が buildSendFrame(OP.ASYNC=6, UNLOCK=83, createHistag(tag)) と一致 (CHSesame2Device.kt:195-211 / Bike CHSesameBikeDevice.kt:313 SSM2OpCode.async, unlock)
- ref: packages/core/src/ble/os2/index.js:165; packages/core/src/ble/os2/protocol.js:219-220; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:195-211; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:306-313
- kind: payload-fidelity
- status: covered
- note: SSM2Payload(SSM2OpCode.async, SesameItemCode.unlock, his) は CHSesameBikeDevice.kt:313。CHSesame2Device.kt:195-211 (=:202 async unlock)。UNLOCK=83 は itemcodes.js:35。

### [LOCK-0069] OS2 click (Bot1) の OP/ItemCode (OP.ASYNC, item=89)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.click(tag)`
- branch: tag省略 | tag指定
- assert: OS2 Bot1 click が buildSendFrame(OP.ASYNC=6, CLICK=89, createHistag(tag)) と一致 (CHSesameBotDevice.kt:409 SSM2OpCode.async, click)
- ref: packages/core/src/ble/os2/index.js:172; packages/core/src/itemcodes.js:41; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:397-412
- kind: payload-fidelity
- status: covered
- note: SSM2Payload(SSM2OpCode.async, SesameItemCode.click, his) は CHSesameBotDevice.kt:409。refs 範囲 397-412 は click override 先頭 (:397) と async click 行 (:409) の双方を包含。os2/index.js:172 click()→OP.ASYNC,ITEM.CLICK、CLICK=89 は itemcodes.js:41。

## OS2 history tag

OS2 createHistag のバイト列 ([size 1B]++take(21)++0埋め=22B固定) と型検証。

### [LOCK-0070] OS2 createHistag のバイト列 ([size 1B]++take(21)++0埋め=22B固定)
- surface: core
- backend: ble-os2
- command: `createHistag(tag)`
- branch: tag省略/null(全0 22B) | tag指定 | tag>21B(21B切詰め)
- assert: createHistag が [limited.length 1B] ++ histag.take(21) ++ padding で常に 22B を返す (CHDBModel.kt:18-23 と 1:1)。tag 無しでも全 0 の 22B
- ref: packages/core/src/ble/os2/protocol.js:284-294; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/db/model/CHDBModel.kt:18-23
- kind: payload-fidelity
- status: covered
- note: OS3 historyTagBLE (20B, type前置=CHDBModel.kt:37-40) と構造が異なる [[LOCK-0054]]。os2/protocol.js:284-294 = createHistag 実装 (subarray(0,21)→out[0]=length→copy→22B Buffer)、CHDBModel.kt:18-23 = take(21)+padding(22-size-1) で 1:1。null/省略時 [0x00]++0*21 = 全0 22B。

### [LOCK-0071] OS2 createHistag に非バイト列を渡すと reject
- surface: core
- backend: ble-os2
- command: `createHistag(tag)`
- branch: string渡し | number渡し
- assert: tag が Buffer/Uint8Array/null 以外のとき throw (SDK は ByteArray? のみ受ける)
- ref: packages/core/src/ble/os2/protocol.js:285-288; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/db/model/CHDBModel.kt:18-23
- kind: error-path
- status: covered
- note: os2/protocol.js:286-288 = null→空、Buffer/Uint8Array→Buffer.from、else throw new Error('createHistag: pass tag as Buffer/Uint8Array')。CHDBModel.kt:18 の Kotlin シグネチャは ByteArray? のみで string/number を型レベルで排除。

## OS2 toggle

OS2 toggle のクライアント側 lock/unlock 判定 (lastStatus.state)。

### [LOCK-0072] OS2 toggle のクライアント側 lock/unlock 判定 (lastStatus.state)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.toggle(tag)`
- branch: lastStatus=locked→unlock | else→lock | lastStatus未取得→status()待ち
- assert: toggle は直近 mechStatus が state=locked なら UNLOCK(83) else LOCK(82) を送る (CHSesame2Device.kt:172-176: mechStatus?.isInLockRange==true→unlock else lock と一致)
- ref: packages/core/src/ble/os2/index.js:179-184; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:165-178
- kind: payload-fidelity
- status: covered
- note: index.js:179-184 (toggle メソッド本体, s.state===MECH_STATE.LOCKED→UNLOCK else LOCK)。Kotlin の判定そのものは CHSesame2Device.kt:172-176。ref の 165-178 はメソッド全体 (override fun toggle) を含む。

## OS2 autolock

OS2 autolock の OP.UPDATE/2B LE++createHistag=24B payload・範囲検証・disableAutolock・getAutolock。

### [LOCK-0073] OS2 autolock の OP/ItemCode (OP.UPDATE, item=11) と 2B LE++createHistag=24B payload
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.autolock(seconds, tag)`
- branch: seconds=正常 | tag省略 | tag指定
- assert: autolock が buildSendFrame(OP.UPDATE=3, AUTOLOCK=11, autolockData(seconds,tag)) で、autolockData=2B LE 秒数 ++ createHistag(tag)=24B と一致 (CHSesame2Device.kt:141 SSM2OpCode.update, autolock, delay.toShort().toReverseBytes()++createHistag)
- ref: packages/core/src/ble/os2/index.js:193; packages/core/src/ble/os2/protocol.js:425-432; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:138-148
- kind: payload-fidelity
- status: covered
- note: index.js:193 autolock=request(OP.UPDATE, ITEM.AUTOLOCK, autolockData)。protocol.js:425-432 autolockData=writeUInt16LE(2B)++createHistag(22B)=24B。OP.UPDATE=0x03 (protocol.js:35), AUTOLOCK=11 (itemcodes.js:22)。createHistag は 22B (protocol.js:290)。CHSesame2Device.kt:141 enableAutolock 一致。OS3 autolock(2B のみ)との差 [[LOCK-0057]]。

### [LOCK-0074] OS2 autolockData の範囲/非整数 reject (0..65535 / 整数)
- surface: core
- backend: ble-os2
- command: `autolockData(seconds, tag)`
- branch: 負値 | >65535 | 非整数 | NaN
- assert: seconds が 0..65535 の整数でないとき throw (writeUInt16LE 範囲外を事前に弾く)
- ref: packages/core/src/ble/os2/protocol.js:426-428; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:141
- kind: error-path
- status: covered
- note: protocol.js:426-428 = `if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) throw` で NaN/非整数/負値/>65535 を弾く。CHSesame2Device.kt:141 は delay:Int を toShort() で 16bit 化するため上位制約に対応。

### [LOCK-0075] OS2 disableAutolock = autolock(0) のショートカット (seconds=0 無効化)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.disableAutolock(tag)`
- branch: tag省略 | tag指定
- assert: disableAutolock(tag) が autolock(0, tag) と同じフレーム ([0x03,0x0B] ++ [0,0] ++ createHistag) を送る (CHSesame2Device.kt:150-152 disableAutolock=enableAutolock(0))
- ref: packages/core/src/ble/os2/index.js:196; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:150-152
- kind: payload-fidelity
- status: covered
- note: index.js:196 = `disableAutolock(tag) { return this.autolock(0, tag); }`。OP.UPDATE=0x03 / AUTOLOCK=11=0x0B、seconds=0→[0,0] LE。CHSesame2Device.kt:150-152 = `disableAutolock = enableAutolock(0, ...)` 一致。

### [LOCK-0076] OS2 getAutolock の OP/ItemCode (OP.READ, item=11) と LE 秒数デコード
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.getAutolock()`
- branch: payload<=6B(readUIntLE) | 7-8B 上位0(下位6B) | 7-8B 上位非0(BigInt) | 空payload(0)
- assert: getAutolock が OP.READ+AUTOLOCK を送り、応答 payload を reversedArray した LE 整数を返す (CHSesame2Device.kt:154-162: Long.parseLong(payload.reversedArray().toHexString(),16).toInt() と等価)
- ref: packages/core/src/ble/os2/index.js:202-224; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:154-162
- kind: payload-fidelity
- status: covered
- note: index.js:202-224 getAutolock=request(OP.READ, ITEM.AUTOLOCK)→payload を空/<=6B(readUIntLE)/7-8B(上位0は下位6B, 上位非0は BigInt) で分岐デコード。CHSesame2Device.kt:154-162 getAutolockSetting (:157 read+autolock, :159 Long.parseLong(reversedArray().toHexString(),16).toInt()) と等価。

## OS2 mech status

OS2 mechStatus (8B 固定) のビットレイアウト・不正長・3 値 state・isStop kind 分岐・度数換算。

### [LOCK-0077] OS2 8B mechStatus のビットレイアウト (retCode=data[6], flags=data[7])
- surface: core
- backend: ble-os2
- command: `parseMechStatus(buf)`
- branch: flags bit1=lockRange | bit2=unlockRange | bit5=batCritical | data[6]=retCode
- assert: 8B で batteryRaw=u16LE[0..1], target=i16LE[2..3](-32768→null), position=i16LE[4..5], retCode=data[6], flags=data[7] の bit1 isInLockRange/bit2 isInUnlockRange/bit5 isBatteryCritical を CHSesame2MechStatus(CHSesame2.kt:30-40) と一致して解釈 (retCode/flags の順が OS3 と逆)
- ref: packages/core/src/ble/os2/protocol.js:488-499; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:30-40
- kind: payload-fidelity
- status: covered
- note: protocol.js:488-499 = batteryRaw=readUInt16LE(0)/target=readInt16LE(2)/position=readInt16LE(4)/retCode=buf[6]/flags=buf[7]/isInLockRange=flags&2/isInUnlockRange=flags&4/isBatteryCritical=flags&32。CHSesame2.kt:30-40 と完全一致。OS3 lock は flags=data[6]・retCode 無し。OS2 は data[6]=retCode/data[7]=flags [[LOCK-0060]]。

### [LOCK-0078] OS2 mechStatus の不正長 reject (>=8B 必須)
- surface: core
- backend: ble-os2
- command: `parseMechStatus(buf)`
- branch: len<8→throw | 非Buffer→throw
- assert: Kotlin の CHSesame2MechStatus は data[7] まで無条件に読む 8B 固定のため、8B 未満や非Buffer は throw する
- ref: packages/core/src/ble/os2/protocol.js:489-491; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:30-40
- kind: error-path
- status: covered
- note: protocol.js:489 = `if (!Buffer.isBuffer(buf)) throw`、:491 = `if (buf.length < 8) throw`。CHSesame2.kt:30-40 (とくに :36 flags=data[7]) は data[7] まで無条件アクセスするため 8B 未満は Kotlin 側で IndexOutOfBounds 相当。

### [LOCK-0079] OS2 mechStatus state の 3 値判定 (lock/unlock/moved)
- surface: core
- backend: ble-os2
- command: `parseMechStatus(buf).state`
- branch: isInLockRange→locked | isInUnlockRange→unlocked | どちらも0→moved
- assert: OS2 lock は isInLockRange→LOCKED, isInUnlockRange→UNLOCKED, どちらも非該当→MOVED の 3 値 (CHSesame2Device.kt:551 / CHSesameBikeDevice.kt:299 と一致)
- ref: packages/core/src/ble/os2/protocol.js:506-508; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:551; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:299
- kind: payload-fidelity
- status: covered
- note: OS3 は 2 値で moved 無し [[LOCK-0063]] (CHSesame5Device.kt:61/207/216 で if(isInLockRange) Locked else Unlocked を確認)。

### [LOCK-0080] OS2 mechStatus isStop の kind 3 値化 (os2lock=null/os2bot=motorStatus/os2bike=flags bit0)
- surface: core
- backend: ble-os2
- command: `parseMechStatus(buf, {kind})`
- branch: os2lock(null) | os2bot(motorStatus 0/2→true,1/3→false) | os2bike(flags&1==0)
- assert: isStop が kind により分岐: Sesame2/3/4(os2lock)=null(CHSesame2.kt:40), Bot1(os2bot)=motorStatus由来(CHSesameBotDevice.kt:286-293), Bike1(os2bike)=flags bit0由来(CHSesameBot.kt:28) と一致
- ref: packages/core/src/ble/os2/protocol.js:519-524; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:40; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot.kt:28; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:286-293
- kind: payload-fidelity
- status: covered
- note: test os2-mech-status-kind.test.js が 3 kind を網羅 (実在確認済, 未タグ→planned)。CHSesame2.kt:40=`isStop:Boolean?=null`, CHSesameBot.kt:28=`(flags and 1 == 0)`, CHSesameBotDevice.kt:286-293=motorStatus when ブロック。

### [LOCK-0081] OS2 Bot1 mechStatus state は 2 値 (MOVED 出ない)
- surface: core
- backend: ble-os2
- command: `parseMechStatus(buf, {kind:'os2bot'})`
- branch: isInLockRange→locked | else→unlocked
- assert: os2bot は isInLockRange→LOCKED else→UNLOCKED の 2 値で MOVED を出さない (CHSesameBotDevice.kt:303/346: if(isInLockRange) Locked else Unlocked と一致)
- ref: packages/core/src/ble/os2/protocol.js:505-508; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:303
- kind: payload-fidelity
- status: covered
- note: protocol.js:505 が isBot を定義し :506-508 の三項演算で MOVED を抑止。CHSesameBotDevice.kt:303(login経路)/:346(mechStatus経路) 共に 2 値。Bike(CHSesameBikeDevice.kt:299) は同じ Bot クラスでも device 側で 3 値を出す点と対照的。

### [LOCK-0082] OS2 mechStatus の度数換算 (positionDeg/targetDeg = raw*360/1024 切捨て)
- surface: core
- backend: ble-os2
- command: `parseMechStatus(buf)`
- branch: 正角 | 負角(0方向切捨て) | target=-32768→null
- assert: raw エンコーダ値を Math.trunc(raw*360/1024) で度数化し positionDeg/targetDeg に併記する (CHSesame2.kt:32-33 の Int 除算 0 方向切捨てと一致)
- ref: packages/core/src/ble/os2/protocol.js:536-537; packages/core/src/ble/os2/protocol.js:556-558; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:32-33
- kind: payload-fidelity
- status: covered
- note: protocol.js:536-537=targetDeg/positionDeg(target===-32768→null 分岐込), :556-558=os2RawToDeg(Math.trunc((raw*360)/1024))。CHSesame2.kt:32-33=position/target の `(raw.toInt()*360/1024).toShort()`(:33 で -32768→null)。

## OS3/OS2 response routing

OS2 notify フレーム分解 (response 3B header / publish 1B header, itemCode 先頭)。

### [LOCK-0083] OS2 response/publish フレーム分解 (itemCode 先頭, response 3B header / publish 1B header)
- surface: core
- backend: ble-os2
- command: `parseRecvFrame(buf)`
- branch: notifyOpCode=7(response: itemCode,opCode,resultCode) | =8(publish: itemCode,payload)
- assert: OS2 notify の response body=[cmdItemCode,cmdOpCode,cmdResultCode,...] (itemCode 先頭), publish body=[cmdItemCode,...] を SesameProtocols.kt:15-19/5-8 と一致して分解 (送信フレーム [opCode,itemCode] とは順序が逆)
- ref: packages/core/src/ble/os2/protocol.js:243-259; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:5-19
- kind: wire-fidelity
- status: covered
- note: response の itemCode 先頭が応答ルーティングのキー。実関数は parseRecvFrame:239。protocol.js:243-259=RESPONSE(3B header: itemCode/opCode/resultCode)/PUBLISH(1B header) 分岐。SesameProtocols.kt:5-8=SSM3PublishPayload(cmdItCode=data[0]), :15-19=SSM2ResponsePayload(cmdItCode=data[0],cmdOPCode=data[1],cmdResultCode=data[2]), OP response=0x07/publish=0x08(:57) を確認。

## OS3 lock send path

OS3 lock 系コマンドは login 後のみ送れる (notLoggedIn reject)。

### [LOCK-0084] OS3 lock 系コマンドは login 後のみ送れる (notLoggedIn reject)
- surface: core
- backend: ble
- command: `session.request(itemCode)`
- branch: login済み→送信 | 未login→reject
- assert: request() が _loggedIn=false のとき即 reject し、SDK の unlogined ガード (CHBaseDevice.kt:193-196 isBleAvailable: deviceStatus==unlogined→SesameUnlogin failure、lock/unlock から CHSesame5Device.kt:147-176 経由で発火) と等価に lock/unlock/autolock を弾く
- ref: packages/core/src/ble/session.js:489-505; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/CHBaseDevice.kt:193-196; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:147-176
- kind: error-path
- status: covered
- note: 真の unlogined ガードは CHBaseDevice.kt:193-196 (deviceStatus.value==unlogined→Result.failure(SesameUnlogin))で、CHSesame5Device.kt:147(unlock)/:168(lock) が純BLE経路で isBleAvailable(result) を呼んで発火 (:148/:169 の shadow 経路は cloud cmdSesame へフォールバックする別系統)。session.js:489-505 の `if(!this._loggedIn) reject(ble.notLoggedIn)` は confirmed。

## device-subject routing

デバイス主語ルーティング (argv 書き換え) の各分岐: 既知デバイス/action 同伴/予約コマンド据え置き/値オプション/引数なし/-h。

### [LOCK-0085] 既知デバイス名先頭 → 隠し op コマンドへ argv 書き換え
- surface: cli
- backend: local
- command: `sesame <device> [action]` / `routeDeviceArgv`
- branch: isKnownDevice(firstTok)=true
- assert: 先頭トークンが予約コマンドでなく既知デバイスのとき、argv が [bin, sesame, op, ...userArgs] へ書き換わる (デバイス主語 = device.method() ルーティング)
- ref: packages/kit/src/cli/dispatch.js:80-86; packages/kit/src/cli.js:245-251
- kind: option-branch
- status: covered
- note: tests/cli/dispatch.test.js [既知デバイス (action 無し) も op へ] が被覆。dispatch.js:84-85 で isKnownDevice(firstTok) 真なら op 書き換え。cli.js:245-251 が routeDeviceArgv 呼び出し点。

### [LOCK-0086] device action 同伴トークン → op へ (未登録デバイスでも)
- surface: cli
- backend: local
- command: `sesame <device> <action>` / `routeDeviceArgv`
- branch: secondTok ∈ DEVICE_ACTIONS
- assert: secondTok が DEVICE_ACTIONS のいずれか (unlock/lock/toggle/click/autolock/status) なら firstTok が未知デバイスでも op へ書き換える
- ref: packages/kit/src/cli/dispatch.js:83-86; packages/kit/src/cli/lock-ops.js:40
- kind: option-branch
- status: covered
- note: tests/cli/dispatch.test.js [device action 同伴は op へ書き換える] (isKnownDevice=false でも op) が被覆。dispatch.js:83 hasDeviceAction = secondTok != null && deviceActions.has(secondTok)。lock-ops.js:40 DEVICE_ACTIONS = new Set([...CONTROL_OPS, "status"])。

### [LOCK-0087] 予約コマンド/未知単独トークンは据え置き (op に誤誘導しない)
- surface: cli
- backend: local
- command: `routeDeviceArgv` / `reservedCommandNames`
- branch: reserved firstTok | 未知単独トークン
- assert: 先頭が管理コマンド (init/help/エイリアス含む) または device でも action でもない単独トークンのとき argv を書き換えず commander に未知コマンド (候補提示) を出させる
- ref: packages/kit/src/cli/dispatch.js:44-54; packages/kit/src/cli/dispatch.js:80-88
- kind: option-branch
- status: covered
- note: tests/cli/dispatch.test.js [既知の管理コマンドは書き換えない][未知トークンは据え置き] が被覆。dispatch.js:44-54 reservedCommandNames (help + commands + aliases)、80-88 で !reserved.has(firstTok) ガード + 末尾 return argv 据え置き。

### [LOCK-0088] 値オプションの値をデバイス名と誤認しない (extractPositionals)
- surface: cli
- backend: local
- command: `extractPositionals` / `routeDeviceArgv`
- branch: --config-dir <path> 先頭 | --opt=value | --json bool | -- 区切り
- assert: 値を取るグローバルオプションの次トークンを位置引数から除外し、--opt=value は値同梱として後続を消費せず、-- 以降は全位置引数として扱う (commander Option introspection で追従)
- ref: packages/kit/src/cli/dispatch.js:17-37
- kind: option-branch
- status: covered
- note: tests/cli/dispatch.test.js extractPositionals 群 + tests/cli/arg-router.test.js (実バイナリ --config-dir 前置) が被覆。dispatch.js:27 -- 区切り, 28-32 オプション処理 (eq===-1 && valueOpts.get(flag)===true で i++ 値スキップ)。

### [LOCK-0089] 引数なし: 対話(非--json)は全デバイス session、--json/非対話は help
- surface: cli
- backend: local
- command: `routeDeviceArgv`
- branch: firstTok 無し & interactive & 非--json | firstTok 無し & (--json | 非対話)
- assert: 位置引数ゼロかつ TTY かつ非--json なら [bin, sesame, session] へ、そうでなければ argv 据え置き (help)
- ref: packages/kit/src/cli/dispatch.js:75-79
- kind: option-branch
- status: covered
- note: tests/cli/dispatch.test.js [引数なし + 対話 は session へ][引数なし + --json は据え置き] が被覆。dispatch.js:75-79 if (!firstTok) { if (!isJson && interactive) return [argv[0], argv[1], "session"]; return argv; }。

### [LOCK-0090] -h/--help を含む argv は常に据え置き
- surface: cli
- backend: local
- command: `routeDeviceArgv`
- branch: userArgs に -h | --help
- assert: userArgs に -h/--help が含まれるとき device 主語ルーティングを行わず argv をそのまま返す (help は commander に委ねる)
- ref: packages/kit/src/cli/dispatch.js:67
- kind: option-branch
- status: covered
- note: tests/cli/dispatch.test.js [-h/--help は常に据え置き] が被覆。dispatch.js:67 if (userArgs.some((a) => a === "-h" || a === "--help")) return argv; が最初のガード。

### [LOCK-0091] デバイス名の部分一致では実操作に進まない (完全一致のみ)
- surface: cli
- backend: local
- command: `sesame <device> status` / `resolveLockEntry`
- branch: 部分一致 (例 front に対し fron)
- assert: resolveLockEntry は config.locks の完全一致のみ受理し、不一致は cli.lockNotFound で exit 2 (login 案内などの後段に進まない)
- ref: packages/kit/src/cli/lock-ops.js:59-61; packages/kit/src/i18n/cli.js:189
- kind: error-path
- status: covered
- note: tests/cli/arg-router.test.js [デバイス名の部分一致では実操作に進まない] が被覆 (fron status → code 2, error に 'Lock "fron" not found', 'Not logged in' を含まない)。lock-ops.js:59-61 if (name) { if (locks[name]) chosen=name; else die(t("cli.lockNotFound"),2) } で完全一致のみ受理。cli.lockNotFound の正準 (en) 定義は cli.js:189 (ja は :610)。

## action vocabulary

DEVICE_ACTIONS の語彙導出 (CONTROL_OPS ∪ {status}) と未知 action の die。

### [LOCK-0092] DEVICE_ACTIONS = CONTROL_OPS ∪ {status} の語彙導出
- surface: cli, core
- backend: local
- command: `DEVICE_ACTIONS` / `CONTROL_OPS` / `deriveControlOps`
- branch: -
- assert: DEVICE_ACTIONS が能力テーブル由来の CONTROL_OPS (lock/unlock/toggle/click/autolock) に status を足した集合と一致し、ir/relay/led を含まない (二重定義の排除)
- ref: packages/kit/src/cli/lock-ops.js:40; packages/core/src/ble/devicemodel.js:114-132; packages/core/src/ble/devicemodel.js:250-256
- kind: contract-existence
- status: covered
- note: CONTROL_OPS は CAPS から導出。IOT_OPS 除外 (devicemodel.js:114) を固定。l40=`new Set([...CONTROL_OPS,"status"])`, l114=IOT_OPS=[ir,relay,led], l123-132=deriveControlOps が IOT_OPS を除外し order=[lock,unlock,toggle,click,autolock], l256=export CONTROL_OPS。

### [LOCK-0093] 未知 action は exit 2 + 許可動詞列挙メッセージ
- surface: cli
- backend: local
- command: `sesame <device> <bogus>` / `cmdDeviceOp`
- branch: action ∉ DEVICE_ACTIONS
- assert: DEVICE_ACTIONS に無い action は cli.unknownAction (許可動詞リスト同梱) で die(...,2)
- ref: packages/kit/src/cli/lock-ops.js:268-271; packages/kit/src/i18n/cli.js:240
- kind: error-path
- status: covered
- note: lock-ops.js:268-271 `if(!DEVICE_ACTIONS.has(action)){die(t("cli.unknownAction",{action,actions:[...DEVICE_ACTIONS].join(" / "),device}),2)}`、cli.js:240 "Unknown action ... Allowed: {actions} ..." に許可動詞 {actions} 同梱。

## transport selection

pickTransport の経路選択 (auto/--ble-only/--cloud-only/併用)・status のゲート・運べる経路ゼロの die。

### [LOCK-0094] pickTransport auto: cloud で運べる op は cloud (BLE接続コスト回避)
- surface: cli, core
- backend: cloud
- command: `pickTransport` / `transportsForOp`
- branch: options なし & cloud 可 op (lock/unlock/toggle/click)
- assert: オート (フラグ無し) かつ transportsForOp に cloud を含む op は "cloud" を返す (autolock 以外の制御 op は cloud 既定)
- ref: packages/kit/src/cli/lock-ops.js:107-118; packages/core/src/ble/devicemodel.js:339-345
- kind: option-branch
- status: covered
- note: lock-ops.js:107 allowed=transportsForOp(model,op)、l118 `return allowed.includes("cloud")?"cloud":"ble"` (auto 既定)。devicemodel.js:339-345 transportsForOp が caps.cloud.includes(op) なら "cloud" を含める。lock5 cloud=[lock,unlock,toggle](l83)・bot2 cloud=[click](l84) より lock/unlock/toggle/click は cloud 可。

### [LOCK-0095] pickTransport auto: BLE 必須 op (autolock) は BLE へフォールバック
- surface: cli, core
- backend: ble
- command: `pickTransport` / `transportsForOp`
- branch: options なし & cloud 不可 op (autolock)
- assert: オートかつ cloud に運べない op (autolock = lock5/sesame2 で ble のみ) は "ble" を返す (能力テーブル: lock5.ble に autolock 在り cloud に無し)
- ref: packages/kit/src/cli/lock-ops.js:117-118; packages/core/src/ble/devicemodel.js:83; packages/core/src/ble/devicemodel.js:87; packages/core/src/ble/devicemodel.js:339-345
- kind: option-branch
- status: covered
- note: autolock が cloud 未反映なのは lock.js:182-189/228-235 の実機所見と整合 [[LOCK-0038]] (l182-189=biz3TriggerLocker は lock/unlock/toggle/bot のみ実機中継・autolock=11 は ack のみ, l228-235=autolock 関数のクラウド未反映警告)。devicemodel.js:87 sesame2 caps (ble に autolock 有・cloud に無)。lock-ops.js:117-118 が auto フォールバックで "ble"。

### [LOCK-0096] --ble-only: BLE 不可 op は exit 2、可なら ble 固定
- surface: cli
- backend: ble
- command: `pickTransport`
- branch: --ble-only & allowed に ble 含む | 含まない
- assert: --ble-only は allowed に ble を含めば "ble"、含まなければ cli.opNotOverBle で die(...,2)
- ref: packages/kit/src/cli/lock-ops.js:109-112; packages/kit/src/i18n/cli.js:195
- kind: option-branch
- status: covered
- note: lock-ops.js:109-112 `if(options.bleOnly){if(!allowed.includes("ble")){die(t("cli.opNotOverBle",{op}),2)}return "ble"}`、cli.js:195 "{op} cannot be sent over BLE."。

### [LOCK-0097] --cloud-only: cloud 不可 op (autolock) は exit 2、可なら cloud 固定
- surface: cli
- backend: cloud
- command: `pickTransport`
- branch: --cloud-only & allowed に cloud 含む | 含まない (autolock)
- assert: --cloud-only は allowed に cloud を含めば "cloud"、含まなければ cli.opNotOverCloud で die(...,2) (autolock は cloud 不可)
- ref: packages/kit/src/cli/lock-ops.js:113-116; packages/kit/src/i18n/cli.js:196
- kind: option-branch
- status: covered
- note: lock-ops.js:113-116 `if(options.cloudOnly){if(!allowed.includes("cloud")){die(t("cli.opNotOverCloud",{op}),2)}return "cloud"}`、cli.js:196 "{op} is not applied to the device over the cloud (BLE required)..."。autolock は devicemodel.js:83/87 で cloud に無いため allowed に cloud 無し→die。

### [LOCK-0098] --cloud-only と --ble-only の併用は exit 2 で die
- surface: cli
- backend: local
- command: `pickTransport`
- branch: cloudOnly && bleOnly
- assert: 両フラグ同時指定は cli.cloudBleExclusive で die(...,2) (最優先で弾く)
- ref: packages/kit/src/cli/lock-ops.js:98; packages/kit/src/i18n/cli.js:193
- kind: error-path
- status: covered
- note: lock-ops.js:98 が pickTransport 先頭で `if(options.cloudOnly && options.bleOnly){die(t("cli.cloudBleExclusive"),2)}` と最優先で弾く、cli.js:193 "--cloud-only and --ble-only cannot be specified together."。

### [LOCK-0099] pickTransport status: mech 型は経路ゲート通過、auto/cloud-only は cloud 既定
- surface: cli
- backend: cloud
- command: `sesame <device> status` / `pickTransport`
- branch: op=status & mechKind!=null & (auto | --cloud-only)
- assert: status は mech を持つ型 (lock/bot, mechKind!=null) なら経路ゲートを通過し、auto/--cloud-only で "cloud" を返す (制御 op の capability に載らないが両経路で取得可)
- ref: packages/kit/src/cli/lock-ops.js:103-106; packages/core/src/ble/devicemodel.js:292-311
- kind: option-branch
- status: covered
- note: tests/cli/status-transport.test.js [mech を持つ lock は status の経路ゲートを通過する] が被覆。lock-ops.js:103-106 = status 分岐 (mechKind ゲート→bleOnly ? ble : cloud)、devicemodel.js:292-311 = capabilitiesForModel。

### [LOCK-0100] pickTransport status: --ble-only は ble を返す
- surface: cli
- backend: ble
- command: `sesame <device> status --ble-only` / `pickTransport`
- branch: op=status & mechKind!=null & --ble-only
- assert: status かつ --ble-only は "ble" を返す (ble.status 経路)
- ref: packages/kit/src/cli/lock-ops.js:103-106
- kind: option-branch
- status: covered
- note: lock-ops.js:105 `return options.bleOnly ? "ble" : "cloud";` が --ble-only→ble を支える (103-106 = status 分岐全体)。

### [LOCK-0101] pickTransport status: mech 無し型 (hub/wifi/biometric) は非対応で exit 2
- surface: cli
- backend: local
- command: `sesame <device> status` / `pickTransport`
- branch: op=status & mechKind=null (hub3/wm2/biometric)
- assert: mech を持たない型 (mechKind=null) は status を cli.noTransportForOp で die(...,2) (実行層が扱えてもゲートで弾く)
- ref: packages/kit/src/cli/lock-ops.js:103-104; packages/core/src/ble/devicemodel.js:90-96; packages/kit/src/i18n/cli.js:194
- kind: error-path
- status: covered
- note: tests/cli/status-transport.test.js [mech を持たない hub は status を従来どおり非対応で弾く] が被覆。lock-ops.js:104 = `if (!capabilitiesForModel(model).mechKind) die(noTransportForOp,2)`、devicemodel.js:90-96 = BIOMETRIC/HUB3/WIFI/UNKNOWN すべて mechKind:null、cli.js:194 = noTransportForOp 文言。

### [LOCK-0102] pickTransport: 制御 op で運べる経路ゼロは exit 2
- surface: cli, core
- backend: local
- command: `pickTransport` / `transportsForOp`
- branch: transportsForOp(model,op).length === 0
- assert: 型×op の能力テーブルでどちらの経路にも無い op は cli.noTransportForOp で die(...,2) (操作を捏造しない)
- ref: packages/kit/src/cli/lock-ops.js:107-108; packages/core/src/ble/devicemodel.js:339-345
- kind: error-path
- status: covered
- note: lock-ops.js:107-108 = `const allowed = transportsForOp(...); if (allowed.length===0) die(noTransportForOp,2)`、devicemodel.js:339-345 = transportsForOp 本体 (ble/cloud の caps から導出)。

## capability gate

機種能力ゲート (非対応 op は接続前に die) と capabilitiesForModel/kindForModel の機種別能力・UNKNOWN 既定。

### [LOCK-0103] 機種能力ゲート: 非対応制御 op は接続前に exit 2
- surface: cli, core
- backend: local
- command: `cmdAct` / `capabilitiesForModel`
- branch: CONTROL_OPS に含む op & caps.ops に無い (Bot に lock 等)
- assert: model 既知かつ caps.ops に無い制御 op は接続前に cli.modelNotSupportOp (可能操作リスト同梱) で die(...,2)。例: Bot に lock/unlock、Lock に click
- ref: packages/kit/src/cli/lock-ops.js:298-304; packages/core/src/ble/devicemodel.js:292-311; packages/kit/src/i18n/cli.js:242
- kind: error-path
- status: covered
- note: lock-ops.js:298-304 = `if (CONTROL_OPS.includes(op) && entry.model){ caps=...; if(!caps.ops.includes(op)) die(modelNotSupportOp,2) }` (接続前)、devicemodel.js:292-311 = capabilitiesForModel(.ops)、cli.js:242 = modelNotSupportOp 文言 (label/model/op/ops 同梱)。

### [LOCK-0104] capabilitiesForModel: lock5 の op/経路 (lock/unlock/toggle cloud+ble, autolock ble のみ)
- surface: core
- backend: cloud, ble
- command: `capabilitiesForModel` / `transportsForOp`
- branch: model=sesame_5/6/pro/us/miwa (lock5)
- assert: lock5 の cloud=[lock,unlock,toggle], ble=[lock,unlock,toggle,autolock], mechKind=os3lock, os=3 が SesameSDK の CHSesame5 能力 (lock/unlock/toggle/autolock) と一致
- ref: packages/core/src/ble/devicemodel.js:83; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame5.kt:10-18
- kind: contract-existence
- status: covered
- note: tests/ble/devicemodel.test.js:64 [Sesame5: ble=lock/unlock/toggle/autolock, cloud=lock/unlock/toggle, ops=和集合, 7B mech] が CAPS を被覆。devicemodel.js:83 = LOCK5 CAPS (os:3, cloud:[lock,unlock,toggle], ble:[lock,unlock,toggle,autolock], mechKind:os3lock)。SDK 正典は CHSesame5.kt:13-18 (interface CHSesame5: fun lock/unlock/toggle/autolock のみ)。

### [LOCK-0105] capabilitiesForModel: bot は click のみ (lock/unlock 不可)
- surface: core
- backend: cloud, ble
- command: `capabilitiesForModel`
- branch: model=bot_2/bot_3 (bot2) | ssmbot_1 (botOs2)
- assert: Bot 系の cloud/ble は [click] のみで lock/unlock/toggle/autolock を含まない (CHSesameBot2Device の click のみ能力)。OS3=os3bot / OS2=os2bot
- ref: packages/core/src/ble/devicemodel.js:84; packages/core/src/ble/devicemodel.js:88; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:113-115
- kind: contract-existence
- status: covered
- note: devicemodel.js:84 = BOT2 CAPS (cloud:[click], ble:[click], mechKind:os3bot)、devicemodel.js:88 = BOT_OS2 CAPS (cloud:[click], ble:[click], mechKind:os2bot)。SDK 正典 CHSesameBot2.kt:113-115 (interface CHSesameBot2: CHSesameLock { var scripts; fun click(...) } — lock/unlock/toggle を宣言せず click のみ)。tests/ble/devicemodel.test.js:72 [Bot2 = click のみ] /:99 [OS2 Bot1 = click] も整合。

### [LOCK-0106] capabilitiesForModel: OS2 ロック (sesame_2/4) の世代/op
- surface: core
- backend: cloud, ble-os2
- command: `capabilitiesForModel` / `kindForModel`
- branch: model=sesame_2/sesame_4 (sesame2)
- assert: sesame2 kind は os=2, cloud=[lock,unlock,toggle], ble=[lock,unlock,toggle,autolock], mechKind=os2lock (BLE は SesameOS2Ble 別プロトコル経路)
- ref: packages/core/src/ble/devicemodel.js:87; packages/core/src/ble/devicemodel.js:191; packages/core/src/ble/devicemodel.js:195; packages/kit/src/cli/lock-ops.js:182
- kind: contract-existence
- status: covered
- note: devicemodel.js:87 が SESAME2 caps (os:2/cloud:[lock,unlock,toggle]/ble:[...,autolock]/mechKind:os2lock)、:191/:195 が sesame_2/sesame_4→KIND.SESAME2 マッピング。ble-os2 経路の制御は lock-ops.js:182 の caps.os===2 分岐で SesameOS2Ble facade (export: packages/core/src/ble/index.js:109) へ委譲。

### [LOCK-0107] kindForModel: 未知 model は UNKNOWN (操作を捏造しない)
- surface: core
- backend: local
- command: `kindForModel` / `capabilitiesForModel`
- branch: model がテーブル外 | model 未指定(null)
- assert: テーブルに無い model は KIND.UNKNOWN (ops 空) を返し lock5 に化けさせない。null/空は後方互換で lock5 既定
- ref: packages/core/src/ble/devicemodel.js:267-270; packages/core/src/ble/devicemodel.js:96
- kind: contract-existence
- status: covered
- note: Hub3 が解錠を出していた類のバグの構造的防止。kindForModel (devicemodel.js:267-270): !model→KIND.LOCK5 (268)、テーブル外→KIND.UNKNOWN (269)。devicemodel.js:96 が UNKNOWN caps エントリ (cloud:[]/ble:[]=ops空)。

## autolock validation

CLI autolock の seconds 引数欠落・範囲検証を接続前に exit 2 で弾く。

### [LOCK-0108] autolock: seconds 引数欠落は exit 2 (cmdDeviceOp)
- surface: cli
- backend: local
- command: `sesame <device> autolock [seconds]` / `cmdDeviceOp`
- branch: action=autolock & args[0] 無し
- assert: autolock で秒数引数が無いとき cli.autolockNeedsSeconds で die(...,2) (接続前)
- ref: packages/kit/src/cli/lock-ops.js:273-274; packages/kit/src/i18n/cli.js:241
- kind: error-path
- status: covered
- note: cmdDeviceOp の seconds==null 分岐 273 で die(t('cli.autolockNeedsSeconds'),2)。i18n/cli.js:241 が cli.autolockNeedsSeconds 定義。

### [LOCK-0109] autolock: seconds 範囲 0..65535 整数検証は接続前に exit 2
- surface: cli
- backend: local
- command: `sesame <device> autolock <seconds>` / `cmdAct`
- branch: seconds 非整数 | <0 | >65535
- assert: autolock の seconds が 0..65535 の整数でないとき cli.secondsRange で die(...,2) (BLE 接続前に弾く)。範囲は SDK の 2B LE 秒数と一致
- ref: packages/kit/src/cli/lock-ops.js:307-310; packages/core/src/lock.js:242-245; _sesame_sdk_ref/doc/class/SesameItemCode_jp.md:93
- kind: error-path
- status: covered
- note: lock-ops.js:309 が Number.isInteger/0..65535 検証→die(t('cli.secondsRange'),2)、CONTROL_OPS ゲート (298-304) の直後・接続(312)前。lock.js:242-245 が setAutolock の同範囲検証 (0..0xffff)、2B LE payload は lock.js:247 (seconds&0xff,seconds>>8)。SesameItemCode_jp.md:93=autolock(11u)。

## execution / output

cloud/ble op の実行振り分け・未ログイン die・--json 封筒・status の secretKey 落とし・整形一致。

### [LOCK-0110] cloud op 実行: lock/unlock/toggle → hub[op], click → botClick
- surface: cli, core
- backend: cloud
- command: `runCloudOp` / `hub.lock|unlock|toggle|botClick`
- branch: op=lock|unlock|toggle | op=click
- assert: cloud 経路は op=click を hub.botClick(cmd=89) に、lock/unlock/toggle を hub[op] に振る。cmd code は LOCK=82/UNLOCK=83/TOGGLE=88/CLICK=89 と一致 (op='bot' は DEVICE_ACTIONS に無く到達しないデッドブランチで境界対象外)
- ref: packages/kit/src/cli/lock-ops.js:229-236; packages/kit/src/cli/lock-ops.js:268-271; packages/core/src/lock.js:144-151; packages/core/src/ble/devicemodel.js:124; _sesame_sdk_ref/doc/class/SesameItemCode_jp.md:105-112
- kind: wire-fidelity
- status: covered
- note: cmd code 出典 SesameProtocols.kt:36 (lock82/unlock83/toggle88/click89), 11=autolock は同 kt:34。lock-ops.js:231 の振り分けは (op==='bot'||op==='click')→hub.botClick : hubAny[op] だが、'bot' は DEVICE_ACTIONS(=CONTROL_OPS∪status, devicemodel.js:124 順序に 'bot' 無し)に含まれず cmdDeviceOp:268-271 が unknownAction で die するため到達不能=デッドコード。本 spec は到達する 'click' のみを境界とする(【撤去済】コード側 op==='bot' デッドブランチは削除し、現在は (op==='click')→botClick : hubAny[op])。lock.js:144-151 が lockLock(82)/lockUnlock(83)/lockToggle(88)/botClick(89)。SesameItemCode_jp.md:105/106/111/112=lock82/unlock83/toggle88/click89。

### [LOCK-0111] cloud transport は未ログインで exit 2 (login 案内)
- surface: cli
- backend: cloud
- command: `cmdAct` / `hasCloudSession`
- branch: transport=cloud & token 無し
- assert: cloud 経路で token (refreshToken/idToken) が無いとき cli.cloudNotLoggedIn で die(...,2)。token 判定は hasCloudSession
- ref: packages/kit/src/cli/lock-ops.js:324-327; packages/kit/src/cli/ctx.js:169-173; packages/kit/src/i18n/cli.js:245
- kind: error-path
- status: covered
- note: lock-ops.js:324-325 が transport==='cloud' 分岐で !hasCloudSession(program)→die(t('cli.cloudNotLoggedIn'),2)。ctx.js:169-173 hasCloudSession は tokenStore.load() の refreshToken||idToken を真偽化。i18n/cli.js:245 が cli.cloudNotLoggedIn 定義。

### [LOCK-0112] --json 出力封筒: cloud op の {ok,op,name,via:cloud,response}
- surface: cli
- backend: cloud
- command: `runCloudOp`
- branch: --json (cloud 制御 op)
- assert: --json 時 stdout に {ok:true, op, name, via:"cloud", response} の純 JSON を 1 件、人間ログ ([cloud] ...) は stderr へ分離
- ref: packages/kit/src/cli/lock-ops.js:232-236; packages/kit/src/cli/lock-ops.js:328; packages/kit/src/cli/ctx.js:92-95
- kind: surface-parity
- status: covered
- note: 他言語 subprocess 契約 (packages/kit/tests/cli/json-contract.test.js の封筒規約: --json 成功は stdout 純 JSON 1件・人間ログは stderr と整合)。out(...) 呼び出しは 232 開始、JSON封筒 {ok:true,op,name,via:'cloud',response:resp} は 235。lock-ops.js:328 が [cloud] 人間ログを console.error (stderr) へ (json 時は出さない: !gopts.json ガード)。ctx.js:92-95 の out() が json→stdout/JSON.stringify, else→humanFn の分離本体。

### [LOCK-0113] --json 出力封筒: ble op の {ok,op,name,via:ble,result,status}
- surface: cli
- backend: ble
- command: `runBleOp` / `runBleOnLock`
- branch: --json (ble op autolock 等)
- assert: --json 時 stdout に {ok:true, op, name, via:"ble", result, status} の純 JSON、[ble] ... ログは stderr へ
- ref: packages/kit/src/cli/lock-ops.js:161-165; packages/kit/src/cli/lock-ops.js:314; packages/kit/src/cli/ctx.js:92-95
- kind: surface-parity
- status: covered
- note: lock-ops.js:165 が out() に {ok:true,op,name,via:"ble",result,status} を渡す。out (ctx.js:92-95) は json 時 console.log(JSON.stringify) で stdout へ純 JSON。[ble] ログは lock-ops.js:314 で console.error (stderr)、ただし !gopts.json ガードのため --json 時は抑止。

### [LOCK-0114] status 出力から secretKey を落とす (sanitizeStatus)
- surface: cli
- backend: cloud
- command: `runCloudOp` / `sanitizeStatus`
- branch: op=status (cloud)
- assert: cloud status の JSON/人間出力ともに secretKey を含めない (device-status は devices と同形で鍵を含むため落とす)
- ref: packages/kit/src/cli/lock-ops.js:141-145; packages/kit/src/cli/lock-ops.js:223-227
- kind: payload-fidelity
- status: covered
- note: tests/cli/status-output.test.js sanitizeStatus 群 が被覆。lock-ops.js:141-145 が sanitizeStatus、223-227 が runCloudOp の status 分岐で sanitizeStatus を適用。

### [LOCK-0115] fmtCloudStatus と fmtMech の整形一致 (state/pos/battery)
- surface: cli
- backend: cloud, ble
- command: `fmtCloudStatus` / `fmtMech`
- branch: cloud stateInfo | ble mechStatus
- assert: cloud (fmtCloudStatus) と BLE (fmtMech) の status を同じ 1 行形 (state=.. pos=.. battery=..) に整形し position 無しは省略
- ref: packages/kit/src/cli/lock-ops.js:128-134; packages/kit/src/cli/exec.js:21-27
- kind: surface-parity
- status: covered
- note: tests/cli/status-output.test.js fmtCloudStatus 群 が被覆 (fmtMech 側は別途)。lock-ops.js:128-134=fmtCloudStatus (state/pos/battery、pos null は省略)、exec.js:21-27=fmtMech (state/pos、pos null は省略)。両者の 1 行整形契約は一致。

## OS2 BLE routing

CLI runBleOp が OS2 を SesameOS2Ble facade へ委譲・OS2 BLE login の ssmPublicKey 必須。

### [LOCK-0116] runBleOp: OS2 (os===2) は SesameOS2Ble facade へ委譲
- surface: cli, core
- backend: ble-os2
- command: `runBleOp` / `capabilitiesForModel`
- branch: caps.os===2 (sesame_2/4, ssmbot_1, bike_1)
- assert: OS2 デバイスの BLE op は SesameOS2Ble.use へ委譲し OS3 (SesameBle) と別ファサードを使う (ハンドシェイク・暗号が別物のため間違えると接続不可)
- ref: packages/kit/src/cli/lock-ops.js:181-213; packages/core/src/ble/devicemodel.js:87-89; packages/core/src/ble/devicemodel.js:292-300
- kind: option-branch
- status: covered
- note: tests/cli/ble-os2-routing.test.js が被覆。lock-ops.js:182 if(caps.os===2)→196 SesameOS2Ble.use、209 SesameBle.use(OS3)。os:2 の真実源は devicemodel.js:87-89 (SESAME2/BOT_OS2/BIKE_OS2)、capabilitiesForModel(292-300) が os を spread。

### [LOCK-0117] runBleOp: OS2 BLE login は ssmPublicKey 必須、未保存は exit 2
- surface: cli
- backend: ble-os2
- command: `runBleOp` / `resolveLockEntry`
- branch: caps.os===2 & entry.ssmPublicKey 無し
- assert: OS2 BLE 経路で config に ssmPublicKey (ECDH 相手鍵) が無いとき cli.os2BleNeedSsmPublicKey で die(...,2)。保存済みなら resolveLockEntry が透過
- ref: packages/kit/src/cli/lock-ops.js:187-205; packages/kit/src/cli/lock-ops.js:77-82; packages/kit/src/i18n/cli.js:246
- kind: error-path
- status: covered
- note: lock-ops.js:187-188 !entry.ssmPublicKey→die(t("cli.os2BleNeedSsmPublicKey"),2)、77-82 resolveLockEntry が lock.ssmPublicKey/keyIndex を透過、i18n cli.js:246 にキー存在を確認。tests/cli/ble-os2-routing.test.js 60-97 で未保存→非0+OS2専用エラーを実証 (指示に従い status=planned 維持)。

## surface parity (serve)

serve (JSON-RPC) の lock.* が cli/core と同結果・requireAuth・openrpc 整合。

### [LOCK-0118] lock.lock/unlock/toggle が serve (JSON-RPC) で同結果
- surface: serve, cli, core
- backend: cloud
- command: `lock.lock` / `lock.unlock` / `lock.toggle`
- branch: name 解決 | {deviceUUID,secretKey} 直指定
- assert: serve の lock.lock|unlock|toggle が hub[verb](name) または hub[verb]Device({deviceUUID,secretKey}) を呼び、cli の同 op と同じ cloud 命令 (cmd 82/83/88) になる (surface-parity)
- ref: packages/kit/src/serve/entries/lock.js:18-44; packages/core/src/client.js:646-666; schema/openrpc.json:8828
- kind: surface-parity
- status: covered
- note: openrpc lock.lock=8828 / lock.unlock=8890 / lock.toggle=8952。serve lock.js:18-28 lockOp が hub[verb](name) | hub[`${verb}Device`]({deviceUUID,secretKey})、42-44 で 3 entry を生成。client.js:646(lock)/655(unlock)/664(toggle)。cmd 82/83/88 は itemcodes.js:40 TOGGLE=88 と lock.js:144-149 で確認。

### [LOCK-0119] lock.click: scriptIndex 有無で botClickScript / botClick 分岐
- surface: serve, core
- backend: cloud
- command: `lock.click`
- branch: scriptIndex 指定 (0..9) | 省略
- assert: serve lock.click は scriptIndex 指定で botClickScript(cmd=170+index)、省略で botClick(cmd=89) に振る (CHSesameBot2Device.kt click(index) と 1:1)
- ref: packages/kit/src/serve/entries/lock.js:47-66; packages/core/src/lock.js:168-173; schema/openrpc.json:9014
- kind: surface-parity
- status: covered
- note: serve lock.js:47-66 lock.click が hasScript で botClickScript(Device) | botClick(Device) に分岐。core lock.js:168-173 botClickScript = cmd CMD.BOT2_ITEM_CODE_RUN_SCRIPT_0(170)+scriptIndex、botClick(151)=cmd CLICK(89)。CHSesameBot2Device.kt:73-89 click(index) が itemCode=RUN_SCRIPT_0.value+index へ切替を実装 (1:1)。schema 9014 は lock.click 直前。

### [LOCK-0120] lock.setAutolock: transport=cloud(既定) | ble の経路分岐
- surface: serve, core
- backend: cloud, ble
- command: `lock.setAutolock`
- branch: transport 省略/cloud | transport=ble | 不正 transport
- assert: serve lock.setAutolock は既定 cloud (cmd=11、戻り {ack,cmd,seconds})、transport=ble は SesameBle.autolock(seconds) の {resultCode} を bleCommandAck で {resultCode,resultName} に正規化し {resultCode,resultName,seconds,transport:'ble'} を返す (cloud と戻り封筒形が異なる)、不正 transport は INVALID_PARAMS、seconds は必須
- ref: packages/kit/src/serve/entries/lock.js:74-109; packages/core/src/lock.js:242-250; packages/core/src/ble/session.js:539-549; packages/core/src/ble/rpc-helpers.js:170-172; schema/openrpc.json:9084
- kind: surface-parity
- status: covered
- note: CLI の auto は autolock を BLE へ回すが serve 既定は cloud (意図的逸脱: serve/entries/lock.js:67-73)。差分そのものを固定。cloud 経路 setAutolock(cmd=CMD.AUTOLOCK=itemcodes.js:22 の 11, ack のみ) は lock.js:242-250、BLE 直送実体 ble/session.js:539-549 (autolock(seconds)→request(ITEM.AUTOLOCK))。serve 側の transport 分岐(ble→ble.autolock / cloud→hub.setAutolock / 不正→INVALID_PARAMS, seconds need)は serve/entries/lock.js:88-108。

### [LOCK-0121] lock.* は requireAuth (cloud) 必須、ble 経路のみ非認証
- surface: serve
- backend: cloud, ble
- command: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.click` / `lock.status`
- branch: cloud op (requireAuth) | setAutolock transport=ble (非認証)
- assert: serve の cloud 系 lock op は requireAuth(daemon) を通過必須、setAutolock の transport=ble だけ requireAuth しない (BLE はクラウド接続不要)
- ref: packages/kit/src/serve/entries/lock.js:19-27; packages/kit/src/serve/entries/lock.js:54-55; packages/kit/src/serve/entries/lock.js:88-102; packages/kit/src/serve/entries/lock.js:113; packages/kit/src/serve/registry-helpers.js:55-62
- kind: error-path
- status: covered
- note: requireAuth 呼び出しは lockOp(lock/unlock/toggle)=L20、click=L55、setAutolock cloud=L102、status=L113。BLE 分岐(L91-98)は requireAuth しない(L92 コメント明示)。requireAuth 定義実体(authState=expired→NOT_AUTHENTICATED / hub 未接続→CONNECTION_LOST)を registry-helpers.js:55-62 で補強。

### [LOCK-0122] lock.status: deviceUUID 必須で getDeviceStatus を呼ぶ
- surface: serve, core
- backend: cloud
- command: `lock.status`
- branch: deviceUUID 必須
- assert: serve lock.status は deviceUUID 必須 (need) で hub.getDeviceStatus(deviceUUID) を呼び、cli status の cloud 経路と同データ源
- ref: packages/kit/src/serve/entries/lock.js:110-113; packages/core/src/client.js:953-955; schema/openrpc.json:9183
- kind: surface-parity
- status: covered
- note: serve lock.status entry は deviceUUID required:true(L112)+need([deviceUUID])+hub.getDeviceStatus(L113)。core client.getDeviceStatus(deviceUUID)→devices.getDeviceStatus(L953-955)。openrpc.json:9183 は lock.status 定義先頭(deviceUUID required)。

## surface parity (sdk)

生成 SDK (ts/py) に lock.* メソッドが openrpc と 1:1 で存在する。

### [LOCK-0123] 生成 SDK (ts/py) に lock.* メソッドが openrpc と 1:1 で存在
- surface: sdk
- backend: cloud
- command: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.click` / `lock.setAutolock` / `lock.status`
- branch: -
- assert: eject される ts/py SDK に lock.lock|unlock|toggle|click|setAutolock|status が openrpc 定義と同じシグネチャで存在する (contract-existence)
- ref: schema/openrpc.json:8828; packages/kit/src/serve/entries/lock.js:40-115; packages/kit/sdk/ts/sesame-client.ts:502-508; packages/kit/sdk/python/sesame_client.py:981-998
- kind: contract-existence
- status: covered
- note: tests/sdk-ts-contract.test.js / tests/sdk-py-contract.test.js / tests/openrpc-contract.test.js が openrpc↔SDK の網羅を被覆 (実体は packages/kit/tests/ 配下)。TS SDK(sesame-client.ts:502-508 に click/lock/setAutolock/status/toggle/unlock)、Python SDK(sesame_client.py:981-998 の _Lock クラス、setAutolock は L987)。setAutolock は x-stability=experimental(openrpc:9084 配下)だが SDK 生成は全メソッド対象。

## i18n

lock 経路エラー文言の en/ja カタログ完全性。

### [LOCK-0124] lock 経路エラー文言の en/ja カタログ完全性
- surface: cli
- backend: local
- command: `pickTransport` / `cmdAct エラー群`
- branch: en | ja
- assert: cli.cloudBleExclusive/noTransportForOp/opNotOverBle/opNotOverCloud/unknownAction/autolockNeedsSeconds/modelNotSupportOp/secondsRange/cloudNotLoggedIn/os2BleNeedSsmPublicKey が en/ja 両方に欠けなく存在
- ref: packages/kit/src/i18n/cli.js:193-246; packages/kit/src/i18n/cli.js:614-667
- kind: i18n
- status: covered
- note: tests/i18n-catalog.test.js (実体: packages/kit/tests/i18n-catalog.test.js) が en/ja キー集合一致(test1)とプレースホルダ一致(test3)でロケール完全性を被覆。en 側 10 キーは L193/L194/L195/L196/L240/L241/L242/L244/L245/L246。ja 側は L614/L615/L616/L617/L661/L662/L663/L665/L666/L667。

## 監査追補 (audit gap-fill)

reference-audit で発見した valid-new gap を、既存 spec を変更せず連番 (LOCK-0125..) で追補する。各エントリ冒頭 note の subarea で帰属を示す。

### [LOCK-0125] webapiSendCmd / webapi_cmd_send — 第3のクラウド lock-trigger 経路
- surface: core
- backend: cloud
- command: `client.webapiSendCmd / devices.webapiSendCmd`
- branch: -
- assert: webapi_cmd_send フレーム形。webapi ドメインと重複につき [[WEB-0010]] を正典とする
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[WEB-0010]]）
- note: 正典: spec/webapi.md WEB-0010。webapi(biz3InvokeWebAPIs/webapi_*) は WEB ドメインが所有

### [LOCK-0126] serve webapi.sendCmd の surface-parity / requireAuth / 必須引数
- surface: serve, core
- backend: cloud
- command: `webapi.sendCmd / hub.webapiSendCmd`
- branch: deviceId/cmd/sign/history 必須 | apiKeyId 省略→config 既定
- assert: serve webapi.sendCmd の requireAuth/必須引数。webapi ドメインと重複につき [[WEB-0026]] を正典とする
- ref: local-contract
- kind: surface-parity
- status: waived: 重複（正典 [[WEB-0026]]）
- note: 正典: spec/webapi.md WEB-0026。webapi(biz3InvokeWebAPIs/webapi_*) は WEB ドメインが所有

### [LOCK-0127] webapiSendCmd は apiKeyId 必須・invokeWebAPI assertSuccess は非strict
- surface: core
- backend: cloud
- command: `client.webapiSendCmd / devices.invokeWebAPI`
- branch: missing-apiKeyId | success-absent(許容) | success:false→reject
- assert: apiKeyId 必須 + 非strict assertSuccess。webapi ドメインと重複につき [[WEB-0016]] を正典とする
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[WEB-0016]]）
- note: 正典: spec/webapi.md WEB-0016。webapi(biz3InvokeWebAPIs/webapi_*) は WEB ドメインが所有

### [LOCK-0128] biz3TriggerLocker op=pubUserDeviceChange は triggerLock を解決しない (負の事実)
- surface: core
- backend: cloud
- command: `lock.triggerLock / transport._onMessage`
- branch: state-push | op=pubUserDeviceChange
- assert: action=biz3TriggerLocker で op=pubUserDeviceChange の push は dispatch キー 'biz3TriggerLocker:pubUserDeviceChange' になり、lock の aux 購読 (biz3TriggerLocker:pubDeviceStateChange) にも ack pending ('biz3TriggerLocker:') にもヒットせず triggerLock を resolve しない (vendor は pubUserDeviceChange を getCompanyDevices=デバイス一覧再取得として消費し lock 完了シグナルではない)
- ref: packages/core/src/lock.js:36; packages/core/src/lock.js:81-85; packages/core/src/transport.js:527; references_web/src/api/useIotCtrl.js:23-25; references_web/src/api/useIotCtrl.js:12
- kind: idempotency
- status: covered
- note: subarea=state push aux。refs 全実在・支持確認。lock.js:36 STATE_EVENT_KEY=`${TRIGGER_ACTION}:pubDeviceStateChange` (pubDeviceStateChange のみ購読)、:81-85 subscribe+一致判定。transport.js:527 key=`${msg.action}:${msg.op||''}` のため pubUserDeviceChange は別キー。useIotCtrl.js:12 PubedUserDeviceChange 定数、:23-25 op===PubedUserDeviceChange→gManageDevice.getCompanyDevices()。lock.md state push 群 LOCK-0017..0020 は pubDeviceStateChange の一致/不一致(別 deviceUUID)/二重解決のみで、別 op が誤解決しない負の事実は無い (LOCK-0019 は同 op・別 deviceUUID、本件は別 op)。広すぎる action 単位 fan-out への回帰防止。

### [LOCK-0129] webapi_cmd_send / webapi_ssm_shadow_get の device_id は無加工 (iot.js と対照)
- surface: core
- backend: cloud
- command: `devices.webapiSendCmd / devices.webapiDeviceState`
- branch: device_id-raw-passthrough
- assert: webapi 系 device_id の無加工素通し。webapi ドメインと重複につき [[WEB-0011]] を正典とする
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[WEB-0011]]）
- note: 正典: spec/webapi.md WEB-0011。webapi(biz3InvokeWebAPIs/webapi_*) は WEB ドメインが所有

### [LOCK-0130] OS3/OS2 BLE lock/unlock/click/toggle/autolock の resultCode!=0 → BleResultError reject
- surface: core
- backend: ble, ble-os2
- command: `session.request(itemCode) / SesameBle.lock|unlock|click|toggle|autolock / SesameOS2Ble.lock|unlock|click|autolock`
- branch: resultCode=0→resolve | resultCode!=0→reject(BleResultError)
- assert: BLE response の resultCode!=0 のとき request promise を BleResultError('command', resultCode, itemCode) で reject する (resultCode==0 のみ {resultCode,payload} で resolve)。SDK は lock/unlock の sendCommand コールバックで cmdResultCode==success.value 以外を Result.failure(NSError(resultCode)) にするのと等価。施錠失敗(モータ詰まり/鍵不一致 invalidSig 等)はこの経路で表面化する
- ref: packages/core/src/ble/session.js:1001-1010; packages/core/src/ble/os2/session.js:796-806; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:160-165; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:181-186; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:186-190; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:28-30
- kind: error-path
- status: covered
- note: subarea=OS3 lock send path。refs 検証済 (5Dev unlock callback の if は :160/else Result.failure :163 のため unlock ref を 159-165→160-165 に補正、lock は :181-186)。session.js:1008-1009 `if(resultCode===0)resolve;else reject(new BleResultError('command',resultCode,itemCode))`、os2/session.js:804-805 同。spec の BLE error-path は LOCK-0084 notLoggedIn と LOCK-0058/0074 autolockData 範囲(送信前)のみ。LOCK-0059 note が session.js:1008 reject を副次言及するだけで assert していないため、resultCode!=0 reject 境界は未被覆。

### [LOCK-0131] serve: BLE lock 失敗の BleResultError.resultName → JSON-RPC kind/code 写像
- surface: serve
- backend: ble, ble-os2
- command: `lock.setAutolock(transport=ble) / ble.* / errorFromThrow`
- branch: invalidFormat/invalidParam→bad_params | invalidSig→not_authenticated | busy→rejected(retryable) | notFound/notSupported/resultStorageFail/unknown→rejected | 未登録名(unknown(N))→rejected(fallback)
- assert: BleResultError.resultName を BLE_RESULT_TO_RPC で JSON-RPC {kind,code,retryable} に写像する: invalidFormat/invalidParam=bad_params(INVALID_PARAMS), invalidSig=not_authenticated(APP_ERROR), busy=rejected(APP_ERROR,retryable=true), notFound/notSupported/resultStorageFail/unknown=rejected(APP_ERROR,retryable=false)。テーブル未登録の resultName (例 unknown(9)) は errorFromThrow の fallback で rejected。timeout は BleResultError でなく ble.requestTimeout 通常 Error で届くため本表に現れない
- ref: packages/core/src/jsonrpc.js:179-203; packages/core/src/ble/protocol.js:58-61; packages/core/src/ble/protocol.js:85-87; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:28-30
- kind: error-path
- status: covered
- note: subarea=surface parity (serve)。refs 検証済。jsonrpc.js:194-202 BLE_RESULT_TO_RPC が候補のテーブルと完全一致 (invalidFormat/invalidParam=bad_params INVALID_PARAMS, invalidSig=not_authenticated, busy=rejected retryable:true, notFound/notSupported/resultStorageFail/unknown=rejected)。errorFromThrow は jsonrpc.js:260 (fallback 処理 :270)。protocol.js:58-61=RESULT, :85-87=resultName(未知→unknown(N))。grep 'BleResultError|resultName|BLE_RESULT_TO_RPC|errorFromThrow' spec/lock.md = 0 件で完全未被覆。LOCK-0121 は serve requireAuth(送信前 auth gate)のみで device-returned 拒否の RPC 封筒を固定せず。

### [LOCK-0132] OS3 response フレーム分解 ([op][item][resultCode][payload]) — OS2 [LOCK-0083] の OS3 対応版
- surface: core
- backend: ble
- command: `parseRecvFrame(buf) / session._handleDecrypted`
- branch: opCode=RESPONSE(7): itemCode-keyed pending を resultCode=body[0] で解決 | opCode=PUBLISH(8): body=payload
- assert: OS3 復号後フレーム = [op_code][item_code][body...]。parseRecvFrame が op=buf[0]/item=buf[1]/body=buf.subarray(2) に分解し、RESPONSE(7) では resultCode=body[0]・payload=body.subarray(1) を itemCode-keyed pending に渡す。SDK SSM3ResponsePayload (data[0]=cmdItCode, data[1]=cmdResultCode, payload=data.drop(2)) と一致 (notifyOpCode を剥いだ後の構造)。OS2 の 3B header (itemCode,opCode,resultCode) とは header 長が異なる
- ref: packages/core/src/ble/protocol.js:340-343; packages/core/src/ble/session.js:795-800; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:22-26
- kind: wire-fidelity
- status: covered
- note: subarea=OS3/OS2 response routing。refs 検証済。protocol.js:342 return {opCode:buf[0], itemCode:buf[1], body:buf.subarray(2)}。session.js:795 if(opCode===OP.RESPONSE), :796 resultCode=body.length>0?body[0]:0, :797 payload=body.subarray(1), :800 _resolvePending(itemCode,resultCode,payload)。SSM3ResponsePayload (Protocols.kt:23 cmdItCode=data[0], :24 cmdResultCode=data[1], :25 payload=data.drop(2))。LOCK-0083 は OS2 SSM2ResponsePayload(3B header itemCode/opCode/resultCode) 専用で OS3 response 分解(parseRecvFrame+session RESPONSE)は未索引。OS3/OS2 header 非対称は新規。

### [LOCK-0133] OS3 BLE bot2 script index 範囲検証 (index>9 / 非UByte は送信前 throw)
- surface: core
- backend: ble
- command: `bot2.clickItemCode(index) / SesameBle script.click(index)`
- branch: index<0 | index>9(MAX_SCRIPT_INDEX) | 非整数/非UByte
- assert: clickItemCode(index) は index が 0..9 の UByte でない (負/9超/非整数/255超) とき送信前に throw(ble.bot2ScriptIndexRange{max:9})。RUN_SCRIPT_0..RUN_SCRIPT_9 の 10 本枠と一致 (cloud 側 [LOCK-0030] botClickScript 範囲検証の BLE 対応)
- ref: packages/core/src/ble/bot2.js:63-69; packages/core/src/ble/bot2.js:55; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:75-80
- kind: error-path
- status: covered
- note: subarea=OS3 lock/unlock wire。refs 検証済。bot2.js:65-66 `if(!isUByte(index)||index>MAX_SCRIPT_INDEX) throw new Error(t('ble.bot2ScriptIndexRange',{max:MAX_SCRIPT_INDEX}))`、:55 isUByte=Number.isInteger&&0..255、MAX_SCRIPT_INDEX=9(bot2.js:32, 候補 note の :31 は軽微なズレだが refs 配列は正確)。i18n キー ble.bot2ScriptIndexRange は ble.js:88(en)/261(ja) に {max} 補間付きで実在。LOCK-0030 は cloud 経路(lock.js botClickScript / domain.lock.scriptIndexRange / backend=cloud)専用で、BLE 経路(bot2.js clickItemCode / ble.bot2ScriptIndexRange / UByte 検証追加)は別関数・別 i18n キー・別 backend で未索引。

### [LOCK-0134] OS3/OS2 BLE request の ack タイムアウト (ble.requestTimeout) で reject し pending を dequeue
- surface: core
- backend: ble, ble-os2
- command: `session.request(itemCode) (OS3/OS2)`
- branch: timeoutMs 指定 | 既定 _defaultTimeoutMs
- assert: BLE request は timeoutMs (省略時 _defaultTimeoutMs) 経過で当該 itemCode の pending entry を _dequeue し Error(ble.requestTimeout{item}) で reject する (ack/response が来ない時の境界)。これは BleResultError ではなく通常 Error のため serve の BLE_RESULT_TO_RPC には現れず TIMEOUT kind へ写像される
- ref: packages/core/src/ble/session.js:489-505; packages/core/src/ble/session.js:708; packages/core/src/i18n/ble.js:46; packages/core/src/jsonrpc.js:183-184
- kind: error-path
- status: covered
- note: subarea=OS3 BLE request lifecycle。session.js:493-496 setTimeout(()=>{this._dequeue(itemCode,entry);reject(new Error(t('ble.requestTimeout',{item:itemCode})))},to) を確認、_dequeue 定義は :708。i18n/ble.js:46 'BLE request timeout (item={item})' は en/ja(:219)ともに実在。lock.md の timeout は cloud [LOCK-0022/0023/0024] (全て backend:cloud) と mechStatus 待ち [LOCK-0056] のみで BLE request ack timeout は未被覆 (spec 全体でも requestTimeout/_defaultTimeoutMs の索引ゼロ)。jsonrpc.js:183-184 が timeout は BleResultError でなく通常 Error で届くと明記。ref 出典は純ローカル契約のため local-contract 扱い。

### [LOCK-0135] OS3 BLE 同一 itemCode 並行 request の意味論 (P3-27): in-flight 抑止せず毎回ワイヤ送信
- surface: core
- backend: ble
- command: `session.request(itemCode)`
- branch: 同一 itemCode in-flight 中の 2 回目 request
- assert: OS3 session.request は同一 itemCode が in-flight でも _pending[itemCode] FIFO キューに積みつつ毎回 _sendCipher() でワイヤ送信する。SDK CHSesameOS3.kt:349-372 の sendCommand が in-flight 中はワイヤ再送を抑止するのと意図的に乖離 (P3-27)。応答は itemCode-keyed FIFO で送信順に shift() 解決される (cloud [LOCK-0013] の FIFO と類似だが BLE は両方ワイヤに出る点が差)
- ref: packages/core/src/ble/session.js:462-505; packages/core/src/ble/session.js:1001-1010; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:349-372
- kind: idempotency
- status: covered
- note: subarea=OS3 BLE request lifecycle。session.js:462-482 JSDoc が P3-27 意図的乖離を明記、:498-503 が _pending[itemCode] push + 無条件 _sendCipher()。_resolvePending:1002-1006 が itemCode queue を shift() で FIFO 解決 (関数定義 :1001)。SDK CHSesameOS3.kt:354-371 を実物確認: tmp=cmdCallBack[itemCode] が非 null なら callback 差替えのみで return (ワイヤ送信前に短絡) + 2000ms 超過で破棄して新規扱い。cloud FIFO は [LOCK-0013] にあるが BLE pending の対応 spec は無い (spec 全体で P3-27/in-flight/_pending の索引ゼロ)。candidate の SDK パスは base/ サブディレクトリを補正済み。

### [LOCK-0136] session モード (cmdSession) の起動ゲート: --json は exit2 / 非TTY は exit2
- surface: cli
- backend: local
- command: `sesame session [names...] / cmdSession`
- branch: --json→exit2 | 非TTY→exit2 | TTY&非json→起動
- assert: cmdSession は json モードで cli.sessionJsonOnly (exit2)、非対話で cli.sessionTtyOnly (exit2) を出し、対話TTYでのみ起動する
- ref: packages/kit/src/cli/session.js:206-208; packages/kit/src/i18n/cli.js:228-229
- kind: error-path
- status: covered
- note: subarea=session lifecycle。session.js:206-208 gopts.json→die(cli.sessionJsonOnly,2) / !isInteractive()→die(cli.sessionTtyOnly,2) を確認。i18n/cli.js sessionJsonOnly(:228)/sessionTtyOnly(:229) は en 実在、ja は :649/:650。dispatch 側 [LOCK-0089] (dispatch.js:75-79 の routeDeviceArgv で session 振り分け) とは別レイヤで、cmdSession 自体のゲート分岐は 124 エントリのいずれにも無い (spec に cli/session.js 参照ゼロ・command に cmdSession ゼロ)。

### [LOCK-0137] session の複数デバイス対象解決 (完全一致絞り込み・重複除去・候補列挙)
- surface: cli
- backend: local
- command: `sesame session [names...] / cmdSession`
- branch: names空→全デバイス | name完全一致→絞り込み | 不一致→exit2 | 重複name→1件に畳む
- assert: session は names 指定で完全一致絞り込み (不一致は cli.deviceNotFoundCandidates exit2)、重複指定は 1 件に畳み、names 空なら操作可能な全デバイス (lock+hub3) を対象にする
- ref: packages/kit/src/cli/session.js:214-231; packages/kit/src/i18n/cli.js:231
- kind: option-branch
- status: covered
- note: subarea=session lifecycle。session.js:222-228 names 指定時 allDevs.find(name 完全一致)、未一致は cli.deviceNotFoundCandidates で die(2)(:226)、targets push 時 !targets.some で同名重複除去(:227)、:229-230 names 空→全デバイス。allLockEntries(:38-45)+allHub3Entries(loggedIn 時のみ :215) を結合(:214-216)、対象0は cli.noOperableDevices die(2)(:217)。deviceNotFoundCandidates(i18n/cli.js:231 en / :652 ja) 実在。単発の resolveLockEntry [LOCK-0091] は完全一致を扱うが単一デバイス用で、session のマルチデバイス対象集合構築は未被覆。

### [LOCK-0138] session の経路別 action 提示 (sessionActionsFor: BLE能力/cloud能力の和集合)
- surface: cli
- backend: ble, cloud
- command: `sessionActionsFor`
- branch: ble接続中(caps.ble) | ログイン中(caps.cloud) | lock5は状態順 | relay→on/off展開 | status はmechKind&&ble時のみ
- assert: session メニューの提示 op は『今使える経路で運べる op』の和集合 (BLE接続中なら caps.ble、ログイン時なら caps.cloud) で、lock5 は直近 state から primary を並べ替え、relay は ON/OFF に展開、status は mechKind を持ち BLE 接続中のときだけ出す
- ref: packages/kit/src/cli/session.js:115-145; packages/core/src/ble/devicemodel.js:339-345
- kind: option-branch
- status: covered
- note: subarea=session lifecycle。session.js:120-121 d.ble→caps.ble / hasCloud→caps.cloud を avail へ和集合、:126-128 lock5 は lastStatus.state===locked で primary=unlock else lock に並べ替え、:137-138 relay を relay-on/relay-off に展開、:143 caps.mechKind && d.ble のときだけ status を足す。devicemodel.js:339-345 transportsForOp は静的 (model×op) で [LOCK-0094] が cover するが、session は接続状態依存の動的可否で別レイヤ。pickTransport の auto/--cloud-only/--ble-only とも別。

### [LOCK-0139] session の op 実行振り分け (makeSessionExec: BLE優先/cloud fallback/Hub3 ir/relay/led)
- surface: cli
- backend: ble, cloud
- command: `makeSessionExec / sessionExec`
- branch: lock+ble接続→BLE | lock+cloud→hub[op]/botClick | autolock無ble→注記 | status無ble→cloud注記 | hub3 ir/relay/led
- assert: session 実行は BLE 接続中ならその接続で bleExec、未接続ロックは cloud (autolock は cli.sessAutolockBleOnly・status は cli.sessStatusCloud の注記、click→botClick・lock/unlock/toggle→hub[op]) へ、Hub3 は ir/relay-on/relay-off/led をクラウド IoT へ振り分ける
- ref: packages/kit/src/cli/session.js:164-195; packages/kit/src/cli/exec.js:40-49; packages/kit/src/i18n/cli.js:218-227
- kind: surface-parity
- status: covered
- note: subarea=session lifecycle。session.js:183-185 ロック系は d.ble があれば bleExec(op,d.ble,extra)、:187 autolock 無 ble→cli.sessAutolockBleOnly / :188 status 無 ble→cli.sessStatusCloud / :189 未ログイン→cli.sessNeedBleOrLogin / :191 click→hub.botClick / :192 他→hubAny[op]。Hub3 は :168 ir→hub.send / :171 relay→iot.hub3RelaySwitch / :176 led→iot.setHub3LedDuty、secretKey 欠落で cli.sessNoSecretKey(:170,:175)、未ログインで cli.sessHub3NeedLogin(:167)。bleExec コア(exec.js:40-49 が autolock/status/lock 系を分岐) は単発と session 共用。runCloudOp [LOCK-0110] は単発専用でこの session 振り分けを cover しない。i18n キー sessHub3NeedLogin..sessNeedBleOrLogin(:218-227) 全て en/ja(:639-648) 実在。

### [LOCK-0140] session の BLE 接続戦略 (connectMany 一括スキャン・背景接続/待機&0件 exit1)
- surface: cli, core
- backend: ble
- command: `cmdSession / SesameBle.connectMany`
- branch: ログイン→背景接続(非ブロッキング) | 未ログイン→待機&0件→exit1 | lockTargets0→スキップ
- assert: cmdSession は SesameBle.connectMany で 1 回のスキャンに集約して並行接続し、ログイン時は BLE を背景接続 (blePromise・メニューを待たせない)・未ログイン時は接続完了を待って 0 件なら cli.bleNoneAndNotLoggedIn で die(1)。connectMany は {connected,unreachable,failed} を返し、close は finally で blePromise 完了待ち→各 ble.close する
- ref: packages/kit/src/cli/session.js:244-273; packages/kit/src/cli/session.js:305-309; packages/core/src/ble/index.js:1160-1184; packages/kit/src/i18n/cli.js:234
- kind: idempotency
- status: covered
- note: subarea=session lifecycle。全 ref 実在確認。session.js:247 connectMany(lockTargets,{scanTimeoutMs:8000})、:261-265 loggedIn→blePromise 背景接続、:266-272 未ログイン→await connectBle()===0 で die(cli.bleNoneAndNotLoggedIn,1)、:305-309 finally で blePromise.catch→ble.close。core index.js:1160-1184 connectMany が {connected:Map,unreachable:string[],failed:[{name,error}]} を返す (:1158 JSDoc/:1183 return)。i18n cli.js:234 cli.bleNoneAndNotLoggedIn 実在 (ja:655)。既存 LOCK-0089 は dispatch.js の argv→session ルーティングのみで session の接続戦略は未被覆。connectMany の unreachable/failed 仕分け (index.js:1171-1181) も同 spec で固定可。

### [LOCK-0141] session-ui の autolock/LED 数値入力モードと runExec の extra 受け渡し
- surface: cli
- backend: ble, cloud
- command: `runSessionUI / session-ui runExec / makeSessionExec`
- branch: autolock数値入力(max65535→bleExec) | led duty入力(max255→cloud iot) | 範囲外→numRange&戻る | 数値入力中は q/←→ をテキスト扱い
- assert: session-ui は autolock/LED モードで TextInput の値を numVal に集め、onSubmit で 0..max(autolock65535/led255) 整数を検証し runExec の extra として渡す (autolock→bleExec(op,ble,extra) の seconds / led→hub.iot.setHub3LedDuty の duty)。数値入力 mode (isList=false) では q/←/→ をテキストとして扱いメニュー操作を奪わない
- ref: packages/kit/src/session-ui.js:131-132; packages/kit/src/session-ui.js:188-209; packages/kit/src/session-ui.js:232-249; packages/kit/src/cli/session.js:174-187
- kind: option-branch
- status: covered
- note: subarea=session lifecycle。全 ref 実在確認。session-ui.js:63 SessionMode に autolock/led/ir-remote/ir-key、:93 numVal state、:131-132 autolock/led 選択で setNumVal('')+setMode、:188-196 useInput が isList のみで q/←/→ を奪う (数値 mode は素通し)、:232-249 TextInput onSubmit が Number.isInteger&&0..max 検証 (:245) して runExec(extra=n) (:246)、:203-209 runExec(op,d,extra)。session.js:184 bleExec(op,d.ble,extra) で autolock の extra=秒数、:176 setHub3LedDuty({duty:Number(extra)}) で LED の extra=duty。CLI 単発 autolock seconds は LOCK-0108/0109 が args 経由を被覆するが、session-ui の対話 TextInput 数値入力境界は spec に存在せず別経路。session-ui.js が ink/react optional peer dep (session.js:277-283 rethrowMissingOptional) の点は E2E 性が高く waived 候補。
