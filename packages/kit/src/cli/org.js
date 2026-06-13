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

import { buildShareKeyUrl, parseFriendQrUrl } from "@sesame-kit/core/sharekey";
import { cmacTime } from "@sesame-kit/core/crypto";
import { t } from "@sesame-kit/core/i18n";

/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerOrgCommands(program, ctx) {
  const org = program.command("org").description(t("org.cmd.org"));

  // ════════════════════════════════════════════════════════════════════════
  //  org employee … (biz3ManageEmployee)
  // ════════════════════════════════════════════════════════════════════════
  const employee = org.command("employee").description(t("org.cmd.employee"));

  // sesame org employee ls
  employee.command("ls")
    .description(t("org.employee.ls.desc"))
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        // 戻りは { count, list } (count=totalCount)。namespace getter は unknown に erase する。
        const { count, list } = /** @type {{count:number, list:any[]}} */ (
          await hub.org.getEmployees()
        );
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log(t("org.employee.ls.none"));
            return;
          }
          console.log(t("org.employee.ls.found", { n: list.length, count }));
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
    .description(t("org.employee.me.desc"))
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const info = await hub.org.getCurrentUserInfo();
        ctx.out(opts.json, () => {
          console.log(JSON.stringify(info, null, 2));
        }, { ok: true, currentUser: info });
      }),
    );

  // sesame org employee add --json <items> [--friend-qr <url>]
  employee.command("add")
    .description(t("org.employee.add.desc"))
    .option("--json <items>", t("org.employee.add.opt"))
    .option("--friend-qr <url>", "ssm://UI/?t=friend&friend=<subUUID> format URL (from SESAME app friend QR). Parses friendID and composes items=[{friendID,companyID}].")
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        /** @type {any[]} */
        let items;
        if (cmdOpts.friendQr) {
          // --friend-qr <url>: parseFriendQrUrl でフレンド QR を解析し、
          // AddEmployee.js:394-406 の 1:1 で items=[{friendID, companyID}] を合成する。
          // 参照: references_web/src/components/biz/device/AddEmployee.js:386-410
          //         sendParam = { ...userInfo, companyID }  → submit([sendParam])
          let parsed;
          try {
            parsed = parseFriendQrUrl(cmdOpts.friendQr);
          } catch (e) {
            ctx.die(`Invalid friend QR URL: ${/** @type {any} */ (e)?.message || String(e)}`, 2);
            return;
          }
          items = [{ friendID: parsed.friendID, companyID: hub.config.companyID }];
        } else if (cmdOpts.json) {
          items = ctx.parseJson(cmdOpts.json, t("org.employee.add.hint"));
          if (items === undefined) return;
          if (!Array.isArray(items)) { ctx.die(t("org.err.jsonArray"), 2); return; }
        } else {
          ctx.die(t("org.employee.add.need") + " or use --friend-qr <url>", 2);
          return;
        }
        // 各要素に companyID を補完 (本体 addEmployees は item 内 companyID を期待。biz3 同様)。
        // companyID を後置し、item 内に空文字/null が紛れても必ず有効値が勝つようにする
        // (明示の有効な companyID があればそれを尊重)。
        const withCid = items.map((it) => ({ ...it, companyID: it.companyID || hub.config.companyID }));
        const resp = await hub.org.addEmployees({ items: withCid });
        ctx.out(opts.json, () => {
          console.log(t("org.employee.add.ok", { n: withCid.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee update --json <data>
  employee.command("update")
    .description(t("org.employee.update.desc"))
    .option("--json <data>", t("org.employee.update.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.employee.update.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, t("org.employee.update.hint"));
        if (data === undefined) return;
        const resp = await hub.org.updateEmployee({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.employee.update.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee rm --json <items>
  employee.command("rm")
    .description(t("org.employee.rm.desc"))
    .option("--json <items>", t("org.employee.rm.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.employee.rm.need"), 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"subUUID":"…","companyID":"…"}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die(t("org.err.jsonArray"), 2); return; }
        const resp = await hub.org.removeEmployees({ items });
        ctx.out(opts.json, () => {
          console.log(t("org.employee.rm.ok", { n: items.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee reorder --json <items>
  employee.command("reorder")
    .description(t("org.employee.reorder.desc"))
    .option("--json <items>", t("org.employee.reorder.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.employee.reorder.need"), 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"friendUUID":"…","rank":0}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die(t("org.err.jsonArray"), 2); return; }
        const resp = await hub.org.reorderEmployees({ items });
        ctx.out(opts.json, () => {
          console.log(t("org.employee.reorder.ok", { n: items.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org employee search <keyword>
  employee.command("search <keyword>")
    .description(t("org.employee.search.desc"))
    .action((keyword) =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.queryByCS({ keyword });
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log(t("org.employee.search.none"));
            return;
          }
          console.log(t("org.employee.search.found", { n: list.length }));
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
    .description(t("org.employee.confirm.desc"))
    .action((email) =>
      ctx.withAccount(async (hub, { opts }) => {
        // 副作用が重い (biz3 UI は成功時 signout)。対話可能なら確認を取る。
        if (ctx.canPrompt()) {
          const ok = await ctx.prompts.confirm(
            t("org.employee.confirm.prompt", { email }),
            { defaultYes: false },
          );
          // 正常な中断: die (Error: プレフィックス + process.exit で finally skip) ではなく
          // plain log + return にして withHub の close() を生かす。
          if (!ok) { console.error(t("org.employee.confirm.aborted")); return; }
        }
        const resp = await hub.org.confirmQueryByCS({ email });
        ctx.out(opts.json, () => {
          console.log(t("org.employee.confirm.ok", { email }));
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org group … (社員グループ, biz3ManageEmployeeGroup)
  // ════════════════════════════════════════════════════════════════════════
  const group = org.command("group").description(t("org.cmd.group"));

  // sesame org group ls
  group.command("ls")
    .description(t("org.group.ls.desc"))
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getEmployeeGroups();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log(t("org.group.ls.none"));
            return;
          }
          console.log(t("org.group.ls.found", { n: list.length }));
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
    .description(t("org.group.add.desc"))
    .option("--json <item>", t("org.group.add.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.group.add.need"), 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, t("org.group.add.hint"));
        if (item === undefined) return;
        // namespace getter は unknown を返すため、追加グループ (resp.data) の形へ cast。
        const created = /** @type {{gid?:string}|undefined} */ (
          await hub.org.addEmployeeGroup({ item })
        );
        ctx.out(opts.json, () => {
          console.log(created?.gid ? t("org.group.add.okId", { gid: created.gid }) : t("org.group.add.ok"));
        }, { ok: true, group: created });
      }),
    );

  // sesame org group update --json <item>
  group.command("update")
    .description(t("org.group.update.desc"))
    .option("--json <item>", t("org.group.update.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.group.update.need"), 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, t("org.group.update.hint"));
        if (item === undefined) return;
        const resp = await hub.org.updateEmployeeGroup({ item });
        ctx.out(opts.json, () => {
          console.log(t("org.group.update.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group rm --json <gids>
  group.command("rm")
    .description(t("org.group.rm.desc"))
    .option("--json <gids>", t("org.group.rm.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.group.rm.need"), 2);
          return;
        }
        const gids = ctx.parseJson(cmdOpts.json, '["gid1","gid2"]');
        if (gids === undefined) return;
        if (!Array.isArray(gids)) { ctx.die(t("org.err.jsonArray"), 2); return; }
        const resp = await hub.org.removeEmployeeGroups({ gids });
        ctx.out(opts.json, () => {
          console.log(t("org.group.rm.ok", { n: gids.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group device-groups <gid>
  group.command("device-groups <gid>")
    .description(t("org.group.deviceGroups.desc"))
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
    .description(t("org.group.addUsers.desc"))
    .option("--json <body>", t("org.group.addUsers.opt"))
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.group.addUsers.need"), 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["sub1"],"items":[{"subUUID":"sub1"}]}');
        if (body === undefined) return;
        // rm-users と対称に uuids/items の配列性を検証 (undefined のまま送ると曖昧な失敗になる)。
        if (!Array.isArray(body.uuids) || !Array.isArray(body.items)) {
          ctx.die(t("org.err.uuidsItemsArray"), 2); return;
        }
        const resp = await hub.org.addEmployeeInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(t("org.group.addUsers.ok", { gid }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group rm-users <gid> --json <body>
  group.command("rm-users <gid>")
    .description(t("org.group.rmUsers.desc"))
    .option("--json <body>", t("org.group.rmUsers.opt"))
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.group.rmUsers.need"), 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["sub1"],"items":[{"subUUID":"sub1"}]}');
        if (body === undefined) return;
        if (!Array.isArray(body.items)) { ctx.die(t("org.err.itemsArray"), 2); return; }
        const resp = await hub.org.removeEmployeeInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(t("org.group.rmUsers.ok", { gid }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org group rm-device-group --json <data>
  group.command("rm-device-group")
    .description(t("org.group.rmDeviceGroup.desc"))
    .option("--json <data>", t("org.group.rmDeviceGroup.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.group.rmDeviceGroup.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"gid":"…"}');
        if (data === undefined) return;
        const resp = await hub.org.removeEmployeeGroupBindDeviceGroup({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.group.rmDeviceGroup.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org role … (役割タグ, biz3ManageRole)
  // ════════════════════════════════════════════════════════════════════════
  const role = org.command("role").description(t("org.cmd.role"));

  // sesame org role ls
  role.command("ls")
    .description(t("org.role.ls.desc"))
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getTags();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log(t("org.role.ls.none"));
            return;
          }
          console.log(t("org.role.ls.found", { n: list.length }));
          // ロールの実フィールドは {tag, access[]} (DataTableColumns.js:560-575)。
          // id/name は存在しない (P3-10: 旧 `?? ` フォールバック連鎖は誤フィールドを隠すため削除)。
          for (const tagSetting of list) {
            console.log(`  ${tagSetting.tag}\t${tagSetting.access.join(",")}`);
          }
        }, { ok: true, count: Array.isArray(list) ? list.length : 0, tags: list });
      }),
    );

  // sesame org role post --json <data>
  role.command("post")
    .description(t("org.role.post.desc"))
    .option("--json <data>", t("org.role.post.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.role.post.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, t("org.role.post.hint"));
        if (data === undefined) return;
        const resp = await hub.org.postTag({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.role.post.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org role rm --json <data>
  role.command("rm")
    .description(t("org.role.rm.desc"))
    .option("--json <data>", t("org.role.rm.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.role.rm.need"), 2);
          return;
        }
        // removeTag へ渡す data は tagSetting 全体 ({tag, access[]})。
        // 参照: DataTableColumns.js:627 gManageEmployee.removeTag(tagSetting, …)。
        const data = ctx.parseJson(cmdOpts.json, t("org.role.rm.hint"));
        if (data === undefined) return;
        const resp = await hub.org.removeTag({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.role.rm.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org device-group … (デバイスグループ, biz3ManageDeviceGroup)
  // ════════════════════════════════════════════════════════════════════════
  const deviceGroup = org.command("device-group").description(t("org.cmd.deviceGroup"));

  // sesame org device-group ls
  deviceGroup.command("ls")
    .description(t("org.deviceGroup.ls.desc"))
    .action(() =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getDeviceGroups();
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log(t("org.deviceGroup.ls.none"));
            return;
          }
          console.log(t("org.deviceGroup.ls.found", { n: list.length }));
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
    .description(t("org.deviceGroup.add.desc"))
    .option("--uuids <json>", t("org.deviceGroup.add.opt"), "[]")
    .action((name, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        const uuids = ctx.parseJson(cmdOpts.uuids, '["uuid1","uuid2"]');
        if (uuids === undefined) return;
        if (!Array.isArray(uuids)) { ctx.die(t("org.err.uuidsArray"), 2); return; }
        const resp = await hub.org.addDeviceGroup({ name, uuids });
        ctx.out(opts.json, () => {
          console.log(t("org.deviceGroup.add.ok", { name, n: uuids.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group update --json <item>
  deviceGroup.command("update")
    .description(t("org.deviceGroup.update.desc"))
    .option("--json <item>", t("org.deviceGroup.update.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.deviceGroup.update.need"), 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, t("org.deviceGroup.update.hint"));
        if (item === undefined) return;
        const resp = await hub.org.updateDeviceGroup({ item });
        ctx.out(opts.json, () => {
          console.log(t("org.deviceGroup.update.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group rm --json <groupIds>
  deviceGroup.command("rm")
    .description(t("org.deviceGroup.rm.desc"))
    .option("--json <groupIds>", t("org.deviceGroup.rm.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.deviceGroup.rm.need"), 2);
          return;
        }
        const groupIds = ctx.parseJson(cmdOpts.json, '[{"gid":"…"}]');
        if (groupIds === undefined) return;
        if (!Array.isArray(groupIds)) { ctx.die(t("org.err.jsonArray"), 2); return; }
        const resp = await hub.org.removeDeviceGroups({ groupIds });
        ctx.out(opts.json, () => {
          console.log(t("org.deviceGroup.rm.ok", { n: groupIds.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group add-devices <gid> --json <body>
  deviceGroup.command("add-devices <gid>")
    .description(t("org.deviceGroup.addDevices.desc"))
    .option("--json <body>", t("org.deviceGroup.addDevices.opt"))
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.deviceGroup.addDevices.need"), 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["dev1"],"items":[{"deviceUUID":"dev1"}]}');
        if (body === undefined) return;
        // rm-devices と対称に uuids/items の配列性を検証。
        if (!Array.isArray(body.uuids) || !Array.isArray(body.items)) {
          ctx.die(t("org.err.uuidsItemsArray"), 2); return;
        }
        const resp = await hub.org.addDeviceInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(t("org.deviceGroup.addDevices.ok", { gid }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group rm-devices <gid> --json <body>
  deviceGroup.command("rm-devices <gid>")
    .description(t("org.deviceGroup.rmDevices.desc"))
    .option("--json <body>", t("org.deviceGroup.rmDevices.opt"))
    .action((gid, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.deviceGroup.rmDevices.need"), 2);
          return;
        }
        const body = ctx.parseJson(cmdOpts.json, '{"uuids":["dev1"],"items":[{"deviceUUID":"dev1","secretKey":"…"}]}');
        if (body === undefined) return;
        if (!Array.isArray(body.items)) { ctx.die(t("org.err.itemsArray"), 2); return; }
        const resp = await hub.org.removeDeviceInGroup({ gid, uuids: body.uuids, items: body.items });
        ctx.out(opts.json, () => {
          console.log(t("org.deviceGroup.rmDevices.ok", { gid }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org device-group user-groups <gid>
  deviceGroup.command("user-groups <gid>")
    .description(t("org.deviceGroup.userGroups.desc"))
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
    .description(t("org.deviceGroup.rmUserGroup.desc"))
    .option("--json <data>", t("org.deviceGroup.rmUserGroup.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.deviceGroup.rmUserGroup.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"gid":"…"}');
        if (data === undefined) return;
        const resp = await hub.org.removeDeviceGroupBindUserGroup({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.deviceGroup.rmUserGroup.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // ════════════════════════════════════════════════════════════════════════
  //  org keys … (デバイス鍵の共有/列挙/取消, biz3ManageEmployeeDevice + getDeviceEmployeeKeys)
  // ════════════════════════════════════════════════════════════════════════
  const keys = org.command("keys").description(t("org.cmd.keys"));

  // sesame org keys device <deviceUUID> [--limit <n>]
  keys.command("device <deviceUUID>")
    .description(t("org.keys.device.desc"))
    .option("--limit <n>", t("org.keys.device.opt"), (v) => Number(v), 0)
    .action((deviceUUID, cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        const list = await hub.org.getDeviceEmployeeKeys({ deviceUUID, limit: cmdOpts.limit });
        ctx.out(opts.json, () => {
          if (!Array.isArray(list) || list.length === 0) {
            console.log(t("org.keys.device.none"));
            return;
          }
          console.log(t("org.keys.device.found", { n: list.length, deviceUUID }));
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
    .description(t("org.keys.employee.desc"))
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
    .description(t("org.keys.share.desc"))
    .option("--json <items>", t("org.keys.share.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.keys.share.need"), 2);
          return;
        }
        const items = ctx.parseJson(cmdOpts.json, '[{"deviceUUID":"…","subUUID":"…","keyLevel":1,"startTime":"","endTime":""}]');
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die(t("org.err.jsonArray"), 2); return; }
        const resp = await hub.org.shareDeviceKeysToEmployees({ items });
        ctx.out(opts.json, () => {
          console.log(t("org.keys.share.ok", { n: items.length }));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys share-group --json <item>
  keys.command("share-group")
    .description(t("org.keys.shareGroup.desc"))
    .option("--json <item>", t("org.keys.shareGroup.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.keys.shareGroup.need"), 2);
          return;
        }
        const item = ctx.parseJson(cmdOpts.json, '{"keyLevel":"1","members":[],"devices":[],"mid":"…","dids":[]}');
        if (item === undefined) return;
        const resp = await hub.org.shareDeviceGroupKeysToEmployeeGroup({ item });
        ctx.out(opts.json, () => {
          console.log(t("org.keys.shareGroup.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys rm --json <data>
  keys.command("rm")
    .description(t("org.keys.rm.desc"))
    .option("--json <data>", t("org.keys.rm.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.keys.rm.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"subUUID":"…","deviceUUID":"…"}');
        if (data === undefined) return;
        // BIZ-12: ゲスト鍵削除 (guestKeyId あり) は randomTag = cmacTime(device.secretKey) が
        // 必須 (DeviceUserList.js:117-132 onRemoveUser)。256 秒粒度の時刻 CMAC で手入力は
        // 事実上不可能なため、未指定なら listDevices から該当 deviceUUID の secretKey を
        // 引いて自動補完する (同じ計算 = crypto.cmacTime)。
        if (data.guestKeyId && !data.randomTag) {
          const list = await hub.listDevices();
          const devs = Array.isArray(list) ? list : [];
          const device = devs.find((d) => d.deviceUUID === data.deviceUUID);
          if (!device) {
            ctx.die(t("org.keys.rm.deviceNotFound", { deviceUUID: String(data.deviceUUID ?? "") }), 2);
            return;
          }
          if (!device.secretKey) {
            ctx.die(t("org.keys.rm.noSecretKey", { deviceUUID: String(data.deviceUUID) }), 2);
            return;
          }
          data.randomTag = cmacTime(device.secretKey);
        }
        const resp = await hub.org.removeEmployeeDeviceKey({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.keys.rm.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys update-guest-tag --json <data>
  keys.command("update-guest-tag")
    .description(t("org.keys.updateGuestTag.desc"))
    .option("--json <data>", t("org.keys.updateGuestTag.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.keys.updateGuestTag.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, t("org.keys.updateGuestTag.hint"));
        if (data === undefined) return;
        const resp = await hub.org.updateGuestKeyTag({ data });
        ctx.out(opts.json, () => {
          console.log(t("org.keys.updateGuestTag.ok"));
        }, { ok: true, response: resp });
      }),
    );

  // sesame org keys generate-guest-qr --json <data>
  keys.command("generate-guest-qr")
    .description(t("org.keys.generateGuestQr.desc"))
    .option("--json <data>", t("org.keys.generateGuestQr.opt"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        if (!cmdOpts.json) {
          ctx.die(t("org.keys.generateGuestQr.need"), 2);
          return;
        }
        const data = ctx.parseJson(cmdOpts.json, '{"deviceUUID":"…","secretKey":"…"}');
        if (data === undefined) return;
        // namespace getter は unknown を返すが、本体 generateGuestQR は guestKeyId (string) を返す。
        const guestKeyId = /** @type {string} */ (await hub.org.generateGuestQR({ data }));
        ctx.out(opts.json, () => {
          console.log(t("org.keys.generateGuestQr.ok", { guestKeyId }));
        }, { ok: true, guestKeyId });
      }),
    );

  // sesame org keys share-url --device <uuid> [--level 0|1|2] [--name …] [--qr]
  // biz3 のゲスト共有 QR と同じ ssm://UI?... 共有 URL を組み立てる (sharekey.buildShareKeyUrl)。
  // level=2 (guest) のときだけ先に generateGuestQR で guestKeyId を発行し secretKey 位置へ差し込む。
  keys.command("share-url")
    .description(t("org.keys.shareUrl.desc"))
    .option("-d, --device <uuid>", t("org.keys.shareUrl.optDevice"))
    .option("-l, --level <0|1|2>", t("org.keys.shareUrl.optLevel"), "2")
    .option("--name <name>", t("org.keys.shareUrl.optName"))
    .option("--json <deviceKey>", t("org.keys.shareUrl.optJson"))
    .option("--qr", t("org.keys.shareUrl.optQr"))
    .addHelpText("after", t("org.keys.shareUrl.help"))
    .action((cmdOpts) =>
      ctx.withAccount(async (hub, { opts }) => {
        const level = parseInt(cmdOpts.level, 10);
        if (![0, 1, 2].includes(level)) {
          ctx.die(t("org.keys.shareUrl.badLevel"), 2);
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
            if (!deviceKey) { ctx.die(t("org.keys.shareUrl.deviceNotFound", { device: cmdOpts.device }), 2); return; }
          } else if (ctx.canPrompt()) {
            if (devs.length === 0) { ctx.die(t("org.keys.shareUrl.noDevices"), 2); return; }
            deviceKey = await ctx.prompts.selectFromList(
              t("org.keys.shareUrl.selectPrompt"),
              devs,
              (d) => `${d.deviceName || "(no-name)"}  ${d.deviceModel || "?"}  ${d.deviceUUID}`,
            );
            if (!deviceKey) { console.error(t("org.keys.shareUrl.cancelled")); return; }
          } else {
            ctx.die(t("org.keys.shareUrl.needDeviceOrJson"), 2);
            return;
          }
        }

        // guest (level 2) のみ使い捨て guestKeyId を発行 (biz3 と同じ。0/1 は deviceKey.secretKey)。
        // namespace getter は unknown を返すが、本体 generateGuestQR は guestKeyId (string) を返す。
        /** @type {string|undefined} */
        let guestKeyId;
        if (level === 2) {
          guestKeyId = /** @type {string} */ (await hub.org.generateGuestQR({ data: deviceKey }));
        }

        const url = buildShareKeyUrl(deviceKey, { keyLevel: level, guestKeyId, name: cmdOpts.name });

        // --qr 指定時のみ端末 QR を試みる (qrcode-terminal は任意依存。未導入なら案内のみ)。
        /** @type {string|null} */
        let qrText = null;
        if (cmdOpts.qr && !opts.json) {
          try {
            // qrcode-terminal は型定義の無い任意 (optional) 依存。未導入の環境では catch で案内に
            // フォールバックするため、解決不能でも実害は無い (型を付与する手段が無い唯一のケース)。
            // @ts-expect-error optional untyped dep (qrcode-terminal): no type declarations available
            const { default: qrcodeTerminal } = await import("qrcode-terminal");
            qrcodeTerminal.generate(url, { small: true }, (/** @type {string} */ out) => { qrText = out; });
          } catch {
            qrText = t("org.keys.shareUrl.qrNotInstalled");
          }
        }

        ctx.out(opts.json, () => {
          console.log(url);
          if (qrText) console.log(`\n${qrText}`);
        }, { ok: true, url, level, guestKeyId: guestKeyId ?? null, deviceUUID: deviceKey.deviceUUID });
      }),
    );
}
