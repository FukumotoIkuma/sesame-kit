#!/usr/bin/env node
process.env.AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED ??= "true";

const { run } = await import("../src/cli.js");

run().catch((err) => {
  console.error("Fatal:", err?.message || err);
  if (process.env.DEBUG) console.error(err?.stack);
  process.exit(1);
});
