import { spawn } from "node:child_process";
import process from "node:process";

const SERVICE_HEALTH_URL = "http://127.0.0.1:8787/api/v1/health";
const READER_URL = "http://127.0.0.1:4174/";
const children = new Set();
let shuttingDown = false;

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /(?:npm-cli|npm)\.js$/i.test(npmCli)) {
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", ["npm", ...args].join(" ")]
    };
  }
  return { command: "npm", args };
}

function startNpm(args) {
  const invocation = npmInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: new URL("../", import.meta.url),
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForExit(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || shuttingDown) resolve();
      else reject(new Error(`${label} stopped unexpectedly (${signal || `exit ${code}`})`));
    });
  });
}

async function runNpm(args, label) {
  const child = startNpm(args);
  await waitForExit(child, label);
}

async function serviceIsHealthy() {
  try {
    const response = await fetch(SERVICE_HEALTH_URL, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok" && body?.extraction === "mineru-precision";
  } catch {
    return false;
  }
}

async function readerIsHealthy() {
  try {
    const response = await fetch(READER_URL, { signal: AbortSignal.timeout(1_500) });
    return response.ok && (await response.text()).includes("Paper2MD");
  } catch {
    return false;
  }
}

async function waitUntil(check, label, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (child.exitCode !== null) {
      throw new Error(`${label} failed to start (exit ${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within 15 seconds`);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGINT");
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function main() {
  const longRunning = [];

  if (await serviceIsHealthy()) {
    console.log("Paper2MD processing service is already running on http://127.0.0.1:8787");
  } else {
    console.log("Building the Paper2MD processing service...");
    await runNpm(["run", "processing:build"], "Processing service build");
    const service = startNpm(["run", "processing:start"]);
    longRunning.push(waitForExit(service, "Processing service"));
    await waitUntil(serviceIsHealthy, "Processing service", service);
  }

  if (await readerIsHealthy()) {
    console.log(`Paper2MD Reader is already running on ${READER_URL}`);
  } else {
    const reader = startNpm(["run", "web:dev"]);
    longRunning.push(waitForExit(reader, "Reader web server"));
    await waitUntil(readerIsHealthy, "Reader web server", reader);
  }

  console.log(`\nPaper2MD Reader is ready: ${READER_URL}`);
  console.log("Keep this window open while reading or processing PDFs. Press Ctrl+C to stop.\n");

  if (longRunning.length) await Promise.race(longRunning);
}

main().catch((error) => {
  console.error(`\nCould not start Paper2MD Reader: ${error instanceof Error ? error.message : error}`);
  shutdown();
  process.exitCode = 1;
});
