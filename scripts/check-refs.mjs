// 参照実装健全性チェック。
//
// 目的: _aws_sdk_ref/ / _sesame_sdk_ref/ / references_web/ の主要ファイルについて
//       「存在・非空・期待シンボル含有」を検査し、結果を表で出力する。
//       欠損・空・プレースホルダ(404: Not Found)があれば exit 1。
//
// 実行: node scripts/check-refs.mjs  (または npm run check:refs)
// CI には載せない(参照ディレクトリは gitignored のため)。
//
// 期待シンボルは参照ファイル実物から確認した実在シンボルを使う:
//   - CognitoUser.java → "Caldera Derived Key"
//     (AuthenticationHelper インナークラス :4027 で DERIVED_KEY_INFO 定数として使用)
//   - Hkdf.java → "deriveKey"
//     (Hkdf.java:119 public メソッド)
//   - CognitoCredentialsProvider.java → "DEFAULT_THRESHOLD_SECONDS"
//     (CognitoCredentialsProvider.java:67 定数)
//   - CHHub3Device.kt → "CHHub3Device"
//     (CHHub3Device.kt:49 クラス定義)
//   - useManageDevice.js → "useManageDevice"
//     (useManageDevice.js:11 export)

import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// プレースホルダ検出: 14 バイトの "404: Not Found" が過去に混入していた
// (REFACTORING_PLAN.md §0.1 規範9 / P2-1 の発生源)
const PLACEHOLDER = "404: Not Found";

/** @type {Array<{label: string, file: string, symbol: string}>} */
const CHECKS = [
  // _aws_sdk_ref/ — AWSMobileClient 2.77.0 Java (auth 数式・Cognito ワイヤ形の最一次資料)
  {
    label: "_aws_sdk_ref/CognitoUser.java",
    file: "_aws_sdk_ref/CognitoUser.java",
    // AuthenticationHelper インナークラス(CognitoUser.java:4027)の DERIVED_KEY_INFO 定数
    symbol: "Caldera Derived Key",
  },
  {
    label: "_aws_sdk_ref/Hkdf.java",
    file: "_aws_sdk_ref/Hkdf.java",
    // Hkdf.java:119 の public メソッド
    symbol: "deriveKey",
  },
  {
    label: "_aws_sdk_ref/AWSMobileClient.java",
    file: "_aws_sdk_ref/AWSMobileClient.java",
    // AWSMobileClient.java:1203 の signIn メソッド
    symbol: "signIn",
  },
  {
    label: "_aws_sdk_ref/AuthenticationDetails.java",
    file: "_aws_sdk_ref/AuthenticationDetails.java",
    // AuthenticationDetails.java クラス定義
    symbol: "AuthenticationDetails",
  },
  {
    label: "_aws_sdk_ref/ChallengeContinuation.java",
    file: "_aws_sdk_ref/ChallengeContinuation.java",
    // ChallengeContinuation.java クラス定義
    symbol: "ChallengeContinuation",
  },
  {
    label: "_aws_sdk_ref/CognitoDeviceHelper.java",
    file: "_aws_sdk_ref/CognitoDeviceHelper.java",
    // CognitoDeviceHelper.java:42 クラス定義
    symbol: "CognitoDeviceHelper",
  },
  {
    label: "_aws_sdk_ref/CognitoCredentialsProvider.java",
    file: "_aws_sdk_ref/CognitoCredentialsProvider.java",
    // CognitoCredentialsProvider.java:67 閾値定数(P2-5 で参照)
    symbol: "DEFAULT_THRESHOLD_SECONDS",
  },
  {
    label: "_aws_sdk_ref/CognitoCachingCredentialsProvider.java",
    file: "_aws_sdk_ref/CognitoCachingCredentialsProvider.java",
    // CognitoCachingCredentialsProvider.java:78 クラス定義
    symbol: "CognitoCachingCredentialsProvider",
  },
  {
    label: "_aws_sdk_ref/CognitoIdentityProviderClientConfig.java",
    file: "_aws_sdk_ref/CognitoIdentityProviderClientConfig.java",
    // クラス定義
    symbol: "CognitoIdentityProviderClientConfig",
  },
  {
    label: "_aws_sdk_ref/SignUpRequestMarshaller.java",
    file: "_aws_sdk_ref/SignUpRequestMarshaller.java",
    // P2-6 で使う SignUp ワイヤ形マーシャラ
    symbol: "SignUpRequestMarshaller",
  },
  {
    label: "_aws_sdk_ref/InitiateAuthRequestMarshaller.java",
    file: "_aws_sdk_ref/InitiateAuthRequestMarshaller.java",
    // P2-6 で使う InitiateAuth ワイヤ形マーシャラ
    symbol: "InitiateAuthRequestMarshaller",
  },
  {
    label: "_aws_sdk_ref/RespondToAuthChallengeRequestMarshaller.java",
    file: "_aws_sdk_ref/RespondToAuthChallengeRequestMarshaller.java",
    // P2-6 で使う RespondToAuthChallenge ワイヤ形マーシャラ
    symbol: "RespondToAuthChallengeRequestMarshaller",
  },
  {
    label: "_aws_sdk_ref/ClientConfiguration.java",
    file: "_aws_sdk_ref/ClientConfiguration.java",
    // P3-13: DEFAULT_SOCKET_TIMEOUT = 15_000 / DEFAULT_CONNECTION_TIMEOUT = 15_000
    // (ClientConfiguration.java:33,36)
    symbol: "DEFAULT_SOCKET_TIMEOUT",
  },
  {
    label: "_aws_sdk_ref/PredefinedRetryPolicies.java",
    file: "_aws_sdk_ref/PredefinedRetryPolicies.java",
    // P3-13: DEFAULT_MAX_ERROR_RETRY = 3 (PredefinedRetryPolicies.java:50)
    symbol: "DEFAULT_MAX_ERROR_RETRY",
  },
  {
    label: "_aws_sdk_ref/RetryUtils.java",
    file: "_aws_sdk_ref/RetryUtils.java",
    // P3-13: isThrottlingException (RetryUtils.java:34)
    symbol: "isThrottlingException",
  },

  // _sesame_sdk_ref/ — Android SesameSDK (アプリのフロー結線)
  {
    label: "_sesame_sdk_ref/.../CHHub3Device.kt",
    file: "_sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt",
    // CHHub3Device.kt:49 クラス定義
    symbol: "CHHub3Device",
  },
  {
    label: "_sesame_sdk_ref/.../LoginMailFG.kt",
    file: "_sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/account/LoginMailFG.kt",
    // LoginMailFG.kt でのサインイン呼び出し
    symbol: "signIn",
  },

  // references_web/ — biz3 web (クラウドトランスポートのワイヤ形)
  {
    label: "references_web/.../useManageDevice.js",
    file: "references_web/src/api/useManageDevice.js",
    // useManageDevice.js:11 export
    symbol: "useManageDevice",
  },
];

/** @type {Array<{label: string, status: string, detail: string, ok: boolean}>} */
const results = [];

for (const { label, file, symbol } of CHECKS) {
  const fullPath = join(ROOT, file);

  // 存在チェック
  if (!existsSync(fullPath)) {
    results.push({ label, status: "MISSING", detail: "ファイルが存在しない", ok: false });
    continue;
  }

  // 非空チェック
  const stat = statSync(fullPath);
  if (stat.size === 0) {
    results.push({ label, status: "EMPTY", detail: "ファイルが空", ok: false });
    continue;
  }

  // コンテンツ読み取り
  let content;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch (e) {
    results.push({ label, status: "ERROR", detail: `読み取り失敗: ${e.message}`, ok: false });
    continue;
  }

  // プレースホルダチェック (14 バイト "404: Not Found" の再発防止)
  if (content.trim() === PLACEHOLDER || content.trim().startsWith(PLACEHOLDER)) {
    results.push({
      label,
      status: "PLACEHOLDER",
      detail: `"${PLACEHOLDER}" プレースホルダ — 実体ファイルを配置すること`,
      ok: false,
    });
    continue;
  }

  // 期待シンボルチェック
  if (!content.includes(symbol)) {
    results.push({
      label,
      status: "MISSING_SYMBOL",
      detail: `期待シンボル "${symbol}" が見つからない`,
      ok: false,
    });
    continue;
  }

  results.push({ label, status: "OK", detail: `"${symbol}" 確認済み`, ok: true });
}

// 結果テーブル出力
const COL1 = Math.max(12, ...results.map((r) => r.label.length));
const COL2 = 14;
const COL3 = Math.max(8, ...results.map((r) => r.detail.length));

const header = `${"ファイル".padEnd(COL1)}  ${"ステータス".padEnd(COL2)}  詳細`;
const sep = `${"-".repeat(COL1)}  ${"-".repeat(COL2)}  ${"-".repeat(COL3)}`;
console.log(header);
console.log(sep);
for (const r of results) {
  const icon = r.ok ? "PASS" : "FAIL";
  console.log(`${r.label.padEnd(COL1)}  ${(icon + " " + r.status).padEnd(COL2)}  ${r.detail}`);
}

const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok);
console.log(`\n${passed.length}/${results.length} checks passed.`);

if (failed.length > 0) {
  console.error(
    `\n${failed.length} check(s) FAILED — 参照ファイルを補完してから再実行すること (REFERENCES.md の「How to populate」を参照)。`,
  );
  process.exit(1);
}

console.log("参照ファイルの健全性確認 OK。");
