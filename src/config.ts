import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const safeUserSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: "must contain only letters, numbers, '_' or '-'",
  })
  .refine((value) => value !== "." && value !== ".." && !value.includes("."), {
    message: "must not contain '.' or '..'",
  })
  .refine((value) => !value.includes("/") && !value.includes("\\"), {
    message: "must be a single path segment (no '/' or '\\\\')",
  });

const configSchema = z.object({
  deployUser: safeUserSchema,
  publicBaseUrl: z.string().url().optional(),
  sessionLog: z.object({
    enabled: z.boolean().default(false),
    path: z.string().min(1).default("/tmp/remote-demo-mcp-session.log"),
    logInputValue: z.boolean().default(false),
  }).default({
    enabled: false,
    path: "/tmp/remote-demo-mcp-session.log",
    logInputValue: false,
  }),
  ssh: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    password: z.string().default(""),
    interactiveAuth: z.boolean().default(true),
    hostKeyPolicy: z.enum(["accept-new", "strict", "insecure"]).default("accept-new"),
    autoFillPassword: z.boolean().default(true),
  }),
  rsyncOptions: z.array(z.string()).default(["-az", "--delete"]),
});

export type AppConfig = z.infer<typeof configSchema>;

export function getConfigPath(): string {
  return process.env.REMOTE_DEMO_MCP_CONFIG ?? path.join(os.homedir(), ".config", "remote-demo-mcp", "config.json");
}

export const DEFAULT_CONFIG_TEMPLATE = {
  deployUser: "demo_user-01",
  publicBaseUrl: "https://example.com",
  sessionLog: {
    enabled: false,
    path: "/tmp/remote-demo-mcp-session.log",
    logInputValue: false,
  },
  ssh: {
    host: "xxx.xxx.xxx.xxx",
    port: 2222,
    username: "alice123#ec2-user#52.76.147.44",
    interactiveAuth: true,
    password: "",
    hostKeyPolicy: "accept-new",
    autoFillPassword: true,
  },
  rsyncOptions: ["-az", "--delete"],
} as const;

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse config JSON at ${configPath}: ${String(error)}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${configPath}: ${result.error.message}`);
  }

  return result.data;
}
