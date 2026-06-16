<!-- spec-domain: auth-cli | prefix: AUTHC | tests: packages/kit/tests/cli -->

# 認証 CLI コマンド spec (AUTHC)

sesame の認証系 CLI コマンド(login/verify/refresh/logout/whoami/init/setup/migrate/config/bootstrap/meta)の引数・オプション・対話分岐・--json 封筒・終了コード・認証後自動セットアップ(bootstrapAfterLogin)を監査する。認証フロー/wire 本体は auth.md(AUTH)へ。

## login command

### [AUTHC-0001] login <email> 必須引数欠落で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame login <email>`
- branch: email欠落
- assert: cmdLogin が email 未指定で die(t('cli.emailRequired'), 2) を呼び、終了コードが usage=2 になる (引数解析段で loginInitiate へ進まない)
- ref: packages/kit/src/cli/auth.js:26; packages/kit/src/cli/auth.js:27; packages/kit/src/cli/errors.js:18
- kind: error-path
- status: covered
- note: commander の missingArgument 経路 (commanderErrorInfo, errors.js:81; COMMANDER_USAGE_CODES の commander.missingArgument errors.js:26) と二重に exit 2 を保証する

### [AUTHC-0002] login → loginInitiate(tokenStore, email) 配線と signUp 先行フロー
- surface: cli
- backend: cloud
- command: `sesame login <email>`
- branch: 正常
- assert: cmdLogin が loadCtx 由来の tokenStore と email でちょうど一度 loginInitiate を呼ぶ。loginInitiate は SignUp(dummypwk,email) → UsernameExists 容認 → CUSTOM_AUTH(SRP_A) を発行する移植元順序と一致する
- ref: packages/kit/src/cli/auth.js:28; packages/kit/src/cli/auth.js:29; packages/core/src/auth.js:315; packages/core/src/auth.js:324; packages/core/src/auth.js:354; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:106; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:130
- kind: option-branch
- status: covered
- note: auth.js:28=loadCtx で tokenStore 取得, :29=loginInitiate(tokenStore,email) 単一呼出。core loginInitiate (auth.js:315) は SignUp(dummypwk) (:324) → UsernameExists のみ容認 (:343) → InitiateAuth CUSTOM_AUTH+SRP_A (:354-360)。Kotlin:106=nextStep の signUp 属性構築開始 (core auth.js:322 が LoginMailFG.kt:106-127 を出典として明記), :130=goSignIIn (signIn→CUSTOM_CHALLENGE)。

### [AUTHC-0003] login の --json 封筒 ({ok,email,next})
- surface: cli
- backend: cloud
- command: `sesame login <email>`
- branch: --json | 人間可読
- assert: --json 時は stdout に {ok:true, email, next:'sesame verify <code>'} を出し人間向け loginSent/loginStep2 を抑止。非 --json 時は逆 (out(isJsonMode(),...) 契約)
- ref: packages/kit/src/cli/auth.js:30; packages/kit/src/cli/auth.js:33; packages/kit/src/cli/ctx.js:92
- kind: surface-parity
- status: covered
- note: auth.js:30=out(isJsonMode(),humanFn,jsonObj) 呼出 (humanFn が loginSent/loginStep2), :33={ok:true,email,next:'sesame verify <code>'} 封筒。ctx.js:92=out() 定義 (json なら JSON.stringify, 否なら humanFn())

## verify command

### [AUTHC-0004] verify [code] 省略時に TTY なら対話 prompt へフォールバック
- surface: cli
- backend: cloud
- command: `sesame verify [code]`
- branch: code省略 & TTY & !--json
- assert: code 未指定かつ canPrompt() が真なら promptLine(t('cli.verifyCodePrompt')) で対話入力した値を code に充てる (アプリの 4桁入力 EditText 自動送信に相当する境界)
- ref: packages/kit/src/cli/auth.js:104; packages/kit/src/cli/ctx.js:160; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginVerifiCodeFG.kt:49
- kind: option-branch
- status: covered
- note: auth.js:104=if(!code && canPrompt(program)) code=await promptLine(t('cli.verifyCodePrompt'))。ctx.js:160=canPrompt 定義 (isInteractive && !json)。Kotlin :49 `if (s?.length == 4)` (→:56 confirmSignIn) が自動送信境界の本体。

### [AUTHC-0005] verify code 欠落かつ非対話で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame verify [code]`
- branch: code省略 & (--json or 非TTY)
- assert: prompt 不可 (canPrompt 偽) で code も無いとき die(t('cli.codeRequired'), 2) で終了コード 2、loginVerify は呼ばれない
- ref: packages/kit/src/cli/auth.js:104; packages/kit/src/cli/auth.js:105; packages/kit/src/cli/ctx.js:161
- kind: error-path
- status: covered
- note: auth.js:104=canPrompt 分岐, :105=if(!code) die(t('cli.codeRequired'),2)。die より後ろの :106 loginVerify には到達しない。ctx.js:161=`return isInteractive() && !program.opts().json` (canPrompt 偽判定の本体)

### [AUTHC-0006] verify → loginVerify(tokenStore, code) で CUSTOM_CHALLENGE/ANSWER 回答
- surface: cli
- backend: cloud
- command: `sesame verify [code]`
- branch: 正常
- assert: cmdVerify が code で loginVerify を呼び、loginVerify は pending Session に対し RespondToAuthChallenge(CUSTOM_CHALLENGE, ChallengeResponses={USERNAME:usernameInternal, ANSWER:code}) を送る移植元形と一致する
- ref: packages/kit/src/cli/auth.js:106; packages/core/src/auth.js:575; packages/core/src/auth.js:582; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginVerifiCodeFG.kt:89
- kind: option-branch
- status: covered
- note: auth.js:106=const tok=await loginVerify(tokenStore,code)。core auth.js:575=challengeResponses={USERNAME:usernameInternal,ANSWER:code} (:573 で usernameInternal=s.usernameInternal??s.username), :582=cognitoCall('RespondToAuthChallenge',{ChallengeName:'CUSTOM_CHALLENGE',Session,ChallengeResponses})。Kotlin:89=confirmSignInAsync の res=mutableMapOf(CHLG_RESP_ANSWER to code) (:90, → :95 confirmSignIn で USERNAME は SDK 内部補完)

### [AUTHC-0007] verify 後に bootstrapAfterLogin が自動実行され封筒に bootstrap が入る
- surface: cli
- backend: cloud
- command: `sesame verify [code]`
- branch: 正常 (自動セットアップ)
- assert: loginVerify 成功後 cmdVerify が bootstrapAfterLogin を呼び、--json 封筒に {ok,clientId,username,deviceKey,bootstrap:summary} を、deviceKey は値ではなく 'set'|null に正規化して出す
- ref: packages/kit/src/cli/auth.js:109; packages/kit/src/cli/auth.js:115; packages/kit/src/cli/auth.js:116; packages/kit/src/cli/auth.js:119
- kind: option-branch
- status: covered
- note: auth.js:109=const summary=await bootstrapAfterLogin(program,{quiet:!!opts.json})。:115=out(opts.json,...) の json 分岐開始, :116={ok:true,clientId:tok.clientId,...}, :117=username, :119=deviceKey:tok.deviceKey?'set':null, :120=bootstrap:summary。封筒キー集合 ({ok,clientId,username,deviceKey,bootstrap}) と deviceKey 正規化を支える

### [AUTHC-0008] verify の bootstrap quiet 連動 (--json で人間ログ抑止)
- surface: cli
- backend: cloud
- command: `sesame verify [code]`
- branch: --json | 人間可読
- assert: --json 時 bootstrapAfterLogin({quiet:true}) で stderr 進捗 (bootAccount 等) を抑止し signedInAutoSetup も出さない。非 --json では console.error に進捗を出す
- ref: packages/kit/src/cli/auth.js:107; packages/kit/src/cli/auth.js:109; packages/kit/src/cli/auth.js:53; packages/kit/src/cli/auth.js:55
- kind: option-branch
- status: covered
- note: 107=非json時のみ signedInAutoSetup、109=quiet:!!opts.json 連動、53=quiet パラメータ既定 false、55=log() が quiet で console.error 抑止。

## bootstrapAfterLogin

### [AUTHC-0009] bootstrapAfterLogin が companyID(refreshAccount) を取り込む
- surface: cli
- backend: cloud
- command: bootstrapAfterLogin / hub.refreshAccount
- branch: account ステップ
- assert: withHub 内で hub.refreshAccount() を呼び companyID を summary.companyID に格納。refreshAccount は biz3GetLoginUser を email で送り customerInfo.companyID を config へ保存する web 移植元 (localStorage curLogin 設定) と同境界
- ref: packages/kit/src/cli/auth.js:61; packages/kit/src/cli/auth.js:62; packages/core/src/client.js:446; references_web/src/api/useStripeInfo.js:93; references_web/src/api/useStripeInfo.js:191
- kind: wire-fidelity
- status: covered
- note: auth.js:62 'summary.companyID = ci?.companyID || null;' が load-bearing 行。useStripeInfo.js:93 'localStorage.setItem(\'curLogin\', customerInfoData.companyID)' が companyID 保存(curLogin 設定)の直接出典。client.js:446=async refreshAccount()、useStripeInfo.js:191=biz3GetCustomerInfo を email で送出。

### [AUTHC-0010] bootstrapAfterLogin が locks/Hub3/remotes を devices から取り込む
- surface: cli
- backend: cloud
- command: bootstrapAfterLogin / syncLocksFromDevices / syncHub3sFromDevices / syncRemotesFromDevices
- branch: locks/hub3/remotes ステップ
- assert: account の後に syncLocksFromDevices→syncHub3sFromDevices→syncRemotesFromDevices の順で呼び summary.locks/hub3s/remotes を埋め、remotes の added/updated 各 name に syncRemoteKeys を best-effort で呼ぶ
- ref: packages/kit/src/cli/auth.js:67; packages/kit/src/cli/auth.js:73; packages/kit/src/cli/auth.js:79; packages/kit/src/cli/auth.js:80; packages/core/src/client.js:528; packages/core/src/client.js:556
- kind: option-branch
- status: covered
- note: 67=syncLocksFromDevices({})、73=syncHub3sFromDevices()、79=const {remotes}=syncRemotesFromDevices()、80='for (const name of [...remotes.added, ...remotes.updated]) { try { await hub.syncRemoteKeys(name); } catch {} }' で best-effort、client.js:528/556=各 sync 定義。呼び出し順 (67<73<79) も assert 通り。

### [AUTHC-0011] bootstrapAfterLogin は各ステップを個別 try/catch し best-effort 続行する
- surface: cli
- backend: cloud
- command: bootstrapAfterLogin
- branch: account失敗 | locks失敗 | hub3失敗 | remotes失敗
- assert: いずれかのステップが throw しても他ステップを続行し summary.errors にプレフィックス付き ('account:'/'locks:'/'hub3s:'/'remotes:') メッセージを蓄積、認証成功扱いは潰さない
- ref: packages/kit/src/cli/auth.js:64; packages/kit/src/cli/auth.js:70; packages/kit/src/cli/auth.js:76; packages/kit/src/cli/auth.js:83
- kind: error-path
- status: covered
- note: 64='catch...errors.push(`account: ...`)'、70='locks: '、76='hub3s: '、83='remotes: '。各 try/catch は独立で他ステップを潰さず errors に蓄積。プレフィックス文字列も assert と完全一致。

### [AUTHC-0012] bootstrapAfterLogin の connect 失敗時に authExpired を構造化エラーで判定
- surface: cli
- backend: cloud
- command: bootstrapAfterLogin
- branch: connect失敗(認証失効) | connect失敗(その他)
- assert: withHub が throw したとき e instanceof SesameError && e.code===ERR.UNAUTHENTICATED のときだけ summary.authExpired=true とし bootAuthExpired を、それ以外は bootConnectFail を出す (message 文字列マッチに依存しない)
- ref: packages/kit/src/cli/auth.js:85; packages/kit/src/cli/auth.js:89; packages/kit/src/cli/auth.js:91; packages/kit/src/cli/auth.js:92; packages/core/src/auth.js:210
- kind: error-path
- status: covered
- note: 85=withHub を囲む外側 catch、89='const authExpired = e instanceof SesameError && e.code === ERR.UNAUTHENTICATED;'、91=authExpired時 bootAuthExpired ログ、92=else 分岐 bootConnectFail。core/auth.js:210='throw new SesameError(tr("auth.noTokens"), { code: ERR.UNAUTHENTICATED })' が getValidIdToken の UNAUTHENTICATED 送出源で withHub 経由伝播。

## setup command

### [AUTHC-0013] setup は未ログインで usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame setup`
- branch: 未ログイン
- assert: cmdSetup が tokenStore.load() 偽で die(t('cli.notLoggedIn'),2)、bootstrapAfterLogin へ進まず終了コード 2
- ref: packages/kit/src/cli/auth.js:129; packages/kit/src/cli/auth.js:131
- kind: error-path
- status: covered
- note: 129=export async function cmdSetup(_opts, program)、131='if (!tokenStore.load()) die(t("cli.notLoggedIn"), 2);' で未ログイン時に exit 2 ・以降の bootstrapAfterLogin に到達しない。backend=local も妥当 (tokenStore.load はローカル読み、ネットワーク不要)。

### [AUTHC-0014] setup の手動再実行と部分失敗時 exit 1
- surface: cli
- backend: cloud
- command: `sesame setup`
- branch: 正常 | 部分失敗 | authExpired
- assert: ログイン済みなら bootstrapAfterLogin を再実行し、summary.errors が空でなければ process.exitCode=1 とし封筒は {ok:false, bootstrap}。authExpired は setupAuthExpired、部分失敗は setupPartialFail、成功は setupDone を出し分ける
- ref: packages/kit/src/cli/auth.js:133; packages/kit/src/cli/auth.js:134; packages/kit/src/cli/auth.js:136; packages/kit/src/cli/auth.js:143; packages/kit/src/cli/auth.js:144
- kind: error-path
- status: covered
- note: 133=bootstrapAfterLogin 再実行、134='const failed = summary.errors.length > 0;'、136='if (summary.authExpired)' で setupAuthExpired/ 138-141 で setupPartialFail/setupDone を出し分け、143='{ ok: !failed, bootstrap: summary }'、144='if (failed) process.exitCode = 1;'。

## refresh command

### [AUTHC-0015] refresh は marginSec を大きく取り強制リフレッシュする
- surface: cli
- backend: cloud
- command: `sesame refresh`
- branch: 正常
- assert: cmdRefresh が getValidIdToken(tokenStore,{marginSec:999999}) を呼び、有効期限に関わらず REFRESH_TOKEN_AUTH(InitiateAuth, AuthParameters={REFRESH_TOKEN, DEVICE_KEY?}) を走らせて新 idToken 長を返す
- ref: packages/kit/src/cli/auth.js:153; packages/core/src/auth.js:207; packages/core/src/auth.js:234; _aws_sdk_ref/CognitoUser.java:2867
- kind: option-branch
- status: covered
- note: CognitoUser.java の REFRESH_TOKEN_AUTH 経路は refreshSession()(2865)→initiateRefreshTokenAuthRequest()(3550) で REFRESH_TOKEN+DEVICE_KEY を addAuthParametersEntry する。DEVICE_KEY 付与は core/auth.js:227 で確認。

### [AUTHC-0016] refresh の --json 封筒 ({ok,idTokenLength})
- surface: cli
- backend: cloud
- command: `sesame refresh`
- branch: --json | 人間可読
- assert: --json 時 {ok:true, idTokenLength:tok.length} を stdout に出し、生 idToken は出さない (長さのみ)。非 --json は idTokenRefreshed メッセージ
- ref: packages/kit/src/cli/auth.js:154; packages/kit/src/cli/auth.js:156
- kind: surface-parity
- status: covered

## logout command

### [AUTHC-0017] logout はセッション無しで冪等に成功封筒を返す
- surface: cli
- backend: local
- command: `sesame logout`
- branch: セッション無し
- assert: tokenStore.load() 偽なら logout(core) を呼ばず {ok:true, alreadyLoggedOut:true} を出して即 return (logoutNoSession)。サーバ呼び出しは発生しない
- ref: packages/kit/src/cli/auth.js:165; packages/kit/src/cli/auth.js:166
- kind: idempotency
- status: covered

### [AUTHC-0018] logout は ForgetDevice + RevokeToken をしてからローカル消去する
- surface: cli
- backend: cloud
- command: `sesame logout`
- branch: セッション有り | 部分失敗
- assert: セッション有りなら logout(core) が ForgetDevice(AccessToken,DeviceKey)→RevokeToken(Token,ClientId) を best-effort で叩いてから store.clear()。封筒 {ok:true, forgotDevice, revokedToken}、どちらか偽なら logoutPartial を stderr に出す
- ref: packages/kit/src/cli/auth.js:170; packages/kit/src/cli/auth.js:173; packages/core/src/auth.js:875; packages/core/src/auth.js:892; packages/core/src/auth.js:902
- kind: option-branch
- status: covered
- note: サーバ側クリーンアップは kit の意図的強化 (アプリはローカル signOut のみ、core/auth.js:864-870 のコメントで明示)。store.clear() は core/auth.js:907。実 Cognito 往復は wire モックで検証

## whoami command

### [AUTHC-0019] whoami は biz3GetLoginUser で customerInfo/quotas を取得し companyID を保存
- surface: cli
- backend: cloud
- command: `sesame whoami`
- branch: 正常
- assert: withHub 内で hub.refreshAccount() (companyID のみ config 保存・subUUID は this._subUUID に in-memory 反映のみ=非永続) と hub.getLoginUser().quotas を取り、両者の wire が biz3GetLoginUser {action:'biz3GetLoginUser',email} → data:{customerInfo,quotas} の web 形と一致する
- ref: packages/kit/src/cli/auth.js:189; packages/kit/src/cli/auth.js:190; packages/core/src/client.js:446-462; packages/core/src/account.js:47; packages/core/src/account.js:51; references_web/src/api/useStripeInfo.js:192; references_web/src/api/useStripeInfo.js:89
- kind: wire-fidelity
- status: covered
- note: request の {action:'biz3GetLoginUser',email} 実体は useStripeInfo.js:192-194、応答 data:{customerInfo,quotas} は handleBiz3GetCustomerInfoResponse 89-92。action 値は messageConstants.js:3 BIZ3_GET_LOGIN_INFO='biz3GetLoginUser'。refreshAccount (client.js:446-462) は companyID を _config+configStore.save (450-456)、subUUID は this._subUUID へ代入のみ (458-460) で config 保存しない。

### [AUTHC-0020] whoami の customerInfo 欠落分岐と --json 封筒
- surface: cli
- backend: cloud
- command: `sesame whoami`
- branch: customerInfo無し | --json | 人間可読
- assert: customerInfo が null なら noCustomerInfo を出し以降の companyId/subUuid 行をスキップ。--json は {ok:true, customerInfo, quotas} を出す。subUUID 欠落は '(none)'、name/subscriptionId は存在時のみ行追加
- ref: packages/kit/src/cli/auth.js:191; packages/kit/src/cli/auth.js:192; packages/kit/src/cli/auth.js:194; packages/kit/src/cli/auth.js:198
- kind: option-branch
- status: covered
- note: name/subscriptionId の条件行追加は auth.js:195-196 にも対応。--json 封筒 {ok,customerInfo,quotas} は 198。

## bootstrap command

### [AUTHC-0021] bootstrap は TTY (パイプ無し) で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame bootstrap`
- branch: stdin が TTY
- assert: process.stdin.isTTY が真なら stdin を読まず die(t('cli.bootstrapStdin'),2) で終了コード 2 (無限待ち回避)
- ref: packages/kit/src/cli/auth.js:209
- kind: error-path
- status: covered
- note: isTTY チェック + die は auth.js:209。cli.bootstrapStdin キーは kit/src/i18n/cli.js:408 に実在。

### [AUTHC-0022] bootstrap は空入力 / 不正 JSON で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame bootstrap`
- branch: 空入力 | JSON parse 失敗
- assert: stdin trim が空なら die(bootstrapEmpty,2)、JSON.parse 失敗なら die(bootstrapInvalidJson{message},2)。どちらも core bootstrap() へ進まない
- ref: packages/kit/src/cli/auth.js:213; packages/kit/src/cli/auth.js:214; packages/kit/src/cli/auth.js:216; packages/kit/src/cli/auth.js:219
- kind: error-path
- status: covered
- note: 213=input trim, 214=die(bootstrapEmpty,2), 216=JSON.parse, 219=die(bootstrapInvalidJson,2)

### [AUTHC-0023] bootstrap は app-login 由来トークンのみ受理 (aud/ConfirmDevice 検証)
- surface: cli
- backend: local
- command: `sesame bootstrap` / bootstrap(core)
- branch: idToken欠落 | refreshToken欠落 | 非consumer aud | 未確定device
- assert: core bootstrap() が idToken/refreshToken 必須を検査し assertAppLoginTokens(requireAud,requireConfirmedDevice) で consumer clientId 以外 / deviceKey ありで device 3点不整合を UNAUTHENTICATED 拒否する (web 方式トークンを弾く負の証拠境界)
- ref: packages/kit/src/cli/auth.js:221; packages/core/src/auth.js:922; packages/core/src/auth.js:923; packages/core/src/auth.js:924; packages/core/src/auth.js:179; packages/core/src/auth.js:192
- kind: error-path
- status: covered
- note: 絶対制約: 認証は Android アプリ方式のみ。references_web/src/api/useAuthState.js (実在, @aws-amplify/auth=web Amplify flow) は負の証拠。refreshToken 必須を支える core/auth.js:923。

### [AUTHC-0024] bootstrap 成功時 clientId を consumer に固定し封筒返却
- surface: cli
- backend: local
- command: `sesame bootstrap` / bootstrap(core)
- branch: 正常
- assert: 検証通過後 store.save し、保存トークンの clientId は入力に依らず CONSUMER_CLIENT_ID に固定。封筒 {ok:true, clientId} / 人間向け okBootstrapped を出す
- ref: packages/kit/src/cli/auth.js:221; packages/kit/src/cli/auth.js:222; packages/core/src/auth.js:926; packages/core/src/auth.js:936
- kind: option-branch
- status: covered
- note: core/auth.js:926=clientId: CONSUMER_CLIENT_ID 固定行。936=store.save(t)。cli/auth.js:222=out(...okBootstrapped, {ok:true, clientId})。

## init command

### [AUTHC-0025] init は 0700 で config dir を作り --lang を焼き込む
- surface: cli
- backend: local
- command: `sesame init`
- branch: --lang 指定 | 未指定 | 既存
- assert: cmdInit が ensureSecureDir(paths.dir) で 0700 作成し、解決済み langFlag があれば configStore.init({uiLang,lang}) に焼き込む。既存 config は created=false で alreadyExists を出す
- ref: packages/kit/src/cli/config-cmd.js:21; packages/kit/src/cli/config-cmd.js:23; packages/kit/src/cli/config-cmd.js:25; packages/kit/src/cli.js:185
- kind: option-branch
- status: covered
- note: config-cmd.js 21=cmdInit, 23=ensureSecureDir(paths.dir)(0700), 25=configStore.init(langFlag?{uiLang,lang}:{}); cli.js:185=registerInitCommand(program,{getLangFlag:()=>CLI_LANG_FLAG})

### [AUTHC-0026] init の --json 封筒 ({ok,created,configPath,nodeVersion})
- surface: cli
- backend: local
- command: `sesame init`
- branch: --json | 人間可読
- assert: --json 時 {ok:true, created, configPath, nodeVersion} を stdout に出し、人間向けの手順テキスト群 (initNextSteps 等) は抑止する
- ref: packages/kit/src/cli/config-cmd.js:26; packages/kit/src/cli/config-cmd.js:44
- kind: surface-parity
- status: covered
- note: 26=out(opts.json, ()=>{...},...) の human/json 分岐起点 (内側 33 行に initNextSteps 等の手順テキスト)、44=json 封筒 {ok:true, created, configPath:paths.config, nodeVersion:process.version}。

## config command

### [AUTHC-0027] config (引数省略) と config show が同じ表示になる
- surface: cli
- backend: local
- command: `sesame config` / `sesame config show`
- branch: サブコマンド省略 | show 明示
- assert: config グループの action と show サブコマンドが共に cmdConfigShow を呼び、引数なしでも exit 1 にならず同一封筒/出力を返す
- ref: packages/kit/src/cli/config-cmd.js:100; packages/kit/src/cli/config-cmd.js:102; packages/kit/src/cli/config-cmd.js:106
- kind: surface-parity
- status: covered
- note: 100=registerConfigCommands, 102=program.command('config').action((opts)=>cmdConfigShow(...)), 106=config.command('show').action((opts)=>cmdConfigShow(...))。両 action が同一 cmdConfigShow を呼ぶ。

### [AUTHC-0028] config show は secretKey をツリー全体でマスクする (test 済)
- surface: cli
- backend: local
- command: `sesame config show`
- branch: config あり
- assert: cmdConfigShow が redactConfig(cfg) を通し devices と派生 locks 双方の secretKey を mask() で潰す。出力ツリーに生 32hex 鍵が残らない (生鍵は sesame devices のみ)
- ref: packages/kit/src/cli/config-cmd.js:75; packages/kit/src/cli/ctx.js:74; packages/kit/src/cli/ctx.js:80; packages/kit/tests/cli/config-redact.test.js:20
- kind: payload-fidelity
- status: covered
- note: config-cmd.js:75=const cfgRedacted=redactConfig(cfg), ctx.js:74=export function redactConfig(cfg), ctx.js:80=secretKey を mask() で潰す walk。packages/kit/tests/cli/config-redact.test.js が redactConfig をカバー済 (devices/locks 双方 mask、生 32hex 非含有、非破壊)。[ID] タグ付与は後工程。

### [AUTHC-0029] config show は tokens を長さマスクし deviceKey は set/null に潰す
- surface: cli
- backend: local
- command: `sesame config show`
- branch: tokens あり | tokens 無し
- assert: tokens があれば idToken/refreshToken/accessToken を mask() で長さ表示、deviceKey は値でなく 'set'|null。tokens 無しは notSignedIn / null を出す
- ref: packages/kit/src/cli/config-cmd.js:68; packages/kit/src/cli/config-cmd.js:71; packages/kit/src/cli/config-cmd.js:81; packages/kit/src/cli/ctx.js:61
- kind: error-path
- status: covered
- note: idToken/refreshToken/accessToken の mask() 呼び出しは :68-70、deviceKey の 'set'|null は :71、notSignedIn/null 分岐は :81。mask() 関数本体は ctx.js:61 で len 表示を実装。

### [AUTHC-0030] config path は config dir パスのみを出す
- surface: cli
- backend: local
- command: `sesame config path`
- branch: --json | 人間可読
- assert: cmdConfigPath が paths.dir を出力 (--json は {dir})。config 存在に依らずパス解決のみで副作用なし
- ref: packages/kit/src/cli/config-cmd.js:51; packages/kit/src/cli/config-cmd.js:53
- kind: surface-parity
- status: covered
- note: :51 が cmdConfigPath 定義、:53 が out(isJsonMode(), ()=>console.log(paths.dir), {dir: paths.dir})。loadCtx でパス解決のみ、configStore.load() を呼ばず副作用なし。

## migrate command

### [AUTHC-0031] migrate はトークン (.tokens.json/.login_state.json) を取り込まず skip する
- surface: cli
- backend: local
- command: `sesame migrate [srcDir]`
- branch: 旧 .tokens.json 在 | 旧 .login_state.json 在
- assert: 旧 .tokens.json / .login_state.json が存在しても tokenStore へ取り込まず summary.skipped に再ログイン誘導付きで積むだけ (ConfirmDevice 済みか検証不能なため認証状態は移行しない)
- ref: packages/kit/src/cli/migrate.js:40; packages/kit/src/cli/migrate.js:42; packages/kit/src/cli/migrate.js:45; packages/kit/src/cli/migrate.js:47
- kind: error-path
- status: covered
- note: アプリ方式の再ログイン (sesame login) で作り直す前提。トークン移行は意図的に欠落。:40 oldTokens 解決, :42 skipped.push('.tokens.json (run `sesame login <email>`)'), :45 oldPending 解決, :47 skipped.push('.login_state.json (stale sign-in state)')。

### [AUTHC-0032] migrate は .env (COMPANY_ID/WS_URL/LANG) と keys.json を config へ統合する
- surface: cli
- backend: local
- command: `sesame migrate [srcDir]`
- branch: .env あり | keys.json あり | hub3/remote 派生
- assert: parseDotenv で .env を読み COMPANY_ID/WS_URL/LANG を cfg へ、HUB3_DEVICE_ID は addHub3、IR_DEVICE_UUID は addRemote (store API 経由) で登録し summary.imported/hub3Added/remoteAdded を埋める
- ref: packages/kit/src/cli/migrate.js:55; packages/kit/src/cli/migrate.js:66; packages/kit/src/cli/migrate.js:74; packages/kit/src/cli/migrate.js:81
- kind: option-branch
- status: covered
- note: parseDotenv 呼び出しは :55、addHub3 呼び出しは :74。:66 が COMPANY_ID→cfg.companyID (WS_URL/LANG は :67-68)、:81 が addRemote(remoteName,...) で IR_DEVICE_UUID 登録。store API 経由 (派生 view 直書き回避) のコメントも :70-71 に整合。

### [AUTHC-0033] migrate は 0700 dir 作成と src 既定 cwd 解決
- surface: cli
- backend: local
- command: `sesame migrate [srcDir]`
- branch: srcDir 指定 | 省略
- assert: srcDir 省略時 process.cwd() を resolve、ensureSecureDir(paths.dir) で 0700 作成、最後に configStore.save() で companyID/wsUrl/lang を確定する
- ref: packages/kit/src/cli/migrate.js:31; packages/kit/src/cli/migrate.js:32; packages/kit/src/cli/migrate.js:92
- kind: option-branch
- status: covered
- note: :31 const src = resolve(srcDir || process.cwd()), :32 ensureSecureDir(paths.dir); // 0700, :92 configStore.save()。

## meta command

### [AUTHC-0034] meta は CONFIG_META (region/userPoolId/consumerClientId) を出す
- surface: cli
- backend: local
- command: `sesame meta`
- branch: --json | 人間可読
- assert: meta コマンドが CONFIG_META {region, userPoolId, consumerClientId} をそのまま出力し、consumerClientId が認証フローで使う CONSUMER_CLIENT_ID と同値であることを公開する
- ref: packages/kit/src/cli.js:223; packages/kit/src/cli.js:224; packages/core/src/auth.js:940
- kind: contract-existence
- status: covered
- note: cli.js:223 program.command('meta'), :224 action が out(...,CONFIG_META)。auth.js:940 export const CONFIG_META = { region:COGNITO_REGION, userPoolId:USER_POOL_ID, consumerClientId:CONSUMER_CLIENT_ID }。consumerClientId が CONSUMER_CLIENT_ID (:75 = '6ialca0p8u0lsgvbmvsljfm305') と同値。

## ctx helpers

### [AUTHC-0035] canPrompt は TTY かつ --json 無しのときだけ真
- surface: cli
- backend: local
- command: canPrompt / promptLine
- branch: TTY&!json | --json | 非TTY
- assert: canPrompt(program) が isInteractive() && !opts.json と同値で、verify の対話フォールバック可否を支配する。--json か非 TTY では prompt を呼ばない契約
- ref: packages/kit/src/cli/ctx.js:160; packages/kit/src/cli/ctx.js:161; packages/kit/src/prompts.js:12
- kind: option-branch
- status: covered
- note: ctx.js:160 export function canPrompt(program), :161 return isInteractive() && !program.opts().json。prompts.js:12 export function isInteractive() { return Boolean(process.stdin.isTTY && process.stdout.isTTY) }。

### [AUTHC-0036] promptLine は Ctrl-D (EOF) で空入力なら throw する
- surface: cli
- backend: local
- command: promptLine
- branch: EOF空入力 | 通常入力
- assert: readline が close 後に空文字を resolve したら promptAbortedEof を throw し、verify の対話入力で無限ループ/空 code 確定を防ぐ。通常は trim 済み入力を返す
- ref: packages/kit/src/cli/ctx.js:141; packages/kit/src/cli/ctx.js:148
- kind: error-path
- status: covered
- note: ctx.js:141 = export async function promptLine(question); ctx.js:148 = `if (closed && !ans) throw new Error(t("cli.promptAbortedEof"))`。close ハンドラ(144)で closed フラグ、149 で trim 済み入力を返す。

### [AUTHC-0037] out 封筒は --json で純 JSON、非 --json で人間関数を出す
- surface: cli
- backend: local
- command: out
- branch: --json | 人間可読
- assert: out(json,humanFn,jsonObj) が json 真で JSON.stringify(jsonObj,null,2) を stdout に、偽で humanFn() を呼ぶ。全認証コマンドの封筒/人間出力の二者択一を一本化した契約
- ref: packages/kit/src/cli/ctx.js:92; packages/kit/src/cli/ctx.js:93; packages/kit/src/cli/ctx.js:94
- kind: surface-parity
- status: covered
- note: ctx.js:92 = export function out(json, humanFn, jsonObj); :93 = `if (json) console.log(JSON.stringify(jsonObj, null, 2))` (stdout); :94 = `else humanFn()`。

### [AUTHC-0038] loadCtx は configDir からパス/ConfigStore/TokenStore を構築する
- surface: cli
- backend: local
- command: loadCtx
- branch: --config-dir 指定 | 既定
- assert: loadCtx(program) が opts.configDir → configPaths で paths を解き ConfigStore(config) と FileTokenStore({tokensPath,loginStatePath}) を作る。全認証コマンドが同一の store ファクトリ経由で状態へ触れる契約
- ref: packages/kit/src/cli/ctx.js:102; packages/kit/src/cli/ctx.js:104; packages/kit/src/cli/ctx.js:106
- kind: contract-existence
- status: covered
- note: ctx.js:102 = export function loadCtx(program); :104 = `const paths = configPaths(opts.configDir)`; :106 = `const tokenStore = new FileTokenStore({` (107-108 で tokensPath/loginStatePath)。ConfigStore は :105。

### [AUTHC-0039] withHub は config 不在で usage エラー、接続後 close を保証する
- surface: cli
- backend: cloud
- command: withHub
- branch: config 不在 | 正常 (connect→fn→close)
- assert: withHub が configStore.exists() 偽で die(noConfigRun,2)。存在時は SesameHub3.connect()→fn(hub,{opts,paths}) 実行後 finally で必ず hub.close()。whoami/bootstrapAfterLogin が乗る共通土台
- ref: packages/kit/src/cli/ctx.js:118; packages/kit/src/cli/ctx.js:120; packages/kit/src/cli/ctx.js:129; packages/kit/src/cli/ctx.js:133
- kind: error-path
- status: covered
- note: ctx.js:118 = export async function withHub(program, fn); :120 = `if (!configStore.exists())`(121 で die(t("cli.noConfigRun"),2)); :129 = `try {`(130 connect, 131 fn(hub,{opts,paths})); :133 = `await hub.close()` in finally。

## errors contract

### [AUTHC-0040] 認証コマンドの終了コード契約 (0/1/2) が README と一致する
- surface: cli
- backend: local
- command: die / EXIT / runtimeExitCode
- branch: usage(2) | runtime(1) | ok(0)
- assert: die の既定が EXIT.RUNTIME(1)、login/verify/setup/bootstrap の usage 拒否が code 2、SesameError(BAD_REQUEST) は runtimeExitCode で 2 に写る。EXIT={OK:0,RUNTIME:1,USAGE:2} が README 契約と一致
- ref: packages/kit/src/cli/errors.js:18; packages/kit/src/cli/errors.js:49; packages/kit/src/cli/errors.js:99; packages/kit/src/cli/auth.js:27; README.md:168
- kind: error-path
- status: covered
- note: errors.js:18 = `EXIT = Object.freeze({ OK: 0, RUNTIME: 1, USAGE: 2 })`; :49 = `die(msg, code = EXIT.RUNTIME)`; :99 = runtimeExitCode が SesameError(BAD_REQUEST)→USAGE。auth.js:27 = login usage 拒否=2 (verify codeRequired→:105、bootstrap empty/invalid→:214/219 も die(...,2))。README.md:168 = `0=success / 1=runtime error / 2=usage error`。

### [AUTHC-0041] --json エラー封筒は stderr に {error,code}、成功 JSON は stdout に分離
- surface: cli
- backend: local
- command: die (--json)
- branch: --json エラー | 非 --json エラー
- assert: _jsonMode 真のとき die は stderr に JSON {error,code} を出し stdout を成功 JSON 専用に保つ。非 --json は 'Error: <msg>' を stderr へ。setJsonMode は run 冒頭 argv 走査で確定
- ref: packages/kit/src/cli/errors.js:50; packages/kit/src/cli/errors.js:51; packages/kit/src/cli/errors.js:39; packages/kit/src/cli.js:120
- kind: error-path
- status: covered
- note: errors.js:50 = `if (_jsonMode) console.error(JSON.stringify({ error: msg, code }))`、非 --json は :51 = `else console.error(\`Error: ${msg}\`)`。setJsonMode 定義は :39。run 冒頭 argv 走査は cli.js:120 = `setJsonMode(argv.includes("--json"))`。

## i18n (auth コマンド文言)

### [AUTHC-0042] 認証コマンドの人間向けメッセージが en/ja 両カタログに存在する
- surface: cli
- backend: local
- command: login/verify/setup/logout/whoami/bootstrap/migrate
- branch: en | ja
- assert: loginSent/loginStep2/signedInAutoSetup/verifyDone/setupDone/setupAuthExpired/logoutDone/logoutPartial/noCustomerInfo/okBootstrapped/okMigrated/unknownLang/promptAbortedEof が en と ja 両方のカタログに揃う (欠落キーで実行時 fallback しない)
- ref: packages/kit/src/i18n/cli.js:33; packages/kit/src/i18n/cli.js:49; packages/kit/src/i18n/cli.js:454; packages/kit/src/i18n/cli.js:470
- kind: i18n
- status: covered
- note: cli.js:33 = "cli.loginSent"(en)、:454 = "cli.loginSent"(ja); :49 = "cli.signedInAutoSetup"(en)、:470 = "cli.signedInAutoSetup"(ja)。列挙 13 キー全てを grep -c で各 count=2 (en+ja) 確認。欠落なし。

## cli divergence

### [AUTHC-0043] sesame whoami は account.whoami RPC を介さず hub.refreshAccount+getLoginUser を直接呼ぶ
- surface: cli
- backend: cloud
- command: `sesame whoami`
- branch: customerInfo あり | null (noCustomerInfo) | --json
- assert: cmdWhoami は account.whoami メソッドではなく hub.refreshAccount() (companyID を config 保存) + hub.getLoginUser().quotas を直接呼ぶ。--json は {ok,customerInfo,quotas}、人間向けは companyID/subUUID/name/subscriptionId を出し config 保存を告げる
- ref: packages/kit/src/cli/auth.js:186-200; packages/core/src/client.js:441-456,433-439; packages/kit/src/i18n/cli.js:268,488
- kind: surface-parity
- status: covered
- note: 重要な面差: CLI whoami は serve の account.whoami (entries/auth.js:42 hub.getLoginUser のみ) と同じ biz3GetLoginUser を叩くが副作用 (companyID 永続化, client.js:450-456。subUUID は in-memory のみで非永続) が追加。RPC 版は副作用なし。

### [AUTHC-0044] sesame ping は cloud.ping RPC を介さず hub.ping を直接呼ぶ
- surface: cli
- backend: cloud
- command: `sesame ping`
- branch: success (okKeepalive) | --json | 接続失敗(throw)
- assert: cmdPing は cloud.ping メソッドではなく withHub 経由で hub.ping() を直接呼び、成功時 cli.okKeepalive を出す (--json は {ok:true})。rttMs は返さない (RPC 版との出力差)
- ref: packages/kit/src/cli/remote.js:88-93,297-298; packages/core/src/client.js:421-424; packages/kit/src/i18n/cli.js:76,497,275,696
- kind: surface-parity
- status: covered
- note: 面差: CLI ping は rttMs 無し (remote.js:91 → {ok:true})・cloud.ping RPC は {ok,rttMs} (serve/entries/auth.js:36)。どちらも biz3KeepAlive 1 往復で底は同一。

## 監査追補 (audit gap-fill)

> このセクションは reference-audit で検出した valid-new gap を、subarea を問わず追補としてまとめる。
> 各エントリの note 冒頭に対象 subarea と既存関連 ID を記す。既存エントリ (AUTHC-0001〜0044) は無変更。

### [AUTHC-0045] verify の誤コード/失効デバイス再試行 throw が CLI で runtime error (exit 1) として浮上し bootstrap に到達しない
- surface: cli
- backend: cloud
- command: `sesame verify [code]`
- branch: 誤コード再試行 (wrongCodeRetry) | 失効デバイス再試行 (staleDeviceRetry)
- assert: cmdVerify は loginVerify を try/catch 無しで呼ぶ (auth.js:106) ため、loginVerify が wrongCodeRetry (plain Error) / staleDeviceRetry (SesameError UNAUTHENTICATED) を throw すると run() 最終 catch (cli.js:280 die(withStaleHint(err), runtimeExitCode(err))) に伝播し、bootstrapAfterLogin に到達せず exit 1。runtimeExitCode は BAD_REQUEST のみ usage(2) に写すため UNAUTHENTICATED も plain Error も runtime(1) になる。pending は新 Session で温存され (auth.js:638) 同 login のまま再 verify 可能。AUTH-0021/0031 は core 側 wire/retry を扱うが CLI 終了コード写像は未被覆
- ref: packages/kit/src/cli/auth.js:106; packages/core/src/auth.js:640; packages/core/src/auth.js:625; packages/kit/src/cli.js:280; packages/kit/src/cli/errors.js:99
- kind: error-path
- status: covered
- note: subarea=verify command。関連: AUTH-0021 (wrongCodeRetry 新 Session 書き戻し, idempotency), AUTH-0031 (staleDeviceRetry, error-path) は surface に cli を含むが core 動作のみを assert し、CLI プロセスの exit code (1, usage 2 ではない) と bootstrap 非到達は未被覆。本 spec は AUTHC (CLI 終了コード契約) の責務。refs 全件実在・主張支持を確認。runtimeExitCode(errors.js:99) で BAD_REQUEST のみ USAGE になる点を確認済み (UNAUTHENTICATED→RUNTIME)。

### [AUTHC-0046] グローバル --lang の未知値は警告のみで続行し init 焼き込み対象から除外される (isKnownLang ゲート)
- surface: cli
- backend: local
- command: `sesame --lang <lang> <any>` / init
- branch: 未知 --lang (警告のみ続行) | 既知 --lang | 未指定
- assert: run() 冒頭で argv を直接覗き langFlag が isKnownLang 偽なら cli.unknownLang を stderr へ警告するが英語へ落として続行 (exit しない)。CLI_LANG_FLAG = (langFlag && isKnownLang(langFlag)) ? locale : null なので未知値は null になり、init は configStore.init(langFlag?{uiLang,lang}:{}) で {} 焼き込み (uiLang/lang を残さない)。isKnownLang は空を true、en/ja 接頭辞のみ true
- ref: packages/kit/src/cli.js:132; packages/kit/src/cli.js:138; packages/core/src/i18n.js:122; packages/kit/src/cli/config-cmd.js:25
- kind: i18n
- status: covered
- note: subarea=i18n (auth コマンド文言)。AUTHC-0042 は unknownLang を i18n カタログのキー存在列挙に含めるのみで『警告しつつ続行 (exit しない)』behavior と init 焼き込みゲートは未被覆。AUTHC-0025 は『解決済み langFlag があれば焼き込む』正の境界のみで『未知値は焼き込まない』負の境界が無い。ref を config.js:510 から config-cmd.js:25 (langFlag?{uiLang,lang}:{} の焼き込みゲート本体) に修正 — config.js:510 は init() の uiLang 代入行だが、未知値除外の load-bearing 行は config-cmd.js:25 の三項。refs 全件実在を確認。

### [AUTHC-0047] logout は ForgetDevice 前に AccessToken を refresh し、失効時は ForgetDevice を断念する
- surface: cli
- backend: cloud
- command: `sesame logout` / logout(core)
- branch: deviceKey あり & refresh 可 | deviceKey あり & refresh 失効 | deviceKey 無し
- assert: logout(core) は t.deviceKey がある場合のみ getValidIdToken(store,{marginSec:300}) で AccessToken を更新してから ForgetDevice を試み、refresh が失効 (throw) すれば catch して ForgetDevice を諦める (forgotDevice=false のまま続行)。RevokeToken はローテート後の最新 refreshToken (store.load()?.refreshToken||t.refreshToken) を読み直して使い、いずれも best-effort、最後に必ず store.clear()/clearPending する
- ref: packages/core/src/auth.js:882; packages/core/src/auth.js:885; packages/core/src/auth.js:887; packages/core/src/auth.js:899
- kind: error-path
- status: covered
- note: subarea=logout command。AUTHC-0018 は ForgetDevice→RevokeToken→clear の順と封筒 {ok,forgotDevice,revokedToken} のみを assert (branch=セッション有り|部分失敗) で、ForgetDevice の AccessToken 事前 refresh (marginSec:300) と deviceKey 有でも refresh 失効なら forgotDevice=false に留まる分岐、RevokeToken のローテート後最新 refreshToken 読み直しは未被覆。AUTHC-0018 の補強。refs 全件 (auth.js:882/885/887/899) 実在・主張支持を確認。

### [AUTHC-0048] bootstrap は requireAud=true を渡し aud claim 欠落 (aud=null) も拒否する (他経路との非対称)
- surface: cli
- backend: local
- command: `sesame bootstrap` / bootstrap(core)
- branch: aud=consumer | aud≠consumer (present) | aud claim 無し (null)
- assert: core bootstrap() は assertAppLoginTokens(values,'bootstrap input',{requireAud:true,requireConfirmedDevice:true}) を呼ぶ。requireAud=true のため aud が CONSUMER_CLIENT_ID と厳密一致しない場合 (aud=null すなわち jwt の aud claim 欠落も含む) UNAUTHENTICATED で拒否する (auth.js:179-180)。これは getValidIdToken (requireAud 既定 false で aud null を許容, auth.js:212) より厳しい入口検証で、両経路の非対称が本境界
- ref: packages/core/src/auth.js:924; packages/core/src/auth.js:179; packages/core/src/auth.js:180; packages/core/src/auth.js:212
- kind: error-path
- status: covered
- note: subarea=bootstrap command。AUTHC-0023 は ref に auth.js:179 を含み『非consumer aud / 未確定device』を述べるが、その assert は aud が present-but-wrong (auth.js:182) を主軸にしており、requireAud=true による aud-null (claim 欠落) 厳格拒否 (auth.js:179-180) と getValidIdToken/loginVerify (requireAud=false で aud-null 許容, auth.js:212) との非対称は未明示。AUTHC-0023 の relatedSpec 補強。refs 全件実在・主張支持を確認。

### [AUTHC-0049] migrate の addRemote は irType/irOperation 既定 (DEFAULT_IR_TYPE / 'learnEmit') と keys.json の alias/keys を取り込む
- surface: cli
- backend: local
- command: `sesame migrate [srcDir]`
- branch: IR_TYPE 指定/未指定(既定) | IR_OPERATION 指定/未指定(learnEmit) | keys.json alias/keys
- assert: IR_DEVICE_UUID かつ hub3 が存在するとき addRemote に irType=Number(IR_TYPE)||DEFAULT_IR_TYPE, irOperation=IR_OPERATION||'learnEmit', alias=keysFile?.alias||null, keys=keysFile?.keys||{} を渡す。remoteName は keysFile?.alias||'default'、対象 hub3 は cfg.hub3s の先頭キー
- ref: packages/kit/src/cli/migrate.js:84; packages/kit/src/cli/migrate.js:85; packages/kit/src/cli/migrate.js:81; packages/kit/src/cli/migrate.js:79
- kind: option-branch
- status: covered
- note: subarea=migrate command。AUTHC-0032 は HUB3_DEVICE_ID→addHub3 と IR_DEVICE_UUID→addRemote の存在のみで、irType/irOperation 既定値と keys.json 由来 alias/keys のマージ、remoteName/hub3 先頭キー解決は未被覆。AUTHC-0032 の補強。DEFAULT_IR_TYPE は @sesame-kit/core/crypto (crypto.js:274 = IR_TYPE.learn = 0xFE00)。refs 全件 (migrate.js:84/85/81/79) 実在・主張支持を確認。

### [AUTHC-0050] --debug 時に全コマンド(認証含む)のエラー stack を stderr へ出すグローバル診断境界
- surface: cli
- backend: local
- command: `sesame --debug <any>`
- branch: --debug | 非 --debug
- assert: run() の最終 catch は program.opts().debug が真のとき e.stack を console.error する。--debug 無しでは stack を出さず die(withStaleHint(err), runtimeExitCode(err)) のメッセージのみ。これは login/verify/setup/bootstrap 等の認証コマンドを含む全経路に効くグローバル可観測性境界 (--debug は ctx.js の withHub 経由で hub の debug にも伝播)
- ref: packages/kit/src/cli.js:270; packages/kit/src/cli.js:280; packages/kit/src/cli/ctx.js:127
- kind: error-path
- status: covered
- note: subarea=errors contract。refs 健全 (cli.js:270 = if(program.opts().debug) console.error(e.stack); cli.js:280 = die(withStaleHint(err),runtimeExitCode(err)); ctx.js:127 = debug: !!opts.debug を withHub が SesameHub3 へ渡す)。既存 AUTHC-0040(終了コード 0/1/2)・AUTHC-0041(--json {error,code} 封筒)は --debug の stack 出力境界を被覆していない=真に新規。AUTHC-0041 の補強でも可。

### [AUTHC-0051] config show は config 不在でも exit 0 で notInitialized/notSignedIn を返す (withHub の exit 2 との対比)
- surface: cli
- backend: local
- command: `sesame config show` / `sesame config`
- branch: config 在 | config 不在 | tokens 無し
- assert: cmdConfigShow は configStore.exists() が偽なら cfg=null とし die せず、人間向けは notInitialized/notSignedIn を、--json は {configDir, config:null, tokens:null} を exit 0 で出す。loadCtx のみでパス解決し configStore.load を強制しない読み取り専用コマンドのため、config 不在でも withHub の noConfigRun(exit 2) と異なり usage エラーにしない
- ref: packages/kit/src/cli/config-cmd.js:62; packages/kit/src/cli/config-cmd.js:79; packages/kit/src/cli/config-cmd.js:81; packages/kit/src/cli/ctx.js:120
- kind: surface-parity
- status: covered
- note: subarea=config command。refs 健全 (config-cmd.js:62 = const cfg = configStore.exists() ? configStore.load() : null; :79 = cfgRedacted ? ... : t('cli.notInitialized'); :81 = tokensMasked ? ... : t('cli.notSignedIn'); ctx.js:120 = withHub の if(!configStore.exists()) die(...,2) ブロック先頭)。既存 AUTHC-0027(config/show 等価)・0028/0029(redaction)は config 在前提で、config 不在時 exit 0 の境界は未被覆=真に新規。AUTHC-0027 の補強でも可。

### [AUTHC-0052] bootstrapAfterLogin の remotes ステップは syncRemoteKeys 個別失敗を内側空 catch で握り潰し summary.errors に残さない
- surface: cli
- backend: cloud
- command: bootstrapAfterLogin / hub.syncRemoteKeys
- branch: syncRemoteKeys 成功 | syncRemoteKeys 失敗(握り潰し)
- assert: syncRemotesFromDevices 後、added/updated 各 name の hub.syncRemoteKeys を for ループで呼ぶが各呼び出しを独立 try{}catch{}(空 catch)で囲み、個別失敗は summary.errors に積まず remotes ステップ全体 (外側 try/catch) も潰さない。外側 remotes: catch とは別レイヤの二重 best-effort=部分鍵同期失敗が summary.errors で観測されない設計境界
- ref: packages/kit/src/cli/auth.js:79; packages/kit/src/cli/auth.js:80; packages/kit/src/cli/auth.js:83
- kind: error-path
- status: covered
- note: subarea=bootstrapAfterLogin。refs 健全 (auth.js:79 = const {remotes} = await hub.syncRemotesFromDevices(); :80 = for(const name of [...remotes.added,...remotes.updated]){try{await hub.syncRemoteKeys(name);}catch{}}; :83 = 外側 catch errors.push(`remotes: ...`))。既存 AUTHC-0010 は syncRemoteKeys を best-effort で呼ぶ事実を assert するが、内側空 catch が summary.errors に痕跡を残さない (外側 4 catch=AUTHC-0011 とは別レイヤ) 点は未明示=真に新規。AUTHC-0010/0011 の補強でも可。
