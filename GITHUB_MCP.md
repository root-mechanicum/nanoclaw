# GitHub MCP Integration

The PA agent now includes the official GitHub MCP server for GitHub API access.

## Setup

### 1. Binary Installation
The `github-mcp-server` binary (from https://github.com/github/github-mcp-server) is installed in the Docker image at `/usr/local/bin/github-mcp-server`.

### 2. MCP Configuration
Configured in `.mcp.json` as a stdio server:
```json
{
  "mcpServers": {
    "github": {
      "command": "github-mcp-server",
      "args": [],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

### 3. GitHub Token
The agent requires a `GITHUB_TOKEN` environment variable with appropriate scopes:
- `repo` - Full control of private repositories
- `read:org` - Read org and team membership
- `read:user` - Read user profile data

**Set the token on the host:**
```bash
# In the nanoclaw config or systemd unit
export GITHUB_TOKEN="ghp_yourTokenHere"
```

The token is passed into the container and used by the MCP server.

## Available Tools

Once configured, the PA agent will have access to GitHub MCP tools (prefixed with `mcp__github__*`), such as:
- `create_issue`
- `create_pull_request`
- `get_issue`
- `list_issues`
- `update_issue`
- `search_repositories`
- etc.

Use `ListMcpResourcesTool` with `server: "github"` to see all available tools.

## Usage Example

```typescript
// Create an issue in the gluon repo
mcp__github__create_issue({
  owner: "your-org",
  repo: "gluon",
  title: "Bug: Authentication fails on staging",
  body: "Detailed description...",
  labels: ["bug", "priority-high"]
})
```

## Beads Integration

The PA can now potentially interact with beads via the GitHub API (since beads are stored in GitHub), though the primary interface remains the `br` CLI via TealSparrow dispatch.

## Next Steps

1. Deploy the updated Docker image with GitHub MCP
2. Configure `GITHUB_TOKEN` in the deployment environment
3. Test GitHub MCP access from PA
4. Consider migrating some beads operations to direct GitHub API calls
