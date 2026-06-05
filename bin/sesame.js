#!/usr/bin/env node
import { run } from "../src/cli.js";

run().catch((err) => {
  console.error("Fatal:", err?.message || err);
  if (process.env.DEBUG) console.error(err?.stack);
  process.exit(1);
});
