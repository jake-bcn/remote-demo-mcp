import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { closeTty, openTty, promptRetry } from "./tty.js";
import type { AppConfig } from "./config.js";

const FIXED_REMOTE_BASE_PATH = "/var/www/html/demo-remote";

export type DeployResult = {
  ok: boolean;
  attempts: number;
  user: string;
  project: string;
  remotePath: string;
  publicUrl?: string;
  message: string;
};

export type DeployPlan = {
  user: string;
  project: string;
  remotePath: string;
  publicUrl?: string;
  command: string[];
  resolvedLocalDir: string;
};

export function deriveProjectName(localDir: string, clientCwd?: string): string {
  const basePath = clientCwd?.trim() ? path.resolve(clientCwd) : path.resolve(localDir);
  const project = path.basename(basePath);

  if (!project || project === "." || project === "..") {
    throw new Error(`Unable to derive project name from base path: ${basePath}`);
  }

  return project;
}

function assertSafePathSegment(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (value === "." || value === "..") {
    throw new Error(`${label} cannot be '.' or '..'.`);
  }
  if (value.includes(".")) {
    throw new Error(`${label} cannot contain '.'.`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} cannot contain path separators.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} can only contain letters, numbers, '_' or '-'.`);
  }
}

function buildAndValidateRemotePath(user: string, project: string): string {
  const remotePath = path.posix.join(FIXED_REMOTE_BASE_PATH, user, project, "/");
  const normalized = path.posix.normalize(remotePath);
  const expectedPrefix = `${FIXED_REMOTE_BASE_PATH}/`;

  if (!normalized.startsWith(expectedPrefix)) {
    throw new Error(`Remote path must stay under ${FIXED_REMOTE_BASE_PATH}. Got: ${normalized}`);
  }

  return normalized;
}

function ensureDirectoryExists(localDir: string): void {
  const stat = fs.statSync(localDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`localDir is not a directory or does not exist: ${localDir}`);
  }
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

export function formatCommandForShell(args: string[]): string {
  return args
    .map((arg, index) => {
      if (index > 0 && args[index - 1] === "-e") {
        return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
      }
      if (/^[A-Za-z0-9_./:@#%+=,-]+$/.test(arg)) {
        return arg;
      }
      return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
    })
    .join(" ");
}

function buildPublicUrl(config: AppConfig, user: string, project: string): string | undefined {
  if (!config.publicBaseUrl) {
    return undefined;
  }
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return `${base}/${user}/${project}/`;
}

export function resolveLocalDir(localDir: string, clientCwd?: string): string {
  if (path.isAbsolute(localDir)) {
    return localDir;
  }
  const baseDir = clientCwd?.trim() || process.env.CODEX_START_DIR?.trim() || process.cwd();
  return path.resolve(baseDir, localDir);
}

async function runRsyncOnce(args: string[], tty: ReturnType<typeof openTty>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const stdio: Array<number | "pipe" | "inherit"> = tty
      ? [tty.inputFd, tty.outputFd, tty.outputFd]
      : ["pipe", "pipe", "pipe"];

    const child = spawn(args[0], args.slice(1), { stdio });

    let stderr = "";
    if (!tty && child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (!tty && code !== 0) {
        const msg = stderr.trim();
        if (msg) {
          process.stderr.write(`${msg}\n`);
        }
      }
      resolve({ code, signal });
    });
  });
}

function buildRsyncCommand(config: AppConfig, resolvedLocalDir: string, remotePath: string): string[] {
  const sshOptions = ["-p", String(config.ssh.port)];

  if (config.ssh.hostKeyPolicy === "accept-new") {
    sshOptions.push("-o", "StrictHostKeyChecking=accept-new");
  } else if (config.ssh.hostKeyPolicy === "strict") {
    sshOptions.push("-o", "StrictHostKeyChecking=yes");
  } else {
    sshOptions.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }

  const sshCommand = ["ssh", ...sshOptions].join(" ");
  const sourceDir = ensureTrailingSlash(resolvedLocalDir);
  const destination = `${config.ssh.username}@${config.ssh.host}:${remotePath}`;
  const hasPartial = config.rsyncOptions.some((option) => option === "--partial");
  const hasAppendVerify = config.rsyncOptions.some((option) => option === "--append-verify");
  const hasProgress =
    config.rsyncOptions.some((option) => option === "--progress") ||
    config.rsyncOptions.some((option) => option.startsWith("--info="));
  const resumableOptions = [...config.rsyncOptions];

  // Force resumable transfer behavior for interrupted deployments.
  if (!hasPartial) {
    resumableOptions.push("--partial");
  }
  if (!hasAppendVerify) {
    resumableOptions.push("--append-verify");
  }
  if (!hasProgress) {
    resumableOptions.push("--progress");
  }

  return ["rsync", ...resumableOptions, "-e", sshCommand, "--", sourceDir, destination];
}

export function prepareDeploy(config: AppConfig, localDir: string, clientCwd?: string): DeployPlan {
  const resolvedLocalDir = resolveLocalDir(localDir, clientCwd);
  ensureDirectoryExists(resolvedLocalDir);
  const user = config.deployUser;
  assertSafePathSegment(user, "user");

  const project = deriveProjectName(resolvedLocalDir, clientCwd);
  assertSafePathSegment(project, "project");
  const remotePath = buildAndValidateRemotePath(user, project);
  const publicUrl = buildPublicUrl(config, user, project);
  const command = buildRsyncCommand(config, resolvedLocalDir, remotePath);

  return {
    user,
    project,
    remotePath,
    publicUrl,
    command,
    resolvedLocalDir,
  };
}

export async function deployWithRsync(config: AppConfig, localDir: string, dryRun: boolean, clientCwd?: string): Promise<DeployResult> {
  const plan = prepareDeploy(config, localDir, clientCwd);
  const { user, project, remotePath, publicUrl, command } = plan;

  if (dryRun) {
    return {
      ok: true,
      attempts: 0,
      user,
      project,
      remotePath,
      publicUrl,
      message: `Dry run command: ${formatCommandForShell(command)}`,
    };
  }

  const tty = openTty();
  let attempts = 0;

  try {
    while (true) {
      attempts += 1;
      const result = await runRsyncOnce(command, tty);
      if (result.code === 0) {
        return {
          ok: true,
          attempts,
          user,
          project,
          remotePath,
          publicUrl,
          message: `Deploy succeeded after ${attempts} attempt(s).`,
        };
      }

      if (!tty) {
        throw new Error(
          `rsync failed with code=${String(result.code)} signal=${String(result.signal)}. No TTY found; cannot prompt for retry/OTP interaction.`,
        );
      }

      const retry = await promptRetry(tty);
      if (!retry) {
        return {
          ok: false,
          attempts,
          user,
          project,
          remotePath,
          publicUrl,
          message: `Deploy cancelled by user after ${attempts} attempt(s).`,
        };
      }
    }
  } finally {
    closeTty(tty);
  }
}
