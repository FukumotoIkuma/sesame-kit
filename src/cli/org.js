// `sesame org …` コマンド群。
//
// 本体ロジックは src/org.js (biz3 組織管理: employee / employeeGroup / role /
// deviceGroup / employeeDevice / getDeviceEmployeeKeys)。ここは commander への配線と
// 入出力整形のみを担う。
//
// ctx 契約 (cli.js makeCtx が供給。schedule.js のコメント参照):
//   ctx.withHub(fn)      : connect → fn(hub, {opts}) → close。
//   ctx.withAccount(fn)  : withHub + 事前に refreshAccount() で実 companyID/subUUID 保証。
//                          org の op はほぼ全て companyID 必須なので基本こちらを使う。
//   ctx.out(json, humanFn, jsonObj) : --json 時は jsonObj、それ以外は humanFn()。
//   ctx.die(msg, code)   : エラー表示して exit。
//   ctx.canPrompt()      : TTY かつ --json なし。
//   ctx.prompts          : { selectFromList, promptText, confirm, promptLine }。
//
// namespace hub.org.* は companyID / subUUID を自動注入する。companyID は
// refreshAccount() で実値に更新されるため、companyID を要する op は withAccount を使う。
// gid のみで companyID を送らない op (getBindDeviceGroup / getBindUserGroup) も、
// 接続前提を揃えるため withAccount で扱う (実害なし)。
//
// 構造化された配列/オブジェクト (items / data / item 等) を要する作成・更新・削除系は
// --json <文字列> で受け、JSON.parse する。biz3 のネスト差異 (companyID キー名が
// employee系='companyID' / employeeGroup・deviceGroup='cid' 等、本体 JSDoc 参照) は
// 本体側で吸収済みなので、ここでは本体の引数名にそのまま合わせる。

import { buildShareKeyUrl } from "../sharekey.js";

/**
 * @param {import("commander").Command} program
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerOrgCommands(program, ctx) {
  const org = program.command("org").description("組織管理 (biz3: 社員 / 社員グループ / 役割タグ / デバイスグループ / 鍵共有)");

  // ════════════════════════════════════════════════════════════════════════
  //  org employee … (biz3ManageEmployee)
  // ════════════════════════════════════════════════════════════════════════
  const employee = org.command("employee").description("社員管理 (一覧/追加/更新/削除/並替/検索/自己情報)");

  // sesame org employee ls
  employee.command("ls")
    .description("社員一覧 (getEmployees。pubEmployees push を全 page 集約)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        // 戻りは { count, list } (count=totalCount)。
        const { count, list } = await hub.org.getEmployees();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log("(no employees)");
            return;
          }
          console.log(`Found ${list.length} employee(s) (totalCount=${count}):`);
          for (const e of list) {
            const id = e.subUUID ?? "(no-uuid)";
            const name = e.employeeName ?? e.nickname ?? "(no-name)";
            const mail = e.employeeEmail ? `\t${e.employeeEmail}` : "";
            console.log(`  ${id}\t${name}${mail}`);
          }
        }, { ok: true, count, employees: list });
      }),
    );

  // sesame org employee me
  employee.command("me")
    .description("ログイン中の自分自身の社員情報 (getCurrentUserInfo。data 構造は biz3 未確認)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const info = await hub.org.getCurrentUserInfo();
        ctx.out(opts.json, () => {
          console.log(JSON.stringify(info, null, 2));
        }, { ok: true, currentUser: info });
      }),
    );

  // sesame org employee add --json <items>
  employee.command("add")
    .description("社員を追加 (addEmployees。items は配列で各要素に companyID を含める)")
    .option("--json <items>", 'JSON 配列。例 \'[{"employeeEmail":"a@b.c","employeeName":"山田","tag":[]}]\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('items が必要です: sesame org employee add --json \'[{"employeeEmail":"…","employeeName":"…"}]\'', 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"employeeEmail":"a@b.c","employeeName":"山田"}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die("--json は配列である必要があります。", 2); return; }
        // 各要素に companyID を補完 (本体 addEmployees は item 内 companyID を期待。biz3 同様)。
        // companyID を後置し、item 内に空文字/null が紛れても必ず有効値が勝つようにする
        // (明示の有効な companyID があればそれを尊重)。
        const withCid = items.map((it) => ({ ...it, companyID: it.companyID || hub.config.companyID }));
        const resp = await hub.org.addEmployees({ items: withCid });
        ctx.out(opts.json, () => {
          console.log(`OK: requested add of ${withCid.length} employee(s)`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee update --json <data>
  employee.command("update")
    .description("社員情報を更新 (updateEmployee。companyID は自動注入、更新フィールドは --json で渡す)")
    .option("--json <data>", 'JSON オブジェクト。例 \'{"Name":"nickname","Value":"新名"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('更新フィールドが必要です: sesame org employee update --json \'{"Name":"…","Value":"…"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"Name":"nickname","Value":"新名"}');
        if (data === undefined) return;
        const resp = await hub.org.updateEmployee({ data });
        ctx.out(opts.json, () => {
          console.log("OK: employee updated");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee rm --json <items>
  employee.command("rm")
    .description("社員を削除 (removeEmployees。items は社員オブジェクト/[{subUUID,companyID}] 配列)")
    .option("--json <items>", 'JSON 配列。例 \'[{"subUUID":"…","companyID":"…"}]\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('items が必要です: sesame org employee rm --json \'[{"subUUID":"…"}]\'', 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"subUUID":"…","companyID":"…"}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die("--json は配列である必要があります。", 2); return; }
        const resp = await hub.org.removeEmployees({ items });
        ctx.out(opts.json, () => {
          console.log(`OK: requested removal of ${items.length} employee(s)`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee reorder --json <items>
  employee.command("reorder")
    .description("社員の並び順を更新 (reorderEmployees。各要素 {friendUUID, rank})")
    .option("--json <items>", 'JSON 配列。例 \'[{"friendUUID":"…","rank":0},{"friendUUID":"…","rank":-1}]\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('items が必要です: sesame org employee reorder --json \'[{"friendUUID":"…","rank":0}]\'', 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"friendUUID":"…","rank":0}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die("--json は配列である必要があります。", 2); return; }
        const resp = await hub.org.reorderEmployees({ items });
        ctx.out(opts.json, () => {
          console.log(`OK: reorder requested (${items.length} item(s))`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee search <keyword>
  employee.command("search <keyword>")
    .description("CS 横断でユーザーを検索 (queryByCS。pubQueryByCS push を全 page 集約)")
    .action((keyword) =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.queryByCS({ keyword });
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log("(no matches)");
            return;
          }
          console.log(`Found ${list.length} match(es):`);
          for (const u of list) {
            const id = u.subUUID ?? "(no-uuid)";
            const name = u.employeeName ?? u.nickname ?? "";
            const mail = u.employeeEmail ?? u.email ?? "";
            console.log(`  ${id}\t${name}\t${mail}`);
          }
        }, { ok: true, count: Array.isArray(list) ? list.length : 0, results: list });
      }),
    );

  // sesame org employee confirm <email>
  employee.command("confirm <email>")
    .description("queryByCS で見つけたユーザーを確定 (confirmQueryByCS)。注: biz3 では成功時に現セッションを signout する設計")
    .action((email) =>
      ctx.withAccount(async (hub, { opts }) => {
        // 副作用が重い (biz3 UI は成功時 signout)。対話可能なら確認を取る。
        if (ctx.canPrompt()) {
          const ok = await ctx.prompts.confirm(
            `confirmQueryByCS は biz3 では成功時に現セッションを signout します。続行しますか? (${email})`,
            { defaultYes: false },
          );
          // 正常な中断: die (Error: プレフィックス + process.exit で finally skip) ではなく
          // plain log + return にして withHub の close() を生かす。
          if (!ok) { console.error("中止しました。"); return; }
        }
        const resp = await hub.org.confirmQueryByCS({ email });
        ctx.out(opts.json, () => {
          console.log(`OK: confirmed ${email}`);
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org group … (社員グループ, biz3ManageEmployeeGroup)
  // ════════════════════════════════════════════════════════════════════════
  const group = org.command("group").description("社員グループ管理 (一覧/追加/更新/削除/メンバー紐付/デバイスグループ連携)");

  // sesame org group ls
  group.command("ls")
    .description("社員グループ一覧 (getEmployeeGroups)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getEmployeeGroups();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log("(no employee groups)");
            return;
          }
          console.log(`Found ${list.length} employee group(s):`);
          for (const g of list) {
            const id = g.gid ?? g.groupId ?? "(no-id)";
            const name = g.name ?? g.groupName ?? "(no-name)";
            console.log(`  ${id}\t${name}`);
          }
        }, { ok: true, count: Array.isArray(list) ? list.length : 0, groups: list });
      }),
    );

  // sesame org group add --json <item>
  group.command("add")
    .description("社員グループを追加 (addEmployeeGroup。companyID は自動注入、item は --json)")
    .option("--json <item>", 'JSON オブジェクト (グループ名等は biz3 UI 依存で未確認)。例 \'{"name":"営業部"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('item が必要です: sesame org group add --json \'{"name":"営業部"}\'', 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, '{"name":"営業部"}');
        if (item === undefined) return;
        const created = await hub.org.addEmployeeGroup({ item });
        ctx.out(opts.json, () => {
          console.log(`OK: added employee group${created?.gid ? ` (${created.gid})` : ""}`);
        }, { ok: true, group: created });
      }),
    );

  // sesame org group update --json <item>
  group.command("update")
    .description("社員グループを更新 (updateEmployeeGroup。item に gid 等を含める)")
    .option("--json <item>", 'JSON オブジェクト。例 \'{"gid":"…","name":"新名"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('item が必要です: sesame org group update --json \'{"gid":"…","name":"…"}\'', 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, '{"gid":"…","name":"新名"}');
        if (item === undefined) return;
        const resp = await hub.org.updateEmployeeGroup({ item });
        ctx.out(opts.json, () => {
          console.log("OK: employee group updated");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group rm --json <gids>
  group.command("rm")
    .description("社員グループを削除 (removeEmployeeGroups。gids は配列、要素型は biz3 UI 依存で未確認)")
    .option("--json <gids>", 'JSON 配列。例 \'["gid1","gid2"]\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('gids が必要です: sesame org group rm --json \'["gid1"]\'', 2);
          return;
        }
        const gids = ctx.parseJson(cmdOpts.json, '["gid1","gid2"]');
        if (gids === undefined) return;
        if (!Array.isArray(gids)) { ctx.die("--json は配列である必要があります。", 2); return; }
        const resp = await hub.org.removeEmployeeGroups({ gids });
        ctx.out(opts.json, () => {
          console.log(`OK: requested removal of ${gids.length} group(s)`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group device-groups <gid>
  group.command("device-groups <gid>")
    .description("社員グループに紐づくデバイスグループを取得 (getEmployeeGroupBindDeviceGroup。cid は送らない)")
    .action((gid) =>
      ctx.withAccount(async (hub, { opts }) => {
        const data = await hub.org.getEmployeeGroupBindDeviceGroup({ gid });
        ctx.out(opts.json, () => {
          // data 構造は biz3 未確認。そのまま整形出力。
          console.log(JSON.stringify(data, null, 2));
        }, { ok: true, gid, bindDeviceGroup: data });
      }),
    );

  // sesame org group add-users <gid> --json <body>
  group.command("add-users <gid>")
    .description("社員グループにユーザーを紐付け (addEmployeeInGroup。uuids/items 両方を --json で渡す)")
    .option("--json <body>", 'JSON {uuids,items}。例 \'{"uuids":["sub1"],"items":[{"subUUID":"sub1"}]}\'')
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('uuids/items が必要です: sesame org group add-users <gid> --json \'{"uuids":[],"items":[]}\'', 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["sub1"],"items":[{"subUUID":"sub1"}]}');
        if (body === undefined) return;
        // rm-users と対称に uuids/items の配列性を検証 (undefined のまま送ると曖昧な失敗になる)。
        if (!Array.isArray(body.uuids) || !Array.isArray(body.items)) {
          ctx.die('--json の uuids / items は配列である必要があります。', 2); return;
        }
        const resp = await hub.org.addEmployeeInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(`OK: bound users to group ${gid}`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group rm-users <gid> --json <body>
  group.command("rm-users <gid>")
    .description("社員グループからユーザーを解除 (removeEmployeeInGroup。items は {subUUID} に絞り込まれる)")
    .option("--json <body>", 'JSON {uuids,items}。例 \'{"uuids":["sub1"],"items":[{"subUUID":"sub1"}]}\'')
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('uuids/items が必要です: sesame org group rm-users <gid> --json \'{"uuids":[],"items":[]}\'', 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["sub1"],"items":[{"subUUID":"sub1"}]}');
        if (body === undefined) return;
        if (!Array.isArray(body.items)) { ctx.die('--json の items は配列である必要があります。', 2); return; }
        const resp = await hub.org.removeEmployeeInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(`OK: unbound users from group ${gid}`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group rm-device-group --json <data>
  group.command("rm-device-group")
    .description("社員グループからデバイスグループを解除 (removeEmployeeGroupBindDeviceGroup。data 内容は biz3 未確認)")
    .option("--json <data>", 'JSON オブジェクト (gid 等。biz3 UI 依存で未確認)。')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org group rm-device-group --json \'{"gid":"…"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"gid":"…"}');
        if (data === undefined) return;
        const resp = await hub.org.removeEmployeeGroupBindDeviceGroup({ data });
        ctx.out(opts.json, () => {
          console.log("OK: unbound device group from employee group");
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org role … (役割タグ, biz3ManageRole)
  // ════════════════════════════════════════════════════════════════════════
  const role = org.command("role").description("役割タグ管理 (一覧/追加更新/削除)");

  // sesame org role ls
  role.command("ls")
    .description("役割タグ一覧 (getTags)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getTags();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log("(no role tags)");
            return;
          }
          console.log(`Found ${list.length} role tag(s):`);
          for (const t of list) {
            const id = t.id ?? t.tagId ?? "(no-id)";
            const name = t.name ?? t.tagName ?? "(no-name)";
            console.log(`  ${id}\t${name}`);
          }
        }, { ok: true, count: Array.isArray(list) ? list.length : 0, tags: list });
      }),
    );

  // sesame org role post --json <data>
  role.command("post")
    .description("役割タグを追加/更新 (postTag。companyID は自動注入、data は --json)")
    .option("--json <data>", 'JSON オブジェクト (タグ名等。biz3 UI 依存)。例 \'{"name":"管理者"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org role post --json \'{"name":"管理者"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"name":"管理者"}');
        if (data === undefined) return;
        const resp = await hub.org.postTag({ data });
        ctx.out(opts.json, () => {
          console.log("OK: role tag posted");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org role rm --json <data>
  role.command("rm")
    .description("役割タグを削除 (removeTag。data 内容は biz3 UI 依存)")
    .option("--json <data>", 'JSON オブジェクト。例 \'{"id":"…"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org role rm --json \'{"id":"…"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"id":"…"}');
        if (data === undefined) return;
        const resp = await hub.org.removeTag({ data });
        ctx.out(opts.json, () => {
          console.log("OK: role tag removed");
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org device-group … (デバイスグループ, biz3ManageDeviceGroup)
  // ════════════════════════════════════════════════════════════════════════
  const deviceGroup = org.command("device-group").description("デバイスグループ管理 (一覧/作成/更新/削除/デバイス紐付/社員グループ連携)");

  // sesame org device-group ls
  deviceGroup.command("ls")
    .description("デバイスグループ一覧 (getDeviceGroups)")
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getDeviceGroups();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log("(no device groups)");
            return;
          }
          console.log(`Found ${list.length} device group(s):`);
          for (const g of list) {
            const id = g.gid ?? g.groupId ?? "(no-id)";
            const name = g.name ?? g.groupName ?? "(no-name)";
            console.log(`  ${id}\t${name}`);
          }
        }, { ok: true, count: Array.isArray(list) ? list.length : 0, groups: list });
      }),
    );

  // sesame org device-group add <name> [--uuids <json>]
  deviceGroup.command("add <name>")
    .description("デバイスグループを作成 (addDeviceGroup。companyID は自動注入)")
    .option("--uuids <json>", 'JSON 配列の deviceUUID。例 \'["uuid1","uuid2"]\'', "[]")
    .action((name, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        const uuids = ctx.parseJson(cmdOpts.uuids, '["uuid1","uuid2"]');
        if (uuids === undefined) return;
        if (!Array.isArray(uuids)) { ctx.die("--uuids は配列である必要があります。", 2); return; }
        const resp = await hub.org.addDeviceGroup({ name, uuids });
        ctx.out(opts.json, () => {
          console.log(`OK: created device group "${name}" (${uuids.length} device(s))`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group update --json <item>
  deviceGroup.command("update")
    .description("デバイスグループを更新 (updateDeviceGroup。item に gid 等を含める)")
    .option("--json <item>", 'JSON オブジェクト。例 \'{"gid":"…","name":"新名"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('item が必要です: sesame org device-group update --json \'{"gid":"…","name":"…"}\'', 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, '{"gid":"…","name":"新名"}');
        if (item === undefined) return;
        const resp = await hub.org.updateDeviceGroup({ item });
        ctx.out(opts.json, () => {
          console.log("OK: device group updated");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group rm --json <groupIds>
  deviceGroup.command("rm")
    .description("デバイスグループを削除 (removeDeviceGroups。各要素に cid が自動マージされる)")
    .option("--json <groupIds>", 'JSON オブジェクト配列。例 \'[{"gid":"…"}]\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('groupIds が必要です: sesame org device-group rm --json \'[{"gid":"…"}]\'', 2);
          return;
        }
        const groupIds = ctx.parseJson(cmdOpts.json, '[{"gid":"…"}]');
        if (groupIds === undefined) return;
        if (!Array.isArray(groupIds)) { ctx.die("--json は配列である必要があります。", 2); return; }
        const resp = await hub.org.removeDeviceGroups({ groupIds });
        ctx.out(opts.json, () => {
          console.log(`OK: requested removal of ${groupIds.length} device group(s)`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group add-devices <gid> --json <body>
  deviceGroup.command("add-devices <gid>")
    .description("デバイスグループにデバイスを紐付け (addDeviceInGroup。uuids/items を --json で渡す)")
    .option("--json <body>", 'JSON {uuids,items}。例 \'{"uuids":["dev1"],"items":[{"deviceUUID":"dev1"}]}\'')
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('uuids/items が必要です: sesame org device-group add-devices <gid> --json \'{"uuids":[],"items":[]}\'', 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["dev1"],"items":[{"deviceUUID":"dev1"}]}');
        if (body === undefined) return;
        // rm-devices と対称に uuids/items の配列性を検証。
        if (!Array.isArray(body.uuids) || !Array.isArray(body.items)) {
          ctx.die('--json の uuids / items は配列である必要があります。', 2); return;
        }
        const resp = await hub.org.addDeviceInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(`OK: bound devices to group ${gid}`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group rm-devices <gid> --json <body>
  deviceGroup.command("rm-devices <gid>")
    .description("デバイスグループからデバイスを解除 (removeDeviceInGroup。items は {deviceUUID,secretKey} に絞り込まれる)")
    .option("--json <body>", 'JSON {uuids,items}。例 \'{"uuids":["dev1"],"items":[{"deviceUUID":"dev1","secretKey":"…"}]}\'')
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('uuids/items が必要です: sesame org device-group rm-devices <gid> --json \'{"uuids":[],"items":[]}\'', 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["dev1"],"items":[{"deviceUUID":"dev1","secretKey":"…"}]}');
        if (body === undefined) return;
        if (!Array.isArray(body.items)) { ctx.die('--json の items は配列である必要があります。', 2); return; }
        const resp = await hub.org.removeDeviceInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(`OK: unbound devices from group ${gid}`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group user-groups <gid>
  deviceGroup.command("user-groups <gid>")
    .description("デバイスグループにバインド済みの社員グループを取得 (getDeviceGroupBindUserGroup。cid は送らない)")
    .action((gid) =>
      ctx.withAccount(async (hub, { opts }) => {
        const data = await hub.org.getDeviceGroupBindUserGroup({ gid });
        ctx.out(opts.json, () => {
          // data 構造は biz3 未確認。そのまま整形出力。
          console.log(JSON.stringify(data, null, 2));
        }, { ok: true, gid, bindUserGroup: data });
      }),
    );

  // sesame org device-group rm-user-group --json <data>
  deviceGroup.command("rm-user-group")
    .description("デバイスグループから社員グループを解除 (removeDeviceGroupBindUserGroup。data 内容は biz3 未確認)")
    .option("--json <data>", 'JSON オブジェクト (gid/uuids 等。biz3 UI 依存で未確認)。')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org device-group rm-user-group --json \'{"gid":"…"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"gid":"…"}');
        if (data === undefined) return;
        const resp = await hub.org.removeDeviceGroupBindUserGroup({ data });
        ctx.out(opts.json, () => {
          console.log("OK: unbound user group from device group");
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org keys … (デバイス鍵の共有/列挙/取消, biz3ManageEmployeeDevice + getDeviceEmployeeKeys)
  // ════════════════════════════════════════════════════════════════════════
  const keys = org.command("keys").description("デバイス鍵の共有/列挙/取消 (employeeDevice + getDeviceEmployeeKeys)");

  // sesame org keys device <deviceUUID> [--limit <n>]
  keys.command("device <deviceUUID>")
    .description("デバイス側から鍵保有従業員を列挙 (getDeviceEmployeeKeys。companyID 必須・自動注入)")
    .option("--limit <n>", "0=全件 / 5=非管理モード", (v) => Number(v), 0)
    .action((deviceUUID, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getDeviceEmployeeKeys({ deviceUUID, limit: cmdOpts.limit });
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log("(no key holders)");
            return;
          }
          console.log(`Found ${list.length} key holder(s) for ${deviceUUID}:`);
          for (const k of list) {
            const lv = k.keyLevel; // 0=owner,1=manager,2=guest
            const who = k.employeeName ?? k.subUUID ?? "(unknown)";
            const guest = k.guestKeyId && String(k.guestKeyId).length > 0 ? " [guest]" : "";
            console.log(`  lv${lv}\t${who}${guest}`);
          }
        }, { ok: true, count: Array.isArray(list) ? list.length : 0, keys: list });
      }),
    );

  // sesame org keys employee <subUUID>
  keys.command("employee <subUUID>")
    .description("指定従業員が持つデバイス鍵一覧 (getEmployeeDeviceKeys。companyID 不要、data 構造は未確認)")
    .action((subUUID) =>
      ctx.withAccount(async (hub, { opts }) => {
        const data = await hub.org.getEmployeeDeviceKeys({ subUUID });
        ctx.out(opts.json, () => {
          console.log(JSON.stringify(data, null, 2));
        }, { ok: true, subUUID, keys: data });
      }),
    );

  // sesame org keys share --json <items>
  keys.command("share")
    .description("従業員にデバイス鍵を共有 (shareDeviceKeysToEmployees。items は呼出側で device+user 情報を合成)")
    .option("--json <items>", 'JSON 配列。各要素 {...device,...user,keyLevel,startTime,endTime}。keyLevel 0=owner/1=manager/2=guest')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('items が必要です: sesame org keys share --json \'[{"deviceUUID":"…","subUUID":"…","keyLevel":1,"startTime":"","endTime":""}]\'', 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"deviceUUID":"…","subUUID":"…","keyLevel":1,"startTime":"","endTime":""}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die("--json は配列である必要があります。", 2); return; }
        const resp = await hub.org.shareDeviceKeysToEmployees({ items });
        ctx.out(opts.json, () => {
          console.log(`OK: shared keys (${items.length} item(s))`);
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys share-group --json <item>
  keys.command("share-group")
    .description("社員グループにデバイスグループ鍵を共有 (shareDeviceGroupKeysToEmployeeGroup。companyID 自動注入)")
    .option("--json <item>", 'JSON {keyLevel,members,devices,mid,dids,startTime,endTime}。keyLevel は文字列 "0"/"1"/"2"')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('item が必要です: sesame org keys share-group --json \'{"keyLevel":"1","members":[],"devices":[],"mid":"…","dids":[]}\'', 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, '{"keyLevel":"1","members":[],"devices":[],"mid":"…","dids":[]}');
        if (item === undefined) return;
        const resp = await hub.org.shareDeviceGroupKeysToEmployeeGroup({ item });
        ctx.out(opts.json, () => {
          console.log("OK: shared device group keys to employee group");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys rm --json <data>
  keys.command("rm")
    .description("従業員/ゲストのデバイス鍵を削除 (removeEmployeeDeviceKey)。ゲスト鍵は randomTag が必要 (本体 JSDoc 参照)")
    .option("--json <data>", 'JSON。従業員 \'{"subUUID":"…","deviceUUID":"…"}\' / ゲスト \'{"guestKeyId":"…","randomTag":"…","deviceUUID":"…"}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org keys rm --json \'{"subUUID":"…","deviceUUID":"…"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"subUUID":"…","deviceUUID":"…"}');
        if (data === undefined) return;
        const resp = await hub.org.removeEmployeeDeviceKey({ data });
        ctx.out(opts.json, () => {
          console.log("OK: device key removed");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys update-guest-tag --json <data>
  keys.command("update-guest-tag")
    .description("ゲスト鍵の名称タグを更新 (updateGuestKeyTag)")
    .option("--json <data>", 'JSON {deviceUUID,guestKeyId,keyName}。keyName が新タグ名')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org keys update-guest-tag --json \'{"deviceUUID":"…","guestKeyId":"…","keyName":"新名"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"deviceUUID":"…","guestKeyId":"…","keyName":"新名"}');
        if (data === undefined) return;
        const resp = await hub.org.updateGuestKeyTag({ data });
        ctx.out(opts.json, () => {
          console.log("OK: guest key tag updated");
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys generate-guest-qr --json <data>
  keys.command("generate-guest-qr")
    .description("ゲスト用 guestKeyId を発行 (generateGuestQR)。data はデバイス鍵オブジェクト全体。QR 画像化は本 op 対象外")
    .option("--json <data>", 'JSON のデバイス鍵オブジェクト全体。例 \'{"deviceUUID":"…","secretKey":"…","sesame2PublicKey":"…","keyIndex":0,"deviceModel":"…","keyLevel":0}\'')
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die('data が必要です: sesame org keys generate-guest-qr --json \'{"deviceUUID":"…","secretKey":"…"}\'', 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"deviceUUID":"…","secretKey":"…"}');
        if (data === undefined) return;
        const guestKeyId = await hub.org.generateGuestQR({ data });
        ctx.out(opts.json, () => {
          console.log(`OK: guestKeyId = ${guestKeyId}`);
        }, { ok: true, guestKeyId });
      }),
    );

  // sesame org keys share-url --device <uuid> [--level 0|1|2] [--name …] [--qr]
  // biz3 のゲスト共有 QR と同じ ssm://UI?... 共有 URL を組み立てる (sharekey.buildShareKeyUrl)。
  // level=2 (guest) のときだけ先に generateGuestQR で guestKeyId を発行し secretKey 位置へ差し込む。
  keys.command("share-url")
    .description("デバイス鍵の共有 URL (ssm://UI?...) を生成。SESAME アプリが読む QR の中身そのもの")
    .option("-d, --device <uuid>", "対象 deviceUUID (省略時は対話選択)")
    .option("-l, --level <0|1|2>", "鍵レベル 0=owner / 1=manager / 2=guest (既定 2)", "2")
    .option("--name <name>", "共有時の表示名 (省略時はデバイス名)")
    .option("--json <deviceKey>", "デバイス鍵を JSON で直接指定 (省略時は devices から解決)")
    .option("--qr", "端末に QR を表示 (要 qrcode-terminal: npm i qrcode-terminal)")
    .addHelpText("after", `
level 2 (guest) のみ generateGuestQR で使い捨て guestKeyId を発行して埋め込みます。
0/1 (owner/manager) はデバイス自身の secretKey を共有するため取り扱い注意。
QR 画像化を省く場合でも、出力された ssm://UI URL を任意の QR 生成器に貼れば共有できます。`)
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        const level = parseInt(cmdOpts.level, 10);
        if (![0, 1, 2].includes(level)) {
          ctx.die("--level は 0 / 1 / 2 のいずれか。", 2);
          return;
        }
        // deviceKey の解決: --json 優先 → --device で devices から検索 → 対話選択。
        let deviceKey;
        if (cmdOpts.json) {
          deviceKey = ctx.parseJson(cmdOpts.json, '{"deviceUUID":"…","secretKey":"…","sesame2PublicKey":"…","keyIndex":"…","deviceModel":"sesame_5"}');
          if (deviceKey === undefined) return;
        } else {
          const list = await hub.listDevices();
          const devs = Array.isArray(list) ? list : [];
          if (cmdOpts.device) {
            deviceKey = devs.find((d) => d.deviceUUID === cmdOpts.device);
            if (!deviceKey) { ctx.die(`deviceUUID ${cmdOpts.device} が devices に見つかりません。`, 2); return; }
          } else if (ctx.canPrompt()) {
            if (devs.length === 0) { ctx.die("共有できるデバイスがありません。", 2); return; }
            deviceKey = await ctx.prompts.selectFromList(
              "共有するデバイスを選択",
              devs,
              (d) => `${d.deviceName || "(no-name)"}  ${d.deviceModel || "?"}  ${d.deviceUUID}`,
            );
            if (!deviceKey) { console.error("キャンセルしました。"); return; }
          } else {
            ctx.die("--device <uuid> または --json <deviceKey> が必要です (非対話モード)。", 2);
            return;
          }
        }

        // guest (level 2) のみ使い捨て guestKeyId を発行 (biz3 と同じ。0/1 は deviceKey.secretKey)。
        let guestKeyId;
        if (level === 2) {
          guestKeyId = await hub.org.generateGuestQR({ data: deviceKey });
        }

        const url = buildShareKeyUrl(deviceKey, { keyLevel: level, guestKeyId, name: cmdOpts.name });

        // --qr 指定時のみ端末 QR を試みる (qrcode-terminal は任意依存。未導入なら案内のみ)。
        let qrText = null;
        if (cmdOpts.qr && !opts.json) {
          try {
            const { default: qrcodeTerminal } = await import("qrcode-terminal");
            qrcodeTerminal.generate(url, { small: true }, (out) => { qrText = out; });
          } catch {
            qrText = "(qrcode-terminal 未インストール: `npm i qrcode-terminal` で端末 QR 表示)";
          }
        }

        ctx.out(opts.json, () => {
          console.log(url);
          if (qrText) console.log(`\n${qrText}`);
        }, { ok: true, url, level, guestKeyId: guestKeyId ?? null, deviceUUID: deviceKey.deviceUUID });
      }),
    );
}
