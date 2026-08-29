#!/usr/bin/env node

import { readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "linux") {
  console.error("[H3 Studio] Questo helper è riservato a Linux.");
  process.exit(2);
}

const projectRoot = await realpath(process.argv[2] || process.cwd());
const runDir = path.join(projectRoot, "data", "run");

async function identity(pid) {
  const root = `/proc/${pid}`;
  const [raw, cwd, stat] = await Promise.all([
    readFile(path.join(root, "cmdline")),
    readlink(path.join(root, "cwd")),
    readFile(path.join(root, "stat"), "utf8"),
  ]);
  return {
    pid,
    args: raw.toString("utf8").split("\0").filter(Boolean),
    cwd: await realpath(cwd),
    startToken: stat.split(" ")[21],
  };
}

function belongsToStudio(processInfo) {
  if (processInfo.cwd !== projectRoot) return false;
  const command = processInfo.args.join(" ").replaceAll("\\", "/");
  return command.includes("bridge/server.ts") ||
    (command.includes("vinext") && /(?:^|\s)dev(?:\s|$)/.test(command));
}

const candidates = new Map();
try {
  for (const name of await readdir(runDir)) {
    if (!name.endsWith(".pid")) continue;
    const pid = Number((await readFile(path.join(runDir, name), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) candidates.set(pid, null);
  }
} catch {}

for (const name of await readdir("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  const pid = Number(name);
  const processInfo = await identity(pid).catch(() => null);
  if (processInfo && belongsToStudio(processInfo)) candidates.set(pid, processInfo);
}

const stopped = [];
for (const [pid, known] of candidates) {
  const processInfo = known ?? await identity(pid).catch(() => null);
  if (!processInfo || !belongsToStudio(processInfo)) continue;
  process.kill(pid, "SIGTERM");
  stopped.push({ pid, startToken: processInfo.startToken });
}

const deadline = Date.now() + 10_000;
for (const target of stopped) {
  while (Date.now() < deadline) {
    const current = await identity(target.pid).catch(() => null);
    if (!current || current.startToken !== target.startToken) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const current = await identity(target.pid).catch(() => null);
  if (current?.startToken === target.startToken) process.kill(target.pid, "SIGKILL");
}

await rm(runDir, { recursive: true, force: true });
console.log(stopped.length
  ? `[H3 Studio] Arrestati ${stopped.length} processi del progetto.`
  : "[H3 Studio] Nessun processo del progetto attivo.");
