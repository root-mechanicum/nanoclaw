#!/usr/bin/env bash
# Setup the meta interactive group in NanoClaw.
# Creates the #meta Slack channel config and registers the group.
#
# Usage: ./scripts/setup-meta-group.sh <slack-channel-id>
# Example: ./scripts/setup-meta-group.sh C0AGJJQ1VT6
#
# After running: add HOST_GROUPS to .env.static and restart nanoclaw.

set -euo pipefail

CHANNEL_ID="${1:-}"
if [ -z "$CHANNEL_ID" ]; then
  echo "Usage: $0 <slack-channel-id>"
  echo ""
  echo "Get channel ID from Slack: right-click channel name > View channel details > scroll to bottom"
  echo "Or use: claude -p 'list slack channels' (via Slack MCP)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NANOCLAW_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Meta Group Setup ==="
echo "Channel ID: $CHANNEL_ID"
echo "NanoClaw dir: $NANOCLAW_DIR"

# Ensure group directory exists
mkdir -p "$NANOCLAW_DIR/groups/meta/logs"
echo "[OK] groups/meta/ directory exists"

# Check CLAUDE.md exists
if [ -f "$NANOCLAW_DIR/groups/meta/CLAUDE.md" ]; then
  echo "[OK] groups/meta/CLAUDE.md exists"
else
  echo "[WARN] groups/meta/CLAUDE.md not found — agent will have no system prompt"
fi

# Generate HOST_GROUPS JSON entry
HOST_GROUP_JSON="[{\"jid\":\"sl:${CHANNEL_ID}\",\"name\":\"#meta\",\"folder\":\"meta\",\"agentName\":\"meta-agent\",\"requiresTrigger\":false}]"

echo ""
echo "=== Add to .env.static ==="
echo ""
echo "HOST_GROUPS='${HOST_GROUP_JSON}'"
echo ""
echo "=== Then restart ==="
echo ""
echo "cd $NANOCLAW_DIR && npx tsc && sudo systemctl restart nanoclaw"
echo ""

# Optionally append to .env.static
read -p "Append HOST_GROUPS to .env.static now? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  ENV_FILE="$NANOCLAW_DIR/.env.static"
  if grep -q '^HOST_GROUPS=' "$ENV_FILE" 2>/dev/null; then
    echo "[WARN] HOST_GROUPS already exists in .env.static — update it manually:"
    echo "HOST_GROUPS='${HOST_GROUP_JSON}'"
  else
    echo "" >> "$ENV_FILE"
    echo "# Meta interactive group — mobile control surface (dev-qnh)" >> "$ENV_FILE"
    echo "HOST_GROUPS='${HOST_GROUP_JSON}'" >> "$ENV_FILE"
    echo "[OK] HOST_GROUPS appended to .env.static"
  fi
fi

echo ""
echo "Done. After adding HOST_GROUPS and restarting nanoclaw, message in #meta to test."
