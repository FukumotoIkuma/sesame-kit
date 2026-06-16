<!-- spec-domain: cli | prefix: CLI | tests: packages/kit/tests/cli, packages/kit/tests/prompts -->

# CLI 横断機構 spec (CLI)

コマンド非依存の CLI 機構(デバイス主語ルーティング/位置引数抽出/グローバルオプション/--json 封筒/終了コード契約/対話 prompt/help/ロケール解決/BLE エラー誘導/終了処理)を監査する。各コマンド固有の分岐はドメイン spec へ。

## CLI dispatch (デバイス主語ルーティング)

### [CLI-0001] routeDeviceArgv のデバイス主語振り分け (既知デバイス/有効 action のみ op へ・他は据え置き)
- surface: cli
- backend: local
- command: `routeDeviceArgv`
- branch: 引数なし+対話→session | 引数なし+--json→据え置き | device action 同伴→op | 既知デバイス→op | 未知単独トークン→据え置き | -h/--help→据え置き
- assert: 先頭が予約語でなく (有効 device action 同伴 or isKnownDevice 真) のときだけ argv を隠し op コマンドへ書き換え、未知単独トークンは据え置いて commander に未知コマンド+候補提示を出させる。引数なしは対話 (非 --json) で session、それ以外は据え置き
- ref: packages/kit/src/cli/dispatch.js:65-89; packages/kit/src/cli.js:245-251
- kind: option-branch
- status: covered
- note: 観点源: dispatch.test.js:46-85, arg-router.test.js:42-69 (未タグ→planned)。session の経路/解決は LOCK ドメイン、ここは argv 書き換え機構そのもの。-h/--help 早期 return は dispatch.js:67。

### [CLI-0002] routeDeviceArgv の argv 書換は不変参照保存 (非該当時は同一 argv を返し再パース副作用なし)
- surface: cli
- backend: local
- command: `routeDeviceArgv`
- branch: 書換あり (op/session) | 書換なし (同一参照)
- assert: ルーティング非該当 (予約コマンド/未知単独トークン/-h/--help/引数なし非対話) では受領 argv をそのまま (同一参照) 返し、該当時のみ新配列 [bin, sesame, op|session, ...] を生成する。commander parse へ渡る argv の不必要な再構築を避ける機構不変条件
- ref: packages/kit/src/cli/dispatch.js:65-89; packages/kit/src/cli.js:245-251
- kind: option-branch
- status: covered
- note: 確認済 dispatch.test.js が複数ケースで toBe(argv) (同一参照) を期待 (l51 既知管理コマンド/l68 未知トークン/l78 引数なし--json/l83 -h--help)。dispatch.js:67 return argv (-h/--help) / 78 return argv (引数なし非対話) / 88 return argv (非該当末尾) が据え置き経路、85 のみ [argv[0],argv[1],"op",...userArgs]、77 のみ [argv[0],argv[1],"session"] で新配列。[[CLI-0001]] は『どの分岐で op/session へ書換わるか』を assert するが、本エントリは逆の不変条件=非該当時の同一参照保存 (新配列を作らない) を機構として固定。

### [CLI-0003] extractPositionals が値オプション (--config-dir <path>) の値を位置引数と誤認しない
- surface: cli
- backend: local
- command: `routeDeviceArgv / extractPositionals`
- branch: 別トークン値 (--config-dir <path>) | --opt=value 同梱形 | ブール値オプション | -- 以降
- assert: extractPositionals が program.options を introspection し、required/optional な値オプションの直後トークンを読み飛ばす (--opt=value は後続を消費しない・-- 以降は全て位置引数) ため、グローバル値オプションの値がデバイス名へ誤ルートしない
- ref: packages/kit/src/cli/dispatch.js:17-37
- kind: option-branch
- status: covered
- note: 確認済 dispatch.js:31 if(eq===-1 && valueOpts.get(flag)===true) i++ で別トークン値スキップ、30 eq!==-1 (--opt=value) は flag のみ判定し i++ せず後続非消費、27 -- 以降全位置引数。観点源: tests/cli/dispatch.test.js:22-35 (extractPositionals 純ロジック, 未タグ→planned), arg-router.test.js:31-35 (実バイナリ --config-dir 前置回帰)。AUTH の serve framing dispatch (daemon.dispatchMessage) とは別機構 (こちらは CLI argv 解析)。

### [CLI-0004] 値オプション集合は commander Option introspection 由来 (ハードコード非依存・将来オプション追従)
- surface: cli
- backend: local
- command: `extractPositionals / program.options`
- branch: o.required | o.optional → takesValue | bool option
- assert: 値スキップ対象の valueOpts Map は program.options の各 Option の .required||.optional から動的構築され、long/short 両名が登録される。値リストをハードコードせず、新しい値オプション追加時も追従する (機構=registry-derived, no-drift)
- ref: packages/kit/src/cli/dispatch.js:18-23
- kind: contract-existence
- status: covered
- note: 確認済 dispatch.js:18 const valueOpts=new Map(); 19-23 for(o of program.options){takesValue=o.required||o.optional; o.long→valueOpts.set(o.long), o.short→valueOpts.set(o.short)}。LOCK-0088 は --config-dir 値の誤認回避という挙動分岐を assert。本エントリは『値オプション集合が commander Option 内省由来でハードコードでない』という機構不変条件 (no-drift) を分離。重複起票回避のため挙動分岐ではなく導出契約に限定。[[CLI-0003]] と相補。

### [CLI-0005] -- は option 走査終端・bare - は位置引数 (POSIX argv 機構不変条件)
- surface: cli
- backend: local
- command: `extractPositionals`
- branch: a === '--' | a === '-' | a.startsWith('-')
- assert: `--` 出現で以降を全て位置引数として push し走査終了、bare `-` (stdin 慣用) は a!=='-' ガードでオプション扱いされず位置引数になる。POSIX 引数解釈の終端/特例という機構レベル境界
- ref: packages/kit/src/cli/dispatch.js:27-28
- kind: option-branch
- status: covered
- note: 確認済 dispatch.js:27 if(a==="--"){positionals.push(...slice(i+1)); break} 終端、28 if(a.startsWith("-")&&a!=="-") で bare `-` 特例。LOCK-0088 の branch は --opt=value/--json bool/-- 区切りを列挙するが bare `-` は未 assert。本エントリは `--` 終端と bare `-` 特例の POSIX argv 機構不変条件に限定し device-name 誤認とは別境界。

### [CLI-0006] reservedCommandNames が登録コマンド名+エイリアス+暗黙 help を予約語に含める
- surface: cli
- backend: local
- command: `routeDeviceArgv / reservedCommandNames`
- branch: コマンド名 | エイリアス (watch) | commander 暗黙 help
- assert: reservedCommandNames が program.commands の name()+aliases() に加え commander 既定の 'help' を明示予約し、予約語先頭トークンを op へ誤誘導しない (sesame help <cmd> が op に回らない)
- ref: packages/kit/src/cli/dispatch.js:44-54
- kind: option-branch
- status: covered
- note: 確認済 dispatch.js:48 reserved.add("help") (l46-47 コメント: help は program.commands に現れないため明示 add が要), 49-52 name()+aliases()。観点源: dispatch.test.js:37-44 (init/watch エイリアス/help を has 検証, 未タグ→planned)。LOCK-0087 は予約語先頭の据え置き挙動を assert する一方、本エントリは予約集合の構成 (name+alias+暗黙help) を別境界として固定。

### [CLI-0007] 予約語集合は live registry 由来 + commander が program.commands に出さない help を明示合成
- surface: cli
- backend: local
- command: `reservedCommandNames / program.commands`
- branch: explicit 'help' | command name | alias
- assert: reserved set = ('help' 明示追加) ∪ program.commands の各 name() ∪ aliases()。commander 既定の help コマンドは program.commands に現れないため明示予約しないと `sesame help <cmd>` が op へ誤誘導される。予約語がコマンド登録に自動追従する機構不変条件
- ref: packages/kit/src/cli/dispatch.js:44-54
- kind: contract-existence
- status: covered
- note: 確認済 dispatch.js:48 reserved.add("help") (コメント: program.commands に現れないため明示予約)、49-52 for(c of program.commands){reserved.add(c.name()); for(a of c.aliases()) reserved.add(a)}。LOCK-0087 は予約コマンド/未知単独トークンの『据え置きルート挙動』を assert。本エントリは『予約集合が registry 由来 + 合成 help を含む』という機構の自己整合 (commander が出さない help を埋める no-drift 契約) を分離。重複回避のため route 結果でなく集合導出に限定。[[CLI-0006]] と相補。

### [CLI-0008] isKnownDevice は config 不在/破損で false を返し例外を握り潰す (ルーティング非破壊)
- surface: cli
- backend: local
- command: `isKnownDevice (run() ルーティング補助)`
- branch: config 不在 | 0件 | 既知名一致 | load 例外
- assert: isKnownDevice が configStore.exists() 偽/devices 0件/load 例外で false を返し (例外を catch で飲み込む)、config 破損時もデバイス主語ルーティングを壊さず未知コマンド扱いに委ねる
- ref: packages/kit/src/cli.js:92-104
- kind: option-branch
- status: covered
- note: 純ローカル判定。devices 全キー (Object.keys(cfg.devices), cli.js:98) を対象。exists()偽→false (cli.js:96)、0件→false (cli.js:99)、catch→false (cli.js:101-103)。

### [CLI-0009] --json の早期検出は bare flag 限定で setJsonMode/dispatch/commander parse の三者が同一トークンを見る
- surface: cli
- backend: local
- command: `run / routeDeviceArgv / setJsonMode`
- branch: argv.includes('--json')
- assert: commander parse 前に run() の setJsonMode(argv.includes('--json')) と routeDeviceArgv の isJson=userArgs.includes('--json') が同一の bare `--json` トークンで JSON 封筒/ルーティングを早期決定する。早期判定と commander 後段 parse の --json 認識が機構として一致する境界
- ref: packages/kit/src/cli.js:120; packages/kit/src/cli/dispatch.js:68
- kind: option-branch
- status: covered
- note: 確認済 cli.js:120 setJsonMode(argv.includes("--json")) (コメント: die/エラー経路用にグローバル --json を先に確定); dispatch.js:68 const isJson=userArgs.includes("--json")。両者 exact-match includes ゆえ bare flag 限定 (--json= 形は対象外)。LOCK-0089 は引数なし時の session/help 分岐で --json を branch 要素に使うが、--json 検出機構そのもの (parse 前の bare-flag includes が setJsonMode/dispatch で共通) は未 assert。機構レベルの早期 JSON 確定一致境界。

## 終了コード契約 (EXIT)

### [CLI-0010] EXIT 契約 (0/1/2) と commander usage コードの exit 2 への一律写像
- surface: cli
- backend: local
- command: `EXIT / commanderErrorInfo / isCommanderError`
- branch: unknownCommand | unknownOption | missingArgument | excessArguments | optionMissingArgument | 非 usage commander エラー (exitCode 尊重)
- assert: EXIT={OK:0,RUNTIME:1,USAGE:2} で、COMMANDER_USAGE_CODES 9 種は exit 2 に統一 (commander 既定 1 を上書き)、非 usage の commander エラーは exitCode を尊重し、メッセージ先頭 'error: ' を剥がす
- ref: packages/kit/src/cli/errors.js:17-33; packages/kit/src/cli/errors.js:60-87
- kind: error-path
- status: covered
- note: 観点源: errors.test.js:11-43 (未タグ→planned)。COMMANDER_USAGE_CODES は errors.js:23-33 で実数 9 種 (unknownCommand/unknownOption/missingArgument/optionMissingArgument/missingMandatoryOptionValue/mandatoryOptionMissing/excessArguments/invalidArgument/invalidOptionArgument)。AUTHC-0040 は認証コマンドの 0/1/2、AUTH-0113 は serve toServeError 写像。ここは commander usage→2 機構そのもの。

### [CLI-0011] runtimeExitCode が SesameError(BAD_REQUEST) を usage(2)・他を runtime(1) に写す
- surface: cli
- backend: local
- command: `runtimeExitCode`
- branch: BAD_REQUEST→2 | REJECTED/TIMEOUT/NOT_CONNECTED/UNAUTHENTICATED→1 | 明示 exitCode 尊重 | BAD_REQUEST+exitCode は USAGE 優先
- assert: runtimeExitCode が SesameError.code===BAD_REQUEST を EXIT.USAGE(2) に写し (serve の bad_params→exitCode=2 と対称)、他の SesameError/一般エラーは明示 exitCode を尊重しつつ無ければ 1。BAD_REQUEST チェックが明示 exitCode より優先
- ref: packages/kit/src/cli/errors.js:96-105; packages/core/src/errors.js:31-45
- kind: error-path
- status: covered
- note: 観点源: errors.test.js:45-68 (未タグ→planned)。BAD_REQUEST チェックは errors.js:99 で exitCode 抽出より前に return するため優先 (errors.test.js:64-68 が固定)。ERR.BAD_REQUEST='bad_request' は core/errors.js:35。BAD_REQUEST→2 の意味論写像は CLI/serve 横断の対称契約 (serve は AUTH-0113)。

## --json 封筒 (JSON envelope)

### [CLI-0012] die() の --json エラー封筒は stderr に {error,code}・成功 JSON は stdout 分離
- surface: cli
- backend: local
- command: `die / setJsonMode / isJsonMode / out`
- branch: --json (封筒) | 非 --json (人間 'Error: ')
- assert: setJsonMode(argv.includes('--json')) を parse 前に確定し、die() は --json 時 stderr へ {error,code} JSON・非 --json 時 'Error: <msg>' を出す。out() は --json で純 JSON を stdout、非 --json で humanFn。stdout はエラーで汚さない
- ref: packages/kit/src/cli/errors.js:37-53; packages/kit/src/cli/ctx.js:92-95; packages/kit/src/cli.js:120
- kind: error-path
- status: covered
- note: 観点源: json-contract.test.js:31-191 (未タグ→planned)。die は errors.js:49-53 (_jsonMode 分岐)、setJsonMode/isJsonMode は errors.js:37-41、out は ctx.js:92-95、先行確定は cli.js:120。program.opts() を取れない経路でも JSON 契約を守るため setJsonMode を先行確定。AUTHC-0041 は認証コマンド観点、これは die/out 機構そのもの。

### [CLI-0013] exitOverride 全コマンド伝播 + --json 時 commander writeErr 抑止
- surface: cli
- backend: local
- command: `run() propagateExitOverride / configureOutput`
- branch: --json (writeErr 抑止→die 封筒のみ) | 非 --json (commander 整形 stderr, 二重出力回避)
- assert: propagateExitOverride が program と全サブコマンドへ再帰的に exitOverride() を伝播し process.exit でなく throw させて run() の単一 catch に集約、かつ writeErr を --json 時抑止して commander 素のエラー文を出さず die() の JSON 封筒のみにする。非 --json は commander が usage 付き整形済みのため二重出力を避ける
- ref: packages/kit/src/cli.js:256-260; packages/kit/src/cli.js:274-279
- kind: error-path
- status: covered
- note: 観点源: json-contract.test.js:161-166 (未知オプション JSON 封筒, 未タグ→planned)。writeErr 抑止は cli.js:258 (if(!isJsonMode())…)、再帰伝播は cli.js:259、非 --json の二重出力回避は cli.js:276-277。commander usage エラーを JSON 契約に乗せる機構。

## help/version 終了境界

### [CLI-0014] help/version 表示は正常終了 (exit 0) でエラー経路に乗せない
- surface: cli
- backend: local
- command: `run() catch (commander.helpDisplayed/help/version)`
- branch: helpDisplayed | help | version → finishCli 後 return (exit 0)
- assert: run() の catch が commander.helpDisplayed/commander.help/commander.version を正常終了として扱い、die せず finishCli() 後に return する (commander が stdout に出力済みのため exit 0)
- ref: packages/kit/src/cli.js:266-269
- kind: error-path
- status: covered
- note: 観点源: json-contract.test.js:175-183 (--lang ja --help が exit 0, 未タグ→planned)。-V/-h/help [command] の終了境界。catch 内の早期 return は cli.js:267-268。

## BLE エラー誘導 (BLE error handler)

### [CLI-0015] maybeHandleBleError: BLE 環境エラー 5 種を exit 1 へ・封筒に bleCode 維持
- surface: cli
- backend: ble
- command: `maybeHandleBleError`
- branch: BLE_UNAUTHORIZED/UNSUPPORTED/POWERED_OFF/INIT_TIMEOUT/NO_ADAPTER→exit1 | BLE 以外→false (副作用ゼロ) | --json (封筒) | 非 --json (人間)
- assert: maybeHandleBleError が BLE 環境エラー 5 コードのみ true を返し setExitCode(EXIT.RUNTIME=1) する (usage 2 ではない=SURF-19)。--json 時 stderr へ {error,code:1,bleCode} を出し bleCode (機械可読分類) を維持、BLE 以外の code/コード無しは false で副作用ゼロ
- ref: packages/kit/src/cli/errors.js:126-160; packages/core/src/errors.js:40-45
- kind: error-path
- status: covered
- note: 検証済: errors.js:134-141 が 5 コードのみ通し他は早期 false、:145 が --json 封筒 {error,code:1,bleCode}、:158 setExitCode(EXIT.RUNTIME)。core/errors.js:40-44 が BLE_NO_ADAPTER..BLE_INIT_TIMEOUT 定義。SURF-19 は spec ID でなく errors.js 内部の終了コード契約マーカ (spec 横断 ref ではない)。観点源: tests/cli/errors.test.js:105-179 (SURF-19 describe, 未タグ→planned)。ACC-0071 は enroll の BLE 終了コード、これはグローバル BLE エラー handler 機構 (deps 注入 seam 含む)。

### [CLI-0016] maybeHandleBleError: macOS+BLE_UNAUTHORIZED で設定ペインを open (--json では開かない)
- surface: cli
- backend: ble
- command: `maybeHandleBleError (macOS 誘導)`
- branch: darwin+BLE_UNAUTHORIZED+非 --json (設定ペイン open+誘導文) | --json (open しない) | 非 darwin (open しない)
- assert: platform===darwin かつ BLE_UNAUTHORIZED かつ非 --json のときのみ spawn('open', ['x-apple.systempreferences:...Privacy_Bluetooth'], {detached}).unref() で設定ペインを開き誘導文を出す。--json では機械可読出力を汚さないため open しない
- ref: packages/kit/src/cli/errors.js:147-157
- kind: error-path
- status: covered
- note: 検証済: errors.js:147 のガードが !isJsonMode() && platform===darwin && code===BLE_UNAUTHORIZED、:150-152 spawn('open', Privacy_Bluetooth, {stdio:ignore,detached:true}).unref()、spawn 失敗時は :155 cli.bleEnablePrivacy にフォールバック。i18n キー cli.bleOpenedPrivacy/bleEnablePrivacy 実在 (i18n/cli.js:415-416,836-837)。観点源: tests/cli/errors.test.js:158-178 (未タグ→planned)。[[CLI-0015]] と同 handler の macOS 誘導分岐。

## stale hint (古い config 誘導)

### [CLI-0017] withStaleHint は stale っぽい平文エラーにのみ sync 導線を足し構造化エラーには付けない
- surface: cli
- backend: local
- command: `withStaleHint`
- branch: Unknown key/not found/...failed 平文→ヒント付与 | rpcError | data.kind | SesameError → 付けない | 無関係→そのまま
- assert: withStaleHint が Unknown key/sendIR failed/getIRCodes failed/triggerLock failed/not found/invalid device の平文メッセージにだけ cli.staleHint (sync 導線) を足し、rpcError マーカ/data.kind/型付き SesameError には付けない (Method not found を config 古いと誤誘導しない)
- ref: packages/kit/src/cli/errors.js:170-191; packages/kit/src/cli.js:280
- kind: error-path
- status: covered
- note: 検証済: errors.js:173-175 が rpcError/data.kind/SesameError を素通し、:182-188 の looksStale 正規表現 6 種、:190 で t('cli.staleHint',{msg}) を付与。staleHint メッセージ実体 (i18n/cli.js:417,838) に sesame remote sync-keys / locks sync-from-devices の導線あり。cli.js:280 が die(withStaleHint(err), runtimeExitCode(err)) で run() 最終 catch の表示機構。観点源: tests/cli/errors.test.js:71-96 (未タグ→planned)。

## 終了処理 (finishCli)

### [CLI-0018] finishCli: noble 使用時のみ明示 exit + stdout drain で出力取りこぼし防止
- surface: cli
- backend: ble
- command: `finishCli / bleWasUsed`
- branch: BLE 未使用→自然 exit (return) | BLE 使用+write('')真→即 process.exit | 偽→drain 後 exit
- assert: finishCli が bleWasUsed() 偽なら return し自然 exit に任せる (出力 truncate 回避)、真なら process.exitCode を保ったまま stdout.write('') で drain 確認後に process.exit する (noble の CoreBluetooth ハンドルが残り node が自然 exit しない問題への対処)
- ref: packages/kit/src/cli.js:290-295; packages/core/src/ble/transport.js:251-255
- kind: error-path
- status: covered
- note: 検証済: cli.js:291 が !bleWasUsed()→return、:293 write('') 真→即 process.exit(code)、偽→:294 drain 後 exit。transport.js:251-255 が _nobleLoaded フラグと export function bleWasUsed() (noble ロードでネイティブハンドル残留の機構説明コメント含む)。実 BLE ハンドル残留は実機依存だが bleWasUsed()/drain 分岐は純ロジックで検証可能。

## 対話 prompt

### [CLI-0019] isInteractive/canPrompt が TTY かつ --json 無しのときだけ対話を許可
- surface: cli
- backend: local
- command: `isInteractive / canPrompt`
- branch: TTY+非 --json→true | 非 TTY→false | --json→false
- assert: isInteractive() が stdin.isTTY && stdout.isTTY のみ真、canPrompt(program) が isInteractive() && !opts.json と同値で、非 TTY/パイプ/cron/--json では prompt 経路に入らず固まらない契約を支配する
- ref: packages/kit/src/prompts.js:12-14; packages/kit/src/cli/ctx.js:160-162
- kind: option-branch
- status: covered
- note: 検証済: prompts.js:12-14 が return Boolean(process.stdin.isTTY && process.stdout.isTTY)、ctx.js:160-162 が return isInteractive() && !program.opts().json。AUTHC-0035 は canPrompt を verify 観点で持つが (auth-cli.md:405)、ここは横断 prompt ゲート機構 (全 register モジュールが ctx.canPrompt 越しに依存)。

### [CLI-0020] selectFromList の auto-pick/空 throw/装飾剥がし契約
- surface: cli
- backend: local
- command: `selectFromList / promptText / confirm`
- branch: 空/非配列→throw | 要素1個→auto-pick (select 非呼出) | 複数→inquirer select 委譲
- assert: selectFromList が空/非配列で cli.noCandidates throw、要素1個は select を呼ばず即返し、複数のとき plainMessage で先頭装飾を剥がし {name:getLabel(it),value:it} の choices と pageSize:12/loop:false を inquirer select へ渡す
- ref: packages/kit/src/prompts.js:21-23; packages/kit/src/prompts.js:56-68
- kind: option-branch
- status: covered
- note: prompts.js:21-23 が plainMessage (先頭 [?> ] 剥がし)、:56-68 が selectFromList (:57-59 空/非配列→noCandidates throw、:60 要素1個 auto-pick、:62-67 choices {name:getLabel,value} + pageSize:12/loop:false で select 委譲)。i18n キー cli.noCandidates 実在 (i18n/cli.js:421,842)。観点源: packages/kit/tests/prompts/selectFromList.test.js (未タグ→planned, throw/auto-pick/choices/plainMessage を検証; pageSize/loop はソースで確認)。対話 UI ヘルパの不変条件 (inquirer 委譲後も公開 API 据え置き)。

### [CLI-0021] promptLine が Ctrl-D (EOF) 空入力で throw し無限ループを防ぐ
- surface: cli
- backend: local
- command: `promptLine`
- branch: 通常入力→trim 返却 | EOF+空入力→throw
- assert: promptLine の EOF→throw cli.promptAbortedEof 境界は [[AUTHC-0036]] が正典 (cross-ref)。
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[AUTHC-0036]]）
- note: promptLine EOF→throw 境界の正典は auth-cli.md [[AUTHC-0036]]。当エントリは重複のため waive (ID 保持)。

## config redaction (秘匿値マスク)

### [CLI-0022] redactConfig が secretKey をツリー全体で再帰マスクする (横断機構)
- surface: cli
- backend: local
- command: `redactConfig / mask`
- branch: secretKey 文字列→mask | ネスト走査 (devices/locks 双方) | 非破壊 clone
- assert: redactConfig が structuredClone 後に walk で全ノードの secretKey (string) を mask() で潰し (devices と派生 locks の複数箇所)、生 32hex 鍵を残さず元 cfg を破壊しない。生鍵露出は sesame devices のみ
- ref: packages/kit/src/cli/ctx.js:74-85; packages/kit/src/cli/ctx.js:61-65; packages/kit/tests/cli/config-redact.test.js:20-49
- kind: payload-fidelity
- status: covered
- note: 観点源: packages/kit/tests/cli/config-redact.test.js:20-49 (未タグ→planned)。ctx.js:74=export function redactConfig (structuredClone+walk), :80=secretKey→mask(), :61=mask() 本体。AUTHC-0028 (auth-cli.md:322) が同一 redactConfig (ctx.js:74/80) を `sesame config show` コマンド観点 (payload-fidelity) で既出のため重複懸念ありレビュー要。本 spec は再帰 walk 純機構 (構造非依存の全ツリー secretKey 潰し) として起票。

## i18n (ロケール/カタログ)

### [CLI-0023] kit カタログ完全性: cli/serve/session の en==ja キー集合・area 間重複ゼロ・{var} 一致
- surface: cli, serve
- backend: local
- command: `kit i18n catalog (cli.js/serve.js/session.js)`
- branch: en/ja キー集合一致 | area 間キー重複ゼロ | en/ja {var} プレースホルダ一致
- assert: kit cli/serve/session カタログの en==ja キー集合・area 間重複ゼロ・{var} 一致の 3 不変条件は [[I18N-0002]] / [[I18N-0004]] / [[I18N-0007]] が正典 (cross-ref)。
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0002]]）
- note: kit カタログ完全性の正典は i18n.md [[I18N-0002]] (en==ja キー集合) / [[I18N-0004]] (area 間重複ゼロ) / [[I18N-0007]] ({var} 一致)。当エントリは 3 不変条件束ねの重複のため waive (ID 保持)。

### [CLI-0024] kit src の t("...") リテラルが全て kit+core マージカタログに存在する
- surface: cli, serve
- backend: local
- command: `kit i18n t() リテラル網羅`
- branch: -
- assert: kit/src 配下の t("key") リテラルが kit+core マージカタログに全存在する境界は [[I18N-0009]] が正典 (cross-ref)。
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0009]]）
- note: kit src t() リテラル網羅の正典は i18n.md [[I18N-0009]] (補完 [[I18N-0010]] が引数付き走査ギャップ)。当エントリは重複のため waive (ID 保持)。

### [CLI-0025] registerCatalog が既存キー重複で TypeError を投げ誤登録を早期検出する
- surface: cli, serve
- backend: local
- command: `registerCatalog`
- branch: 新規キー→Object.assign | 既存キー重複→TypeError
- assert: registerCatalog の既存キー重複→TypeError・新規→Object.assign 境界は [[I18N-0011]] が正典 (cross-ref)。
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0011]]）
- note: registerCatalog 重複検出の正典は i18n.md [[I18N-0011]] (ja 欠落 area 非エラーまで branch 網羅)。登録タイミングは [[I18N-0012]]。当エントリは重複のため waive (ID 保持)。

### [CLI-0026] CLI ロケール確定: --lang>config.uiLang>en を commander 登録前に setLocale
- surface: cli
- backend: local
- command: `run() locale 確定 / resolveLocale / setLocale`
- branch: --lang フラグ (--lang x / --lang=x) | config.uiLang | 既定 en | 登録前 setLocale 順序
- assert: resolveLocale 優先順位 (flag>configLang>en) は [[I18N-0015]]、登録前 setLocale 起動シーケンスは [[I18N-0012]] が正典 (cross-ref)。
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0015]]）
- note: resolveLocale 優先順位の正典は i18n.md [[I18N-0015]]、登録前 setLocale 順序は [[I18N-0012]]。当エントリは重複のため waive (ID 保持)。

### [CLI-0027] 未知 --lang は警告のみで続行し init 焼き込み対象から除外 (isKnownLang ゲート)
- surface: cli
- backend: local
- command: `run() / isKnownLang / CLI_LANG_FLAG`
- branch: 未知 --lang→cli.unknownLang 警告+続行+焼き込み除外 | 既知 --lang→locale+CLI_LANG_FLAG セット | 未指定→null
- assert: isKnownLang ゲート (未知 --lang→警告続行・既知のみ CLI_LANG_FLAG) 境界は [[I18N-0015]] が正典 (cross-ref)。
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0015]]）
- note: isKnownLang ゲート/CLI_LANG_FLAG の正典は i18n.md [[I18N-0015]] (CLI_LANG_FLAG init 焼き込み除外は auth-cli.md [[AUTHC-0046]])。当エントリは重複のため waive (ID 保持)。

## 監査追補 v2 (dual-audit)

### [CLI-0028] ctx.parseJson 横断ヘルパの --json パース失敗→die(invalidJsonValue[+invalidJsonExample],2)+undefined 契約
- surface: cli
- backend: local
- command: `makeCtx().parseJson`
- branch: valid JSON→parse 値返却 | invalid JSON→die(invalidJsonValue,2)+undefined | hint 有→invalidJsonExample 付与 | hint 無→example 無し
- assert: makeCtx().parseJson(raw, hint) は JSON.parse 成功時に値を返し、失敗時に die(t('cli.invalidJsonValue',{message}) + (hint ? t('cli.invalidJsonExample',{hint}) : ''), 2) で usage(2) 終了し undefined を返す。org/access/iot/ble の --json 引数パースが共有する横断 helper の終了コード/二段メッセージ契約
- ref: packages/kit/src/cli/ctx.js:237-244; packages/kit/src/i18n/cli.js:6-7; packages/kit/src/i18n/cli.js:427-428
- kind: error-path
- status: covered
- note: 両監査一致 (consensus)。各ドメインは自コマンドの parseJson 利用を note 言及/stub するのみ ([[CLI-0012]] は die/out --json 封筒の出力側を被覆) で、ctx.parseJson の終了コード(2)+二段メッセージ(invalidJsonValue (+hint 時 invalidJsonExample))+undefined 返却という共有 framework 契約は未 assert。CLI 横断ドメインが正典。

### [CLI-0029] run() 最終 catch のエラー分類ディスパッチ順序 (help/version→debug→BLE→commander→generic)
- surface: cli
- backend: local, ble
- command: `run() catch dispatch ordering`
- branch: helpDisplayed/help/version→finishCli+return(exit0) | debug→e.stack | maybeHandleBleError 真→finishCli+return | isCommanderError→commanderErrorInfo | それ以外→die(withStaleHint,runtimeExitCode)
- assert: run() の単一 catch がエラーを固定優先順で分類する: (1) commander.helpDisplayed/help/version は exit0 で短絡、(2) opts().debug 時 e.stack 出力、(3) maybeHandleBleError(err) 真なら finishCli 後 return (BLE 環境エラーは commander/generic 分類より前に処理し stale-hint を付けない)、(4) isCommanderError なら commanderErrorInfo 経路、(5) それ以外のみ die(withStaleHint(err), runtimeExitCode(err))。この順序により commander usage エラーは withStaleHint/runtimeExitCode に到達せず、BLE エラーは commanderErrorInfo に誤分類されない
- ref: packages/kit/src/cli.js:264-281
- kind: error-path
- status: covered
- note: onlyA。relatedSpecId [[CLI-0013]]/[[CLI-0014]]/[[CLI-0015]]。個別ハンドラの存在は被覆あり ([[CLI-0014]] help/version exit0、[[CLI-0015]]/[[CLI-0016]] maybeHandleBleError 本体、[[CLI-0013]] exitOverride/writeErr) だが、run() catch の『分類ディスパッチ順序』(BLE が commander より前・commander が generic stale-hint より前) という機構不変条件は未固定。BLE エラーが isCommanderError 判定や die(withStaleHint) に落ちないこと、commander usage エラーが runtimeExitCode に到達しないことを機構として固定する境界。
