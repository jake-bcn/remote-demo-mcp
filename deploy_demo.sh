#!/usr/bin/env bash
set -euo pipefail

# ===== Config Source =====
# Reads from:
# - $REMOTE_DEMO_MCP_CONFIG if set
# - otherwise ~/.config/remote-demo-mcp/config.json
CONFIG_PATH="${REMOTE_DEMO_MCP_CONFIG:-$HOME/.config/remote-demo-mcp/config.json}"

REMOTE_BASE="/var/www/html/demo-remote"
PUBLIC_BASE_URL=""

# Base rsync options; script will auto-add --partial/--checksum/--progress
RSYNC_OPTS=(-az --delete)

# ===== Inputs =====
LOCAL_DIR="${1:-}"
REMOTE_DIR="${2:-}"

if [[ -z "$LOCAL_DIR" || -z "$REMOTE_DIR" ]]; then
  echo "Usage: $0 <localDir> <remoteDir>"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found. Install first: brew install jq"
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config not found: $CONFIG_PATH"
  exit 1
fi

DEPLOY_USER="$(jq -r '.deployUser // empty' "$CONFIG_PATH")"
SSH_HOST="$(jq -r '.ssh.host // empty' "$CONFIG_PATH")"
SSH_PORT="$(jq -r '.ssh.port // 22' "$CONFIG_PATH")"
SSH_USER="$(jq -r '.ssh.username // empty' "$CONFIG_PATH")"
SSH_PASSWORD="$(jq -r '.ssh.password // empty' "$CONFIG_PATH")"
PUBLIC_BASE_URL="$(jq -r '.publicBaseUrl // empty' "$CONFIG_PATH")"

mapfile -t CONFIG_RSYNC_OPTS < <(jq -r '.rsyncOptions[]?' "$CONFIG_PATH")
if (( ${#CONFIG_RSYNC_OPTS[@]} > 0 )); then
  RSYNC_OPTS=("${CONFIG_RSYNC_OPTS[@]}")
fi

if [[ -z "$DEPLOY_USER" || -z "$SSH_HOST" || -z "$SSH_USER" ]]; then
  echo "Invalid config: deployUser / ssh.host / ssh.username cannot be empty"
  exit 1
fi
if ! [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
  echo "Invalid config: ssh.port must be an integer in [1, 65535]"
  exit 1
fi

if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "localDir not found: $LOCAL_DIR"
  exit 1
fi

if [[ "$LOCAL_DIR" = /* ]]; then
  RESOLVED_LOCAL_DIR="$LOCAL_DIR"
else
  RESOLVED_LOCAL_DIR="$(cd "$PWD" && cd "$LOCAL_DIR" && pwd)"
fi

if [[ ! "$REMOTE_DIR" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "remoteDir can only contain letters, numbers, '_' or '-'"
  exit 1
fi

REMOTE_PATH="${REMOTE_BASE}/${DEPLOY_USER}/${REMOTE_DIR}/"
SOURCE_DIR="${RESOLVED_LOCAL_DIR%/}/"
DEST="${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}"

has_partial=0
has_checksum=0
has_progress=0
for opt in "${RSYNC_OPTS[@]}"; do
  [[ "$opt" == "--partial" ]] && has_partial=1
  if [[ "$opt" == "--checksum" || "$opt" == "-c" || ( "$opt" =~ ^-[^-] && "$opt" == *c* ) ]]; then
    has_checksum=1
  fi
  [[ "$opt" == "--progress" || "$opt" == --info=* ]] && has_progress=1
done

(( has_partial == 0 )) && RSYNC_OPTS+=(--partial)
(( has_checksum == 0 )) && RSYNC_OPTS+=(--checksum)
(( has_progress == 0 )) && RSYNC_OPTS+=(--progress)

if rsync --help 2>&1 | grep -q -- '--append-verify'; then
  has_append_verify=0
  for opt in "${RSYNC_OPTS[@]}"; do
    [[ "$opt" == "--append-verify" ]] && has_append_verify=1
  done
  (( has_append_verify == 0 )) && RSYNC_OPTS+=(--append-verify)
fi

SSH_CMD="ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new"
CMD_PREVIEW=(rsync "${RSYNC_OPTS[@]}" -e "$SSH_CMD" -- "$SOURCE_DIR" "$DEST")

echo "Uploading:"
echo "  local:   ${SOURCE_DIR}"
echo "  remote:  ${DEST}"
if [[ -n "$PUBLIC_BASE_URL" ]]; then
  echo "  url:     ${PUBLIC_BASE_URL%/}/${DEPLOY_USER}/${REMOTE_DIR}/index.html"
fi
echo -n "  command: "
printf '%q ' "${CMD_PREVIEW[@]}"
echo
echo

if command -v expect >/dev/null 2>&1; then
  RSYNC_OPTS_STR="$(printf '%s ' "${RSYNC_OPTS[@]}")"
  export SSH_PASSWORD SSH_CMD SOURCE_DIR DEST RSYNC_OPTS_STR

  expect <<'EOF'
    log_user 1
    set timeout -1

    set ssh_password $env(SSH_PASSWORD)
    set ssh_cmd $env(SSH_CMD)
    set source_dir $env(SOURCE_DIR)
    set dest $env(DEST)
    set rsync_opts [split [string trim $env(RSYNC_OPTS_STR)] " "]

    set cmd [list rsync]
    foreach o $rsync_opts {
      lappend cmd $o
    }
    lappend cmd -e $ssh_cmd -- $source_dir $dest

    eval spawn $cmd

    while {1} {
      expect {
        -re {(?i)continue connecting.*\(yes/no} {
          send -- "yes\r"
          exp_continue
        }
        -re {(?i)password[^:\r\n]*:} {
          send -- "$ssh_password\r"
          exp_continue
        }
        -re {(?i)(otp|passcode|verification code|enter code|mfa|authenticator|token|one[- ]time)} {
          stty -echo
          send_user "\nPlease Enter OTP: "
          expect_user -re "(.*)\n"
          stty echo
          send_user "\n"
          send -- "$expect_out(1,string)\r"
          exp_continue
        }
        eof {
          catch wait result
          set code [lindex $result 3]
          exit $code
        }
      }
    }
EOF
else
  echo "expect not found: switching to manual mode."
  echo "Please input SSH password and OTP directly in terminal prompts."
  "${CMD_PREVIEW[@]}"
fi
