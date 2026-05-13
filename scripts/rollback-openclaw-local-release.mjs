#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  return `Usage: node scripts/rollback-openclaw-local-release.mjs --target <@glfruit/openclaw@version|tarball.tgz> [--expected-sha256 <sha>] [--execute]`;
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function parseArgs(argv) {
  const args = { target: "", expectedSha256: "", execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--target") {
      args.target = argv[++i] || fail("--target requires a value");
      continue;
    }
    if (arg === "--expected-sha256") {
      args.expectedSha256 = argv[++i] || fail("--expected-sha256 requires a value");
      continue;
    }
    if (arg === "--execute") {
      args.execute = true;
      continue;
    }
    fail(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.target) fail(usage());
  return args;
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
const args = parseArgs(process.argv.slice(2));
const isTarball = args.target.endsWith(".tgz") || args.target.endsWith(".tar.gz");
if (isTarball) {
  const targetPath = path.resolve(args.target);
  if (!fs.existsSync(targetPath)) fail(`rollback tarball does not exist: ${targetPath}`);
  const actual = sha256(targetPath);
  if (args.expectedSha256 && actual !== args.expectedSha256)
    fail(`rollback tarball sha256 mismatch: expected ${args.expectedSha256}, got ${actual}`);
  args.target = targetPath;
}
const current = spawnSync("npm", ["list", "-g", "--depth=0", "@glfruit/openclaw"], {
  encoding: "utf8",
});
const plan = {
  dryRun: !args.execute,
  target: args.target,
  currentState: current.stdout || current.stderr || "unknown",
  actions: [
    `npm install -g ${args.target}`,
    "openclaw gateway restart (requires explicit operator approval outside this script)",
  ],
};
if (!args.execute) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
fail(
  "live rollback execution is stop-gated in slice 1; remove this guard only after TL approval and live rollback tests",
);
