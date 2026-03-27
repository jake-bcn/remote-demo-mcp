#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CONFIG_TEMPLATE, getConfigPath, loadConfig } from "./config.js";
import { deployWithRsync } from "./rsync.js";
import { cancelDeploySession, pollDeploySession, startDeploySession, submitDeployInput } from "./deploy-session.js";

function normalizeVerifyUrl(rawUrl: string): string {
  const target = new URL(rawUrl);
  if (!target.pathname.endsWith("/index.html")) {
    const normalizedPath = target.pathname.replace(/\/+$/, "");
    target.pathname = `${normalizedPath}/index.html`;
  }
  return target.toString();
}

function isYes(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

type EditableConfig = {
  deployUser: string;
  publicBaseUrl: string;
  sessionLog: {
    enabled: boolean;
    path: string;
    logInputValue: boolean;
  };
  ssh: {
    host: string;
    port: number;
    username: string;
    interactiveAuth: boolean;
    password: string;
    hostKeyPolicy: "accept-new" | "strict" | "insecure";
    autoFillPassword: boolean;
  };
  rsyncOptions: string[];
};

function cloneDefaultConfig(): EditableConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG_TEMPLATE)) as EditableConfig;
}

function loadEditableConfig(configPath: string): EditableConfig {
  const base = cloneDefaultConfig();
  if (!fs.existsSync(configPath)) {
    return base;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (typeof raw.deployUser === "string" && raw.deployUser.trim()) base.deployUser = raw.deployUser;
    if (typeof raw.publicBaseUrl === "string") base.publicBaseUrl = raw.publicBaseUrl;

    if (raw.sessionLog && typeof raw.sessionLog === "object") {
      const sessionLog = raw.sessionLog as Record<string, unknown>;
      if (typeof sessionLog.enabled === "boolean") base.sessionLog.enabled = sessionLog.enabled;
      if (typeof sessionLog.path === "string" && sessionLog.path.trim()) base.sessionLog.path = sessionLog.path;
      if (typeof sessionLog.logInputValue === "boolean") base.sessionLog.logInputValue = sessionLog.logInputValue;
    }

    if (raw.ssh && typeof raw.ssh === "object") {
      const ssh = raw.ssh as Record<string, unknown>;
      if (typeof ssh.host === "string" && ssh.host.trim()) base.ssh.host = ssh.host;
      if (typeof ssh.port === "number" && Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port <= 65535) base.ssh.port = ssh.port;
      if (typeof ssh.username === "string" && ssh.username.trim()) base.ssh.username = ssh.username;
      if (typeof ssh.interactiveAuth === "boolean") base.ssh.interactiveAuth = ssh.interactiveAuth;
      if (typeof ssh.password === "string") base.ssh.password = ssh.password;
      if (ssh.hostKeyPolicy === "accept-new" || ssh.hostKeyPolicy === "strict" || ssh.hostKeyPolicy === "insecure") {
        base.ssh.hostKeyPolicy = ssh.hostKeyPolicy;
      }
      if (typeof ssh.autoFillPassword === "boolean") base.ssh.autoFillPassword = ssh.autoFillPassword;
    }

    if (Array.isArray(raw.rsyncOptions) && raw.rsyncOptions.every((item) => typeof item === "string")) {
      base.rsyncOptions = raw.rsyncOptions;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`Existing config parse failed, using defaults for editing: ${message}\n`);
  }

  return base;
}

function toSerializableConfig(config: EditableConfig): Record<string, unknown> {
  return {
    deployUser: config.deployUser,
    publicBaseUrl: config.publicBaseUrl.trim() ? config.publicBaseUrl : undefined,
    sessionLog: config.sessionLog,
    ssh: config.ssh,
    rsyncOptions: config.rsyncOptions,
  };
}

async function promptString(rl: ReturnType<typeof createInterface>, label: string, current: string): Promise<string> {
  const answer = (await rl.question(`${label} [${current}]: `)).trim();
  return answer ? answer : current;
}

async function promptBoolean(rl: ReturnType<typeof createInterface>, label: string, current: boolean): Promise<boolean> {
  const answer = (await rl.question(`${label} [${String(current)}]: `)).trim();
  if (!answer) return current;
  const normalized = answer.toLowerCase();
  if (["1", "true", "t", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "f", "no", "n"].includes(normalized)) return false;
  process.stdout.write(`Invalid boolean input "${answer}", keep current value.\n`);
  return current;
}

async function promptNumber(rl: ReturnType<typeof createInterface>, label: string, current: number): Promise<number> {
  const answer = (await rl.question(`${label} [${String(current)}]: `)).trim();
  if (!answer) return current;
  const parsed = Number(answer);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  process.stdout.write(`Invalid number "${answer}", keep current value.\n`);
  return current;
}

async function promptHostKeyPolicy(
  rl: ReturnType<typeof createInterface>,
  current: "accept-new" | "strict" | "insecure",
): Promise<"accept-new" | "strict" | "insecure"> {
  const answer = (await rl.question(`ssh.hostKeyPolicy [${current}] (accept-new/strict/insecure): `)).trim();
  if (!answer) return current;
  if (answer === "accept-new" || answer === "strict" || answer === "insecure") return answer;
  process.stdout.write(`Invalid hostKeyPolicy "${answer}", keep current value.\n`);
  return current;
}

async function promptRsyncOptions(rl: ReturnType<typeof createInterface>, current: string[]): Promise<string[]> {
  const currentValue = current.join(", ");
  const answer = (await rl.question(`rsyncOptions (comma-separated) [${currentValue}]: `)).trim();
  if (!answer) return current;
  return answer
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function promptConfigEdits(rl: ReturnType<typeof createInterface>, config: EditableConfig): Promise<EditableConfig> {
  process.stdout.write("Edit config. Press Enter to keep current value.\n");
  config.deployUser = await promptString(rl, "deployUser", config.deployUser);
  config.publicBaseUrl = await promptString(rl, "publicBaseUrl", config.publicBaseUrl);
  config.sessionLog.enabled = await promptBoolean(rl, "sessionLog.enabled", config.sessionLog.enabled);
  config.sessionLog.path = await promptString(rl, "sessionLog.path", config.sessionLog.path);
  config.sessionLog.logInputValue = await promptBoolean(rl, "sessionLog.logInputValue", config.sessionLog.logInputValue);
  config.ssh.host = await promptString(rl, "ssh.host", config.ssh.host);
  config.ssh.port = await promptNumber(rl, "ssh.port", config.ssh.port);
  config.ssh.username = await promptString(rl, "ssh.username", config.ssh.username);
  config.ssh.interactiveAuth = await promptBoolean(rl, "ssh.interactiveAuth", config.ssh.interactiveAuth);
  config.ssh.password = await promptString(rl, "ssh.password", config.ssh.password);
  config.ssh.hostKeyPolicy = await promptHostKeyPolicy(rl, config.ssh.hostKeyPolicy);
  config.ssh.autoFillPassword = await promptBoolean(rl, "ssh.autoFillPassword", config.ssh.autoFillPassword);
  config.rsyncOptions = await promptRsyncOptions(rl, config.rsyncOptions);
  return config;
}

const server = new McpServer({
  name: "remote-demo-deployer",
  version: "1.0.0",
});

server.registerTool(
  "deploy_static",
  {
    title: "Deploy Static Site / 部署静态站点",
    description:
      "Deploy to remote, deploy demo, publish demo, upload static site. 部署到远程、部署 demo、发布 demo、上传静态站点。Uses rsync to /var/www/html/demo-remote/{user}/{project}/. For OTP/interactive auth, use session tools (start_deploy_session/poll_deploy_session/submit_deploy_input).",
    inputSchema: z.object({
      localDir: z.string().min(1),
      clientCwd: z.string().min(1).optional(),
      dryRun: z.boolean().optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      attempts: z.number().int(),
      user: z.string(),
      project: z.string(),
      remotePath: z.string(),
      publicUrl: z.string().optional(),
      message: z.string(),
    }),
  },
  async ({ localDir, clientCwd, dryRun }) => {
    try {
      const config = loadConfig();
      const isDryRun = Boolean(dryRun);
      if (config.ssh.interactiveAuth && !isDryRun) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Interactive auth is enabled. deploy_static is disabled for non-dry-run to avoid hanging OTP flow. Use session tools: 1) start_deploy_session 2) poll_deploy_session 3) submit_deploy_input when nextAction=submit_input.",
            },
          ],
          isError: true,
        };
      }

      const result = await deployWithRsync(config, localDir, isDryRun, clientCwd);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "verify_deploy",
  {
    title: "Verify Deploy URL / 验证部署链接",
    description:
      "Verify deployed public URL by HTTP request and return status/latency. 通过 HTTP 请求验证部署后的公网链接并返回状态和耗时。",
    inputSchema: z.object({
      url: z.string().url(),
      timeoutMs: z.number().int().positive().max(60000).default(8000).optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      url: z.string(),
      status: z.number().int(),
      statusText: z.string(),
      responseTimeMs: z.number().int(),
      message: z.string(),
    }),
  },
  async ({ url, timeoutMs }) => {
    const timeout = timeoutMs ?? 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();
    const checkUrl = normalizeVerifyUrl(url);

    try {
      const response = await fetch(checkUrl, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });
      const responseTimeMs = Date.now() - start;
      const ok = response.ok;
      const result = {
        ok,
        url: checkUrl,
        status: response.status,
        statusText: response.statusText,
        responseTimeMs,
        message: ok
          ? `URL is reachable: HTTP ${response.status} in ${responseTimeMs}ms`
          : `URL responded with non-OK status: HTTP ${response.status} in ${responseTimeMs}ms`,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `verify_deploy failed: ${message}`,
          },
        ],
        isError: true,
      };
    } finally {
      clearTimeout(timer);
    }
  },
);

server.registerTool(
  "start_deploy_session",
  {
    title: "Start Deploy Session / 启动部署会话",
    description:
      "Start interactive deploy session and return sessionId. Strict protocol: if nextAction=submit_input call submit_deploy_input; if nextAction=poll call poll_deploy_session; if nextAction=done stop. Agents should continuously relay transfer progress to end users while polling. 启动可交互部署会话并返回 sessionId。严格协议：nextAction=submit_input 则调 submit_deploy_input；nextAction=poll 则调 poll_deploy_session；nextAction=done 则结束；轮询时应持续向用户同步传输进度。",
    inputSchema: z.object({
      localDir: z.string().min(1),
      clientCwd: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      state: z.enum(["running", "waiting_input", "succeeded", "failed", "cancelled"]),
      nextAction: z.enum(["poll", "submit_input", "done"]),
      needsInput: z.boolean(),
      user: z.string(),
      project: z.string(),
      remotePath: z.string(),
      publicUrl: z.string().optional(),
      logPath: z.string(),
      message: z.string(),
      output: z.string(),
      nextCursor: z.number().int(),
    }),
  },
  async ({ localDir, clientCwd }) => {
    try {
      const config = loadConfig();
      const { snapshot, output, nextCursor } = startDeploySession(config, localDir, clientCwd);
      const result = { ...snapshot, output, nextCursor };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "submit_deploy_input",
  {
    title: "Submit Deploy Input / 提交部署输入",
    description:
      "Submit OTP/password to an active deploy session. Always call poll_deploy_session next unless nextAction=done in response. 向活动部署会话提交 OTP/密码输入。提交后通常下一步调用 poll_deploy_session，除非返回 nextAction=done。",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      input: z.string().min(1),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      state: z.enum(["running", "waiting_input", "succeeded", "failed", "cancelled"]),
      nextAction: z.enum(["poll", "submit_input", "done"]),
      needsInput: z.boolean(),
      user: z.string(),
      project: z.string(),
      remotePath: z.string(),
      publicUrl: z.string().optional(),
      logPath: z.string(),
      message: z.string(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
    }),
  },
  async ({ sessionId, input }) => {
    try {
      const result = submitDeployInput(sessionId, input);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "poll_deploy_session",
  {
    title: "Poll Deploy Session / 查询部署会话",
    description:
      "Poll deploy session state and incremental output by cursor. Follow nextAction strictly: submit_input -> submit_deploy_input, poll -> poll_deploy_session, done -> stop. Agents must surface rsync progress output to end users during polling. 使用 cursor 增量查询部署会话状态和输出，并严格按 nextAction 决策下一步；轮询时 agent 必须向用户反馈 rsync 进度输出。",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      state: z.enum(["running", "waiting_input", "succeeded", "failed", "cancelled"]),
      nextAction: z.enum(["poll", "submit_input", "done"]),
      needsInput: z.boolean(),
      user: z.string(),
      project: z.string(),
      remotePath: z.string(),
      publicUrl: z.string().optional(),
      logPath: z.string(),
      message: z.string(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
      output: z.string(),
      nextCursor: z.number().int(),
    }),
  },
  async ({ sessionId, cursor }) => {
    try {
      const { snapshot, output, nextCursor } = pollDeploySession(sessionId, cursor ?? 0);
      const result = { ...snapshot, output, nextCursor };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "cancel_deploy_session",
  {
    title: "Cancel Deploy Session / 取消部署会话",
    description:
      "Cancel an active deploy session; terminal action and no further calls needed. 取消进行中的部署会话；这是终止动作，之后无需继续调用。",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      state: z.enum(["running", "waiting_input", "succeeded", "failed", "cancelled"]),
      nextAction: z.enum(["poll", "submit_input", "done"]),
      needsInput: z.boolean(),
      user: z.string(),
      project: z.string(),
      remotePath: z.string(),
      publicUrl: z.string().optional(),
      logPath: z.string(),
      message: z.string(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
    }),
  },
  async ({ sessionId }) => {
    try {
      const result = cancelDeploySession(sessionId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const [, , arg1] = process.argv;
  if (arg1 === "init") {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const exists = fs.existsSync(configPath);

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (exists) {
        process.stdout.write(`Config already exists: ${configPath}\n`);
        process.stdout.write("Non-interactive shell detected; skip rewrite.\n");
        return;
      }
      fs.writeFileSync(`${configPath}`, `${JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)}\n`, { encoding: "utf8" });
      process.stdout.write(`Config initialized: ${configPath}\n`);
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      if (exists) {
        const modify = await rl.question(`Config already exists: ${configPath}\nModify it? [y/N]: `);
        if (!isYes(modify)) {
          process.stdout.write("Keeping existing config.\n");
          return;
        }
      }

      const editable = loadEditableConfig(configPath);
      const updated = await promptConfigEdits(rl, editable);
      const confirm = await rl.question("Final confirm: write config file now? [y/N]: ");
      if (!isYes(confirm)) {
        process.stdout.write("Write cancelled.\n");
        return;
      }

      fs.writeFileSync(`${configPath}`, `${JSON.stringify(toSerializableConfig(updated), null, 2)}\n`, { encoding: "utf8" });
      process.stdout.write(`Config initialized: ${configPath}\n`);
      return;
    } finally {
      rl.close();
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Failed to start server: ${msg}\n`);
  process.exit(1);
});
