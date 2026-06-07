// `sesame schedule …` コマンド群。
//
// 本体ロジックは src/schedule.js (biz3Schedule: getScheduleList / cancelSchedule)。
// ここは commander への配線と入出力整形のみを担う。
//
// ctx 契約 (cli.js makeCtx が供給):
//   ctx.withHub(fn)      : connect → fn(hub, {opts}) → close。hub.schedule.* は
//                          companyID/subUUID を自動注入する namespace。
//   ctx.withAccount(fn)  : withHub + 事前に refreshAccount() で実 companyID/subUUID 保証。
//   ctx.out(json, humanFn, jsonObj) : --json 時は jsonObj、それ以外は humanFn()。
//   ctx.die(msg, code)   : エラー表示して exit。
//   ctx.canPrompt()      : TTY かつ --json なし。
//   ctx.prompts          : { selectFromList, promptText, confirm, promptLine }。

import { t } from "../i18n.js";

/**
 * @param {import("commander").Command} program
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerScheduleCommands(program, ctx) {
  const schedule = program.command("schedule").description(t("schedule.cmd.desc"));

  // sesame schedule ls
  schedule.command("ls")
    .description(t("schedule.ls.desc"))
    .action(() =>
      ctx.withHub(async (hub, { opts }) => {
        const items = await hub.schedule.getScheduleList();
        ctx.out(opts.json, () => {
          if (!Array.isArray(items) || items.length === 0) {
            console.log(t("schedule.ls.none"));
            return;
          }
          console.log(t("schedule.ls.found", { count: items.length }));
          for (const s of items) {
            const id = s.scheduleId ?? "(no-id)";
            const when = s.displayTime ?? "(no-time)";
            const act = s.action ?? "?";
            const dev = s.deviceName ? ` [${s.deviceName}]` : "";
            console.log(`  ${id}\t${when}\t${act}${dev}`);
          }
        }, { ok: true, count: Array.isArray(items) ? items.length : 0, schedules: items });
      }),
    );

  // sesame schedule cancel [scheduleId]
  schedule.command("cancel [scheduleId]")
    .description(t("schedule.cancel.desc"))
    .action((scheduleId) =>
      ctx.withHub(async (hub, { opts }) => {
        // ID 未指定 & 対話可能なら一覧から選択させる。
        if (!scheduleId && ctx.canPrompt()) {
          const items = await hub.schedule.getScheduleList();
          if (!Array.isArray(items) || items.length === 0) {
            // 空一覧は異常ではない。ls と同じく out で正常メッセージを返す
            // (die だと process.exit で withHub の finally close() を飛ばす)。
            ctx.out(opts.json, () => console.log(t("schedule.cancel.none")), { ok: true, count: 0 });
            return;
          }
          const picked = await ctx.prompts.selectFromList(
            t("schedule.cancel.prompt"),
            items,
            (s) => `${s.scheduleId}  ${s.displayTime ?? ""}  ${s.action ?? ""}`,
          );
          // 対話選択を中断した場合 (picked なし) は「非対話モード」案内ではなく中止扱い。
          if (!picked?.scheduleId) {
            console.error(t("schedule.cancel.aborted"));
            return;
          }
          scheduleId = picked.scheduleId;
        }
        if (!scheduleId) {
          ctx.die(t("schedule.cancel.idRequired"), 2);
          return;
        }
        const resp = await hub.schedule.cancelSchedule({ scheduleId });
        ctx.out(opts.json, () => {
          // 本体 cancelSchedule は ack=成功とみなす設計で、成功 data 構造は未確認
          // (src/schedule.js 参照)。断定を避け ack ベースの表現にする。
          console.log(t("schedule.cancel.ack", { scheduleId }));
        }, { ok: true, scheduleId, response: resp });
      }),
    );
}
