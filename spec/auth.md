<!-- spec-domain: auth | prefix: AUTH | tests: packages/core/tests/auth, packages/core/tests/aws-credentials, packages/core/tests/tokens, packages/core/tests/account, packages/kit/tests/serve -->

# 認証 / トークン / 資格情報 wire spec (AUTH)

Android アプリ方式(AWSMobileClient 2.77.0: CUSTOM_AUTH + device SRP + ConfirmDevice)の wire 忠実度、トークン更新/失効、Identity Pool 資格情報・SigV4、および account/serve/sdk の面横断を監査する。CLI 認証コマンドの分岐は auth-cli.md(AUTHC)、暗号プリミティブの KAT は crypto.md(CRY)へ。

## signUp 先行

### [AUTH-0001] loginInitiate が CUSTOM_AUTH の前に SignUp(dummypwk) を必ず送る
- surface: core, cli
- backend: cloud
- command: loginInitiate / `sesame login <email>`
- branch: 新規ユーザー (SignUp 成功)
- assert: InitiateAuth より前に SignUp が呼ばれ、Password="dummypwk"・UserAttributes=[{Name:"email",Value:username}] の形が LoginMailFG.kt の signUp("mail","dummypwk",...) と一致する
- ref: packages/core/src/auth.js:323-341; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:106-112; _aws_sdk_ref/AWSMobileClient.java:2184-2192
- kind: wire-fidelity
- status: covered
- note: DUMMY_PASSWORD=app方式("dummypwk")。web の Aa123456 は規範2で禁止。auth.js:323-341=SignUp try ブロック(:327 Password=DUMMY_PASSWORD, :328 UserAttributes email)で InitiateAuth(:354) より前。Kt:106-112=signUp("...","dummypwk",attrs,mapOf(),...) 呼出(:109)。AWSMobileClient:2184-2192=4引数 signUp→_signUp(...,Collections.emptyMap(),...)。

### [AUTH-0002] SignUp に ValidationData:[] と ClientMetadata:{} を空のまま書き出す
- surface: core
- backend: cloud
- command: loginInitiate / SignUp
- branch: -
- assert: SignUp ペイロードが ValidationData:[]・ClientMetadata:{} を含む。アプリは 4 引数 signUp で validationData=空Map / clientMetadata=emptyMap() を渡し、marshaller が != null チェックのみで空でも書き出すのと一致する
- ref: packages/core/src/auth.js:337-340; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:109; _aws_sdk_ref/AWSMobileClient.java:2184-2192; _aws_sdk_ref/SignUpRequestMarshaller.java:95-106; _aws_sdk_ref/SignUpRequestMarshaller.java:119-137
- kind: wire-fidelity
- status: covered
- note: SignUpRequestMarshaller.java:95-106 は ValidationData の != null のみチェック(size>0 なし)→空 List で ValidationData:[] を裏付ける。ClientMetadata は :119-137(:119 if(getClientMetadata()!=null), :122 beginObject→空 Map でも {} を書く)。auth.js:337-340・LoginMailFG.kt:109(mapOf() 第4引数)・AWSMobileClient:2184-2192(emptyMap())。

### [AUTH-0003] 既存ユーザーの UsernameExistsException を容認して InitiateAuth へ進む
- surface: core, cli
- backend: cloud
- command: loginInitiate / `sesame login <email>`
- branch: UsernameExists
- assert: SignUp が UsernameExistsException を返したとき例外を握り潰して CUSTOM_AUTH InitiateAuth に進む (アプリ goSignIIn 分岐と一致)
- ref: packages/core/src/auth.js:342-344; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:114-118
- kind: error-path
- status: covered
- note: auth.js:342-344=catch(e){ if(asErr(e).name!=="UsernameExistsException") throw e; } で UsernameExists のみ握り潰し→以降の InitiateAuth に進む。Kt:114-118=onError 内 if(exception is UsernameExistsException){ goSignIIn(...); return }で signIn へ進む。

### [AUTH-0004] UsernameExists 以外の SignUp エラーは中断し伝播する
- surface: core, cli
- backend: cloud
- command: loginInitiate / `sesame login <email>`
- branch: 非 UsernameExists の SignUp 失敗
- assert: InvalidPasswordException 等 UsernameExists 以外の SignUp エラーで loginInitiate が throw し InitiateAuth に進まない (アプリは Toast 表示で中断)
- ref: packages/core/src/auth.js:342-344; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:119-126
- kind: error-path
- status: covered
- note: auth.js:342-344=catch で name!=="UsernameExistsException" のとき throw e(再送出)→ InitiateAuth に到達しない。Kt:119-126=onError 内 UsernameExists でない経路(:123 Toast で中断)。goSignIIn を呼ばないため signIn に進まない。

## InitiateAuth CUSTOM_AUTH

### [AUTH-0005] InitiateAuth が AuthFlow=CUSTOM_AUTH + AuthParameters{USERNAME,CHALLENGE_NAME:SRP_A,SRP_A} を送る
- surface: core, cli
- backend: cloud
- command: loginInitiate / InitiateAuth
- branch: -
- assert: InitiateAuth の AuthParameters キー集合が {USERNAME, CHALLENGE_NAME:"SRP_A", SRP_A} で、CHALLENGE_NAME="SRP_A" は AuthenticationDetails 4引数ctor の setCustomChallenge("SRP_A")、SRP_A=A.toString(16) は initiateCustomAuthRequest の注入と一致する
- ref: packages/core/src/auth.js:354-369; _aws_sdk_ref/AuthenticationDetails.java:67-80; _aws_sdk_ref/AuthenticationDetails.java:175-184; _aws_sdk_ref/CognitoUser.java:3492-3494; _aws_sdk_ref/AWSMobileClient.java:1320-1322
- kind: wire-fidelity
- status: covered
- note: auth.js:354-369=InitiateAuth(:355 AuthFlow:"CUSTOM_AUTH", :357-361 AuthParameters{USERNAME, CHALLENGE_NAME:"SRP_A", SRP_A:A.toString(16)})。AuthenticationDetails.java:67-80=4引数ctor で setAuthenticationParameter(USERNAME)(:74) + setCustomChallenge(AUTH_PARAM_SRP_A)(:75)。:175-184=setCustomChallenge が put(CHALLENGE_NAME, customChallenge)。CognitoUser.java:3492-3494=AUTH_PARAM_SRP_A.equals(getCustomChallenge())→put(SRP_A, helper.getA().toString(16))。AWSMobileClient.java:1320-1322=password!=null→4引数 AuthenticationDetails ctor 選択。

### [AUTH-0006] SRP_A は A=g^a mod N の 16進文字列で、A≠0 を保証する
- surface: core
- backend: cloud
- command: loginInitiate / generateEphemeralA
- branch: -
- assert: SRP_A の値が generateEphemeralA() の A=g^a mod N を .toString(16) した hex で、A%N!=0 のリトライループ・3072bit group(N/G=2)が AuthenticationHelper(EPHEMERAL_KEY_LENGTH=1024, A=GG.modPow(a,N) while A.mod(N)==0) と同型である
- ref: packages/core/src/device-srp.js:158-165; packages/core/src/auth.js:352; _aws_sdk_ref/CognitoUser.java:3984-3988; _aws_sdk_ref/CognitoUser.java:4025
- kind: crypto-vector
- status: covered
- note: generateEphemeralA do{a=randomBytes%N;A=modPow(G,a,N)}while(A%N===0n) (device-srp.js:158-165) / const {a,A}=generateEphemeralA() (auth.js:352) / AuthenticationHelper ctor do{...}while(A.mod(N)==ZERO) (CognitoUser.java:3984-3988) / EPHEMERAL_KEY_LENGTH=1024 (:4025)。A.toString(16) は auth.js:360。

### [AUTH-0007] InitiateAuth(CUSTOM_AUTH) には DEVICE_KEY を入れない
- surface: core
- backend: cloud
- command: loginInitiate / InitiateAuth
- branch: 保存済み deviceKey あり
- assert: store に同一 username の deviceKey が保存済みでも InitiateAuth の AuthParameters に DEVICE_KEY を含めない (initiateCustomAuthRequest は DEVICE_KEY を注入しない)
- ref: packages/core/src/auth.js:354-369; _aws_sdk_ref/CognitoUser.java:3473-3507
- kind: wire-fidelity
- status: covered
- note: DEVICE_KEY は initiate ではなくチャレンジ回答(PASSWORD_VERIFIER / CUSTOM_CHALLENGE)に乗る。auth.js:354-369 の AuthParameters は USERNAME/CHALLENGE_NAME/SRP_A のみ。initiateCustomAuthRequest (CognitoUser.java:3473-3507) は SECRET_HASH(条件付)と SRP_A のみ put し DEVICE_KEY は注入しない。

### [AUTH-0008] InitiateAuth に ClientMetadata:{} を空のまま書き出す
- surface: core
- backend: cloud
- command: loginInitiate / InitiateAuth
- branch: -
- assert: InitiateAuth ペイロードが ClientMetadata:{} を含む。アプリは clientMetadata=emptyMap() を setClientMetadata し marshaller が != null チェックのみ(isEmpty ガード無し)で空 Map でも {} を書くのと一致する
- ref: packages/core/src/auth.js:362-368; _aws_sdk_ref/CognitoUser.java:3480; _aws_sdk_ref/InitiateAuthRequestMarshaller.java:85-99
- kind: wire-fidelity
- status: covered
- note: auth.js:368 ClientMetadata:{} (コメント 362-367)。CognitoUser.java:3480 authRequest.setClientMetadata(clientMetadata)。InitiateAuthRequestMarshaller.java:85-99 は getClientMetadata()!=null の外側ガードのみで、isEmpty チェック無し→空 Map でも {} を出力。

### [AUTH-0009] CUSTOM_CHALLENGE 直行応答を pending に保存して返す
- surface: core
- backend: cloud
- command: loginInitiate / InitiateAuth
- branch: 応答 ChallengeName=CUSTOM_CHALLENGE
- assert: InitiateAuth 応答が CUSTOM_CHALLENGE のとき Session・usernameInternal(ChallengeParameters.USERNAME) を pending に保存し {challenge,params} を返す。usernameInternal の取り出しは updateInternalUsername と一致する
- ref: packages/core/src/auth.js:436-452; _aws_sdk_ref/CognitoUser.java:3948-3962; _aws_sdk_ref/CognitoUser.java:3124
- kind: wire-fidelity
- status: covered
- note: auth.js:444 usernameInternal=resp.ChallengeParameters?.USERNAME / 445-451 savePending(clientId,username,usernameInternal,session,initiatedAt) / 452 return {challenge,params}。updateInternalUsername (CognitoUser.java:3948-3962) は challengeParameters.get(CHLG_PARAM_USERNAME) を usernameInternal に格納→キー一致。:3124 は handleChallenge 経路で updateInternalUsername を呼ぶ。

### [AUTH-0010] 想定外チャレンジ(CUSTOM_CHALLENGE/PASSWORD_VERIFIER 以外)は throw する
- surface: core
- backend: cloud
- command: loginInitiate / InitiateAuth
- branch: 応答 ChallengeName が想定外
- assert: InitiateAuth が CUSTOM_CHALLENGE でも PASSWORD_VERIFIER でもないチャレンジ名を返したとき内部不変条件違反として throw する
- ref: packages/core/src/auth.js:436-439
- kind: error-path
- status: covered
- note: auth.js:436-439 if(resp.ChallengeName!=="CUSTOM_CHALLENGE") throw。PASSWORD_VERIFIER は手前の 373 ブランチで処理し return 済みのため、436 到達時は CUSTOM_CHALLENGE 以外=PASSWORD_VERIFIER 以外。

## PASSWORD_VERIFIER 連鎖

### [AUTH-0011] InitiateAuth→PASSWORD_VERIFIER 応答に user SRP で RespondToAuthChallenge する
- surface: core
- backend: cloud
- command: loginInitiate / respondToPasswordVerifier
- branch: 応答 ChallengeName=PASSWORD_VERIFIER
- assert: PASSWORD_VERIFIER 応答に対し RespondToAuthChallenge(ChallengeName:PASSWORD_VERIFIER) を送り、3コール連鎖 InitiateAuth→RespondToAuthChallenge(PV)→CUSTOM_CHALLENGE が userSrpAuthRequest 分岐 (startWithCustomAuth) と一致する
- ref: packages/core/src/auth.js:371-434; _aws_sdk_ref/CognitoUser.java:3057-3071
- kind: wire-fidelity
- status: covered
- note: auth.js:373 if(resp.ChallengeName==="PASSWORD_VERIFIER") ブロック(373-434)で respondToPasswordVerifier(ChallengeName:PASSWORD_VERIFIER, auth.js:539) を送り、415 で次が CUSTOM_CHALLENGE であることを検証。CognitoUser.java:3057-3071 は startWithCustomAuth 内で CHLG_TYPE_USER_PASSWORD_VERIFIER のとき userSrpAuthRequest→respondToChallenge を実行する 3コール連鎖と同型。

### [AUTH-0012] PASSWORD_VERIFIER の ChallengeResponses キー集合と PASSWORD_CLAIM_SIGNATURE 形
- surface: core
- backend: cloud
- command: respondToPasswordVerifier / RespondToAuthChallenge
- branch: deviceKey 無し
- assert: ChallengeResponses が {PASSWORD_CLAIM_SECRET_BLOCK, PASSWORD_CLAIM_SIGNATURE, TIMESTAMP, USERNAME} を含み、署名 HMAC-SHA256(hkdf, poolName|userIdForSRP|SECRET_BLOCK(base64 decode)|timestamp) が userSrpAuthRequest と一致する
- ref: packages/core/src/auth.js:504-543; _aws_sdk_ref/CognitoUser.java:3618-3646
- kind: wire-fidelity
- status: covered
- note: Java は SECRET_HASH も put するが clientSecret=null のため値 null → marshaller がスキップで kit と一致。auth.js:504-512 HMAC(hkdf).update(poolName).update(userIdForSRP).update(base64 decode SECRET_BLOCK).update(timestamp) / 520-530 responses={...,USERNAME,(DEVICE_KEY 条件付)} / 537-543 cognitoCall。CognitoUser.java:3618-3633 同連結、3638-3646 同キー集合。

### [AUTH-0013] PASSWORD_VERIFIER の USERNAME は usernameInternal(ChallengeParameters.USERNAME) を使う
- surface: core
- backend: cloud
- command: respondToPasswordVerifier / RespondToAuthChallenge
- branch: pool が email→UUID 写像する
- assert: ChallengeResponses.USERNAME が ChallengeParameters.USERNAME(=usernameInternal/UUID) と一致する。写像が無い場合は USER_ID_FOR_SRP にフォールバックする
- ref: packages/core/src/auth.js:514-518; _aws_sdk_ref/CognitoUser.java:3594-3600; _aws_sdk_ref/CognitoUser.java:3644
- kind: wire-fidelity
- status: covered
- note: auth.js:518 usernameForResponse=usernameInternal||userIdForSRP / CognitoUser.java:3594-3598 が USERNAME・USER_ID_FOR_SRP を読み取り 3600 で usernameInternal=userId、3644 で put(CHLG_RESP_USERNAME, usernameInternal)。

### [AUTH-0014] PASSWORD_VERIFIER 応答への DEVICE_KEY 付与条件
- surface: core
- backend: cloud
- command: respondToPasswordVerifier / RespondToAuthChallenge
- branch: 保存済み deviceKey 一致 | 初回(空) | username 不一致
- assert: store に同一 username(または usernameInternal)の deviceKey がある時のみ ChallengeResponses に DEVICE_KEY を付与し、無い/別 username なら付与しない。Java は usernameInternal で CognitoDeviceHelper.getDeviceKey して srpAuthResponses に put、null なら marshaller がキーを省く挙動と一致する
- ref: packages/core/src/auth.js:387-411; packages/core/src/auth.js:527-529; _aws_sdk_ref/CognitoUser.java:3601-3602; _aws_sdk_ref/CognitoUser.java:3645; _aws_sdk_ref/RespondToAuthChallengeRequestMarshaller.java:81-95
- kind: wire-fidelity
- status: covered
- note: auth.js:387-411 で existingForPv を store.load() し pvLookupName(usernameInternal||username) 一致時のみ pvDeviceKey 決定、527-529 で deviceKey 真値時のみ DEVICE_KEY を付与。CognitoUser.java:3601 getDeviceKey(usernameInternal,...)、3645 put(CHLG_RESP_DEVICE_KEY, deviceKey)、Marshaller.java:89 の value!=null ガードで null 値キーを省く。

### [AUTH-0015] PASSWORD_VERIFIER 応答に ClientMetadata:{} を含める
- surface: core
- backend: cloud
- command: respondToPasswordVerifier / RespondToAuthChallenge
- branch: -
- assert: RespondToAuthChallenge(PASSWORD_VERIFIER) が ClientMetadata:{} を含む。Java userSrpAuthRequest は setClientMetadata(空Map) し marshaller が isEmpty ガード無しで {} を書くのと一致する
- ref: packages/core/src/auth.js:532-543; _aws_sdk_ref/CognitoUser.java:3653; _aws_sdk_ref/RespondToAuthChallengeRequestMarshaller.java:110-124
- kind: wire-fidelity
- status: covered
- note: CUSTOM_CHALLENGE 応答との非対称(後述 AUTH-0062)に注意。auth.js:542 ClientMetadata:{} を常に付与。CognitoUser.java:3653 setClientMetadata は PV パスで空 Map。Marshaller.java:110-124 は getClientMetadata()!=null ガードのみで isEmpty 判定が無く {} を書く。

### [AUTH-0016] PASSWORD_VERIFIER の後に CUSTOM_CHALLENGE 以外が来たら throw する
- surface: core
- backend: cloud
- command: loginInitiate / RespondToAuthChallenge
- branch: PV 応答後 ChallengeName!=CUSTOM_CHALLENGE
- assert: RespondToAuthChallenge(PV) の応答が CUSTOM_CHALLENGE でない場合に内部不変条件違反として throw する (handleChallenge は PV を再度返さない=respondToChallenge に進む前提)
- ref: packages/core/src/auth.js:413-419; _aws_sdk_ref/CognitoUser.java:3071
- kind: error-path
- status: covered
- note: auth.js:415-418 で verifierResp.ChallengeName!=='CUSTOM_CHALLENGE' 時に throw。CognitoUser.java:3071 startWithCustomAuth が PV 直後に respondToChallenge を呼び handleChallenge に進む=PV 後は次チャレンジ(CUSTOM_CHALLENGE)が期待される前提。

## CUSTOM_CHALLENGE 回答

### [AUTH-0017] loginVerify が RespondToAuthChallenge(CUSTOM_CHALLENGE) を ANSWER 形で送る
- surface: core, cli
- backend: cloud
- command: loginVerify / `sesame verify <code>`
- branch: -
- assert: ChallengeResponses のキー集合が {USERNAME, ANSWER}(条件付き DEVICE_KEY)で、ANSWER=email コード・ChallengeName=CUSTOM_CHALLENGE・Session=pending.session が ChallengeContinuation continueTask の汎用チャレンジ回答形と一致する
- ref: packages/core/src/auth.js:574-587; _aws_sdk_ref/ChallengeContinuation.java:160-167; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginVerifiCodeFG.kt:65-95
- kind: wire-fidelity
- status: covered
- note: LoginVerifiCodeFG.kt は confirmSignIn(code) でコードを ANSWER に乗せる(AWSMobileClient 経由)。kt:65 confirmSignIn(code)、87-91 confirmSignInAsync が res={CHLG_RESP_ANSWER: code}、95 AWSMobileClient.confirmSignIn(res,...)。auth.js:574-587 challengeResponses={USERNAME,ANSWER}(+条件付き DEVICE_KEY)・Session=s.session、ChallengeContinuation.java:160-167 continueTask が汎用回答形(162 put USERNAME)。

### [AUTH-0018] CUSTOM_CHALLENGE 回答の USERNAME は usernameInternal を優先する
- surface: core
- backend: cloud
- command: loginVerify / RespondToAuthChallenge
- branch: pending.usernameInternal あり | 無し(email フォールバック)
- assert: ChallengeResponses.USERNAME が pending.usernameInternal(あれば UUID)、無ければ pending.username(email)。ChallengeContinuation が username に usernameInternal を入れる挙動(updateInternalUsername 経由)と一致する
- ref: packages/core/src/auth.js:567-578; _aws_sdk_ref/ChallengeContinuation.java:162; _aws_sdk_ref/CognitoUser.java:3948-3962
- kind: wire-fidelity
- status: covered
- note: auth.js:573 usernameInternal=s.usernameInternal??s.username、576 USERNAME に使用。ChallengeContinuation.java:162 put(CHLG_RESP_USERNAME, username)、その username は handleChallenge の生成箇所(CognitoUser.java:3214-3216 new ChallengeContinuation(...,usernameInternal,...))で渡る。:3948-3962 updateInternalUsername が usernameInternal=ChallengeParameters.USERNAME を設定。

### [AUTH-0019] CUSTOM_CHALLENGE 回答への DEVICE_KEY 付与条件
- surface: core
- backend: cloud
- command: loginVerify / RespondToAuthChallenge
- branch: 保存済み deviceKey 一致 | username 不一致(付与しない)
- assert: store に同一 username/usernameInternal の deviceKey がある時のみ ChallengeResponses に DEVICE_KEY を付与する。これにより Cognito が記憶済みデバイスを認識し次に DEVICE_SRP_AUTH を要求できる(respondToChallenge が全回答に DEVICE_KEY を注入する挙動と一致)
- ref: packages/core/src/auth.js:579-581; _aws_sdk_ref/ChallengeContinuation.java:160-167; _aws_sdk_ref/CognitoUser.java:2919-2922
- kind: wire-fidelity
- status: covered
- note: 実際の注入は CognitoUser.java:2919-2922 respondToChallenge が challengeResponse.getChallengeResponses().put(CHLG_RESP_DEVICE_KEY, deviceKey) する箇所(auth.js:559-562 コメントも 2919-2922 を引用)。auth.js:579-581 は (existing.username==usernameInternal||==s.username)&&existing.deviceKey 時のみ DEVICE_KEY 付与。

### [AUTH-0020] CUSTOM_CHALLENGE 回答には ClientMetadata を付けない
- surface: core
- backend: cloud
- command: loginVerify / RespondToAuthChallenge
- branch: -
- assert: RespondToAuthChallenge(CUSTOM_CHALLENGE) のペイロードに ClientMetadata キーが存在しない。ChallengeContinuation continueTask の if(!clientMetaData.isEmpty()) ガードにより空 Map では ClientMetadata を marshall しない挙動と一致する(PASSWORD_VERIFIER/DEVICE_SRP との非対称)
- ref: packages/core/src/auth.js:582-587; _aws_sdk_ref/ChallengeContinuation.java:168-170
- kind: wire-fidelity
- status: covered
- note: CHLG_RESP_SECRET_HASH(null) も付かない点も同型。auth.js:582-587 の CUSTOM_CHALLENGE RespondToAuthChallenge には ClientMetadata キーが無く(DEVICE_SRP の :813 / DEVICE_PASSWORD_VERIFIER の :854 と非対称)、ChallengeContinuation.java:168-170 の if(!clientMetaData.isEmpty()) ガードと一致。

### [AUTH-0021] コード誤り/期限切れの CUSTOM_CHALLENGE 再発行で新 Session を pending に書き戻す
- surface: core, cli
- backend: cloud
- command: loginVerify / `sesame verify <code>`
- branch: 応答 ChallengeName=CUSTOM_CHALLENGE + Session あり | wrong-code-retry
- assert: AuthenticationResult ではなく CUSTOM_CHALLENGE が新 Session 付きで再発行されたとき、新 Session を pending に保存し clearPending せず再 verify を促す(wrongCodeRetry)。Cognito の既定 3 回チャレンジ再発行に追随し、login からやり直さず同 login のまま verify 再試行できる
- ref: packages/core/src/auth.js:633-640
- kind: idempotency
- status: covered
- note: auth.js:633=else if(resp.ChallengeName==="CUSTOM_CHALLENGE" && resp.Session) 分岐、:638=store.savePending({...s,session:resp.Session,initiatedAt}) 書き戻し、:640=throw new Error(tr("auth.wrongCodeRetry"))。CLI verify 経路でもこのまま再試行可能(login flow retry 観点を統合)。

### [AUTH-0022] pending が無ければ loginVerify は throw する
- surface: core, cli
- backend: cloud
- command: loginVerify / `sesame verify <code>`
- branch: loadPending()==null
- assert: pending(loginState)が無い状態で loginVerify を呼ぶと auth.noPending で throw し RespondToAuthChallenge を送らない
- ref: packages/core/src/auth.js:553-558
- kind: error-path
- status: covered
- note: auth.js:553-558 で loginVerify は store.loadPending() が falsy なら throw new Error(tr("auth.noPending")) し、後続の cognitoCall(RespondToAuthChallenge) (:582) に到達しない。

### [AUTH-0023] 予期しないチャレンジ名/空応答は内部不変条件違反として throw する
- surface: core
- backend: cloud
- command: loginVerify / RespondToAuthChallenge
- branch: 他チャレンジ名 | AuthenticationResult もチャレンジも無し
- assert: CUSTOM_CHALLENGE 回答後に DEVICE_SRP_AUTH/CUSTOM_CHALLENGE 以外のチャレンジ名が返る、または AuthenticationResult もチャレンジも無い応答で throw する
- ref: packages/core/src/auth.js:641-647
- kind: error-path
- status: covered
- note: auth.js:641-643 の else if(resp.ChallengeName) が auth.anotherChallenge を throw(DEVICE_SRP_AUTH/CUSTOM_CHALLENGE 分岐は :598/:633 で先取済み)、:644-646 の最終 else が AuthenticationResult もチャレンジも無い応答に "No AuthenticationResult" を throw。

## DEVICE_SRP_AUTH

### [AUTH-0024] 記憶済みデバイスで DEVICE_SRP_AUTH→DEVICE_PASSWORD_VERIFIER の 2 段を回答する
- surface: core
- backend: cloud
- command: deviceSrpAuth / RespondToAuthChallenge
- branch: CUSTOM_CHALLENGE 応答が DEVICE_SRP_AUTH
- assert: loginVerify 後に DEVICE_SRP_AUTH が来たら RespondToAuthChallenge(DEVICE_SRP_AUTH)→DEVICE_PASSWORD_VERIFIER の 2 コールを送り、両回答に DEVICE_KEY を含めるのが deviceSrpAuthentication と一致する
- ref: packages/core/src/auth.js:598-632; packages/core/src/auth.js:791-861; _aws_sdk_ref/CognitoUser.java:3359-3382
- kind: wire-fidelity
- status: covered
- note: auth.js:598-632 が resp.ChallengeName==="DEVICE_SRP_AUTH" で deviceSrpAuth を呼び、:791-861 deviceSrpAuth が DEVICE_SRP_AUTH(:808-814, DEVICE_KEY=:812)→DEVICE_PASSWORD_VERIFIER(:843-855, DEVICE_KEY=:849) の 2 コールを送る。CognitoUser.java:3359-3382 deviceSrpAuthentication も 2 段 respondToAuthChallenge。

### [AUTH-0025] DEVICE_SRP_AUTH の ChallengeResponses {USERNAME, DEVICE_KEY, SRP_A} と USERNAME=内部ユーザー名
- surface: core
- backend: cloud
- command: deviceSrpAuth / RespondToAuthChallenge
- branch: 1段目 (DEVICE_SRP_AUTH) | USERNAME=ChallengeParameters.USERNAME(UUID) | email フォールバック
- assert: 1段目 RespondToAuthChallenge(DEVICE_SRP_AUTH) の ChallengeResponses が {USERNAME, DEVICE_KEY, SRP_A=A.toString(16)} で、USERNAME は呼び出し元が resp.ChallengeParameters.USERNAME(=usernameInternal/UUID)を優先し無ければ s.username(email)にフォールバックした値。initiateDevicesAuthRequest の addChallengeResponsesEntry(USERNAME/SRP_A/DEVICE_KEY) + handleChallenge の usernameInternal 写像と一致する
- ref: packages/core/src/auth.js:605; packages/core/src/auth.js:808-814; _aws_sdk_ref/CognitoUser.java:3530-3536; _aws_sdk_ref/CognitoUser.java:3600
- kind: wire-fidelity
- status: covered
- note: USERNAME 解決は呼び出し元 auth.js:605 (resp.ChallengeParameters?.USERNAME || s.username)、ChallengeResponses 構築は auth.js:812。Java は SECRET_HASH も put するが clientSecret=null で値 null → marshaller スキップ。CognitoUser.java:3600 usernameInternal=challengeParameters.get("USERNAME")、:3530-3536 USERNAME/SRP_A/DEVICE_KEY を addChallengeResponsesEntry。[[AUTH-0013]](PASSWORD_VERIFIER)/[[AUTH-0018]](CUSTOM_CHALLENGE) と同じ usernameInternal 規範を DEVICE_SRP でも固定。

### [AUTH-0026] DEVICE_PASSWORD_VERIFIER の ChallengeResponses キー集合と device 署名
- surface: core
- backend: cloud
- command: deviceSrpAuth / RespondToAuthChallenge
- branch: 2段目 (DEVICE_PASSWORD_VERIFIER)
- assert: 2段目 ChallengeResponses が {USERNAME, DEVICE_KEY, PASSWORD_CLAIM_SECRET_BLOCK, PASSWORD_CLAIM_SIGNATURE, TIMESTAMP} で、署名=HMAC-SHA256(hkdf, deviceGroupKey|deviceKey|SECRET_BLOCK|timestamp) が deviceSrpAuthRequest と一致する
- ref: packages/core/src/auth.js:843-855; packages/core/src/device-srp.js:260-268; _aws_sdk_ref/CognitoUser.java:3702-3730
- kind: wire-fidelity
- status: covered
- note: auth.js:843-855 の ChallengeResponses キー集合。device-srp.js:260-268 devicePasswordSignature が HMAC-SHA256(hkdf, deviceGroupKey||deviceKey||secretBlock||timestamp)。CognitoUser.java:3702-3714 が同一署名、:3722-3730 が同一キー集合(SECRET_HASH は clientSecret=null でスキップ)。

### [AUTH-0027] device SRP の HKDF 鍵が実 Cognito の S と一致する(SRP 一致検証)
- surface: core
- backend: cloud
- command: deviceAuthSecrets / srpPasswordSecrets
- branch: -
- assert: x=H(padHex(salt)|H(deviceGroupKey deviceKey ':' devicePassword)), u=H(padHex(A)|padHex(B)), S=(B-k·g^x)^(a+u·x) mod N, HKDF('Caldera Derived Key',16)(padHex(S),padHex(u)) が AuthenticationHelper.getPasswordAuthenticationKey と数式・バイト等価である
- ref: packages/core/src/device-srp.js:197-247; _aws_sdk_ref/CognitoUser.java:4060-4096
- kind: crypto-vector
- status: covered
- note: device-srp.js:197 srpPasswordSecrets が x/u/S/HKDF を計算、236 deviceAuthSecrets が device 引数を写像。AWS 4060-4096 = getPasswordAuthenticationKey。

### [AUTH-0028] DEVICE_SRP_AUTH 送信に ClientMetadata:{} を含める
- surface: core
- backend: cloud
- command: deviceSrpAuth / RespondToAuthChallenge
- branch: 1段目 | 2段目
- assert: DEVICE_SRP_AUTH と DEVICE_PASSWORD_VERIFIER の両回答が ClientMetadata:{} を含む。Java は initiateDevicesAuthRequest/deviceSrpAuthRequest で setClientMetadata(空Map) し marshaller が {} を書くのと一致する
- ref: packages/core/src/auth.js:803-814; packages/core/src/auth.js:840-855; _aws_sdk_ref/CognitoUser.java:3528; _aws_sdk_ref/CognitoUser.java:3738
- kind: wire-fidelity
- status: covered
- note: auth.js:813 / :854 がそれぞれ ClientMetadata:{} を付与。AWS:3528 initiateDevicesAuthRequest.setClientMetadata / :3738 authChallengeRequest.setClientMetadata。

### [AUTH-0029] DEVICE_SRP_AUTH の応答が DEVICE_PASSWORD_VERIFIER でなければ throw する
- surface: core
- backend: cloud
- command: deviceSrpAuth / RespondToAuthChallenge
- branch: 1段目応答が想定外
- assert: 1段目 DEVICE_SRP_AUTH の応答 ChallengeName が DEVICE_PASSWORD_VERIFIER でない場合に throw する(deviceSrpAuthentication の if 分岐に対応)
- ref: packages/core/src/auth.js:815-818; _aws_sdk_ref/CognitoUser.java:3374-3382
- kind: error-path
- status: covered
- note: auth.js:815 if(srp.ChallengeName !== 'DEVICE_PASSWORD_VERIFIER') → 817 throw。AWS:3374-3375 CHLG_TYPE_DEVICE_PASSWORD_VERIFIER.equals(...) の if、3381-3382 else→handleChallenge。

### [AUTH-0030] device 資格情報欠落時は UNAUTHENTICATED で拒否する
- surface: core
- backend: cloud
- command: deviceSrpAuth
- branch: deviceKey/deviceGroupKey/devicePassword いずれか欠落
- assert: device 3 点のいずれかが欠ける状態で deviceSrpAuth を呼ぶと auth.noDeviceCredentials で throw し RespondToAuthChallenge を送らない
- ref: packages/core/src/auth.js:791-796
- kind: error-path
- status: covered
- note: auth.js:792 if(!deviceKey || !deviceGroupKey || !devicePassword) → 795 throw new SesameError(tr('auth.noDeviceCredentials'), {code: ERR.UNAUTHENTICATED})。RespondToAuthChallenge(798 以降)に到達する前にガード。

## device 失効再開

### [AUTH-0031] DEVICE_SRP の NotAuthorized で device 3 点を破棄しデバイス無し CUSTOM_AUTH を再開始する
- surface: core, cli
- backend: cloud
- command: loginVerify / deviceSrpAuth
- branch: DEVICE_SRP_AUTH が NotAuthorizedException
- assert: device 認証が NotAuthorizedException になったとき store の deviceKey/deviceGroupKey/devicePassword を null 保存し、loginInitiate で device 無し CUSTOM_AUTH を再開始して staleDeviceRetry を throw する。clearCachedDevice→getAuthenticationDetails(再 initiate)と一致する
- ref: packages/core/src/auth.js:611-627; _aws_sdk_ref/CognitoUser.java:3384-3396; _aws_sdk_ref/CognitoDeviceHelper.java:253-260
- kind: error-path
- status: covered
- note: auth.js:612 NotAuthorizedException 判定→620 device3点 null 保存→624 loginInitiate(再開始)→625 throw staleDeviceRetry。AWS:3386 clearCachedDevice + 3393 getAuthenticationDetails(再 initiate)、DeviceHelper:253-260 = clearCachedDevice(awsKeyValueStore.clear)。失効→再失敗の無限ループ防止。

### [AUTH-0032] DEVICE_SRP の NotAuthorized 以外のエラーは後始末せず伝播する
- surface: core
- backend: cloud
- command: loginVerify / deviceSrpAuth
- branch: DEVICE_SRP が非 NotAuthorized 失敗
- assert: DEVICE_SRP が NetworkError 等 NotAuthorized 以外で落ちた場合は device 3 点を破棄せず例外をそのまま伝播する(clearCachedDevice は NotAuthorizedException catch のみ)
- ref: packages/core/src/auth.js:611-628; _aws_sdk_ref/CognitoUser.java:3384-3397
- kind: error-path
- status: covered
- note: auth.js:612 if(NotAuthorized){...} の外、627 throw e で非 NotAuthorized は破棄せず再 throw。AWS:3384-3396 NotAuthorized catch(clearCachedDevice あり)、3397 catch(final Exception e) = 汎用 catch(clear なし、onFailure のみ)。

## ConfirmDevice

### [AUTH-0033] NewDeviceMetadata→ConfirmDevice のみ(UpdateDeviceStatus は送らない)
- surface: core
- backend: cloud
- command: loginVerify / confirmDevice / ConfirmDevice
- branch: AuthenticationResult.NewDeviceMetadata あり
- assert: ログイン成功応答に NewDeviceMetadata がある時 ConfirmDevice のみ発行し UpdateDeviceStatus(remembered 化)は一切送らない。handleChallenge は UserConfirmationNecessary でも confirmDevice+onSuccess のみで UpdateDeviceStatus を呼ばないのと一致する
- ref: packages/core/src/auth.js:740-776; _aws_sdk_ref/CognitoUser.java:3140-3158
- kind: wire-fidelity
- status: covered
- note: auth.js:740 confirmDevice、768-773 cognitoCall('ConfirmDevice', ...) のみで UpdateDeviceStatus 呼び出し無し。AWS:3140 confirmDevice(newDeviceMetadata)、3141-3151 UserConfirmationNecessary 分岐 / 3152-3158 else、いずれも callback.onSuccess のみ。旧実装の remembered 化分岐は参照に無いため削除済み。

### [AUTH-0034] ConfirmDevice のペイロード形(AccessToken/DeviceKey/DeviceName/DeviceSecretVerifierConfig)
- surface: core
- backend: cloud
- command: confirmDevice / ConfirmDevice
- branch: -
- assert: ConfirmDevice が {AccessToken, DeviceKey, DeviceName, DeviceSecretVerifierConfig:{PasswordVerifier, Salt}} の形で、PasswordVerifier/Salt は base64 として confirmDeviceInternal の DeviceSecretVerifierConfigType と一致する
- ref: packages/core/src/auth.js:751-773; _aws_sdk_ref/CognitoUser.java:3917-3940; _aws_sdk_ref/CognitoDeviceHelper.java:269-279
- kind: wire-fidelity
- status: covered
- note: auth.js:751-754 が generateDeviceVerifier 呼び出し、768-773 が ConfirmDevice cognitoCall。CognitoUser.java:3917-3940 = confirmDeviceInternal が setDeviceSecretVerifierConfig(setPasswordVerifier/setSalt)。CognitoDeviceHelper.java:269-279 = generateVerificationParameters が salt/verifier を base64 出力。

### [AUTH-0035] device verifier 生成(SRP-3072 verifier/salt base64)が Cognito generateVerificationParameters と同型
- surface: core
- backend: cloud
- command: generateDeviceVerifier
- branch: -
- assert: device verifier 生成(fullHash/x/verifier=g^x mod N と salt の base64 出力)の固定 salt/password KAT(数式・バイト一致)は [[CRY-0022]] が正典。本 ID は重複起票のため waive。
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0022]]）
- note: fullHash=H('{group}{key}:{password}')→x=H(padHex(salt)|fullHash)→verifier=g^x mod N の base64 出力(salt 符号バイト 15/16/17B 分岐含む)は crypto-vector KAT のため crypto.md [[CRY-0022]]が正典。ConfirmDevice 送信ペイロード形(DeviceSecretVerifierConfig への積載)は wire 側面として [[AUTH-0034]] が担当。本エントリは固定入力の verifier 数式 KAT のみで独自のフロー/wire 主張を持たないため waive(二重起票回避)。

### [AUTH-0036] NewDeviceMetadata 無し(デバイストラッキング無効)は ConfirmDevice を送らず device 無しで成立
- surface: core
- backend: cloud
- command: loginVerify / confirmDevice
- branch: NewDeviceMetadata なし
- assert: 応答に NewDeviceMetadata が無い(または DeviceKey/DeviceGroupKey 欠落)ときは ConfirmDevice を送らず device 無しトークンを保存し、後続 getValidIdToken も成立する。handleChallenge の newDeviceMetadata==null 分岐と一致する
- ref: packages/core/src/auth.js:740-742; _aws_sdk_ref/CognitoUser.java:3132-3138
- kind: wire-fidelity
- status: covered
- note: auth.js:740-742 = confirmDevice 冒頭の `if (!meta?.DeviceKey || !meta?.DeviceGroupKey) return null`。CognitoUser.java:3132-3138 = `if (newDeviceMetadata == null)` → onSuccess(session, null)。device 無しトークンは一級市民。

### [AUTH-0037] NewDeviceMetadata はあるが AccessToken 欠落は fail-fast で throw する
- surface: core
- backend: cloud
- command: loginVerify / confirmDevice
- branch: NewDeviceMetadata あり + AccessToken 無し
- assert: NewDeviceMetadata があるのに ConfirmDevice 用 AccessToken が無い異常系で throw し、未確認 deviceKey を保存させない(意図的逸脱: 参照は best-effort 握り潰しだが kit はトークンストア唯一性のため fail-fast)
- ref: packages/core/src/auth.js:743-749; _aws_sdk_ref/CognitoUser.java:3854-3868
- kind: error-path
- status: covered
- note: auth.js:743-749 = `if (!authResult.AccessToken) throw new Error('device confirmation failed...')`。CognitoUser.java:3854-3868 = confirmDevice が try/catch で失敗時 return null(best-effort)。意図的逸脱: 参照は null 返し継続だが kit は永続化モデル差分で fail-fast。

## token refresh / getValidIdToken

### [AUTH-0038] getValidIdToken fresh-token early return (margin 既定 120s)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: exp - now > marginSec (fresh)
- assert: 保存 idToken の exp が現在時刻 + marginSec を超えるなら refresh せずそのまま返す。既定 marginSec=120 は AWSMobileClient 2.77.0 の REFRESH_THRESHOLD_DEFAULT(120*1000ms) と一致する
- ref: packages/core/src/auth.js:207-218; _aws_sdk_ref/CognitoIdentityProviderClientConfig.java:40
- kind: wire-fidelity
- status: covered
- note: 既存テスト packages/core/tests/auth/getValidIdToken.test.js:78-124 (fresh return / 残り121秒で非refresh) あり。タグ付けは後工程。

### [AUTH-0039] getValidIdToken 早期 refresh 閾値境界 (exp - now <= marginSec)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: exp - now <= marginSec (early refresh) | marginSec 引数上書き
- assert: 失効まで marginSec 以下なら REFRESH_TOKEN_AUTH を 1 回起動する。margin の閾値判定が参照 needsNewSession 相当 (timeRemaining < threshold) で境界一致する
- ref: packages/core/src/auth.js:214-238; _aws_sdk_ref/CognitoIdentityProviderClientConfig.java:40; _aws_sdk_ref/CognitoCredentialsProvider.java:853-863
- kind: wire-fidelity
- status: covered
- note: 参照 needsNewSession() は timeRemaining < (refreshThreshold * 1000) (CognitoCredentialsProvider.java:861-863)。getValidIdToken.test.js:235-265 (残り100秒/expired で refresh)。

### [AUTH-0040] REFRESH_TOKEN_AUTH InitiateAuth ワイヤ形 (AuthFlow/ClientId/AuthParameters)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken / cognitoCall(InitiateAuth)
- branch: -
- assert: refresh の InitiateAuth body が {AuthFlow:'REFRESH_TOKEN_AUTH', ClientId, AuthParameters:{REFRESH_TOKEN,...}} 形で、ClientId は CONSUMER_CLIENT_ID 固定。X-Amz-Target=AWSCognitoIdentityProviderService.InitiateAuth / content-type x-amz-json-1.1 が移植元 AWS JSON1.1 と一致する
- ref: packages/core/src/auth.js:224-238; packages/core/src/cognito-http.js:104-112; _aws_sdk_ref/CognitoUser.java:3550-3568; _aws_sdk_ref/CognitoServiceConstants.java:31
- kind: wire-fidelity
- status: covered
- note: AUTH_TYPE_REFRESH_TOKEN='REFRESH_TOKEN_AUTH' は CognitoServiceConstants.java:31。参照 initiateRefreshTokenAuthRequest は setAuthFlow/setClientId/addAuthParametersEntry(REFRESH_TOKEN,DEVICE_KEY) を組む(CognitoUser.java:3550-3568)。getValidIdToken.test.js:222-232 が body 等価を assert。

### [AUTH-0041] REFRESH の DEVICE_KEY 条件付与 (deviceKey 有無で分岐)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken / InitiateAuth
- branch: deviceKey あり (DEVICE_KEY 付与) | deviceKey 無し (device-less, 省略)
- assert: REFRESH_TOKEN_AUTH の AuthParameters.DEVICE_KEY は保存 deviceKey が存在する場合のみ付与し、無ければ省略する。device 無しトークンでは DEVICE_KEY を省く。参照は deviceKey==null のとき CognitoDeviceHelper から補完するが補完不能なら付けない挙動 (省略=一致境界)
- ref: packages/core/src/auth.js:225-227; _aws_sdk_ref/CognitoUser.java:3554-3565
- kind: wire-fidelity
- status: covered
- note: auth.js:226-227 = `authParameters={REFRESH_TOKEN}; if(t.deviceKey) authParameters.DEVICE_KEY=...`。CognitoUser.java:3554-3565 = deviceKey==null で getDeviceKey 補完→addAuthParametersEntry(kit は補完不能=省略=意図的解釈)。getValidIdToken.test.js:268-285(付与)/:320- P3-16(省略) がカバー。

### [AUTH-0042] refresh 後 token 取り込み (IdToken/AccessToken 必須・RefreshToken rotation 前方互換)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: 応答 RefreshToken あり (rotation 取込) | 応答 RefreshToken 無し (旧 token 維持)
- assert: AuthenticationResult.IdToken を新 idToken に採り、AccessToken があれば更新、RefreshToken があれば取り込む (旧 refresh token 維持の参照 CognitoUser.java:2873-2874 からの意図的逸脱=rotation 前方互換)。lastRefresh を now ISO で更新する
- ref: packages/core/src/auth.js:276-289; _aws_sdk_ref/CognitoUser.java:2870-2875
- kind: wire-fidelity
- status: covered
- note: 意図的逸脱: 参照 refreshSession は getCognitoUserSession(result, currSession.getRefreshToken()) で旧 refresh token を維持(CognitoUser.java:2873-2874)。kit は応答に新 token が来たら取り込む。getValidIdToken.test.js:350-373 (rotation) / :374- (維持) / :421-438 (lastRefresh ISO)。

### [AUTH-0043] refresh 応答に IdToken 無し → UNAUTHENTICATED
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: AuthenticationResult.IdToken 欠落
- assert: refresh 応答に IdToken が無い場合 ERR.UNAUTHENTICATED の SesameError を投げる (応答形の最小契約)
- ref: packages/core/src/auth.js:276-279
- kind: error-path
- status: covered
- note: auth.js:276 const r = resp.AuthenticationResult; 277 if (!r?.IdToken) → 278 throw SesameError(...no IdToken..., {code: ERR.UNAUTHENTICATED})。

### [AUTH-0044] refresh NotAuthorized/UserNotFound → clearCachedTokens 相当 (device 温存 save)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: NotAuthorizedException | UserNotFoundException
- assert: refresh が NotAuthorized/UserNotFound で落ちたとき idToken/accessToken/refreshToken/lastRefresh を null 化し clientId/username/device 3 点を温存して save する。参照 clearCachedTokens が token 3 キーのみ remove・device は別ストア温存する境界と一致する
- ref: packages/core/src/auth.js:239-272; _aws_sdk_ref/CognitoUser.java:1306-1311; _aws_sdk_ref/CognitoUser.java:2703-2720
- kind: error-path
- status: covered
- note: 既存 packages/core/tests/auth/refresh-expiry-device-reuse.test.js。auth.js:256-271 = NotAuthorized/UserNotFound 分岐で store.save({idToken/accessToken/refreshToken/lastRefresh:null, device 3点温存})。CognitoUser.java:1306-1311 両例外で clearCachedTokens()、2703-2720 clearCachedTokens が token 3 キーのみ remove。device は CognitoDeviceHelper の別 SharedPreferences。旧 store.clear() は device まで消し P2-3 原因。

### [AUTH-0045] refresh その他例外は再 throw (非認証エラーは clear しない)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: NotAuthorized/UserNotFound 以外の例外
- assert: NotAuthorized/UserNotFound 以外 (5xx/ネットワーク/Throttling 等) は token を破棄せずそのまま再 throw する (参照 clearCachedTokens は NotAuthorized/UserNotFound のみ)
- ref: packages/core/src/auth.js:255-273; _aws_sdk_ref/CognitoUser.java:1306-1313
- kind: error-path
- status: covered
- note: auth.js:255 name 取得、256 NotAuthorized/UserNotFound 分岐、273 throw e (それ以外の再 throw)。CognitoUser.java:1306/1309 が特定例外のみ clearCachedTokens、1312-1313 catch(Exception) は clear せず再 throw。

### [AUTH-0046] refresh token 不在 / token 不在で UNAUTHENTICATED
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken
- branch: store.load() null | refreshToken 不在
- assert: 保存トークンが無い (auth.noTokens) / refreshToken が無い (auth.noRefreshToken) 場合 ERR.UNAUTHENTICATED で落ち、refresh を起動しない
- ref: packages/core/src/auth.js:208-223
- kind: error-path
- status: covered
- note: auth.js:208 store.load()、209-211 !t→noTokens UNAUTHENTICATED、220-223 !t.refreshToken→noRefreshToken UNAUTHENTICATED。いずれも cognitoCall(InitiateAuth) 234 より手前で throw=refresh 非起動。

### [AUTH-0047] getValidIdToken は app-login token のみ許容 (consumer clientId / device 整合)
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken / assertAppLoginTokens
- branch: aud != consumer | clientId != consumer | deviceKey ありで device 3 点不整合
- assert: idToken aud / 解決 clientId が CONSUMER_CLIENT_ID 以外、または deviceKey 有りで deviceGroupKey/devicePassword 欠落なら UNAUTHENTICATED で拒否。deviceKey 無しトークンは合法 (NewDeviceMetadata==null Pool 一致)
- ref: packages/core/src/auth.js:177-195; packages/core/src/auth.js:212; _aws_sdk_ref/CognitoUser.java:3130-3138
- kind: error-path
- status: covered
- note: 絶対制約: Android アプリ方式 consumer client のみ。web client は拒否。auth.js:177-195 assertAppLoginTokens (182-184 aud≠consumer 拒否, 186-188 resolvedClientId≠consumer 拒否, 192-194 deviceKey 有り && !hasConfirmedDevice 拒否)。212 が getValidIdToken の呼び出し点 (requireConfirmedDevice:true)。Java:3132 if(newDeviceMetadata==null)〜3138。

### [AUTH-0048] getValidIdToken の application 層リトライ無効化 (maxRetries:0)
- surface: core, serve, sdk
- backend: cloud
- command: getValidIdToken
- branch: -
- assert: auth.js は cognitoCall を maxRetries:0 で呼び 1 回だけ InitiateAuth する (リトライは cognitoCall 層の責務)。fake timer 下でも deadlock しない application 層境界
- ref: packages/core/src/auth.js:232-238
- kind: option-branch
- status: covered
- note: auth.js:231-233 コメント (maxRetries:0 / fake timer deadlock 回避)、234-238 cognitoCall("InitiateAuth", {REFRESH_TOKEN_AUTH...}, {maxRetries:0})。

### [AUTH-0049] app-login token guard: Consumer Client 以外の clientId/aud を入口で拒否する
- surface: core, serve, cli
- backend: cloud
- command: getValidIdToken / loginInitiate / bootstrap / assertAppLoginTokens
- branch: aud 非 Consumer | clientId 非 Consumer | aud 欠落
- assert: idToken の aud または clientId が CONSUMER_CLIENT_ID(6ialca0p8u0lsgvbmvsljfm305)でない場合 UNAUTHENTICATED で拒否し再ログインを促す。biz/web token を弾く規範(認証は Android アプリ方式絶対)と一致する
- ref: packages/core/src/auth.js:177-195; packages/core/src/auth.js:315-318; packages/core/src/auth.js:73-75
- kind: error-path
- status: covered
- note: references_web/src/api/useAuthState.js は負の証拠(Amplify Auth.signIn + password 'Aa123456', useAuthState.js:110-121)。getValidIdToken.test.js:306-318 が clientId 拒否をカバー。

### [AUTH-0050] app-login token guard: deviceKey があるのに device 3 点が不整合なトークンを拒否する
- surface: core, serve
- backend: cloud
- command: getValidIdToken / assertAppLoginTokens
- branch: deviceKey あり + deviceGroupKey/devicePassword 欠落
- assert: deviceKey が存在するのに deviceGroupKey または devicePassword が欠ける不整合トークンは UNAUTHENTICATED で拒否する。deviceKey 無し(トラッキング無効 Pool)は device 無しトークンとして合法に通す(P3-16)
- ref: packages/core/src/auth.js:156-158; packages/core/src/auth.js:189-194; _aws_sdk_ref/CognitoUser.java:3130-3138; _aws_sdk_ref/CognitoUser.java:3554-3564
- kind: error-path
- status: covered
- note: getValidIdToken.test.js:150-167 (不整合拒否) / :126-148 (device 無し通過) / p3-auth-fixes.test.js:440- (P3-16) がカバー。

## logout (core)

### [AUTH-0051] logout は ForgetDevice + RevokeToken を送り GlobalSignOut を送らない
- surface: core, cli
- backend: cloud
- command: logout / `sesame logout`
- branch: deviceKey あり + 有効 token
- assert: logout が ForgetDevice(AccessToken,DeviceKey) と RevokeToken(Token,ClientId) を送り、GlobalSignOut を一切送らない。両 op がこのデバイス/セッション限定であることが意図的強化として明記される(公式アプリはローカル signOut のみ)
- ref: packages/core/src/auth.js:875-910
- kind: wire-fidelity
- status: covered
- note: 意図的強化(参照に無いサーバ後始末)。logout fn 875-910, ForgetDevice@892 / RevokeToken@902, GlobalSignOut は 870 のコメントで「使わない」とのみ言及(送信箇所なし)。RevokeToken/ForgetDevice マーシャラー自体は本スライス外だが logout フローの境界として拾う。

### [AUTH-0052] deviceKey 無しなら ForgetDevice をスキップし RevokeToken のみ送る
- surface: core, cli
- backend: cloud
- command: logout / `sesame logout`
- branch: deviceKey 無し
- assert: device 無しトークンの logout では ForgetDevice を呼ばず RevokeToken のみ送り、ローカルは必ず clear する
- ref: packages/core/src/auth.js:882-905
- kind: option-branch
- status: covered
- note: 882 の if(t.deviceKey) ガードが ForgetDevice ブロック(883-895)を囲い、deviceKey 無しなら RevokeToken(902)のみ到達。

### [AUTH-0053] logout のサーバ呼び出しは best-effort でローカル clear は必ず実行する
- surface: core, cli
- backend: cloud
- command: logout / `sesame logout`
- branch: ForgetDevice 失敗 | RevokeToken 失敗 | token 未保存
- assert: ForgetDevice/RevokeToken が失敗しても例外を握り潰し、store.clear()+clearPending() を必ず実行する。token 未保存ならサーバ呼び出し無しでローカル clear のみ行う
- ref: packages/core/src/auth.js:875-909
- kind: error-path
- status: covered
- note: try/catch(889-894, 901-904)で best-effort、if(t) ガード(878)で token 未保存時はサーバ呼び出し回避、store.clear()@907 / clearPending()@908 は無条件実行。

### [AUTH-0054] logout の clientId は store.clientId 欠落時 idToken の aud から復元する
- surface: core, cli
- backend: cloud
- command: logout / RevokeToken
- branch: clientId 欠落
- assert: store.clientId が無い場合 jwtAud(idToken) で復元し、それも無ければ DEFAULT_CLIENT_ID を RevokeToken の ClientId に渡す
- ref: packages/core/src/auth.js:879; packages/core/src/auth.js:128-134
- kind: wire-fidelity
- status: covered
- note: 879 が t.clientId || jwtAud(t.idToken) || DEFAULT_CLIENT_ID で RevokeToken の ClientId(902) に渡る。jwtAud 定義は 134(jsdoc 128-133)、DEFAULT_CLIENT_ID は 77 で CONSUMER_CLIENT_ID。

## nickname 自動設定

### [AUTH-0055] loginVerify 後の nickname 自動設定が GetUser→UpdateUserAttributes の形で送られる
- surface: core, cli
- backend: cloud
- command: setNicknameIfNeeded / GetUser / UpdateUserAttributes / `sesame verify [code]`
- branch: nickname 空かつ email 非空 | nickname 既設 | email 空
- assert: GetUser({AccessToken}) の応答 UserAttributes で nickname が空かつ email 非空のときのみ UpdateUserAttributes({AccessToken, UserAttributes:[{Name:nickname,Value:email の@前}]}) を送る。LoginVerifiCodeFG の updateNickNameIfNeeded ロジックと一致する
- ref: packages/core/src/auth.js:696-726; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginVerifiCodeFG.kt:112-150; _aws_sdk_ref/CognitoUser.java:1491-1492; _aws_sdk_ref/CognitoUser.java:2228-2230
- kind: wire-fidelity
- status: covered
- note: verify コマンド経路で発火する境界 (login flow nickname を統合)。nickname-auto-set.test.js が GetUser→UpdateUserAttributes 順/req 形・nickname 既設 no-op をカバー。auth.js:696-726=setNicknameIfNeeded 本体(702 GetUser, 707-714 判定, 716-725 UpdateUserAttributes)。CognitoUser.java:1491-1492/2228-2230=req setAccessToken/setUserAttributes。Kotlin updateNickNameIfNeeded 112-124 + updateUserNameToCognito 126-150。

### [AUTH-0056] nickname 自動設定は best-effort でログイン成功を変えない
- surface: core, cli
- backend: cloud
- command: loginVerify / setNicknameIfNeeded
- branch: GetUser 失敗 | UpdateUserAttributes 失敗
- assert: GetUser/UpdateUserAttributes が失敗しても loginVerify はトークンを返し成功扱いにする(アプリの catch→続行と同義)
- ref: packages/core/src/auth.js:670-672; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginVerifiCodeFG.kt:121-123
- kind: error-path
- status: covered
- note: nickname-auto-set.test.js が GetUser 失敗/UpdateUserAttributes 失敗いずれも loginVerify がトークンを返すことを検証。auth.js:670-672=if(tokens.accessToken){ await setNicknameIfNeeded(...).catch(()=>{}) }。LoginVerifiCodeFG.kt:121-123=catch(e){ L.e(...) } の catch→続行。

## SRP guard

### [AUTH-0057] SRP_B が N の倍数(B mod N == 0)で SRP error を throw する
- surface: core
- backend: cloud
- command: srpPasswordSecrets / respondToPasswordVerifier / deviceSrpAuth
- branch: B≡0 (mod N): B=0 | B=N | B=2N
- assert: サーバ B が N の倍数(B mod N == 0)のとき 'SRP error, B cannot be zero' を throw する。userSrpAuthRequest/deviceSrpAuthRequest の srpB.mod(N)==ZERO ガードと一致する
- ref: packages/core/src/device-srp.js:198-201; _aws_sdk_ref/CognitoUser.java:3605-3608; _aws_sdk_ref/CognitoUser.java:3686-3689
- kind: error-path
- status: covered
- note: device-srp.js:201 が serverB % N === 0n で throw。AWS user 側 3606-3607、device 側 3687-3688 が srpB.mod(N).equals(ZERO) ガードで完全一致。

### [AUTH-0058] u = H(A,B) が 0 のとき SRP error を throw する
- surface: core
- backend: cloud
- command: srpPasswordSecrets
- branch: u≡0
- assert: u=H(padHex(A)|padHex(B)) が 0 になったとき 'SRP error, U cannot be 0' を throw する。AuthenticationHelper.getPasswordAuthenticationKey の u.equals(ZERO) ガードと一致する
- ref: packages/core/src/device-srp.js:203-204; _aws_sdk_ref/CognitoUser.java:4069-4072
- kind: error-path
- status: covered
- note: device-srp.js:204 が U === 0n で throw(203 で calculateU)。AWS 4069 が u 算出、4070-4071 が u.equals(ZERO) ガード。AWS 文言は 'Hash of A and B cannot be zero' で kit と異なるが assert はガード一致のみ主張。

### [AUTH-0059] cognitoTimestamp が Cognito 固定書式 'EEE MMM d HH:mm:ss UTC yyyy' と一致する
- surface: core
- backend: cloud
- command: cognitoTimestamp
- branch: -
- assert: TIMESTAMP の書式が曜日/月/日(0詰めしない)/HH:mm:ss/UTC/yyyy で、Java の SimpleDateFormat("EEE MMM d HH:mm:ss z yyyy", Locale.US) を UTC で format した値とバイト一致する(署名対象なので厳密一致が必須)
- ref: packages/core/src/device-srp.js:270-276; _aws_sdk_ref/CognitoUser.java:3627-3631; _aws_sdk_ref/CognitoUser.java:3708-3712
- kind: crypto-vector
- status: covered
- note: device-srp.js:271-276 が WEEK_DAYS/MONTHS(129-130)+getUTCDate(非0詰め)+0詰め時分秒+'UTC'+getUTCFullYear。AWS user 側 3627-3628 / device 側 3708-3709 が SimpleDateFormat + setTimeZone(UTC)(3629/3710)。

## HKDF crypto

### [AUTH-0060] HKDF(Caldera Derived Key) 16byte 導出の既知ベクタ
- surface: core
- backend: local
- command: computeHkdf / srpPasswordSecrets
- branch: -
- assert: HKDF-SHA256 'Caldera Derived Key' 16byte 導出(extract→expand)の固定入力 KAT(既知ベクタとのバイト一致)は [[CRY-0017]] が正典。本 ID は重複起票のため waive。
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0017]]）
- note: PRK=HMAC(salt=padHex(u), ikm=padHex(S))→HMAC(PRK,'Caldera Derived Key'||0x01) 先頭 16byte の既知ベクタ一致は crypto-vector KAT のため crypto.md [[CRY-0017]](length=16<=macLen で 1 ブロック完結, フロー非依存純 KAT)が正典。in-flow 利用(device SRP の S 一致)は [[AUTH-0027]] が担当。本エントリはフロー/wire 固有の主張を持たず純 KAT のため waive(二重起票回避)。

### [AUTH-0061] HKDF 用途: device password 所持証明 PASSWORD_CLAIM_SIGNATURE
- surface: core
- backend: cloud
- command: deviceAuthSecrets / devicePasswordSignature
- branch: -
- assert: device 認証フローが deviceAuthSecrets(device 引数→hkdf/secretBlock 写像)→devicePasswordSignature の連鎖で所持証明を生成し、その出力を DEVICE_PASSWORD_VERIFIER 応答の PASSWORD_CLAIM_SIGNATURE フィールドへ積載する(in-flow HKDF 用途)。署名値そのもののバイト一致 KAT は本 ID では検証しない。
- ref: packages/core/src/device-srp.js:236-268; packages/core/src/auth.js:821-833; _aws_sdk_ref/CognitoUser.java:3621-3645
- kind: crypto-vector
- status: covered
- note: KAT 本体(HMAC-SHA256(hkdf, deviceGroupKey||deviceKey||secretBlock||timestamp) の固定ゴールデン署名バイト一致)は crypto.md [[CRY-0023]]が正典。本 ID は in-flow 連鎖(auth.js:822-833 deviceAuthSecrets→devicePasswordSignature)と PASSWORD_CLAIM_SIGNATURE への積載という用途側面のみを残す。DEVICE_PASSWORD_VERIFIER 応答の ChallengeResponses キー集合・wire 形は [[AUTH-0026]]。参照は user SRP 経路だが正準連結形を device 実装が踏襲(CognitoUser.java:3621-3645)。

## TokenStore persistence

### [AUTH-0062] tokens.json を 0600 / 親 0700 でアトミック書き込み
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.save / writeSecretJson
- branch: -
- assert: tokens.json は mode 0600・親ディレクトリ 0700 で temp→rename のアトミック書き込みされ world-readable にならない。CognitoCachingCredentialsProvider の SharedPreferences (端末ローカル秘匿) と同等の秘匿境界
- ref: packages/core/src/tokens.js:188-197; packages/core/src/secure-fs.js:21-49; _aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98
- kind: contract-existence
- status: covered
- note: 既存 packages/core/tests/tokens/FileTokenStore.test.js。tokens.js:188-197 が FileTokenStore.save (withFileLock + writeJson→writeSecretJson の鎖)。secure-fs.js:21-49 が SECRET_FILE_MODE=0o600(21)/SECRET_DIR_MODE=0o700(23)/ensureSecureDir(30-34)/writeSecretFile temp→rename atomic(43-55)。CCCP.java:86-98 は秘匿クレデンシャルキー定義で「端末ローカル秘匿」アナロジー(contract-existence の類比)。

### [AUTH-0063] save lost-update 防止 merge: ディスクが新しければ token 4 点を巻き戻さない (規則2)
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.save / mergeStoredTokens
- branch: disk freshness > incoming (token 保護) | disk <= incoming (incoming 勝ち)
- assert: ロック内でディスク再読し、tokenFreshnessMs(disk) が厳密に大なら idToken/accessToken/refreshToken/lastRefresh はディスク値を保持する。rotation 済み refreshToken の巻き戻り (Invalid Refresh Token 誘発) を防ぐ ARCH-13 境界
- ref: packages/core/src/tokens.js:104-155; packages/core/src/tokens.js:188-199
- kind: idempotency
- status: covered
- note: 既存 packages/core/tests/tokens/lost-update.test.js。104-155 = merge規則コメント+mergeStoredTokens (146=disk<=incoming, 150-153=4点保持), 188-199=save (lock+reread+merge)。

### [AUTH-0064] save merge 規則2a: incoming.idToken===null は明示破棄として尊重
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.save / mergeStoredTokens
- branch: incoming.idToken === null (refresh 失効破棄)
- assert: incoming.idToken が明示 null のとき、ディスクが新しくても token を復活させず null をそのまま書く。refresh 失効後 device-only save がディスクの古い token を merge 復活させる競合を単一ロック内で防ぐ (clearCachedTokens 範囲相当)
- ref: packages/core/src/tokens.js:121-127; packages/core/src/tokens.js:142-146; _aws_sdk_ref/CognitoUser.java:2703-2720
- kind: idempotency
- status: covered
- note: 121-127=規則2aコメント, 142-146=`if (incoming.idToken === null) return incoming`, CognitoUser.java:2703-2720=clearCachedTokens が idToken/accessToken/refreshToken キーを remove。

### [AUTH-0065] save merge 規則3/4: device 3 点は常に incoming 優先・破損ディスクは上書き回復
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.save / mergeStoredTokens
- branch: deviceKey/Group/Password (常に incoming) | disk が壊れた JSON
- assert: deviceKey/deviceGroupKey/devicePassword は merge 保護外で常に incoming を採る (意図的 null 化での再ログイン誘導を巻き戻さない)。ディスクが破損 JSON のときは merge せず incoming で上書き回復する
- ref: packages/core/src/tokens.js:128-134; packages/core/src/tokens.js:188-198
- kind: idempotency
- status: covered
- note: 128-134=規則3(device 常に incoming)+規則4(破損は上書き回復), 188-198=save の catch→mergeStoredTokens(null, t) 経路。mergeStoredTokens は device 3 点を保護リストに含めない (merge は idToken/accessToken/refreshToken/lastRefresh のみ)。

### [AUTH-0066] load の TOCTOU 解消 (ENOENT→null) と clear のロック直列化
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.load / clear
- branch: 並行 logout(unlink) と load | 並行 save と clear
- assert: load は readFileSync の ENOENT を null に写像 (existsSync→read の競合除去)、JSON 破損 (SyntaxError) は伝播。clear は save と同一ロックで直列化し中途復活を防ぐ (P3-17)
- ref: packages/core/src/tokens.js:54-67; packages/core/src/tokens.js:201-207
- kind: idempotency
- status: covered
- note: 54-67=readJsonOrNull (ENOENT→null, それ以外 throw=SyntaxError 伝播), 201-207=clear() が withFileLock(this.tokensPath) で unlinkIfExists を直列化 (save と同一ロックキー)。

### [AUTH-0067] pendingLogin 保存形 (CUSTOM_CHALLENGE 待ち一時状態)
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.savePending / loadPending / clearPending
- branch: -
- assert: loginState ファイルに {clientId, username, usernameInternal?, session?, initiatedAt} を 0600 で保存・復元する。usernameInternal は ChallengeParameters.USERNAME (内部 UUID) に対応 (CognitoUser.java:3600 usernameInternal)
- ref: packages/core/src/tokens.js:25-36; packages/core/src/tokens.js:209-213; _aws_sdk_ref/CognitoUser.java:3594-3600
- kind: contract-existence
- status: covered
- note: 25-36=PendingLogin typedef (全フィールド+usernameInternal 説明), 209-213=savePending/loadPending/clearPending, CognitoUser.java:3594=userId=challengeParameters.get(CHLG_PARAM_USERNAME)・3600=this.usernameInternal=userId。0600 は writeJson→writeSecretJson が担保。

### [AUTH-0068] aws_credentials.json 永続形 (AK/SK/ST/EXP/ID キー対応・0600)
- surface: core, serve, cli
- backend: local
- command: FileTokenStore.saveAwsCredentials / loadAwsCredentials
- branch: save(null)=削除 | save(obj)=書込
- assert: PersistedAwsCredentials {identityId, accessKeyId, secretAccessKey, sessionToken, expirationMs} を tokens.json 同階層の aws_credentials.json (0600) に保存し、null で削除する。参照 CognitoCachingCredentialsProvider の ID_KEY/AK_KEY/SK_KEY/ST_KEY/EXP_KEY 永続フィールドと 1:1 対応する
- ref: packages/core/src/tokens.js:215-240; packages/core/src/aws-credentials.js:227-236; _aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98; _aws_sdk_ref/CognitoCachingCredentialsProvider.java:638-646
- kind: contract-existence
- status: covered
- note: 既存 packages/core/tests/tokens/p3-15-p3-17.test.js。tokens.js:215-240=save/loadAwsCredentials (null→unlink, obj→writeJson), aws-credentials.js:227-236=PersistedAwsCredentials typedef, CCCP.java:86-98=ID/AK/SK/ST/EXP_KEY 定数, CCCP.java:638-646=saveCredentials が AK/SK/ST/EXP を put。

## Identity Pool credentials

### [AUTH-0069] GetId ワイヤ形 (Logins キー = cognito-idp.<region>/<userPoolId>)
- surface: core, serve, sdk
- backend: cloud
- command: makeCognitoCredentialsProvider.getCredentials (GetId)
- branch: identityId キャッシュ無し (GetId 実行) | キャッシュ有り (GetId スキップ)
- assert: GetId は AWS JSON1.1 (X-Amz-Target AWSCognitoIdentityService.GetId) で {IdentityPoolId, Logins:{loginKey: idToken}} を送る。loginKey は 'cognito-idp.<region>.amazonaws.com/<userPoolId>'。identityId はキャッシュ/永続で GetId をスキップする
- ref: packages/core/src/aws-credentials.js:296; packages/core/src/aws-credentials.js:336-347; packages/core/src/aws-credentials.js:129-142; _aws_sdk_ref/AWSMobileClient.java:605
- kind: wire-fidelity
- status: covered
- note: 実機 API Gateway/Identity 受理は未確認だがモック fetch で wire 検証可。既存 aws-credentials.test.js。aws-credentials.js:296=loginKey 構築, 336-347=GetId payload {IdentityPoolId, Logins}, 129-142=X-Amz-Target AWSCognitoIdentityService.<op>。AWSMobileClient.java:605 String.format("cognito-idp.%s.amazonaws.com/%s", Region, PoolId)=loginKey 形の正出典。

### [AUTH-0070] GetCredentialsForIdentity 応答フィールド名 (SecretKey 等) パース
- surface: core, serve, sdk
- backend: cloud
- command: makeCognitoCredentialsProvider.getCredentials (GetCredentialsForIdentity)
- branch: 正常応答 | フィールド欠落 (malformed)
- assert: Credentials.{AccessKeyId, SecretKey, SessionToken, Expiration} を読む (SecretAccessKey ではなく SecretKey)。Expiration は epoch 秒(double)→ms 正規化。いずれか欠落で REJECTED malformed エラー。AWS GetCredentialsForIdentity 応答契約と一致する
- ref: packages/core/src/aws-credentials.js:354-377; packages/core/src/aws-credentials.js:212-225
- kind: wire-fidelity
- status: covered
- note: aws-credentials.js:359-377 fetchCredentialsFor が c.AccessKeyId/c.SecretKey/c.SessionToken を読み、363-368 で欠落時 REJECTED malformed。expirationMsOf (218-225) は number を ×1000 で epoch秒→ms。

### [AUTH-0071] credentials 失効閾値 500s 手前で再取得 (キャッシュ再利用境界)
- surface: core, serve, sdk
- backend: cloud
- command: makeCognitoCredentialsProvider.getCredentials
- branch: expirationMs - margin > now (キャッシュ) | <= now (再取得)
- assert: cached.expirationMs - refreshMarginMs > now() ならキャッシュを返し、超えたら refresh する。既定 margin=500_000ms は CognitoCredentialsProvider DEFAULT_THRESHOLD_SECONDS=500 / needsNewSession (timeRemaining < threshold*1000) と一致する
- ref: packages/core/src/aws-credentials.js:81-87; packages/core/src/aws-credentials.js:424-432; _aws_sdk_ref/CognitoCredentialsProvider.java:67; _aws_sdk_ref/CognitoCredentialsProvider.java:853-863
- kind: wire-fidelity
- status: covered
- note: DEFAULT_REFRESH_MARGIN_MS=500_000 は src:87、キャッシュ境界 cached.expirationMs - refreshMarginMs > now() は src:427。Java:67 DEFAULT_THRESHOLD_SECONDS=500、needsNewSession の timeRemaining < (refreshThreshold * 1000) は Java:863。

### [AUTH-0072] credentials 取得の single-flight 合流
- surface: core, serve, sdk
- backend: cloud
- command: makeCognitoCredentialsProvider.getCredentials
- branch: 同時複数呼び出し
- assert: inflight が在るうちは同一 Promise に合流し、GetId/GetCredentialsForIdentity を 1 回に集約する (重複ネットワーク呼び出し回避の冪等境界)
- ref: packages/core/src/aws-credentials.js:302-303; packages/core/src/aws-credentials.js:426-432
- kind: idempotency
- status: covered
- note: src:302-303 inflight 変数宣言、src:428-431 で if(!inflight){inflight=refresh().finally(()=>inflight=null)} → 同一 Promise 合流。

### [AUTH-0073] GetCredentials 失敗時の Identity 再解決トリガ (ResourceNotFound/Validation のみ)
- surface: core, serve, sdk
- backend: cloud
- command: makeCognitoCredentialsProvider.refresh
- branch: ResourceNotFoundException | ValidationException | NotAuthorizedException(即throw)
- assert: GetCredentialsForIdentity が ResourceNotFound/Validation で落ちたら identityId を捨て GetId からやり直す。NotAuthorized 等それ以外は即 throw する。参照 CognitoCredentialsProvider:789-803 の recoverable 分岐と一致 (hadCachedIdentity ガード無し)
- ref: packages/core/src/aws-credentials.js:386-402; _aws_sdk_ref/CognitoCredentialsProvider.java:789-803
- kind: error-path
- status: covered
- note: 既存 packages/core/tests/aws-credentials/p3-14-p3-15.test.js。src:396-401 で recoverable=ResourceNotFound||Validation のみ identityId=null→再 GetId、非 recoverable は 398 で throw。Java:792-803 は catch(ResourceNotFound)→retry / Validation→retry / else throw ase。

### [AUTH-0074] 起動時 永続 credentials/identityId ロード + 取得後 save
- surface: core, serve, cli
- backend: cloud, local
- command: makeCognitoCredentialsProvider (credentialsStore)
- branch: 全キー揃い (cached 復元) | identityId のみ | 破損ストア (無視)
- assert: credentialsStore から identityId と全キー (AK/SK/ST/expirationMs) 揃いを起動時に復元し GetId をスキップ、refresh 後に saveAwsCredentials する。clearCache は saveAwsCredentials(null)。参照 loadCachedCredentials (expirationKey 存在+全キー) / saveCredentials / saveIdentityId と一致する
- ref: packages/core/src/aws-credentials.js:305-330; packages/core/src/aws-credentials.js:405-419; packages/core/src/aws-credentials.js:433-440; _aws_sdk_ref/CognitoCachingCredentialsProvider.java:588-621; _aws_sdk_ref/CognitoCachingCredentialsProvider.java:638-646; _aws_sdk_ref/CognitoCachingCredentialsProvider.java:655-659
- kind: idempotency
- status: covered
- note: loadCachedCredentials 定義は CCCP.java:588-621 (588-605 expirationKey 存在チェック、612-617 AK/SK/ST 全キー揃いチェック、620 BasicSessionCredentials 組立)。saveCredentials は 638-646、saveIdentityId は 655-659。JS 側 src:307-326 起動時復元 / 405-419 refresh 後 save / 437-439 clearCache→saveAwsCredentials(null)。

### [AUTH-0075] appidentifyid 解決/生成 (ap-northeast-1:<id>) と永続化
- surface: core, serve, cli
- backend: local
- command: resolveAppIdentifyId / generateAppIdentifyId
- branch: 明示注入 | config 保存値 | 新規生成+save | 読み取り専用(in-memory)
- assert: 優先 明示 > config 保存値 > 新規生成 で appidentifyid を解決し、新規生成形は 'ap-northeast-1:<UUID>'、configStore があれば即 save する。参照 AppIdentifyIdUtil.kt の '<region>:<安定ID>' 形と SharedPreferences 永続化に対応する
- ref: packages/core/src/aws-credentials.js:454-479; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/AppIdentifyIdUtil.kt:35-46
- kind: contract-existence
- status: covered
- note: ANDROID_ID 相当が無いため UUID 生成 (意図的逸脱: 値は端末固有でなく初回生成永続)。src:455 generateAppIdentifyId が `${AWS_REGION}:${uuid()}`、src:470-478 resolveAppIdentifyId が 明示>config>生成 で解決し configStore.save()。AppIdentifyIdUtil.kt:42 が 'ap-northeast-1:'+getAndroidIdOrNull、35-39 SP 保存値優先、44 SharedPreferences.edit putString 永続化。

## SigV4 signing

### [AUTH-0076] SigV4 canonical request / string-to-sign / signature 既知ベクタ
- surface: core
- backend: local
- command: signRequest
- branch: AWS doc IAM ListUsers vector | get-vanilla/post-vanilla suite
- assert: SigV4 canonicalRequest/stringToSign/signature の固定入力 KAT(バイト一致)は [[CRY-0024]]/[[CRY-0025]]/[[CRY-0027]] が正典。本 ID は重複起票のため waive。
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0024]]/[[CRY-0025]]/[[CRY-0027]]）
- note: 固定日時/固定鍵 (20150830T123600Z, AKIDEXAMPLE) の canonicalRequest→stringToSign→signature バイト一致は crypto-vector KAT のため crypto.md が正典: canonicalRequest=[[CRY-0024]]、stringToSign=[[CRY-0025]]、signature/Authorization 組立=[[CRY-0027]]。本エントリはフロー/wire 固有の主張を持たず純 KAT のため waive(二重起票回避)。

### [AUTH-0077] SigV4 署名鍵導出 deriveSigningKey 連鎖 (AWS4secret→date→region→service→aws4_request)
- surface: core
- backend: local
- command: deriveSigningKey
- branch: -
- assert: SigV4 deriveSigningKey 4 段 HMAC 連鎖の固定入力 KAT(doc 掲載 hex とのバイト一致)は [[CRY-0026]] が正典。本 ID は重複起票のため waive。
- ref: local-contract
- kind: crypto-vector
- status: waived: 重複（正典 [[CRY-0026]]）
- note: HMAC('AWS4'+secret, dateStamp)→region→service→'aws4_request' 連鎖の既知ベクタ一致は crypto-vector KAT のため crypto.md [[CRY-0026]](固定 secret/dateStamp=20150830/region/service で kSigning=c4afb1cc... 一致)が正典。本エントリはフロー/wire 固有の主張を持たず純 KAT のため waive(二重起票回避)。

### [AUTH-0078] SigV4 sessionToken 署名境界 (Identity Pool 一時 credentials の flow 用途)
- surface: core
- backend: cloud, local
- command: signRequest
- branch: sessionToken あり (x-amz-security-token 署名対象) | sessionToken 無し
- assert: Identity Pool 一時 credentials を使う署名フローで、credentials.sessionToken が指定されたときのみ x-amz-security-token を署名対象 header/SignedHeaders に含め、無いときは含めない。cloud 用途(一時 credentials)の署名境界が成立する。canonical 正規化(URI 二重エンコード/query ソート/header 折り畳み)の固定入力バイト一致 KAT は本 ID では検証しない。
- ref: packages/core/src/sigv4.js:57-101; packages/core/src/sigv4.js:185-211
- kind: crypto-vector
- status: covered
- note: KAT 本体(sessionToken 分岐と canonicalQuery キー→値バイト順ソートの固定入力バイト一致)は crypto.md [[CRY-0033]]が正典。本 ID は flow 内 cloud 用途(Identity Pool 一時 credentials を載せた署名で x-amz-security-token が署名対象に入る境界)のみを残す。sigv4.js:194 で sessionToken 真値時のみ headerMap['x-amz-security-token'] を追加、:196-211 で signedHeaders/canonicalHeaders に組み込み canonical request を組立。

### [AUTH-0079] API Gateway transport ヘッダ構成 (SigV4 + x-api-key + per-op appidentifyid)
- surface: core, serve, sdk
- backend: cloud
- command: makeApiGatewayTransport
- branch: appIdentifyId あり (旧 /device 系) | null (/device/v1 系・既定)
- assert: REST リクエストに x-api-key (API_GATEWAY_API_KEY) と SigV4 Authorization を付け、appIdentifyId が渡された transport だけ appidentifyid ヘッダを付ける (null 既定は付けない)。参照 ApiClientFactory(credentialsProvider/apiKey/region) + CHAPIClient.kt の per-op @Parameter 配置と一致する
- ref: packages/core/src/aws-credentials.js:562-604; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/ApiClientConfigBuilder.kt:34-46; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:24-65
- kind: wire-fidelity
- status: covered
- note: 実機 API Gateway 受理は未確認だがモック fetch で header/署名検証可。aws-credentials.js:562-604=makeApiGatewayTransport(x-api-key=590行, appidentifyid 条件付与=595行, signRequest=596-604)。ApiClientConfigBuilder.kt:34-46=buildApiClientFactory(credentialsProvider/apiKey/region)。CHAPIClient.kt:24-65=per-op @Parameter(name="appidentifyid", location="header") 配置。

## cognito-http transport / AWS retry・timeout

### [AUTH-0080] cognitoCall が AWS JSON 1.1 のワイヤ形で POST する
- surface: core
- backend: cloud
- command: cognitoCall
- branch: -
- assert: URL=https://cognito-idp.<region>.amazonaws.com/, Content-Type=application/x-amz-json-1.1, X-Amz-Target=AWSCognitoIdentityProviderService.<Op>, body=payload JSON が marshaller のヘッダ/ターゲット規約と一致する
- ref: packages/core/src/cognito-http.js:104-112; _aws_sdk_ref/InitiateAuthRequestMarshaller.java:54-56; _aws_sdk_ref/RespondToAuthChallengeRequestMarshaller.java:55-57
- kind: wire-fidelity
- status: covered
- note: cognito-http.test.js が URL/Content-Type/X-Amz-Target/body/region 差替をカバー。cognito-http.js:104(url),108(Content-Type),109(X-Amz-Target),111(body)。Marshaller の target/X-Amz-Target/POST 規約は InitiateAuth:54-56 / RespondToAuthChallenge:55-57 (Content-Type 既定 application/x-amz-json-1.1 は同ファイル 130/137 行)。

### [AUTH-0081] エラー応答 __type(#区切り含む)を Error.name に写像する
- surface: core, serve, sdk
- backend: cloud
- command: cognitoCall / cognitoIdentityCall
- branch: 素形 __type | namespace#Type 形 | __type 無し | message/Message 両キー | 非 JSON body
- assert: エラー body の __type の '#' 以降を Error.name に写像し(NotAuthorizedException 等)、__type 無しは CognitoHttpError、message は message/Message のどちらか。AWS SDK 互換の err.name==='NotAuthorizedException' ハンドラが無変更で動く境界
- ref: packages/core/src/cognito-http.js:176-189; packages/core/src/aws-credentials.js:194-208
- kind: wire-fidelity
- status: covered
- note: cognito-http.js:179(rawType),180('#' split+CognitoHttpError fallback),182-185(message/Message),187-188(err.name 代入)。aws-credentials.js cognitoIdentityCall 196-198 で lastIndexOf('#').slice、199 message/Message。err.name を立てるのは cognito-http.js 側のみ(aws-credentials.js は SesameError.data.type に格納)だが両者とも __type 名空間剥離という核心を支える。cognito-http.test.js がカバー。

### [AUTH-0082] ソケットタイムアウト 15s が AbortSignal.timeout で課され即 throw (リトライ禁止)
- surface: core, serve, sdk
- backend: cloud
- command: cognitoCall / cognitoIdentityCall / apiGateway transport
- branch: デフォルト 15s 発火(TimeoutError) | AbortError(ユーザキャンセル) | timeoutMs オプション上書き
- assert: AbortSignal.timeout のデフォルトが 15000ms(DEFAULT_SOCKET_TIMEOUT)で timeoutMs オプションで上書きでき、発火 (TimeoutError) と AbortError はリトライせず即 throw する。参照 ClientConfiguration DEFAULT_SOCKET_TIMEOUT=15000 / RetryUtils.isInterrupted が SocketTimeoutException を除外する境界と一致する
- ref: packages/core/src/cognito-http.js:46-51; packages/core/src/cognito-http.js:100; packages/core/src/cognito-http.js:124-134; _aws_sdk_ref/ClientConfiguration.java:36; _aws_sdk_ref/RetryUtils.java:82-101
- kind: error-path
- status: covered
- note: 既存 packages/core/tests/aws-credentials/retry-timeout.test.js。cognito-http.js:47=AWS_TIMEOUT_MS=15_000, 100=timeoutMs 既定値(上書き可), 124=AbortSignal.timeout(timeoutMs), 131-132=AbortError/TimeoutError は即 throw。ClientConfiguration.java:36=DEFAULT_SOCKET_TIMEOUT=15*1000。RetryUtils.java:82-101=isInterrupted で SocketTimeoutException 特例除外(94-96)。fake timer で検証可。

### [AUTH-0083] AWS retry 既定 3 回 + 5xx (500/502/503/504) 指数バックオフリトライ
- surface: core, serve, sdk
- backend: cloud
- command: cognitoCall / cognitoIdentityCall / apiGateway transport
- branch: HTTP 5xx (リトライ) | maxRetries 到達 (確定) | maxRetries=0 (1 回のみ)
- assert: HTTP 500/502/503/504 応答は指数バックオフで最大 3 回 (DEFAULT_MAX_ERROR_RETRY) リトライし到達後確定する。maxRetries=0 では 1 回のみ呼ぶ。参照 SDKDefaultRetryCondition の 500/502/503/504 リトライ集合と一致する
- ref: packages/core/src/cognito-http.js:118-141; _aws_sdk_ref/PredefinedRetryPolicies.java:50; _aws_sdk_ref/PredefinedRetryPolicies.java:174-179
- kind: error-path
- status: covered
- note: cognito-http.js:118-141=リトライループ(指数バックオフ 119-122)+5xx リトライ分岐(138-141)。PredefinedRetryPolicies.java:50=DEFAULT_MAX_ERROR_RETRY=3、174-179=500/503/502/504 で return true。auth.js は maxRetries:0 を application 層で明示。現行 cognito-http.test.js は未カバー(リトライ専用テストは aws-credentials/retry-timeout.test.js で別 transport を検証)。

### [AUTH-0084] 4xx Throttling のみリトライ・非 Throttling 4xx は即確定
- surface: core, serve, sdk
- backend: cloud
- command: cognitoCall / cognitoIdentityCall / apiGateway transport
- branch: 4xx __type Throttling 系 (リトライ) | 4xx NotAuthorized 等 (確定)
- assert: 4xx の __type が Throttling/ThrottlingException/ProvisionedThroughputExceededException ならリトライ、それ以外 (NotAuthorizedException 等) は確定して投げる。参照 RetryUtils.isThrottlingException の errorCode 集合と一致する
- ref: packages/core/src/cognito-http.js:52-53; packages/core/src/cognito-http.js:143-160; _aws_sdk_ref/RetryUtils.java:34-41; _aws_sdk_ref/PredefinedRetryPolicies.java:187-189
- kind: error-path
- status: covered
- note: cognito-http.js:52-53=THROTTLING_CODES Set、143-160=4xx の __type を clone().text() で先読みし Throttling のみ continue・他は break で確定(160)。RetryUtils.java:34-41=isThrottlingException の errorCode 集合、PredefinedRetryPolicies.java:187-189=isThrottlingException(ase)→return true。

### [AUTH-0085] ネットワーク例外 (TypeError/IOException 相当) はリトライ対象
- surface: core, serve, sdk
- backend: cloud
- command: cognitoCall / cognitoIdentityCall / apiGateway transport
- branch: fetch reject (非 Abort/Timeout)
- assert: fetch が AbortError/TimeoutError 以外の例外 (TypeError 等) で reject したらリトライ対象とする。参照 SDKDefaultRetryCondition の IOException (非 InterruptedIOException) リトライと一致する
- ref: packages/core/src/cognito-http.js:126-134; _aws_sdk_ref/PredefinedRetryPolicies.java:158-162
- kind: error-path
- status: covered
- note: cognito-http.js:126-134=catch で name が AbortError/TimeoutError なら throw、それ以外(TypeError 等)は continue でリトライ(134)。PredefinedRetryPolicies.java:158-162=IOException && !InterruptedIOException で return true(162)。

### [AUTH-0086] ClockSkew は API Gateway transport でリトライしない (参照からの意図的逸脱)
- surface: core, serve, sdk
- backend: cloud
- command: makeApiGatewayTransport
- branch: 4xx RequestTimeTooSkewed/InvalidSignatureException/SignatureDoesNotMatch/RequestExpired
- assert: 署名はループ外で 1 回生成され X-Amz-Date 固定のため、ClockSkew 系 4xx を再送しても解消しない → リトライせず確定する。参照 PredefinedRetryPolicies.isClockSkewError はリトライ対象だが、再署名が transport 責務外のため意図的逸脱とする境界
- ref: packages/core/src/aws-credentials.js:606-650; _aws_sdk_ref/PredefinedRetryPolicies.java:191-197; _aws_sdk_ref/RetryUtils.java:65-73
- kind: error-path
- status: covered
- note: 実装(606-651)は ClockSkew 非リトライ(throttling/5xx/network のみ)。【修正済】JSDoc P3-13 のドキュメント乖離(旧記述は ClockSkew リトライ)を訂正し、本体どおり「ClockSkew 系 4xx は意図的に非リトライ(再署名は transport 責務外)」へ改めた。本 spec が非リトライ挙動を固定する。

## account whoami (core)

### [AUTH-0087] getLoginUser フレーム形 (biz3GetLoginUser, op 無し, email)
- surface: core, serve, sdk, cli
- backend: cloud
- command: account.getLoginUser / client.getLoginUser
- branch: -
- assert: 送信フレームが {action:'biz3GetLoginUser', email} (op 無し)。request の相関キーは action のみ ('biz3GetLoginUser:' op 空)。参照 web biz3GetCustomerInfo (action+email, op 無し) と一致する
- ref: packages/core/src/account.js:47-52; packages/core/src/vendor/biz3/constants/messageConstants.js:3; references_web/src/api/useStripeInfo.js:191-197
- kind: wire-fidelity
- status: covered
- note: 既存 packages/core/tests/account/getLoginUser.test.js。account.js:51 で client.request({action:ACT_LOGIN, email})(op 無し)、messageConstants.js:3 BIZ3_GET_LOGIN_INFO='biz3GetLoginUser'、useStripeInfo.js:191-197 biz3GetCustomerInfo が {action, email} 送信(op 無し)。

### [AUTH-0088] getLoginUser 応答形 (data.customerInfo / data.quotas ナロー化)
- surface: core, serve, sdk, cli
- backend: cloud
- command: account.getLoginUser
- branch: data あり | data/customerInfo 欠落 (null フォールバック) | success:false
- assert: 応答 message.data から {customerInfo, quotas} を取り、欠落は null。assertSuccess で success:false は拒否。参照 web handleBiz3GetCustomerInfoResponse の message.data.customerInfo/quotas 読み取りと一致する
- ref: packages/core/src/account.js:36-59; references_web/src/api/useStripeInfo.js:85-95
- kind: wire-fidelity
- status: covered
- note: account.js:52 assertSuccess(success:false 拒否)、54-58 で data?.customerInfo??null / data?.quotas??null。useStripeInfo.js:85-95 handleBiz3GetCustomerInfoResponse が message.data.customerInfo(89)/quotas(92) を読む。

### [AUTH-0089] refreshAccount で companyID/subUUID を config・内部状態に保存
- surface: core, serve, sdk, cli
- backend: cloud
- command: client.refreshAccount
- branch: companyID あり (config 上書き+save) | subUUID あり (_subUUID 上書き) | 欠落 (既定維持)
- assert: customerInfo.companyID があれば config.companyID を実値に上書きし configStore.save、subUUID があれば _subUUID を上書きする。参照 web の localStorage.setItem('curLogin', customerInfo.companyID) 相当の companyID 保存境界
- ref: packages/core/src/client.js:446-462; references_web/src/api/useStripeInfo.js:89-94
- kind: wire-fidelity
- status: covered
- note: client.js:446-462 refreshAccount: ci?.companyID で config.companyID 上書き+configStore.save(450-457)、ci?.subUUID で _subUUID 上書き(458-460)、欠落時は既定維持。useStripeInfo.js:93 localStorage.setItem('curLogin', customerInfoData.companyID)。

### [AUTH-0090] newTags アクセス権補完 (isSesameApp / オーナー・マネージャー / allTags)
- surface: core, sdk
- backend: local
- command: account.newTags / PAGE_NAMES / ALL_TAGS
- branch: isSesameApp (developer 追加) | tag[0]=オーナー/マネージャー (allTags 置換) | その他 (素通し)
- assert: isSesameApp は access に '開発者向け' 追加、tag[0] が 'オーナー'/'マネージャー' は access を allTags で置換、他は素通し。PAGE_NAMES/ALL_TAGS の日本語実値が参照 gUtils.pageNames/allTags と 1:1 一致する
- ref: packages/core/src/account.js:73-125; references_web/src/utils/gUtils.js:134-149; references_web/src/utils/gUtils.js:246; references_web/src/api/useStripeInfo.js:28-39
- kind: contract-existence
- status: covered
- note: account.js:73-88=PAGE_NAMES, 94-100=ALL_TAGS, 114-125=newTags。gUtils.js:134-149=pageNames, :246=allTags, useStripeInfo.js:28-39=newTags と日本語実値 1:1 一致。

### [AUTH-0091] priorityCompany / priorityCompanyId 選定 (非 isSesameApp / rootUser / level 最大)
- surface: core, sdk
- backend: local
- command: account.priorityCompany / priorityCompanyId
- branch: 非 isSesameApp (companyID 一致+subscriptionId 合成) | isSesameApp+rootUser | isSesameApp+level 最大 | 候補無し ({})
- assert: 非 isSesameApp は companyID 一致 company の feeLevel.subscriptionId を合成、isSesameApp は rootUser→なければ非 isSesameApp の level 最大を選び feeLevel 展開。companies 空/候補無しは {} (web は TypeError、ここのみ意図的逸脱)。companyID 既定 = priorityCompanyId が参照 useStripeInfo:41-67 と一致する
- ref: packages/core/src/account.js:144-182; references_web/src/api/useStripeInfo.js:41-67
- kind: contract-existence
- status: covered
- note: account.js:144-171=priorityCompany, 180-182=priorityCompanyId。useStripeInfo.js:41-63=priorityCompany, 65-67=priorityCompanyId と一致。意図的逸脱 (候補無しで {}; account.js:152,166 vs web の null.feeLevel TypeError)。既存 packages/core/tests/account/priority-company.test.js。

## status method (serve)

### [AUTH-0092] status は daemon ローカル状態を返す (hub 往復なし・requireAuth なし)
- surface: serve
- backend: local
- command: status
- branch: -
- assert: status handler が {connected:hub.connected, authState:daemon.authState, subUUID:hub.subUUID, apiVersion:CONTRACT_VERSION, contractVersion:CONTRACT_VERSION} を返し、requireAuth を呼ばず hub への RPC 往復もしない (純ローカル契約)
- ref: packages/kit/src/serve/entries/auth.js:14-26; packages/core/src/jsonrpc.js:53
- kind: contract-existence
- status: covered
- note: auth.js:14-26 で status handler が 5 フィールドを同期返却、requireAuth/await なし (cloud.ping=33, whoami=42 のみ requireAuth)。jsonrpc.js:53=CONTRACT_VERSION 定義。authState は daemon.js のトークン有無で決まる。

### [AUTH-0093] status result スキーマ (connected/authState enum/subUUID nullable/apiVersion/contractVersion)
- surface: serve, sdk
- backend: local
- command: status
- branch: -
- assert: RESULT_SCHEMAS.status = obj({connected:BOOL, authState:enum[ok,degraded,expired], subUUID:nullable(STR), apiVersion:STR, contractVersion:STR}, required[connected,authState,apiVersion,contractVersion]) が openrpc.json の status.result.schema と SDK 型 (StatusResult / status(): {...}) と 1:1 一致する
- ref: packages/kit/src/serve/result-schemas.js:64-73; schema/openrpc.json:8703-8743; packages/kit/sdk/python/sesame_client.py:318-323; packages/kit/sdk/ts/sesame-client.ts:170
- kind: surface-parity
- status: covered
- note: result-schemas.js:64-73 / openrpc.json:8703-8743 / python StatusResult:318-323 すべて connected/authState enum[ok,degraded,expired]/subUUID nullable/apiVersion/contractVersion + required で一致。TS は名前付き StatusResult でなく status():170 インライン return 型。純ローカル契約だが SDK/openrpc 三者の形一致をガード。

### [AUTH-0094] status authState の 3 値 (ok/degraded/expired) が daemon 遷移と一致
- surface: serve
- backend: local
- command: status
- branch: ok | degraded | expired
- assert: status.authState の enum [ok,degraded,expired] が daemon の実遷移と一致する: connect 成功=ok / 接続失敗かつ _hasStoredTokens()=true で degraded / トークン無しで expired
- ref: packages/kit/src/serve/daemon.js:88-89,126-152,156-161; packages/kit/src/serve/result-schemas.js:60-73
- kind: option-branch
- status: covered
- note: daemon.js:88-89=authState 3値型注釈+初期値 degraded, :127=connect 成功で authState='ok', :147=接続失敗時 _hasStoredTokens()?'degraded':'expired', :156-161=_hasStoredTokens() 本体。result-schemas.js:60-73 のコメントが 3 値の出所を daemon.js に固定。

### [AUTH-0095] status は apiVersion=contractVersion=CONTRACT_VERSION を canonical SemVer で返す
- surface: serve
- backend: local
- command: status
- branch: -
- assert: status の apiVersion と contractVersion がともに @sesame-kit/core/jsonrpc の CONTRACT_VERSION (API サーフェス SemVer canonical) と一致し、消費者が major 不一致を fail-fast できる。contractVersion は deprecated 別名
- ref: packages/kit/src/serve/entries/auth.js:5,23-24; packages/core/src/jsonrpc.js:53
- kind: contract-existence
- status: covered
- note: auth.js:5=CONTRACT_VERSION import (@sesame-kit/core/jsonrpc), :23=apiVersion:CONTRACT_VERSION, :24=contractVersion:CONTRACT_VERSION。jsonrpc.js:53 (CONTRACT_VERSION = '1.4.0' canonical SemVer)。

### [AUTH-0096] sesame rpc status が degraded/expired 時に notLoggedIn ヒントを stderr へ出す
- surface: cli
- backend: local
- command: `sesame rpc status`
- branch: authState=ok (no hint) | authState!=ok (hint)
- assert: cmdRpc が m===status かつ result.authState!=='ok' のとき serve.hint.notLoggedIn を stderr に出す (ok のときは出さない)。degraded で居座る問題の出口契約
- ref: packages/kit/src/cli/serve.js:341-345; packages/kit/src/i18n/serve.js:58,314
- kind: option-branch
- status: covered
- note: serve.js:343 で if (m==='status' && result && statusRes.authState && statusRes.authState!=='ok') console.error(t('serve.hint.notLoggedIn')) (cmdRpc 287 起点)。i18n serve.js:58 (en) / :314 (ja) の 'serve.hint.notLoggedIn' キー。

## cloud.ping (serve)

### [AUTH-0097] cloud.ping は biz3KeepAlive 1 往復で {ok:true, rttMs} を返す
- surface: serve
- backend: cloud
- command: cloud.ping
- branch: -
- assert: cloud.ping handler が requireAuth 後 hub.ping() を 1 回だけ呼び、{ok:true, rttMs:Date.now()-t0} を返す。hub.ping は transport.ping = client.request({action:biz3KeepAlive}) を 1 往復し ack 受信を生存判定 (success フィールド非依存)
- ref: packages/kit/src/serve/entries/auth.js:29-37; packages/core/src/client.js:416-424; packages/core/src/transport.js:321-330; references_web/src/websocket/WebSocketManager.ts:72-83,305
- kind: wire-fidelity
- status: covered
- note: biz3KeepAlive ack は connectionId を返す (success ではない、WebSocketManager.ts:73) — transport.ping は応答受信自体を生存とする (transport.js:329 return !!resp)。fetch/transport モックで単体検証可。

### [AUTH-0098] cloud.ping は未認証 daemon で not_authenticated を投げる
- surface: serve
- backend: cloud
- command: cloud.ping
- branch: authState=expired (requireAuth throw NOT_AUTHENTICATED) | authState=ok+connected (通過)
- assert: authState==='expired' の daemon で cloud.ping が requireAuth により not_authenticated (KIND.NOT_AUTHENTICATED) を投げ、hub.ping は呼ばれない。requireAuth は expired のみ NOT_AUTHENTICATED、degraded は次段の !hub.connected で CONNECTION_LOST に分岐する
- ref: packages/kit/src/serve/entries/auth.js:33; packages/kit/src/serve/registry-helpers.js:55-63
- kind: error-path
- status: covered
- note: requireAuth は authState==='expired' のみ NOT_AUTHENTICATED を投げる (registry-helpers.js:56-57)。degraded は throw せず connectivity ガードに落ちる。既存 phase4-surfaces.test.js:84-88 が expired ケースをカバー。

### [AUTH-0099] cloud.ping result スキーマ {ok,rttMs} と SDK 戻り型の整合 (experimental)
- surface: serve, sdk
- backend: cloud
- command: cloud.ping
- branch: -
- assert: cloud.ping は RESULT_SCHEMAS 非掲載 (experimental) のため openrpc.json で result.schema={description, type:object} の緩い object になり、SDK は ts ping():Promise<unknown> / py ping(**params)->Any にフォールバックする (型を Any/unknown 以上に主張しない)
- ref: schema/openrpc.json:8749-8755; packages/kit/sdk/ts/sesame-client.ts:368-371; packages/kit/sdk/python/sesame_client.py:716-722; packages/kit/src/serve/result-schemas.js:57-78
- kind: surface-parity
- status: covered
- note: handler は {ok:true,rttMs} を実際に返すが RESULT_SCHEMAS に cloud.ping キーが無い (whoami は 78 にあるが ping は非掲載) ため契約上は緩い object。stability=experimental。

### [AUTH-0100] cloud.ping が experimental (x-stability/x-provenance) として公開される
- surface: serve, sdk
- backend: cloud
- command: cloud.ping
- branch: -
- assert: stabilityOf(cloud.ping)=experimental かつ provenanceOf=unverified が openrpc.json の x-stability=experimental/x-provenance=unverified と SDK の @experimental JSDoc/docstring に一致する (STABLE_METHODS 非掲載)
- ref: packages/kit/src/serve/stability.js:19-33,57-67; schema/openrpc.json:8756-8757; packages/kit/sdk/ts/sesame-client.ts:369; packages/kit/sdk/python/sesame_client.py:721
- kind: contract-existence
- status: covered
- note: STABLE_METHODS (stability.js:19-33) に cloud.ping は無く、stabilityOf/provenanceOf (56-68) が experimental/unverified を導出。openrpc x-stability/x-provenance は 8756-8757。ts:369 / py:721 は @experimental 注記行。

## account.whoami (serve)

### [AUTH-0101] account.whoami は requireAuth 後 hub.getLoginUser() を返す (biz3GetLoginUser 1 往復)
- surface: serve
- backend: cloud
- command: account.whoami
- branch: -
- assert: account.whoami handler が requireAuth 後 hub.getLoginUser() を返す。getLoginUser は account.getLoginUser(ws,{email}) を呼び {action:biz3GetLoginUser, email}(op なし) を 1 往復し data.{customerInfo,quotas} を返す
- ref: packages/kit/src/serve/entries/auth.js:39-43; packages/core/src/client.js:433-439; packages/core/src/account.js:47-59; references_web/src/api/useStripeInfo.js:191-197
- kind: wire-fidelity
- status: covered
- note: biz3 は op を付けない (useStripeInfo.js:191-197 の biz3GetCustomerInfo が {action,email} のみ送出) ため request key は biz3GetLoginUser: (op 空) で一致。account.js:51 も {action:ACT_LOGIN, email} を送る。transport モックで検証可。

### [AUTH-0102] account.whoami は email 未保存時 UNAUTHENTICATED を投げる
- surface: serve
- backend: cloud
- command: account.whoami
- branch: email あり | email 未保存 (tokenStore.username 無し)
- assert: hub.getLoginUser が tokenStore.load().username を email に使い、未保存なら SesameError(ERR.UNAUTHENTICATED) を投げる (認証情報欠落の決定的分類)。account.getLoginUser 側は !email で badRequest(domain.account.emailRequired)
- ref: packages/core/src/client.js:433-438; packages/core/src/account.js:48
- kind: error-path
- status: covered
- note: 二段の email 必須検証 (client 層 client.js:437=UNAUTHENTICATED / account 層 account.js:48=bad_params via badRequest)。

### [AUTH-0103] account.whoami は authState=expired で not_authenticated を投げる
- surface: serve
- backend: cloud
- command: account.whoami
- branch: authState=expired (requireAuth throw NOT_AUTHENTICATED) | authState=ok+connected (通過)
- assert: authState==='expired' の daemon で account.whoami が requireAuth により not_authenticated を投げ、hub.getLoginUser は呼ばれない。requireAuth は expired のみ NOT_AUTHENTICATED、degraded は !hub.connected ガードで CONNECTION_LOST に分岐
- ref: packages/kit/src/serve/entries/auth.js:42; packages/kit/src/serve/registry-helpers.js:55-63
- kind: error-path
- status: covered
- note: requireAuth は authState==='expired' のみ NOT_AUTHENTICATED (registry-helpers.js:56-57)。auth.js:42 の whoami handler が requireAuth(daemon) を先行呼出し。

### [AUTH-0104] account.whoami customerInfo result スキーマが vendor 観測形と 1:1 一致
- surface: serve, sdk
- backend: cloud
- command: account.whoami
- branch: -
- assert: RESULT_SCHEMAS['account.whoami'] の customerInfo フィールド集合 {companyID,subUUID,subscriptionId,name,mainEmail,employeeEmail,employeeName,access[],tag[],isAnonymous,isRootUser,isSesameApp} + quotas(opaque) が openrpc.json・upstream fixture・SDK 型 (AccountWhoamiResult / ts whoami return) と 1:1 一致する
- ref: packages/kit/src/serve/result-schemas.js:78-85; schema/openrpc.json:8759-8826; packages/kit/tests/fixtures/upstream/account.whoami.json:1-24; packages/kit/sdk/python/sesame_client.py:115-132; packages/kit/sdk/ts/sesame-client.ts:209-211
- kind: payload-fidelity
- status: covered
- note: vendor 検証済 shape (verified-live)。upstream-canary-replay が fixture をこのスキーマで検証 (creds 不要)。全 customerInfo フィールドは optional (JS obj() required 既定 [] / openrpc required:[] / python NotRequired / ts ?) で 4 面一致。

### [AUTH-0105] account.whoami が stable/app-core として公開される
- surface: serve, sdk
- backend: cloud
- command: account.whoami
- branch: -
- assert: stabilityOf(account.whoami)=stable かつ provenanceOf=app-core が openrpc.json の x-stability=stable/x-provenance=app-core に一致する (STABLE_METHODS 掲載)。SDK は @experimental 注記を付けない
- ref: packages/kit/src/serve/stability.js:22; schema/openrpc.json:8824-8825; packages/kit/sdk/ts/sesame-client.ts:209-211
- kind: contract-existence
- status: covered
- note: stability.js:22 が STABLE_METHODS['account.whoami']='app-core'。stabilityOf/provenanceOf は同ファイル 57-67。ts SDK の whoami (210) は兄弟 op と異なり @experimental コメント無し。

## contract registry

### [AUTH-0106] 3 メソッドが registry に存在し OpenRPC に列挙される
- surface: serve
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: -
- assert: buildRegistry() が status/cloud.ping/account.whoami の 3 エントリを持ち、buildOpenRpcDoc がそれぞれを methods[] に 1:1 で含む (params=[]、summary は i18n キー serve.sum.* のまま)
- ref: packages/kit/src/serve/entries/auth.js:12-45; packages/kit/src/serve/registry.js:335,358-383; schema/openrpc.json:8703,8746,8760
- kind: contract-existence
- status: covered
- note: daemon.test.js:51 が status/account.whoami の registry 存在をカバー。委託済 openrpc.json は summary を解決済み英文でなく i18n キー (serve.sum.status/cloudPing/whoami) のまま保持する (catalog 訳文は kit/src/i18n/serve.js:102-104)。

### [AUTH-0107] openrpc.json が registry と非ドリフト (CI ゲート) で 3 メソッドを保持
- surface: serve
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: -
- assert: schema/openrpc.json の status/cloud.ping/account.whoami エントリ (name/summary/params/result.schema/x-stability/x-provenance) が buildOpenRpcDoc 出力と一致する (schema-drift ゲート)
- ref: schema/openrpc.json:8703-8826; packages/kit/src/serve/registry.js:358-411; packages/kit/tests/openrpc-contract.test.js:48-51
- kind: contract-existence
- status: covered
- note: openrpc ドリフトゲートは openrpc-contract.test.js:48-51 (machineContract(committed)===machineContract(buildOpenRpcDoc(buildRegistry(),...)))。schema-drift.test.js は rpc-params/proto/grpc-map のみ守る。

### [AUTH-0108] 3 メソッドの gRPC 型付きメソッド (Status/CloudPing/AccountWhoami) 生成
- surface: serve
- backend: cloud, local
- command: Status / CloudPing / AccountWhoami
- branch: -
- assert: grpc-methods.generated.json が status->Status / cloud.ping->CloudPing / account.whoami->AccountWhoami を Pascal 変換で持ち、sesame.proto に対応 rpc 宣言がある (stable な status/whoami は // stable コメント付き)
- ref: packages/kit/src/serve/grpc-methods.generated.json:1500-1513; packages/kit/src/serve/sesame.proto:278-283; packages/kit/tests/serve/result-schemas-stable.test.js:41-58
- kind: surface-parity
- status: covered
- note: result-schemas-stable.test.js が Status/AccountWhoami の // stable コメントをカバー。proto: rpc Status(279)/AccountWhoami(283) は直前行 // stable、experimental の cloud.ping->CloudPing(281) は // experimental (unverified)。

## framing parity

### [AUTH-0109] 3 メソッドが全 framing (stdio/socket/http/ws/grpc) で同一 hub 結果へ届く
- surface: serve
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: stdio | socket | http | ws | grpc
- assert: 全 framing が daemon.dispatchMessage/invoke 経由で同一 registry を解決するため、status/cloud.ping/account.whoami が framing 非依存に同じ hub メソッド・同じ result 封筒へ届く (1 リクエスト=1 JSON-RPC response)
- ref: packages/kit/src/serve/daemon.js:199-247; packages/kit/src/serve/framing/stdio.js:11-25; packages/kit/src/serve/framing/socket.js:41-58; packages/kit/src/serve/framing/http.js:100-145; packages/kit/src/serve/framing/ws.js:26-48; packages/kit/src/serve/framing/grpc.js:115-160
- kind: surface-parity
- status: covered
- note: all-framings-e2e.test.js は同居4経路 (stdio 除く) を看板 op でカバー。read-only 3 メソッドの framing 横断は別途。stdio/socket/ws は daemon.handleLine->dispatchMessage、http POST /rpc は dispatchMessage、grpc 型付き unary loop は daemon.invoke を直呼び (いずれも同一 _registry)。

### [AUTH-0110] HTTP POST /rpc が 3 メソッドを ephemeral 接続で処理し result 封筒を返す
- surface: serve
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: POST /rpc
- assert: POST /rpc が ephemeral Connection で 3 メソッドを dispatchMessage し 200+JSON-RPC result を返す。通知でなければ 204 にならず result.id 対応の封筒を返す
- ref: packages/kit/src/serve/framing/http.js:100-145
- kind: wire-fidelity
- status: covered
- note: http.js: POST /rpc ハンドラ (100) が ephemeral:true Connection を生成 (132)、daemon.dispatchMessage (136)、out===null (通知) のみ 204 (141)、それ以外 200+JSON.stringify(out) (142-143)。

### [AUTH-0111] gRPC unary が 3 メソッド result を JsonRpc{json} で運ぶ
- surface: serve
- backend: cloud, local
- command: Status / CloudPing / AccountWhoami
- branch: unary (型付き) | Invoke (汎用 JSON-RPC)
- assert: gRPC 型付き unary が daemon.invoke(method,params) の result を {json: JSON.stringify(result??null)} で返す (response は動的なので 1 回 JSON.parse 前提)。Invoke 経路は dispatchMessage で同等
- ref: packages/kit/src/serve/framing/grpc.js:115-160,163-172
- kind: wire-fidelity
- status: covered
- note: grpc.js:146 callback(null,{json:JSON.stringify(result??null)}); 163-172 Invoke は daemon.dispatchMessage 経由。command の Pascal 名は grpc-methods.generated.json:1500/1505/1510 と一致。

## framing auth (token)

### [AUTH-0112] TCP framing (http/ws/grpc) は loopback token 必須で 3 メソッドを保護
- surface: serve
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: valid token | missing/wrong token
- assert: token 無し/不一致のとき http は 401 (JSON-RPC error, kind=not_authenticated, WWW-Authenticate: Bearer) / ws は握手前 verifyClient で 401 / grpc は status.UNAUTHENTICATED を返し、3 メソッドの handler に到達しない。tokenMatches は定数時間比較
- ref: packages/kit/src/serve/framing/token.js:7-62; packages/kit/src/serve/framing/http.js:87-98; packages/kit/src/serve/framing/ws.js:18-32; packages/kit/src/serve/framing/grpc.js:56-62,117
- kind: error-path
- status: covered
- note: UDS/stdio は同一ユーザ前提で token 不要。token.test.js (tests/serve/token.test.js) が tokenMatches/parseBearer をカバー。

## exit-code contract (rpc)

### [AUTH-0113] sesame rpc <method> の終了コード契約 (0/1/2) が 3 メソッドで一様
- surface: cli
- backend: cloud, local
- command: `sesame rpc status` / `sesame rpc cloud.ping` / `sesame rpc account.whoami`
- branch: success(0) | bad_params(2) | not_authenticated/internal/rejected(1)
- assert: toServeError が server 由来 JSON-RPC error の kind を CLI 終了コードへ写像する: kind=bad_params→exitCode=2 (usage)、not_authenticated/internal/rejected→exit 1。README の 0=成功/1=ランタイム/2=usage と一致
- ref: packages/kit/src/cli/serve.js:170-192; packages/kit/tests/serve/rpc-exit-mapping.test.js:17-53
- kind: error-path
- status: covered
- note: rpc-exit-mapping.test.js が toServeError の kind→exitCode 写像をカバー (メソッド非依存)。serve.js:190 if(e.kind==='bad_params') err.exitCode=2。

### [AUTH-0114] sesame rpc --json は 3 メソッド result を JSON.stringify で出力
- surface: cli
- backend: cloud, local
- command: `sesame rpc status` / cloud.ping / account.whoami
- branch: --json | human (status は authState hint, 他は raw JSON)
- assert: --json 時 cmdRpc は result を JSON.stringify(result,null,2) で stdout に出す。非 --json でも status/cloud.ping/account.whoami は (rpc.discover でないため) 同じ raw JSON を出す。JSON パース失敗の params は {error,code:2} 封筒で exit 2
- ref: packages/kit/src/cli/serve.js:314-324,346-358
- kind: option-branch
- status: covered
- note: --json 封筒の一様性 (local-contract)。serve.js:321 JSON.stringify({error,code:2}); 346 --json 経路; 358 非 --json raw JSON。

## sdk parity

### [AUTH-0115] TS/PY SDK が 3 メソッドを _call で同一メソッド名へ束ねる
- surface: sdk
- backend: cloud, local
- command: account.whoami / cloud.ping / status
- branch: ts | py
- assert: ts SesameClient は account.whoami()→_call(account.whoami,{}), cloud.ping()→_call(cloud.ping,{}), status()→_call(status,{}); py は同名へ _call。3 メソッドとも params 無し ({} / **params) で送る
- ref: packages/kit/sdk/ts/sesame-client.ts:170,209-211,368-371; packages/kit/sdk/python/sesame_client.py:398-404,716-722,1300-1301
- kind: surface-parity
- status: covered
- note: py status は top-level メソッド (account/cloud は名前空間サブクラス _Account/_Cloud) — 配置の非対称あり。TS status()=line 170; whoami=210, cloud.ping=370。

### [AUTH-0116] 公式 JS クライアント (clients/js) の status ショートカットと未束縛メソッド
- surface: sdk, cli
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: status (ショートカット有) | cloud.ping/account.whoami (generic call のみ)
- assert: clients/js は status() ショートカット (call(status)) を持つが cloud.ping/account.whoami は専用ショートカット無しで generic call(method,params) 経由でのみ叩ける。sesame rpc CLI はこの client を介して全 3 メソッドを呼ぶ
- ref: packages/kit/clients/js/sesame-client.mjs:117-136; packages/kit/src/cli/serve.js:15,241-271
- kind: surface-parity
- status: covered
- note: 生成 sdk(ts/py) と 手書き client(clients/js) の露出差。account/cloud は generic call で到達可能。mjs:135 status(){return this.call('status')}; serve.js:15 import, 241-271 rpcCall/rpcCallHttp が client.call(method,params)。

## i18n (serve/rpc 文言)

### [AUTH-0117] 3 メソッドの summary i18n キーが en/ja カタログで解決される
- surface: serve
- backend: cloud, local
- command: status / cloud.ping / account.whoami
- branch: en | ja
- assert: serve.sum.status / serve.sum.cloudPing / serve.sum.whoami / serve.result.customerInfo が en と ja の両カタログに存在し t() で解決される (未定義キー素通し検出)。openrpc.json の summary はキー文字列 (status=serve.sum.status 等)
- ref: packages/kit/src/i18n/serve.js:102-105,358-361; schema/openrpc.json:8704,8747,8761
- kind: i18n
- status: covered
- note: i18n-catalog.test.js (1) が en/ja キー集合一致, (4) が t() リテラル存在をカバー。phase4-surfaces.test.js SURF-20 が summary キー解決をカバー。4キーは serve/entries/auth.js:15,30,40,41 で t() 解決。

### [AUTH-0118] sesame whoami/ping CLI 出力文言が en/ja で対称に揃う
- surface: cli
- backend: cloud
- command: `sesame whoami` / `sesame ping`
- branch: en | ja
- assert: cli.descWhoami/descPing/okKeepalive/noCustomerInfo/companyId/subUuid/name/subscription/companyIdSaved が en と ja カタログに対で存在する
- ref: packages/kit/src/i18n/cli.js:62,67,76,268,275,483,488,497,689,696
- kind: i18n
- status: covered
- note: en (L2-) / ja (L423-) 各カタログに対で存在。noCustomerInfo=62/483, companyIdSaved=67/488, okKeepalive=76/497, descWhoami=268/689, descPing=275/696。companyId/subUuid/name/subscription も en63-66/ja484-487 に実在。

## 監査追補 (audit gap-fill)

参照実装監査の網羅性ギャップ補填。既存エントリ(AUTH-0001〜0118)の母集合から漏れていた negative fact / missing-branch / wire 非対称 を新規 ID で索引化する。各エントリは subarea を note 冒頭に併記する。既存エントリは一切変更していない。

### [AUTH-0119] UserContextData(ASF 端末フィンガープリント)の非送出 negative fact
- surface: core
- backend: cloud
- command: loginInitiate / respondToPasswordVerifier / deviceSrpAuth / getValidIdToken
- branch: -
- assert: InitiateAuth(CUSTOM_AUTH/REFRESH_TOKEN_AUTH) と RespondToAuthChallenge(PASSWORD_VERIFIER/DEVICE_SRP_AUTH/DEVICE_PASSWORD_VERIFIER) のいずれの payload にも UserContextData キーが存在しない。参照は全リクエストビルダで setUserContextData(getUserContextData()) するが、getUserContextData は advancedSecurityDataCollectionFlag が false の Pool では null を返し marshaller が getUserContextData()!=null ガードで省く。kit は ASF を Node で忠実再現不能のため常時非送出し、ASF 無効 Pool の参照と wire 一致する
- ref: packages/core/src/auth.js:36-44; packages/core/src/auth.js:354-369; _aws_sdk_ref/CognitoUser.java:3457; _aws_sdk_ref/CognitoUser.java:3505; _aws_sdk_ref/CognitoUser.java:3540; _aws_sdk_ref/CognitoUser.java:3575; _aws_sdk_ref/CognitoUser.java:3660; _aws_sdk_ref/CognitoUser.java:3968-3970; _aws_sdk_ref/CognitoUserPool.java:626-636; _aws_sdk_ref/InitiateAuthRequestMarshaller.java:112-117
- kind: wire-fidelity
- status: covered
- note: subarea=InitiateAuth CUSTOM_AUTH。auth.js 意図的逸脱リスト #1(:36-39)に対応する negative fact。ClientMetadata:{} を書く AUTH-0008/0015/0028 と対になる。spec/auth.md に UserContextData は 0 件(grep 確認)。getUserContextData は CognitoUserPool.java:626-636 で flag 依存 null。InitiateAuthRequestMarshaller.java:112-117 が UserContextData!=null ガード。

### [AUTH-0120] CUSTOM_CHALLENGE 回答に stale DEVICE_KEY → ResourceNotFoundException("Device") の device 再開始経路が未被覆
- surface: core, cli
- backend: cloud
- command: loginVerify / RespondToAuthChallenge
- branch: RespondToAuthChallenge が ResourceNotFoundException(message に "Device" 含む)
- assert: loginVerify が DEVICE_KEY 付き CUSTOM_CHALLENGE 回答を送り Cognito が記憶済みデバイス未知で ResourceNotFoundException(message に "Device")を返したとき、参照 respondToChallenge は clearCachedDevice + getAuthenticationDetails(認証再 initiate)する。kit の loginVerify には ResourceNotFound catch が無く(NotAuthorizedException 経路のみ存在)、この device-stale 復帰分岐が欠落していることを negative-coverage として索引化する
- ref: packages/core/src/auth.js:579-587; packages/core/src/auth.js:611-627; _aws_sdk_ref/CognitoUser.java:2918-2940
- kind: error-path
- status: covered
- note: subarea=device 失効再開。AUTH-0031/0032 は deviceSrpAuth の NotAuthorizedException 経路(CognitoUser.java:3384-3396)のみを被覆。本件は CUSTOM_CHALLENGE 回答に対する respondToChallenge の ResourceNotFoundException("Device") 分岐(CognitoUser.java:2926-2940)で別経路。grep ResourceNotFound packages/core/src/auth.js は 0 件で kit 側未実装。spec/auth.md の ResourceNotFound 4 件は全て AUTH-0073(GetCredentials/Identity 再解決)で無関係。関連 [[AUTH-0031]]。

### [AUTH-0121] AnalyticsMetadata(pinpoint endpoint)の非送出 negative fact
- surface: core
- backend: cloud
- command: getValidIdToken / respondToPasswordVerifier / cognitoCall(InitiateAuth, RespondToAuthChallenge)
- branch: -
- assert: REFRESH_TOKEN_AUTH の InitiateAuth と RespondToAuthChallenge(PASSWORD_VERIFIER) の payload に AnalyticsMetadata キーが存在しない。参照は pinpointEndpointId != null のときだけ AnalyticsMetadataType(AnalyticsEndpointId) を setAnalyticsMetadata し marshaller が getAnalyticsMetadata()!=null で書くが、kit は Pinpoint 概念を持たず常時非送出する
- ref: packages/core/src/auth.js:224-238; packages/core/src/auth.js:537-543; _aws_sdk_ref/CognitoUser.java:3570-3574; _aws_sdk_ref/CognitoUser.java:3654-3659; _aws_sdk_ref/InitiateAuthRequestMarshaller.java:105-111
- kind: wire-fidelity
- status: covered
- note: subarea=InitiateAuth CUSTOM_AUTH。spec/auth.md に analytics/pinpoint は 0 件(grep 確認)。auth.js header の意図的逸脱リスト(UserContextData/User-Agent/devicePassword の 3 件)にも AnalyticsMetadata は不在で、出典付き negative fact が抜けている。参照 initiateRefreshTokenAuthRequest(:3570-3574)/userSrpAuthRequest(:3654-3659)が pinpointEndpointId!=null ガード。InitiateAuthRequestMarshaller.java:105-111 が AnalyticsMetadata!=null ガード。

### [AUTH-0122] respondToChallenge が全 ChallengeResponses に DEVICE_KEY を無条件 put する負の対比(deviceKey 無し時の wire 一致)
- surface: core
- backend: cloud
- command: loginVerify / RespondToAuthChallenge
- branch: 保存 deviceKey 無し(kit は DEVICE_KEY を付けない)
- assert: 保存済み deviceKey が無い/別 username のとき kit の CUSTOM_CHALLENGE 回答は DEVICE_KEY キー自体を出さない。参照 respondToChallenge は送信直前に challengeResponses.put(DEVICE_KEY, deviceKey) を ChallengeName 不問で無条件実行するが、deviceKey が null のとき marshaller の per-entry value!=null ガードがキーを省くため、両者の wire は DEVICE_KEY 不在で一致する(kit の条件付与 == 参照の無条件 put + null 省略)
- ref: packages/core/src/auth.js:579-587; _aws_sdk_ref/CognitoUser.java:2918-2922; _aws_sdk_ref/RespondToAuthChallengeRequestMarshaller.java:81-95
- kind: wire-fidelity
- status: covered
- note: subarea=CUSTOM_CHALLENGE 回答。AUTH-0019 は『保存 deviceKey 一致時のみ付与』の肯定境界のみを assert し、deviceKey 無し時に kit の条件付与と参照の無条件 put+null 省略が同じ DEVICE_KEY 不在に収束する否定側 wire 一致を主張していない。CognitoUser.java:2919-2922 が無条件 put、RespondToAuthChallengeRequestMarshaller.java:88-92 の challengeResponsesValue!=null ガードで null 値キーを省く。関連 [[AUTH-0019]]。

### [AUTH-0123] SignUp の SecretHash 非送出 negative fact
- surface: core
- backend: cloud
- command: loginInitiate / SignUp
- branch: -
- assert: SignUp payload に SecretHash キーが存在しない。参照 signUpInternal は getSecretHash(userId, clientId, clientSecret) を無条件に計算して withSecretHash(secretHash) するが、Consumer Client は clientSecret が無く secretHash が null になり SignUpRequestMarshaller の getSecretHash()!=null ガードがキーを省く。kit は SignUp に SecretHash を一切組み立てないため構造的に wire 一致する
- ref: packages/core/src/auth.js:324-341; _aws_sdk_ref/SignUpRequestMarshaller.java:68-72; _aws_sdk_ref/CognitoUserPool.java:531-552
- kind: wire-fidelity
- status: covered
- note: subarea=signUp 先行。spec/auth.md の SignUp 系(AUTH-0001/0002/0003/0004)は Password/UserAttributes/ValidationData:[]/ClientMetadata:{} を扱うが SecretHash の非送出には触れていない(grep SecretHash = 0 件)。SRP の CHLG_RESP_SECRET_HASH=null 省略は AUTH-0012/0025/0026 の note にあるが SignUp request の SecretHash は別フィールドで未被覆。SignUpRequestMarshaller.java:68-72 が getSecretHash()!=null ガード。

### [AUTH-0124] AuthFlow は常に CUSTOM_AUTH で USER_SRP_AUTH/USER_PASSWORD_AUTH を選ばない排他 negative fact
- surface: core
- backend: cloud
- command: loginInitiate / InitiateAuth
- branch: AuthFlow=CUSTOM_AUTH 固定(USER_SRP_AUTH / USER_PASSWORD_AUTH を採らない)
- assert: loginInitiate の InitiateAuth は常に AuthFlow=CUSTOM_AUTH を送り、参照 AWSMobileClient の他フロー分岐(USER_PASSWORD_AUTH / 既定 USER_SRP_AUTH→PASSWORD_VERIFIER)を採らない。アプリは authenticationFlowType=CUSTOM_AUTH 構成で signIn(mail,"dummypwk",null) するため resolvedAuthFlowType==CUSTOM_AUTH 経路に固定される
- ref: packages/core/src/auth.js:354-356; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt:131; _aws_sdk_ref/AWSMobileClient.java:1318-1338
- kind: option-branch
- status: covered
- note: subarea=InitiateAuth CUSTOM_AUTH。AUTH-0005 は CUSTOM_AUTH の AuthFlow=CUSTOM_AUTH と AuthParameters 集合を肯定的に照合するが、他フロー非選択(排他性)を assert していない。spec/auth.md に USER_SRP_AUTH/USER_PASSWORD_AUTH は 0 件(grep 確認)。AWSMobileClient.java:1318(CUSTOM_AUTH)/1326(USER_PASSWORD_AUTH)/1333-1337(既定 USER_SRP_AUTH) が 3 分岐。LoginMailFG.kt:131 が password!=null の signIn。auth.js:355 が AuthFlow:"CUSTOM_AUTH" 固定。関連 [[AUTH-0005]]。

### [AUTH-0125] REFRESH_TOKEN_AUTH の AuthParameters に SECRET_HASH を組まない (clientSecret=null → marshaller スキップ) negative-fact
- surface: core, serve, sdk, cli
- backend: cloud
- command: getValidIdToken / cognitoCall(InitiateAuth)
- branch: -
- assert: REFRESH_TOKEN_AUTH の AuthParameters に SECRET_HASH キーが一切現れない。kit は authParameters を {REFRESH_TOKEN(, DEVICE_KEY)} のみで組み SECRET_HASH を入れない (auth.js:226-227)。参照 initiateRefreshTokenAuthRequest は addAuthParametersEntry(SECRET_HASH, clientSecret) を無条件実行するが clientSecret=null のため InitiateAuthRequestMarshaller の value!=null ガードで省かれ、結果ワイヤ形が一致する
- ref: packages/core/src/auth.js:225-238; _aws_sdk_ref/CognitoUser.java:3565-3566; _aws_sdk_ref/InitiateAuthRequestMarshaller.java:70-84
- kind: wire-fidelity
- status: covered
- note: subarea=token refresh / getValidIdToken。AUTH-0040 は REFRESH の正方向ワイヤ形 ({AuthFlow,ClientId,AuthParameters:{REFRESH_TOKEN,...}})、AUTH-0041 は DEVICE_KEY 条件付与を扱うが、SECRET_HASH 非送出 (clientSecret=null marshaller skip) の negative-fact は REFRESH について未索引 (他フロー SignUp/PASSWORD_VERIFIER/DEVICE_PASSWORD_VERIFIER の note には在る)。

### [AUTH-0126] 指数バックオフが Full Jitter delay∈[0,cap) で cap=AWS_RETRY_BASE_MS*2**attempt、参照の 20s cap を持たない意図的逸脱 (3 transport 共通)
- surface: core
- backend: cloud
- command: cognitoCall / cognitoIdentityCall / makeApiGatewayTransport (retry backoff)
- branch: attempt=1..maxRetries (jitter delay 範囲) | retries 増大 (参照は cap 20s 頭打ち・kit は無限増)
- assert: リトライ遅延が Full Jitter (delay ∈ [0, cap)、cap=AWS_RETRY_BASE_MS*2**attempt) で算出される。3 transport (cognito-http/cognitoIdentityCall/apiGateway) すべて同式。参照 PredefinedRetryPolicies.SDKDefaultBackoffStrategy は cap=min(MAX_BACKOFF=20000ms, (1<<retries)*BASE_DELAY=100ms) で 20s 上限を持つが、kit は上限を持たない意図的逸脱として固定する
- ref: packages/core/src/cognito-http.js:118-122; packages/core/src/aws-credentials.js:146-150; packages/core/src/aws-credentials.js:614-618; _aws_sdk_ref/PredefinedRetryPolicies.java:44; _aws_sdk_ref/PredefinedRetryPolicies.java:47; _aws_sdk_ref/PredefinedRetryPolicies.java:221-230
- kind: option-branch
- status: covered
- note: subarea=cognito-http transport / AWS retry・timeout。AUTH-0083 (cognito-http.js:118-141) は retry 既定3回+5xx リトライのみ assert し、backoff 式 (Full Jitter random*[0,cap)) と 20s cap 逸脱は母集合から漏れている。PredefinedRetryPolicies.java:229 が Full Jitter return random.nextInt(min(maxDelayMs,(1<<retries)*baseDelayMs))。

### [AUTH-0127] cognitoIdentityCall (GetId/GetCredentialsForIdentity) の NotAuthorizedException を ERR.UNAUTHENTICATED に分類する境界
- surface: core, serve, sdk
- backend: cloud
- command: makeCognitoCredentialsProvider.getCredentials / cognitoIdentityCall (error 写像)
- branch: NotAuthorizedException (UNAUTHENTICATED) | その他 service error (REJECTED)
- assert: cognitoIdentityCall のエラー応答で __type の '#' 以降 type が 'NotAuthorizedException' のとき SesameError.code=ERR.UNAUTHENTICATED に分類し、他の全 service error は ERR.REJECTED とする (aws-credentials.js:204 の三項)。idToken 失効/連携不可は再ログインで復帰する認証エラーとして cognitoCall (cognito-http) 側の name 写像と整合する
- ref: packages/core/src/aws-credentials.js:194-208
- kind: error-path
- status: covered
- note: subarea=Identity Pool credentials。AUTH-0070 は malformed→REJECTED とフィールド名パースのみ、AUTH-0073 は recoverable(ResourceNotFound/Validation)再GetId と NotAuthorized 即throw の制御フローのみ、AUTH-0081 は __type→Error.name 写像 (aws-credentials.js は data.type 格納) のみで、UNAUTHENTICATED vs REJECTED の code 分岐は未拾い。

### [AUTH-0128] logout が ForgetDevice 前に getValidIdToken(marginSec:300) で AccessToken を更新し、RevokeToken には store 再読みの rotated refreshToken を渡す境界
- surface: core, cli
- backend: cloud
- command: logout / `sesame logout`
- branch: idToken near-expiry (refresh 発火→fresh AccessToken) | refresh 失敗 (catch で ForgetDevice 諦め) | rotation 済み refreshToken 再読み
- assert: deviceKey 有りの logout は ForgetDevice 直前に getValidIdToken(marginSec:300) で AccessToken を更新し (失敗時は catch で旧値のまま=ForgetDevice は best-effort)、RevokeToken には store.load() を再読みした最新 refreshToken (refresh で rotation された場合は新値) を渡して失効させる
- ref: packages/core/src/auth.js:881-892; packages/core/src/auth.js:899-904
- kind: option-branch
- status: covered
- note: subarea=logout (core)。AUTH-0051/0052/0053/0054 は valid-token 直送・best-effort・clientId 復元を扱うが、logout 内の refresh(marginSec:300) による AccessToken 更新分岐と rotated refreshToken の store 再読みは母集合から漏れている。AUTH-0053 の ref(875-909)は範囲に含むが assert は best-effort/local-clear のみ。

### [AUTH-0129] gRPC unary の error 封筒: errorFromThrow(kind)→grpcStatusFor 写像と kind/retryable trailing metadata が 3 メソッドで未被覆
- surface: serve
- backend: cloud
- command: Status / CloudPing / AccountWhoami
- branch: not_authenticated→UNAUTHENTICATED | connection_lost/timeout→UNAVAILABLE | rejected→FAILED_PRECONDITION | bad_params→INVALID_ARGUMENT | not_implemented→UNIMPLEMENTED | 既定→INTERNAL
- assert: gRPC 型付き unary が handler throw を errorFromThrow で正規化し grpcStatusFor(kind) で gRPC status へ写像する (not_authenticated→UNAUTHENTICATED / connection_lost・timeout→UNAVAILABLE / rejected→FAILED_PRECONDITION / 既定→INTERNAL)。さらに Metadata に kind と (boolean のとき) retryable を set して callback({code,message,metadata}) で返す。cloud.ping の requireAuth 由来 not_authenticated/connection_lost がこの第3の error 表面写像 (HTTP 401 封筒・CLI toServeError と並ぶ) で正しい gRPC status になる
- ref: packages/kit/src/serve/framing/grpc.js:85-95; packages/kit/src/serve/framing/grpc.js:150-155; packages/kit/src/serve/registry-helpers.js:55-62; packages/kit/src/serve/entries/auth.js:32-37
- kind: error-path
- status: covered
- note: subarea=cloud.ping (serve)。refs 健全 (grpc.js:85-95 = grpcStatusFor(kind) switch; :150-155 = const norm=errorFromThrow(null,e).error → md.set('kind',kind)/md.set('retryable',...)+callback({code:grpcStatusFor(kind),...metadata:md}))。既存 AUTH-0098/0103 は requireAuth が throw する kind のみ、AUTH-0112 は token 不一致の UNAUTHENTICATED のみ、AUTH-0111 は success の JsonRpc{json} のみ assert し kind→status・trailing metadata 写像は未被覆=真に新規。汎用テスト packages/kit/tests/serve/grpc.test.js:144-157 (FAILED_PRECONDITION+kind/retryable, LockUnlock 経由) は [AUTH-*] タグ無し孤児=catalog 未登録。

### [AUTH-0130] requireAuth の degraded→CONNECTION_LOST 第2ガードが cloud.ping/account.whoami で未被覆 (expired 枝のみ assert 済み)
- surface: serve
- backend: cloud
- command: cloud.ping / account.whoami
- branch: authState=degraded(token あり)+hub.connected=false (CONNECTION_LOST) | authState=ok+connected (通過)
- assert: requireAuth は authState!=='expired' でも hub.connected が false なら 2 段目ガードで RpcError(kind=CONNECTION_LOST, serve.cloudNotConnected) を投げる。authState='degraded'(トークン有り・未接続) の daemon では cloud.ping/account.whoami が NOT_AUTHENTICATED ではなく CONNECTION_LOST に分岐し hub.ping()/hub.getLoginUser() に到達しない (status は requireAuth を通らず degraded でも通る=3 メソッドで挙動が割れる)
- ref: packages/kit/src/serve/registry-helpers.js:59-61; packages/kit/src/serve/entries/auth.js:33; packages/kit/src/serve/entries/auth.js:42; packages/kit/src/serve/daemon.js:147; packages/kit/src/i18n/serve.js:95; packages/kit/src/i18n/serve.js:351
- kind: error-path
- status: covered
- note: subarea=cloud.ping (serve)。refs 健全 (registry-helpers.js:59-61 = if(!daemon.hub.connected) throw new RpcError(t('serve.cloudNotConnected'),{kind:KIND.CONNECTION_LOST}); entries/auth.js:33=cloud.ping handler requireAuth, :42=whoami handler requireAuth; daemon.js:147 = authState = _hasStoredTokens()?'degraded':'expired'; i18n/serve.js:95=en serve.cloudNotConnected, :351=ja)。既存 AUTH-0098/0103 は branch=expired→NOT_AUTHENTICATED のみを assert し degraded→CONNECTION_LOST 枝は assert 散文 (note) 言及のみで未 assert=真に新規 missing-branch (expired 枝の弱体化ではない)。AUTH-0098/0103 と相補。

### [AUTH-0131] proto3 空 request message 契約 (StatusRequest/CloudPingRequest/AccountWhoamiRequest = message{}) と空 jsonFields/optionalScalars が未被覆
- surface: serve
- backend: local
- command: Status / CloudPing / AccountWhoami
- branch: -
- assert: params=[] の 3 メソッドは sesame.proto で本体フィールド 0 個の空 message (message StatusRequest{} 等) として生成され、grpc-methods.generated.json の対応エントリは jsonFields:[]・optionalScalars:[] を持つ。これにより gRPC handler の optional-scalar presence 正規化 (grpc.js:124-132) と jsonFields parse (:137-140) が no-op になり、空 params で daemon.invoke(method,{}) へ届く (param を持つ他 op の optional scalar presence 契約との対照点=params=[] メソッドの正準形)
- ref: packages/kit/src/serve/sesame.proto:1506-1511; packages/kit/src/serve/grpc-methods.generated.json:1500-1513; packages/kit/src/serve/framing/grpc.js:118-140
- kind: payload-fidelity
- status: covered
- note: subarea=3 メソッド proto 契約。refs 健全 (sesame.proto:1506-1511 = message StatusRequest{}/CloudPingRequest{}/AccountWhoamiRequest{} フィールド宣言ゼロ; grpc-methods.generated.json:1500-1513 = Status/CloudPing/AccountWhoami が method 名+jsonFields:[]・optionalScalars:[]; grpc.js:118-140 = optionalScalars/jsonFields ループが空配列で no-op)。既存 AUTH-0108 は rpc 宣言の存在 (Pascal 名・// stable コメント) のみ assert し、request message が空=params 無しという proto3 presence 契約は未 assert=真に新規。AUTH-0108 と相補。

### [AUTH-0132] NDJSON 行フレーミング (1 行=1 JSON / maxLine DoS 上限 / maxQueue 背圧 drop) が stdio・socket 共有実体で未被覆
- surface: serve
- backend: local
- command: status / cloud.ping / account.whoami
- branch: stdio (closeWritable=false) | socket (closeWritable=true)
- assert: makeLineConnection は send=JSON.stringify(obj)+'\n' の 1 行で応答し、受信は inbuf.indexOf('\n') で行分割して 1 リクエスト行を onLine→daemon.handleLine→dispatchMessage に渡す。改行無しで inbuf.length>maxLine は接続切断 (socket は writable.destroy、stdio は触らず conn.close)、送信キューが maxQueue 超過の遅延接続は当該接続のみ close (背圧 drop)。3 メソッドの応答がこの行プロトコルで届く
- ref: packages/kit/src/serve/framing/ndjson.js:33-49; packages/kit/src/serve/framing/ndjson.js:53-70; packages/kit/src/serve/framing/stdio.js:11-25; packages/kit/src/serve/framing/socket.js:46-58
- kind: wire-fidelity
- status: covered
- note: subarea=framing ndjson wire。refs 全実在・支持確認。ndjson.js:35 send 1行化、:38-40 queue>maxQueue→close (背圧)、:57-61 indexOf('\n') 行分割、:66-69 inbuf>maxLine→socket destroy/stdio 非破壊。AUTH-0109 は framing 横断 parity (同一 hub 結果)、AUTH-0112 は token 認可のみで、ndjson 固有の行境界・maxLine・背圧 wire 契約は auth.md に無い。関連 [[AUTH-0109]] と相補。

### [AUTH-0133] gRPC 汎用 Invoke の null 応答エンコード非対称 ({json:''} vs unary {json:'null'}) が未被覆
- surface: serve
- backend: local
- command: Invoke / Status / CloudPing / AccountWhoami
- branch: unary 型付き (result??null→'null') | Invoke 汎用 (out===null→'')
- assert: gRPC 汎用 Invoke は daemon.dispatchMessage の戻り out が null(通知)のとき callback(null,{json:''}) を返し、型付き unary が callback(null,{json:JSON.stringify(result??null)}) で null→'null' を返すのと非対称。Invoke 経由でも 3 メソッドの非通知 result は JSON.stringify(out) の文字列で運ばれる (JsonRpc{json} を 1 回 JSON.parse 前提のクライアントが '' を受けると例外)
- ref: packages/kit/src/serve/framing/grpc.js:163-172; packages/kit/src/serve/framing/grpc.js:146
- kind: wire-fidelity
- status: covered
- note: subarea=framing grpc wire。refs 全実在・支持確認。grpc.js:171 callback(null,{json: out===null?'':JSON.stringify(out)})、:146 callback(null,{json:JSON.stringify(result??null)})。AUTH-0111 は『Invoke は dispatchMessage 経由』『unary は result??null→'null'』を述べるが Invoke の null→'' エンコード差を assert しない。関連 [[AUTH-0111]] と相補。
