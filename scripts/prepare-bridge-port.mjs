#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function fail(message, code) {
  console.error(`[H3 Studio] ${message}`);
  process.exit(code);
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

const projectRoot = await realpath(option("--project-root", process.cwd())).catch(() => "");
const host = option("--host", "127.0.0.1").trim();
const port = Number(option("--port", "8787"));
const timeoutSeconds = Number(option("--timeout", "15"));

if (process.platform !== "linux") fail("Il preflight POSIX supporta attualmente Linux.", 10);
if (!projectRoot) fail("ProjectRoot non valido.", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Porta bridge non valida.", 10);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) fail("Timeout non valido.", 10);
await access(path.join(projectRoot, "bridge", "server.ts"), constants.R_OK).catch(() =>
  fail(`bridge/server.ts non trovato in ${projectRoot}.`, 10));

function endpointAddress(endpoint) {
  const bracket = /^\[([^\]]+)]:(\d+)$/.exec(endpoint);
  if (bracket) return { address: bracket[1], port: Number(bracket[2]) };
  const match = /^(.*):(\d+)$/.exec(endpoint);
  return match ? { address: match[1], port: Number(match[2]) } : null;
}

function addressConflicts(listenerAddress) {
  const normalized = listenerAddress.replace(/^\[|]$/g, "");
  const wildcard = normalized === "*" || normalized === "0.0.0.0" || normalized === "::";
  if (host === "0.0.0.0" || host === "::" || host === "") return true;
  if (wildcard) return true;
  if (host === "localhost") return normalized === "127.0.0.1" || normalized === "::1";
  return normalized === host;
}

async function listeners() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ss", ["-H", "-ltnp"], { encoding: "utf8" }));
  } catch (error) {
    fail(`Impossibile eseguire ss per verificare la porta: ${error.message}`, 11);
  }
  const found = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0] !== "LISTEN") continue;
    const endpoint = endpointAddress(fields[3]);
    if (!endpoint || endpoint.port !== port || !addressConflicts(endpoint.address)) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    if (!pids.length) fail(`La porta ${host}:${port} è occupata ma il PID non è verificabile.`, 20);
    for (const pid of pids) found.push({ pid, address: endpoint.address });
  }
  return [...new Map(found.map((item) => [item.pid, item])).values()];
}

async function processIdentity(pid) {
  const root = `/proc/${pid}`;
  const [commandRaw, cwd, executable, stat] = await Promise.all([
    readFile(path.join(root, "cmdline")),
    readlink(path.join(root, "cwd")),
    readlink(path.join(root, "exe")),
    readFile(path.join(root, "stat"), "utf8"),
  ]);
  const args = commandRaw.toString("utf8").split("\0").filter(Boolean);
  return { pid, args, cwd: await realpath(cwd), executable, startToken: stat.split(" ")[21] };
}

function isExpectedBridge(identity) {
  if (!path.basename(identity.executable).startsWith("node")) return false;
  if (identity.cwd !== projectRoot) return false;
  const expectedServer = path.join(projectRoot, "bridge", "server.ts");
  const server = identity.args.some((argument) => {
    const candidate = path.isAbsolute(argument) ? path.normalize(argument) : path.resolve(identity.cwd, argument);
    return candidate === expectedServer;
  });
  const tsx = identity.args.some((argument) => {
    const normalized = argument.replaceAll("\\", "/");
    return normalized.includes("/node_modules/") && /\/tsx(?:@[^/]*)?\//.test(normalized);
  });
  return server && tsx;
}

function probeUrl() {
  const target = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${target.includes(":") ? `[${target}]` : target}:${port}/api/health`;
}

async function healthy() {
  try {
    const response = await fetch(probeUrl(), { signal: AbortSignal.timeout(3_000) });
    const payload = await response.json();
    return response.ok && payload?.bridge?.status === "online";
  } catch {
    return false;
  }
}

async function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let current = await listeners();
if (!current.length) {
  console.log(`[H3 Studio] Porta ${host}:${port} libera.`);
  process.exit(0);
}
if (current.length !== 1) fail(`Più processi ascoltano su ${host}:${port}; avvio annullato.`, 12);

const pid = current[0].pid;
let identity;
try { identity = await processIdentity(pid); } catch { fail(`Impossibile verificare il PID ${pid}.`, 20); }
if (!isExpectedBridge(identity)) {
  fail(`La porta ${host}:${port} è occupata dal PID ${pid}, che non è il bridge di questo progetto.`, 21);
}
if (await healthy()) {
  console.log(`[H3 Studio] Bridge del progetto già attivo (PID ${pid}): riuso l'istanza esistente.`);
  process.exit(25);
}

current = await listeners();
let confirmed;
try { confirmed = await processIdentity(pid); } catch { fail("Il listener è cambiato durante la verifica.", 22); }
if (current.length !== 1 || current[0].pid !== pid || confirmed.startToken !== identity.startToken || confirmed.args.join("\0") !== identity.args.join("\0")) {
  fail("Il listener è cambiato durante la verifica; avvio annullato.", 22);
}

console.log(`[H3 Studio] Arresto bridge precedente PID ${pid}...`);
process.kill(pid, "SIGTERM");
const deadline = Date.now() + timeoutSeconds * 1_000;
while (Date.now() < deadline && await alive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
if (await alive(pid)) {
  const finalIdentity = await processIdentity(pid).catch(() => null);
  if (!finalIdentity || finalIdentity.startToken !== identity.startToken) fail("Il PID è cambiato durante l'arresto.", 22);
  process.kill(pid, "SIGKILL");
}
while (Date.now() < deadline) {
  if (!(await listeners()).length) {
    console.log(`[H3 Studio] Porta ${host}:${port} liberata.`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
fail(`La porta ${host}:${port} non si è liberata entro ${timeoutSeconds} secondi.`, 24);
