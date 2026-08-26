import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { MineruJobOptions } from "./contracts";

const MAX_LOG_CHARS = 64 * 1024;

export function mineruExtractArgs(
  sourcePath: string,
  outputPath: string,
  options: MineruJobOptions,
  baseUrl?: string
): string[] {
  return [
    ...(baseUrl ? ["--base-url", baseUrl] : []),
    "extract",
    sourcePath,
    "--model",
    options.model,
    "--language",
    options.language,
    "--format",
    "md,json",
    "--timeout",
    String(options.timeoutSeconds),
    "--output",
    outputPath,
    "--formula",
    "--table"
  ];
}

function quoteCmdArgument(value: string): string {
  if (/[\r\n\0"]/u.test(value)) throw new Error("Unsafe character in configured MinerU command argument");
  return `"${value}"`;
}

export function mineruSpawnSpec(command: string, args: string[]): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  let resolvedCommand = command;
  if (process.platform === "win32" && !extname(command) && !/[\\/]/.test(command)) {
    const pathDirectories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const candidates = pathDirectories.flatMap((directory) => [
      join(directory, `${command}.exe`),
      join(directory, `${command}.cmd`),
      join(directory, `${command}.bat`),
      join(directory, command)
    ]);
    resolvedCommand = candidates.find((candidate) => existsSync(candidate)) ?? command;
  }
  if (process.platform !== "win32" || ![".cmd", ".bat"].includes(extname(resolvedCommand).toLowerCase())) {
    return { command: resolvedCommand, args };
  }
  const commandProcessor = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const commandLine = [resolvedCommand, ...args].map(quoteCmdArgument).join(" ");
  // cmd.exe requires an additional outer quote pair when the command itself is
  // quoted. windowsVerbatimArguments prevents Node from turning those quotes
  // into literal \" characters before cmd.exe sees them.
  return {
    command: commandProcessor,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

export function runMineru(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  onSpawn?: (child: ChildProcess) => void
): Promise<string> {
  const spec = mineruSpawnSpec(command, args);
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: process.env,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  onSpawn?.(child);
  let log = "";
  const append = (chunk: Buffer) => {
    log = `${log}${chunk.toString("utf8")}`.slice(-MAX_LOG_CHARS);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`MinerU exceeded the ${timeoutSeconds}-second task timeout`)));
    }, (timeoutSeconds + 30) * 1000);
    timer.unref();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.once("error", (error) => finish(() => reject(new Error(`Could not start MinerU: ${error.message}`))));
    child.once("close", (code) => finish(() => {
      if (code === 0) resolve(log.trim());
      else reject(new Error(log.trim() || `MinerU exited with code ${code}`));
    }));
  });
}
