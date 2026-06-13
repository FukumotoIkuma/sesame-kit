#!/usr/bin/env node
const { run } = await import("../src/cli.js");

run().catch((err) => {
  console.error("Fatal:", err?.message || err);
  if (process.env.DEBUG) console.error(err?.stack);
  process.exit(1);
});
