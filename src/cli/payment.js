// `sesame payment ...` command group.
//
// Payment mutation commands are intentionally guarded with --yes because they call the same
// biz3ManagePayment operations that change billing/payment state in the web app.
//
// 既定 customerId の解決 (BIZ-11): --customer-id 未指定時は namespace (hub.payment.*) が
// config.companyID (refreshAccount 済みの実値) を自動注入する。「config.companyID 既定、
// --customer-id 上書き」の現状を維持し、--priority 等のフラグは増やさない。web (biz3) と
// 同じ「優先会社」(rootUser / feeLevel 最大) を customerId にしたい場合は、ライブラリの
// account.priorityCompany(customerInfo, companies) / priorityCompanyId()
// (useStripeInfo.js:41-67 の 1:1 移植) で companyID を選定し --customer-id に渡すこと。

import { t } from "../i18n.js";

/** @typedef {import("../cli.js").CliCtx} CliCtx */
/** @typedef {import("../client.js").SesameHub3} SesameHub3 */

/** @param {unknown} value */
function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** @param {CliCtx} ctx @param {Record<string, any>} opts @returns {boolean} */
function requireYes(ctx, opts) {
  if (!opts.yes) {
    ctx.die(t("payment.err.confirmRequired"), 2);
    return false;
  }
  return true;
}

/** @param {string|undefined} v @returns {number|undefined} */
function toInt(v) {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(t("presetir.err.notANumber", { value: JSON.stringify(v) }));
  return n;
}

/**
 * @param {SesameHub3} hub
 * @param {CliCtx} ctx
 * @param {Record<string, any>} opts
 * @param {number|undefined} level
 * @returns {Promise<boolean|undefined>}
 */
async function inferIsUpgrade(hub, ctx, opts, level) {
  if (opts.upgrade && opts.downgrade) {
    ctx.die(t("payment.err.upgradeConflict"), 2);
    return undefined;
  }
  if (opts.upgrade) return true;
  if (opts.downgrade || opts.cancel) return false;
  const config = /** @type {{ level?: number } | null} */ (await hub.company.getPaymentConfig({ companyID: opts.customerId }));
  const current = Number(config?.level);
  if (Number.isFinite(current)) return current * 2 < Number(level);
  ctx.die(t("payment.err.upgradeUnknown"), 2);
  return undefined;
}

/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerPaymentCommands(program, ctx) {
  const payment = program.command("payment").description(t("payment.cmd.desc"));

  payment.command("methods")
    .description(t("payment.methods.desc"))
    .option("--customer-id <id>", t("payment.opt.customerId"))
    .action((opts) =>
      ctx.withAccount(async (hub, { opts: gopts }) => {
        const items = /** @type {Array<{ id?: string, isDefaultPay?: boolean }>} */ (await hub.payment.getPaymentMethods({ customerId: opts.customerId }));
        ctx.out(gopts.json, () => {
          if (!items.length) {
            console.log(t("payment.methods.none"));
            return;
          }
          console.log(t("payment.methods.found", { count: items.length }));
          for (const item of items) {
            console.log(`  ${item.id ?? "(no-id)"}${item.isDefaultPay ? " *" : ""}`);
          }
        }, { ok: true, count: items.length, paymentMethods: items });
      }),
    );

  payment.command("client-secret")
    .description(t("payment.secret.desc"))
    .option("--customer-id <id>", t("payment.opt.customerId"))
    .action((opts) =>
      ctx.withAccount(async (hub, { opts: gopts }) => {
        const secret = /** @type {string|null} */ (await hub.payment.getClientSecret({ customerId: opts.customerId }));
        ctx.out(gopts.json, () => console.log(t("payment.secret.value", { secret: secret ?? "" })), { ok: true, clientSecret: secret });
      }),
    );

  payment.command("default <paymentMethodId>")
    .description(t("payment.default.desc"))
    .option("--customer-id <id>", t("payment.opt.customerId"))
    .option("--yes", t("payment.opt.yes"))
    .action((paymentMethodId, opts) =>
      ctx.withAccount(async (hub, { opts: gopts }) => {
        if (!requireYes(ctx, opts)) return;
        const response = await hub.payment.changeDefaultPayment({
          customerId: opts.customerId,
          defaultPaymentMethod: paymentMethodId,
        });
        ctx.out(gopts.json, () => console.log(t("payment.default.ok")), { ok: true, response });
      }),
    );

  payment.command("remove <paymentId>")
    .description(t("payment.remove.desc"))
    .option("--customer-id <id>", t("payment.opt.customerId"))
    .option("--yes", t("payment.opt.yes"))
    .action((paymentId, opts) =>
      ctx.withAccount(async (hub, { opts: gopts }) => {
        if (!requireYes(ctx, opts)) return;
        const response = await hub.payment.removePayment({ customerId: opts.customerId, paymentId });
        ctx.out(gopts.json, () => console.log(t("payment.remove.ok")), { ok: true, response });
      }),
    );

  payment.command("level <level>")
    .description(t("payment.level.desc"))
    .option("--customer-id <id>", t("payment.opt.customerId"))
    .option("--subscription-id <id>", t("payment.opt.subscriptionId"))
    .option("--upgrade", t("payment.opt.upgrade"))
    .option("--downgrade", t("payment.opt.downgrade"))
    .option("--cancel", t("payment.opt.cancel"))
    .option("--yes", t("payment.opt.yes"))
    .action((levelRaw, opts) =>
      ctx.withAccount(async (hub, { opts: gopts, customerInfo }) => {
        if (!requireYes(ctx, opts)) return;
        const level = toInt(levelRaw);
        const isUpgrade = await inferIsUpgrade(hub, ctx, opts, level);
        if (isUpgrade === undefined) return;
        const response = await hub.payment.payUpdateLevel({
          customerId: opts.customerId,
          subscriptionId: opts.subscriptionId || customerInfo?.subscriptionId,
          level,
          isUpgrade,
          isCancel: !!opts.cancel,
        });
        ctx.out(gopts.json, () => console.log(t("payment.level.ok")), { ok: true, response });
      }),
    );

  payment.command("dev-api")
    .description(t("payment.devApi.desc"))
    .option("--customer-id <id>", t("payment.opt.customerId"))
    .option("--email <email>", t("payment.opt.email"))
    .option("--update", t("payment.opt.update"))
    .option("--yes", t("payment.opt.yes"))
    .action((opts) =>
      ctx.withAccount(async (hub, { opts: gopts, customerInfo }) => {
        if (opts.update && !requireYes(ctx, opts)) return;
        const info = await hub.payment.getDevApiInfo({
          customerId: opts.customerId,
          email: opts.email || customerInfo?.employeeEmail,
          update: opts.update ? true : null,
        });
        ctx.out(gopts.json, () => {
          if (info == null) console.log(t("payment.devApi.none"));
          else printJson(info);
        }, { ok: true, devApiInfo: info });
      }),
    );
}
