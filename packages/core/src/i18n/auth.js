// 認証 (src/auth.js) のユーザー向けエラーメッセージ。
// 注: auth.js のロジック/トークン処理は不可侵。ここは文字列の外出しのみ。
export default {
  en: {
    "auth.noTokens": "No tokens stored. Sign in with `sesame login <email>`.",
    "auth.noPending": "No pending sign-in. Run `login <email>` first.",
    "auth.anotherChallenge": "Another challenge required: {name}. (sign in again)",
    "auth.wrongCodeRetry": "Incorrect code. Run `sesame verify <code>` again with the right code.",
    "auth.staleDeviceRetry": "Stored device credentials were rejected and have been cleared. A new sign-in code was emailed — run `sesame verify <code>` again with the new code.",
    // P5-1: 以下 2 キーは元の英語ハードコードを i18n 化 (auth.js:174/435 相当)。
    "auth.noRefreshToken": "idToken expired and no refreshToken stored. Re-run `sesame login <email>`.",
    "auth.noDeviceCredentials": "No stored device credentials for DEVICE_SRP_AUTH. Re-run `sesame login <email>` to re-register device.",
  },
  ja: {
    "auth.noTokens": "No tokens stored. `sesame login <email>` で sign-in してください。",
    "auth.noPending": "No pending sign-in. 先に `login <email>` を実行してください。",
    "auth.anotherChallenge": "Another challenge required: {name}. (再 login が必要)",
    "auth.wrongCodeRetry": "コードが違います。正しいコードで `sesame verify <code>` をもう一度実行してください。",
    "auth.staleDeviceRetry": "保存済みデバイス資格情報が拒否されたため破棄しました。新しい確認コードを email に送信したので、新コードで `sesame verify <code>` をもう一度実行してください。",
    "auth.noRefreshToken": "idToken が失効しており refreshToken もありません。`sesame login <email>` で再 login してください。",
    "auth.noDeviceCredentials": "DEVICE_SRP_AUTH に必要なデバイス資格情報が保存されていません。`sesame login <email>` で再 login してください。",
  },
};
