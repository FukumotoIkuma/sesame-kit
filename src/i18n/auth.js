// 認証 (src/auth.js) のユーザー向けエラーメッセージ。
// 注: auth.js のロジック/トークン処理は不可侵。ここは文字列の外出しのみ。
export default {
  en: {
    "auth.noTokens": "No tokens stored. Sign in with `sesame login <email>`.",
    "auth.noPending": "No pending sign-in. Run `login <email>` first.",
    "auth.anotherChallenge": "Another challenge required: {name}. (sign in again)",
  },
  ja: {
    "auth.noTokens": "No tokens stored. `sesame login <email>` で sign-in してください。",
    "auth.noPending": "No pending sign-in. 先に `login <email>` を実行してください。",
    "auth.anotherChallenge": "Another challenge required: {name}. (再 login が必要)",
  },
};
