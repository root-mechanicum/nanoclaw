#!/usr/bin/env python3
"""
PA Container Guard — PreToolUse hook for OrangeFox.

Blocks destructive commands that could damage mounted volumes or abuse
IPC channels. PA processes untrusted input (emails, slack) and needs
defense-in-depth beyond container isolation.
"""
import json
import re
import sys

# Patterns that should NEVER run inside PA container
DENY_PATTERNS = [
    # Destructive filesystem ops on mounted volumes
    (r"rm\s+(-[rfR]+\s+)*/workspace/project", "Destructive delete on project mount"),
    (r"rm\s+(-[rfR]+\s+)*/workspace/group", "Destructive delete on group workspace"),
    (r"rm\s+(-[rfR]+\s+)*/workspace/ipc", "Destructive delete on IPC directory"),
    (r"rm\s+(-[rfR]+\s+)*\.\.", "Recursive delete with parent traversal"),
    (r"rm\s+-[rfR]*\s+/", "Recursive delete from root"),
    (r"chmod\s+777\s+/workspace", "Unsafe permissions on mounted volume"),

    # Git force operations that could destroy shared repo state
    (r"git\s+push\s+.*--force", "Force push blocked — could destroy shared history"),
    (r"git\s+reset\s+--hard", "Hard reset blocked — could lose uncommitted work"),
    (r"git\s+clean\s+-[dfx]", "Git clean blocked — could delete untracked files"),

    # IPC abuse — mass scheduling, flooding
    (r"for\s+.*writeIpcFile|while.*writeIpcFile", "IPC flooding pattern detected"),

    # Credential/secret exfiltration
    (r"cat.*/tmp/input\.json", "Reading secrets injection file"),
    (r"curl\s+.*\$.*TOKEN", "Potential credential exfiltration via curl"),
    (r"wget\s+.*\$.*TOKEN", "Potential credential exfiltration via wget"),
    (r"curl\s+.*OAUTH", "Potential OAuth token exfiltration"),
    (r"echo\s+.*\$(CLAUDE_CODE_OAUTH|ANTHROPIC_API_KEY|AGENT_MAIL_AUTH)", "Credential echo blocked"),
    (r"env\s*\|", "Environment dump may leak secrets"),
    (r"printenv", "Environment dump may leak secrets"),

    # Network exfiltration of sensitive data
    (r"curl\s+-[^s]*d\s+@/workspace/ipc/email", "Email data exfiltration attempt"),
    (r"curl\s+.*pastebin|curl\s+.*paste\.ee|curl\s+.*0x0\.st", "Data exfiltration to paste service"),

    # Process/system manipulation
    (r"kill\s+-9", "Force kill blocked in container"),
    (r"pkill\s+-9", "Force kill blocked in container"),
]

# Patterns for tool_input content that should be flagged (Write/Edit tools)
WRITE_DENY_PATTERNS = [
    (r"/workspace/ipc/tasks/.*\.json", "Direct IPC task file creation — use MCP tools instead"),
]


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    if not isinstance(input_data, dict):
        sys.exit(0)

    tool_name = input_data.get("tool_name")
    tool_input = input_data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        sys.exit(0)

    # Check Bash commands
    if tool_name == "Bash":
        command = tool_input.get("command", "")
        if not isinstance(command, str):
            sys.exit(0)

        for pattern, reason in DENY_PATTERNS:
            try:
                if re.search(pattern, command, re.IGNORECASE):
                    output = {
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": (
                                f"[PA GUARD] BLOCKED\n"
                                f"Reason: {reason}\n"
                                f"Pattern: {pattern}\n"
                                f"Command: {command[:200]}\n\n"
                                f"PA runs in a container with untrusted input. "
                                f"This command is blocked for safety."
                            ),
                        }
                    }
                    print(json.dumps(output))
                    sys.exit(0)
            except re.error:
                continue

    # Check Write/Edit file paths
    if tool_name in ("Write", "Edit"):
        file_path = tool_input.get("file_path", "")
        if isinstance(file_path, str):
            for pattern, reason in WRITE_DENY_PATTERNS:
                try:
                    if re.search(pattern, file_path, re.IGNORECASE):
                        output = {
                            "hookSpecificOutput": {
                                "hookEventName": "PreToolUse",
                                "permissionDecision": "deny",
                                "permissionDecisionReason": (
                                    f"[PA GUARD] BLOCKED\n"
                                    f"Reason: {reason}\n"
                                    f"Path: {file_path}\n"
                                ),
                            }
                        }
                        print(json.dumps(output))
                        sys.exit(0)
                except re.error:
                    continue

    # Allow
    sys.exit(0)


if __name__ == "__main__":
    main()
