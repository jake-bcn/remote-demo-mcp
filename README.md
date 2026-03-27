# Remote Demo MCP

Local MCP server that deploys a pre-built static directory to a remote host with `rsync`.

## What It Does

- Uses fixed `deployUser` from MCP config
- Derives `project` from `localDir` basename
- Uploads `localDir` contents to:
  - `/var/www/html/demo-remote/{user}/{project}/`
- Uses local `rsync` command
- Supports OTP/interactive SSH flows by attaching rsync session to `/dev/tty`
- On failure, asks whether to retry until user cancels

## Install

```bash
npm install
npm run build
```

## Config

Default config path:

- `~/.config/remote-demo-mcp/config.json`

Override path with:

- `REMOTE_DEMO_MCP_CONFIG=/abs/path/config.json`

Example:

```json
{
  "deployUser": "demo_user-01",
  "publicBaseUrl": "https://example.com",
  "sessionLog": {
    "enabled": false,
    "path": "/tmp/remote-demo-mcp-session.log",
    "logInputValue": false
  },
  "ssh": {
    "host": "xxx.xxx.xxx.xxx",
    "port": 2222,
    "username": "alice123#ec2-user#52.76.147.44",
    "interactiveAuth": true,
    "password": "",
    "hostKeyPolicy": "accept-new",
    "autoFillPassword": true
  },
  "rsyncOptions": ["-az", "--delete"]
}
```

The server automatically enables resumable uploads by appending:

- `--partial`
- `--append-verify`
- `--progress` (unless `rsyncOptions` already includes `--progress` or `--info=...`)

Remote target base path is hard-coded and cannot be overridden:

- `/var/www/html/demo-remote`

## Tool

### `deploy_static`

Keywords:

- EN: `deploy to remote`, `deploy demo`, `publish demo`, `upload static site`
- 中文: `部署到远程`, `部署demo`, `部署 demo`, `发布demo`, `上传静态网页`

`user` rules:

- `deployUser` is app user id for remote path, not SSH `username`
- Allowed chars: `A-Z a-z 0-9 _ -`
- Not allowed: `.`, `..`, spaces, `/`, `\\`, and other special characters

Input:

```json
{
  "localDir": "/abs/path/to/dist",
  "clientCwd": "/abs/path/on-mcp-client",
  "dryRun": false
}
```

`localDir` path resolution:

- Absolute path: used directly
- Relative path: resolved against `clientCwd` if provided
- Fallback for relative path: `CODEX_START_DIR` if set, otherwise `process.cwd()` (server start directory)

Project name resolution:

- If `clientCwd` is provided, project name uses the last path segment of `clientCwd`
- Otherwise, project name uses the last path segment of resolved `localDir`

Behavior note:

- If `ssh.interactiveAuth=true` and `dryRun=false`, `deploy_static` will fail fast by design.
- For OTP/password interactive deploy, use:
  1. `start_deploy_session`
  2. `poll_deploy_session`
  3. `submit_deploy_input` when `nextAction=submit_input`
- Host-key confirm (`yes/no`) and password prompts are auto-handled in session mode.
- OTP is still manual: call `submit_deploy_input` when `nextAction=submit_input`.

Output (`structuredContent`):

```json
{
  "ok": true,
  "attempts": 1,
  "user": "alice",
  "project": "my-site",
  "remotePath": "/var/www/html/demo-remote/alice/my-site/",
  "publicUrl": "https://example.com/alice/my-site/index.html",
  "message": "Deploy succeeded after 1 attempt(s)."
}
```

### `verify_deploy`

Input:

```json
{
  "url": "https://example.com/alice/my-site/index.html",
  "timeoutMs": 8000
}
```

### Interactive OTP Session Tools

Use these when OTP/password must be entered during deploy in non-TTY hosts:

1. `start_deploy_session`
2. `poll_deploy_session` (read output and progress; if `state=waiting_input`, submit code)
3. `submit_deploy_input` (send OTP/password)
4. repeat step 2 until `state` is `succeeded` or `failed`
5. optional `cancel_deploy_session`

`poll_deploy_session` supports incremental output by `cursor` and returns `nextCursor`.

Session tools return `nextAction` to make orchestration deterministic:

- `submit_input`: call `submit_deploy_input`
- `poll`: call `poll_deploy_session`
- `done`: workflow finished (`succeeded` / `failed` / `cancelled`)

Session logging:

- Configure in MCP config file under `sessionLog`.
- `sessionLog.enabled` default is `false`.
- `sessionLog.path` default is `/tmp/remote-demo-mcp-session.log`.
- `sessionLog.logInputValue` default is `false` (only input length is logged).
- Interactive session tools run rsync in a PTY, so password/OTP prompts can be detected via `poll_deploy_session`.

SSH host key policy:

- `accept-new` (default): first-time host key is auto-accepted; changed key is rejected.
- `strict`: never auto-accept unknown host key.
- `insecure`: disable host key validation (high risk; for temporary/debug use only).

Codex CLI interactive flow:

1. Call `start_deploy_session`
2. Loop `poll_deploy_session`
3. If `needsInput=true` or `nextAction=submit_input`, call `submit_deploy_input` with OTP/password. The tip display to user is "Please Enter MFA Code."  or "Please Enter Password."
4. Continue polling until `nextAction=done`

Agent protocol contract (for MCP clients like Codex):

1. Call `start_deploy_session` once.
2. Read `nextAction` from response.
3. If `nextAction=submit_input`, call `submit_deploy_input`.
4. If `nextAction=poll`, call `poll_deploy_session`.
5. Repeat steps 2-4 until `nextAction=done`.
6. Never call `deploy_static` for OTP flows; use session tools only.
7. While polling, relay transfer progress from `output` to the end user continuously.

Output (`structuredContent`):

```json
{
  "ok": true,
  "url": "https://example.com/alice/my-site/index.html",
  "status": 200,
  "statusText": "OK",
  "responseTimeMs": 123,
  "message": "URL is reachable: HTTP 200 in 123ms"
}
```

## Run

```bash
npm run dev
# or
npm run build && npm start
```


# codex 使用
## 安裝 npm 包
``` bash
npm install -g    @jake.e-com365/remote-demo-mcp
```
## codex 添加 mcp
```
codex mcp add remote-demo-mcp remote-demo-mcp  
``` 

## remote-demo-mcp 的配置
```bash 
vi  ~/.config/remote-demo-mcp/config.json
```

```json
{
  "deployUser": "jake",
  "publicBaseUrl": "https://demo-remote.e-com365.com/",
  "ssh": {
    "host": "xxx.xxx.xxx.xxx",
    "username": "alice123#ec2-user#18.140.183.126",
    "interactiveAuth": true,
    "port": 2222,
    "password": "xxx",
    "hostKeyPolicy": "accept-new",
    "autoFillPassword": true
  },
  "rsyncOptions": ["-az", "--delete"]
}
```