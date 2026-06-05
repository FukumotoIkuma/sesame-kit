// `sesame company …` コマンド群。
//
// 本体ロジックは src/company.js (biz3ManageCompany: getCompanies /
// updateCompanyName / addCompany / getPaymentConfig)。
// ここは commander への配線と入出力整形のみを担う。
//
// ctx 契約 (cli.js makeCtx が供給。schedule.js のコメント参照):
//   ctx.withHub(fn)      : connect → fn(hub, {opts}) → close。
//   ctx.withAccount(fn)  : withHub + 事前に refreshAccount() で実 companyID/subUUID 保証。
//                          companyID 必須の op (updateName/getPaymentConfig) はこちら。
//   ctx.out(json, humanFn, jsonObj) : --json 時は jsonObj、それ以外は humanFn()。
//   ctx.die(msg, code)   : エラー表示して exit。
//   ctx.canPrompt()      : TTY かつ --json なし。
//   ctx.prompts          : { selectFromList, promptText, confirm, promptLine }。
//
// 注: biz3ManageCompany の op はいずれも純 JSON フレーム (binary packing 無し)。
//     namespace hub.company.* は companyID/subUUID を自動注入する。companyID は
//     refreshAccount() で実 (priorityCompanyId) 値に更新されるため withAccount を使う。
//     get だけは companyID 不要だが、一覧の各要素に companyID が含まれる一次データなので
//     ここでも withAccount で揃える (実害なし)。

/**
 * @param {import("commander").Command} program
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerCompanyCommands(program, ctx) {
  const company = program.command("company").description("会社管理 (biz3ManageCompany: 一覧 / 改名 / 追加 / 課金設定)");

  // sesame company ls
  company.command("ls")
    .description("ログインユーザに紐づく会社一覧 (getCompanies)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const items = await hub.company.getCompanies();
        ctx.out(opts.json, () => {
          if (!Array.isArray(items) || items.length === 0) {
            console.log("(no companies)");
            return;
          }
          console.log(`Found ${items.length} compan${items.length === 1 ? "y" : "ies"}:`);
          for (const c of items) {
            const id = c.companyID ?? "(no-id)";
            const name = c.name ?? "(no-name)";
            // tag[0]==='オーナー' で owner 判定 (useStripeInfo.js)。
            const owner = Array.isArray(c.tag) && c.tag[0] === "オーナー" ? " [オーナー]" : "";
            console.log(`  ${id}\t${name}${owner}`);
          }
        }, { ok: true, count: Array.isArray(items) ? items.length : 0, companies: items });
      }),
    );

  // sesame company rename <name>
  company.command("rename <name>")
    .description("優先会社の会社名を変更 (updateCompanyName。companyID は自動注入)")
    .action((name) =>
      ctx.withAccount(async (hub, { opts }) => {
        // companyID は refreshAccount() 済みなので namespace が自動注入する。
        const resp = await hub.company.updateCompanyName({ name });
        ctx.out(opts.json, () => {
          console.log(`OK: renamed company ${resp?.companyID ?? ""} → "${resp?.name ?? name}"`);
        }, { ok: true, company: resp });
      }),
    );

  // sesame company add <name>
  company.command("add <name>")
    .description("会社を新規登録 (addCompany。employeeEmail/subUUID はログインユーザの customerInfo 由来)")
    .action((name) =>
      ctx.withAccount(async (hub, { opts, customerInfo }) => {
        // biz3 addCompany は name に加え employeeEmail / subUUID を必須で要求する
        // (layout/index.js が customerInfo から渡す)。withAccount が refreshAccount() で
        // 取得済みの customerInfo を渡してくれるため、getLoginUser() を再度呼ばない。
        const employeeEmail = customerInfo?.employeeEmail;
        const subUUID = customerInfo?.subUUID;
        if (!employeeEmail || !subUUID) {
          ctx.die("ログインユーザの customerInfo に employeeEmail/subUUID がありません (再 login が必要かもしれません)。", 1);
          return;
        }
        const resp = await hub.company.addCompany({ name, employeeEmail, subUUID });
        ctx.out(opts.json, () => {
          // add 応答 data の個別フィールドは biz3 で読み出されておらず詳細は未確認。
          console.log(`OK: added company "${name}"${resp?.companyID ? ` (${resp.companyID})` : ""}`);
        }, { ok: true, company: resp });
      }),
    );

  // sesame company payment
  company.command("payment")
    .description("優先会社の課金レベル設定を取得 (getPaymentConfig。応答 data の構造は未確認)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        // companyID は refreshAccount() 済みのものを namespace が自動注入する。
        const config = await hub.company.getPaymentConfig();
        ctx.out(opts.json, () => {
          if (config == null) {
            console.log("(no payment config / 応答 data 無し)");
            return;
          }
          // 未確認: 応答 data のフィールド集合 (実機検証要)。そのまま整形出力する。
          console.log(JSON.stringify(config, null, 2));
        }, { ok: true, paymentConfig: config });
      }),
    );
}
