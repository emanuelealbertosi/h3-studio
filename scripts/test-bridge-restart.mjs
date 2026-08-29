import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "h3-restart-"));
const spawnedProcesses = new Set();

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(predicate, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate() && Date.now() < deadline) {
    await sleep(50);
  }
  assert.equal(predicate(), true, message);
}

function waitForExit(child, timeoutMilliseconds, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} non è terminato entro ${timeoutMilliseconds} ms`));
    }, timeoutMilliseconds);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runCaptured(executable, argumentsList, timeoutMilliseconds = 10_000) {
  const child = spawn(executable, argumentsList, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedProcesses.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = await waitForExit(child, timeoutMilliseconds, executable);
  return { ...result, stdout, stderr };
}

async function testDetachedRestartHelper() {
  const markerPath = path.join(temporaryDirectory, "restarted.txt");
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  spawnedProcesses.add(parent);
  assert(parent.pid);

  const replacementCode =
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ok')`;
  const helper = spawn(
    process.execPath,
    [
      path.resolve("scripts", "restart-bridge-helper.mjs"),
      String(parent.pid),
      process.execPath,
      process.cwd(),
      JSON.stringify(["-e", replacementCode]),
    ],
    { stdio: "ignore" },
  );
  spawnedProcesses.add(helper);

  await sleep(300);
  parent.kill();
  await waitUntil(
    () => existsSync(markerPath),
    8_000,
    "Il processo sostitutivo non è partito",
  );
  await waitForExit(helper, 2_000, "restart-bridge-helper");
}

async function createListenerFixture(
  projectRoot,
  markerName,
  { listenAddress = "127.0.0.1", extraArguments = [] } = {},
) {
  const bridgeDirectory = path.join(projectRoot, "bridge");
  const serverPath = path.join(bridgeDirectory, "server.ts");
  const tsxDirectory = path.join(projectRoot, "node_modules", "tsx", "dist");
  const preloadPath = path.join(tsxDirectory, "preflight.cjs");
  const portMarkerPath = path.join(temporaryDirectory, markerName);
  await mkdir(bridgeDirectory, { recursive: true });
  await mkdir(tsxDirectory, { recursive: true });
  await writeFile(preloadPath, "// preload tsx fixture\n", "utf8");
  await writeFile(
    serverPath,
    [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const markerPath = process.argv[2];",
      "const healthy = process.argv[4] === 'healthy';",
      "const server = http.createServer((request, response) => {",
      "  response.statusCode = healthy ? 200 : 503;",
      "  response.setHeader('content-type', 'application/json');",
      "  response.end(JSON.stringify({ bridge: { status: healthy ? 'online' : 'stale' } }));",
      "});",
      "server.listen(0, process.argv[3], () => {",
      "  fs.writeFileSync(markerPath, String(server.address().port));",
      "});",
    ].join("\n"),
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [
      "--require",
      preloadPath,
      path.join("bridge", "server.ts"),
      portMarkerPath,
      listenAddress,
      ...extraArguments,
    ],
    {
      cwd: projectRoot,
      stdio: "ignore",
    },
  );
  spawnedProcesses.add(child);
  assert(child.pid);

  await waitUntil(
    () => existsSync(portMarkerPath),
    5_000,
    `Il listener di test PID ${child.pid} non è partito`,
  );

  return {
    child,
    port: Number(readFileSync(portMarkerPath, "utf8")),
  };
}

async function runPortPreparationHelper(projectRoot, port, hostAddress) {
  const windowsPowerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  const argumentsList = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.resolve("scripts", "prepare-bridge-port.ps1"),
    "-ProjectRoot",
    projectRoot,
    "-Port",
    String(port),
    "-TimeoutSeconds",
    "5",
  ];
  if (hostAddress) {
    argumentsList.push("-HostAddress", hostAddress);
  }
  return runCaptured(windowsPowerShell, argumentsList, 30_000);
}

function testLauncherWiring() {
  const launcher = readFileSync(path.resolve("START_H3_STUDIO.bat"), "utf8");
  assert.equal(
    launcher.includes("node --env-file-if-exists=.env -e"),
    true,
    "Il launcher non carica .env quando risolve host e porta",
  );
  assert.equal(
    launcher.includes(
      '-HostAddress "%H3_BRIDGE_HOST_RESOLVED%" -Port %H3_BRIDGE_PORT_RESOLVED%',
    ),
    true,
    "Il launcher non passa l'endpoint configurato al preflight",
  );
  assert.equal(
    launcher.includes('start "H3 Studio - Bridge" cmd /c'),
    true,
    "La console bridge deve chiudersi quando Node termina",
  );
  assert.equal(
    launcher.includes('start "H3 Studio - Bridge" cmd /k'),
    false,
    "Il launcher conserva ancora una console bridge orfana con cmd /k",
  );
  assert.equal(
    launcher.includes('if "%H3_BRIDGE_PREFLIGHT_EXIT%"=="25" set "H3_BRIDGE_REUSE=1"'),
    true,
    "Il launcher non riusa un bridge sano già attivo",
  );
  assert.equal(
    launcher.includes('if "%H3_BRIDGE_REUSE%"=="0" ('),
    true,
    "Il launcher avvia sempre un secondo bridge",
  );
  assert.equal(
    launcher.includes("vinext.cmd dev --hostname %H3_WEB_HOST_RESOLVED%"),
    true,
    "Il frontend non usa il binding configurabile risolto dal launcher",
  );
  assert.equal(
    launcher.includes("tailscale.exe serve --bg --yes --https=443 http://127.0.0.1:3000"),
    true,
    "Tailscale inoltra ancora verso il vecchio listener IPv6-only",
  );
}

async function testStaleListenerCleanup() {
  if (process.platform !== "win32") {
    console.log("Bridge port preflight: SKIP (solo Windows)");
    return;
  }

  const staleProjectRoot = path.join(temporaryDirectory, "stale-project");
  const stale = await createListenerFixture(staleProjectRoot, "stale-port.txt");
  const result = await runPortPreparationHelper(staleProjectRoot, stale.port);

  assert.equal(
    result.code,
    0,
    `Il preflight non ha rimosso il listener stale:\n${result.stdout}\n${result.stderr}`,
  );
  await waitForExit(stale.child, 2_000, "listener stale");

  const wildcardProjectRoot = path.join(
    temporaryDirectory,
    "wildcard-project",
  );
  const wildcard = await createListenerFixture(
    wildcardProjectRoot,
    "wildcard-port.txt",
    { listenAddress: "0.0.0.0" },
  );
  const wildcardResult = await runPortPreparationHelper(
    wildcardProjectRoot,
    wildcard.port,
    "localhost",
  );
  assert.equal(
    wildcardResult.code,
    0,
    `Il preflight ha ignorato un listener wildcard in conflitto:\n${wildcardResult.stdout}\n${wildcardResult.stderr}`,
  );
  await waitForExit(wildcard.child, 2_000, "listener wildcard");

  const healthyProjectRoot = path.join(temporaryDirectory, "healthy-project");
  const healthy = await createListenerFixture(
    healthyProjectRoot,
    "healthy-port.txt",
    { extraArguments: ["healthy"] },
  );
  const reuse = await runPortPreparationHelper(
    healthyProjectRoot,
    healthy.port,
  );
  assert.equal(
    reuse.code,
    25,
    `Il preflight non ha riusato il bridge sano:\n${reuse.stdout}\n${reuse.stderr}`,
  );
  assert.equal(
    healthy.child.exitCode,
    null,
    "Il preflight ha terminato un bridge sano",
  );
  healthy.child.kill();
  await waitForExit(healthy.child, 2_000, "listener sano");

  const claimedProjectRoot = path.join(temporaryDirectory, "claimed-project");
  await mkdir(path.join(claimedProjectRoot, "bridge"), { recursive: true });
  await writeFile(
    path.join(claimedProjectRoot, "bridge", "server.ts"),
    "// fixture di sicurezza\n",
    "utf8",
  );
  const foreignProjectRoot = path.join(temporaryDirectory, "foreign-project");
  const foreign = await createListenerFixture(
    foreignProjectRoot,
    "foreign-port.txt",
    {
      extraArguments: [
        `prefix${path.join(claimedProjectRoot, "node_modules", "tsx")}suffix`,
        `${path.join(claimedProjectRoot, "bridge", "server.ts")}.bak`,
      ],
    },
  );
  const refusal = await runPortPreparationHelper(claimedProjectRoot, foreign.port);

  assert.equal(
    refusal.code,
    21,
    `Il preflight non ha rifiutato il listener estraneo:\n${refusal.stdout}\n${refusal.stderr}`,
  );
  assert.equal(
    foreign.child.exitCode,
    null,
    "Il preflight ha terminato un listener che non appartiene al ProjectRoot",
  );
  foreign.child.kill();
  await waitForExit(foreign.child, 2_000, "listener estraneo");
}

try {
  testLauncherWiring();
  await testDetachedRestartHelper();
  await testStaleListenerCleanup();
  console.log("Bridge restart helper: OK");
} finally {
  for (const child of spawnedProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
