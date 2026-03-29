import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { IPty } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import type { AppConfig } from "./config.js";
import { formatCommandForShell, prepareDeploy } from "./rsync.js";

export type DeploySessionState = "running" | "waiting_input" | "succeeded" | "failed" | "cancelled";
export type DeploySessionNextAction = "poll" | "submit_input" | "done";

export type DeploySessionSnapshot = {
  sessionId: string;
  state: DeploySessionState;
  nextAction: DeploySessionNextAction;
  needsInput: boolean;
  user: string;
  project: string;
  remotePath: string;
  publicUrl?: string;
  logPath: string;
  exitCode?: number | null;
  signal?: string | null;
  message: string;
};

type DeploySession = DeploySessionSnapshot & {
  pty: IPty;
  output: string;
  updatedAt: number;
  autoHostKeyAccepted: boolean;
  autoPasswordAttempts: number;
  sshPassword: string;
  autoFillPassword: boolean;
  sshpassAvailable: boolean;
  logEnabled: boolean;
  logPathValue: string;
  logInputValue: boolean;
};

const sessions = new Map<string, DeploySession>();
const OUTPUT_LIMIT = 64_000;
const require = createRequire(import.meta.url);
const OTP_HINT = /(otp|passcode|verification code|enter code|mfa|authenticator|token|one-time|one time)/i;
const PASSWORD_HINT = /password[^:\n\r]*:/i;
const HOSTKEY_CONFIRM_HINT = /continue connecting\s*\(yes\/no(?:\/\[[^\]]+\])?\)\?/i;

type HelperRepairResult = { checked: number; fixed: string[]; errors: string[] };

function ensureNodePtySpawnHelperExecutable(): HelperRepairResult {
  const result: HelperRepairResult = { checked: 0, fixed: [], errors: [] };
  const candidates = new Set<string>();
  try {
    const nodePtyMain = require.resolve("node-pty");
    const nodePtyRoot = path.dirname(path.dirname(nodePtyMain));
    const prebuildsDir = path.join(nodePtyRoot, "prebuilds");
    if (fs.existsSync(prebuildsDir) && fs.statSync(prebuildsDir).isDirectory()) {
      for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        candidates.add(path.join(prebuildsDir, entry.name, "spawn-helper"));
      }
    }
    candidates.add(path.join(nodePtyRoot, "build", "Release", "spawn-helper"));
  } catch (error) {
    result.errors.push(`resolve node-pty failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  for (const helperPath of candidates) {
    try {
      if (!fs.existsSync(helperPath)) {
        continue;
      }
      result.checked += 1;
      const stats = fs.statSync(helperPath);
      const mode = stats.mode & 0o777;
      if ((mode & 0o111) !== 0) {
        continue;
      }
      const nextMode = mode | 0o755;
      fs.chmodSync(helperPath, nextMode);
      result.fixed.push(helperPath);
    } catch (error) {
      result.errors.push(`${helperPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function isSshpassAvailable(sshpassPath?: string): boolean {
  if (!sshpassPath) {
    return false;
  }
  const result = spawnSync(sshpassPath, ["-V"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function writeLog(session: DeploySession, level: "INFO" | "STDOUT" | "STDERR" | "INPUT" | "ERROR", text: string): void {
  if (!session.logEnabled) {
    return;
  }
  const ts = new Date().toISOString();
  const normalized = text.replace(/\r/g, "\\r");
  fs.appendFileSync(session.logPathValue, `${ts} [${level}] [${session.sessionId}] ${normalized}\n`, { encoding: "utf8" });
}

function trimOutput(output: string): string {
  if (output.length <= OUTPUT_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_LIMIT);
}

function tryAutoRespond(session: DeploySession, chunk: string): void {
  if (!session.autoHostKeyAccepted && HOSTKEY_CONFIRM_HINT.test(chunk)) {
    session.pty.write("yes\r");
    session.autoHostKeyAccepted = true;
    session.message = "Auto-accepted host key prompt.";
    writeLog(session, "INFO", "Auto-filled host key confirmation with 'yes'.");
  }

  if (session.autoFillPassword && PASSWORD_HINT.test(chunk)) {
    if (!session.sshPassword) {
      session.state = "failed";
      session.message = "Password prompt detected but ssh.password is empty in config.";
      writeLog(session, "ERROR", session.message);
      session.pty.kill();
      return;
    }
    if (session.autoPasswordAttempts >= 3) {
      session.state = "failed";
      session.message = "Password prompt repeated too many times (>=3).";
      writeLog(session, "ERROR", session.message);
      session.pty.kill();
      return;
    }
    session.pty.write(`${session.sshPassword}\r`);
    session.autoPasswordAttempts += 1;
    session.message = "Auto-filled password prompt.";
    writeLog(session, "INFO", `Auto-filled password (attempt=${session.autoPasswordAttempts}).`);
  }
}

function appendOutput(session: DeploySession, chunk: string): void {
  // rsync progress often refreshes with '\r'; normalize to '\n' so poll output is readable by clients.
  const normalizedChunk = chunk.replace(/\r/g, "\n");
  session.output = trimOutput(`${session.output}${normalizedChunk}`);
  session.updatedAt = Date.now();
  writeLog(session, "STDOUT", chunk);
  if (session.state !== "running") {
    return;
  }

  tryAutoRespond(session, normalizedChunk);
  if (session.state !== "running") {
    return;
  }

  if (!session.autoFillPassword && PASSWORD_HINT.test(normalizedChunk)) {
    session.state = "waiting_input";
    session.message = "Password input required (sshpass not found). Call submit_deploy_input with password first.";
    writeLog(session, "INFO", "State changed to waiting_input for password prompt.");
    return;
  }

  if (OTP_HINT.test(normalizedChunk)) {
    session.state = "waiting_input";
    session.message = "OTP input required. Call submit_deploy_input with OTP code.";
    writeLog(session, "INFO", "State changed to waiting_input based on output pattern match.");
  }
}

function makeSnapshot(session: DeploySession): DeploySessionSnapshot {
  const nextAction: DeploySessionNextAction =
    session.state === "waiting_input" ? "submit_input" : session.state === "running" ? "poll" : "done";
  const messageWithNext = `${session.message} NEXT_ACTION=${nextAction}`;
  return {
    sessionId: session.sessionId,
    state: session.state,
    nextAction,
    needsInput: session.state === "waiting_input",
    user: session.user,
    project: session.project,
    remotePath: session.remotePath,
    publicUrl: session.publicUrl + "index.html",
    logPath: session.logEnabled ? session.logPathValue : "",
    exitCode: session.exitCode,
    signal: session.signal,
    message: messageWithNext,
  };
}

export function startDeploySession(config: AppConfig, localDir: string, clientCwd?: string): { snapshot: DeploySessionSnapshot; output: string; nextCursor: number } {
  const plan = prepareDeploy(config, localDir, clientCwd);
  const helperRepair = ensureNodePtySpawnHelperExecutable();
  const sshpassAvailable = isSshpassAvailable(plan.commands.sshpass);
  const autoFillPassword = config.ssh.autoFillPassword && sshpassAvailable;
  let pty: IPty;
  try {
    pty = spawnPty(plan.command[0], plan.command.slice(1), {
      name: "xterm-color",
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to start interactive deploy process: ${details}. command=${plan.command[0]} cwd=${process.cwd()} PATH=${process.env.PATH ?? ""} helperChecked=${helperRepair.checked} helperFixed=${helperRepair.fixed.length} helperErrors=${helperRepair.errors.join(" | ")}`,
    );
  }

  const sessionId = randomUUID();
  const session: DeploySession = {
    sessionId,
    state: "running",
    nextAction: "poll",
    needsInput: false,
    user: plan.user,
    project: plan.project,
    remotePath: plan.remotePath,
    publicUrl: plan.publicUrl,
    logPath: config.sessionLog.enabled ? config.sessionLog.path : "",
    message: "Deploy started. Poll output; if prompt appears, nextAction will switch to submit_input.",
    pty,
    output: "",
    updatedAt: Date.now(),
    autoHostKeyAccepted: false,
    autoPasswordAttempts: 0,
    sshPassword: config.ssh.password,
    autoFillPassword,
    sshpassAvailable,
    logEnabled: config.sessionLog.enabled,
    logPathValue: config.sessionLog.path,
    logInputValue: config.sessionLog.logInputValue,
  };
  writeLog(session, "INFO", `Deploy started. localDir=${plan.resolvedLocalDir}`);
  writeLog(session, "INFO", `Command: ${formatCommandForShell(plan.command)}`);
  writeLog(
    session,
    "INFO",
    `node-pty helper check: checked=${helperRepair.checked} fixed=${helperRepair.fixed.length} errors=${helperRepair.errors.length}`,
  );
  for (const helperPath of helperRepair.fixed) {
    writeLog(session, "INFO", `Fixed non-executable node-pty helper: ${helperPath}`);
  }
  for (const helperError of helperRepair.errors) {
    writeLog(session, "ERROR", `node-pty helper check error: ${helperError}`);
  }
  for (const note of plan.compatibilityNotes) {
    writeLog(session, "INFO", `Compatibility note: ${note}`);
  }
  writeLog(
    session,
    "INFO",
    `sshpass available=${String(sshpassAvailable)}; autoFillPassword=${String(autoFillPassword)}.`,
  );

  pty.onData((chunk: string) => {
    appendOutput(session, chunk);
  });
  pty.onExit(({ exitCode, signal }) => {
    session.exitCode = exitCode;
    session.signal = typeof signal === "number" ? String(signal) : null;
    if (session.state === "cancelled") {
      session.message = "Deploy cancelled.";
      writeLog(session, "INFO", session.message);
      return;
    }
    if (exitCode === 0) {
      session.state = "succeeded";
      session.message = "Deploy completed successfully.";
      writeLog(session, "INFO", session.message);
      return;
    }
    session.state = "failed";
    session.message = `Deploy failed with code=${String(exitCode)} signal=${String(session.signal)}.`;
    writeLog(session, "ERROR", session.message);
  });

  sessions.set(sessionId, session);
  return {
    snapshot: makeSnapshot(session),
    output: session.output,
    nextCursor: session.output.length,
  };
}

export function submitDeployInput(sessionId: string, input: string): DeploySessionSnapshot {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.state === "succeeded" || session.state === "failed" || session.state === "cancelled") {
    throw new Error(`Session already finished: ${sessionId} (${session.state})`);
  }
  writeLog(
    session,
    "INPUT",
    session.logInputValue ? `Input submitted: ${input}` : `Input submitted (length=${input.length})`,
  );
  session.pty.write(`${input}\r`);
  session.state = "running";
  session.message = "Input submitted.";
  session.updatedAt = Date.now();
  return makeSnapshot(session);
}

export function pollDeploySession(sessionId: string, cursor = 0): { snapshot: DeploySessionSnapshot; output: string; nextCursor: number } {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const safeCursor = Math.max(0, Math.min(cursor, session.output.length));
  return {
    snapshot: makeSnapshot(session),
    output: session.output.slice(safeCursor),
    nextCursor: session.output.length,
  };
}

export function cancelDeploySession(sessionId: string): DeploySessionSnapshot {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.state === "running" || session.state === "waiting_input") {
    session.state = "cancelled";
    session.message = "Cancelling deploy session.";
    writeLog(session, "INFO", session.message);
    session.pty.kill();
  }
  return makeSnapshot(session);
}
