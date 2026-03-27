#!/usr/bin/env node

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Failed to start server: ${msg}\n`);
  process.exit(1);
});
