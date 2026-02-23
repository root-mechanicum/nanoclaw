# NanoClaw Corp PA — Implementation Guide

This document is a step-by-step implementation prompt for Claude Code.
Run each section as a Claude Code session. Copy the prompt blocks verbatim.

---

## Pre-requisites (do these manually)

### 1. Provision PA VPS
- Hetzner CX22 or similar (4-8GB RAM, plenty for this)
- Ubuntu 24.04
- Add to your Tailscale mesh
- Note the Tailscale IP

### 2. Create Slack App
Go to https://api.slack.com/apps → Create New App → From Scratch

**Bot Token Scopes** (OAuth & Permissions):
```
app_mentions:read
channels:history
channels:read
chat:write
files:read
files:write
groups:history
groups:read
im:history
im:read
im:write
reactions:read
reactions:write
```

**Event Subscriptions** → Enable → Subscribe to bot events:
```
app_mention
message.channels
message.groups
message.im
```

**Socket Mode** → Enable (Settings → Socket Mode → toggle on)

**App-Level Tokens** → Generate Token (Basic Information → App-Level Tokens)
- Token name: "socket-mode"
- Scope: `connections:write`
- Copy the `xapp-...` token

**Install to workspace** → Copy Bot User OAuth Token (`xoxb-...`)

**Create these channels:**
```
#pa          — Your main PA channel
#planner     — Project planning and agent coordination
#briefing    — Auto-posted daily digests (PA writes, you read)
#alerts      — Urgent items, blockers, escalations
```

### 3. Google OAuth Setup
Go to https://console.cloud.google.com
- Create project "NanoClaw PA"
- Enable Gmail API + Google Calendar API
- Create OAuth 2.0 credentials (Desktop app type)
- Download `credentials.json`
- Note: `/add-gmail` skill will walk you through the OAuth flow

### 4. GitHub Personal Access Token
Go to https://github.com/settings/tokens → Fine-grained tokens

**Permissions:**
```
Repository access: All repositories (or select specific ones)
Permissions:
  Issues: Read and write
  Pull requests: Read and write
  Contents: Read
  Metadata: Read
  Webhooks: Read and write
```

Copy the token.

### 5. Environment Variables
Prepare these — you'll set them during setup:
```bash
# Slack (Socket Mode — both tokens required)
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token (from OAuth & Permissions)
SLACK_APP_TOKEN=xapp-...        # App-Level Token (from Basic Information → App-Level Tokens, connections:write scope)
SLACK_ONLY=true                 # Set to skip WhatsApp startup

# Output-only channel IDs (get from Slack channel settings → copy channel ID)
SLACK_BRIEFING_CHANNEL=C...     # #briefing channel ID
SLACK_ALERTS_CHANNEL=C...       # #alerts channel ID

# Separate incoming webhook for out-of-band alerts (works even when NanoClaw is dead)
SLACK_ALERTS_WEBHOOK=https://hooks.slack.com/services/XXX/YYY/ZZZ

# External heartbeat (dead man's switch — Healthchecks.io free tier)
HEALTHCHECK_PING_URL=https://hc-ping.com/<uuid>

# GitHub
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=...       # Shared secret for webhook signature verification
WEBHOOK_PORT=8443
TAILSCALE_IP=100.x.y.z          # Bind webhook server to this IP

# Gmail (path to OAuth credentials)
GMAIL_CREDENTIALS=...           # Path to credentials.json

# Agent Mail (MCP server over Tailscale — Phase 1, essential)
AGENT_MAIL_MCP_URL=http://<tailscale-ip>:<port>/sse  # SSE transport endpoint
AGENT_MAIL_PROJECT_KEY=/path/to/project              # Absolute path on gluon VPS
```

---

## Design Principle

The PA has two sides:
1. **Flywheel side** (essential) — Agent Mail + Beads. Without this, you have a chatbot.
2. **Human side** (layered) — Slack, Gmail, Calendar, etc. Ways to talk to you.

Session 1 builds both sides. Sessions 2+ add more contact surfaces and automation.

---

## Session 1: Flywheel Node (Slack + Agent Mail + Beads)

SSH into your PA VPS and run:

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
claude
```

### Pre-prompt: Infrastructure Resilience (do before PROMPT 1)

These steps happen outside Claude Code — run them directly on the PA VPS.

```bash
# 1. Create systemd unit for auto-restart on crash
sudo tee /etc/systemd/system/nanoclaw.service > /dev/null <<'EOF'
[Unit]
Description=NanoClaw PA
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/srv/nanoclaw
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
WatchdogSec=120
Environment=NODE_ENV=production
EnvironmentFile=/srv/nanoclaw/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nanoclaw

# 2. Daily SQLite backup cron (3 AM, keep 7 days)
mkdir -p /srv/nanoclaw/backups
(crontab -l 2>/dev/null; echo '0 3 * * * sqlite3 /srv/nanoclaw/store/messages.db ".backup /srv/nanoclaw/backups/messages-$(date +\%Y\%m\%d).db" && find /srv/nanoclaw/backups -name "*.db" -mtime +7 -delete') | crontab -

# 3. Create a SEPARATE Slack incoming webhook (not the bot token)
#    Go to: https://api.slack.com/apps → Your App → Incoming Webhooks → Activate
#    Add new webhook → select #alerts channel
#    Copy the webhook URL — this works even when NanoClaw is dead
#    Save as SLACK_ALERTS_WEBHOOK in .env

# 4. Set up external health check
#    Option A: Sign up for UptimeRobot/Betterstack free tier
#              Monitor URL: http://<pa-tailscale-ip>:8443/health
#              Alert: email/SMS on failure
#    Option B: Cron on a gluon VPS (belt and suspenders):
#    */5 * * * * curl -sf http://<pa-tailscale-ip>:8443/health || \
#      curl -X POST <SLACK_ALERTS_WEBHOOK> -d '{"text":"⚠️ PA VPS health check FAILED"}'

# 5. Set up dead man's switch
#    Sign up for Healthchecks.io free tier
#    Create a check with 10-minute period, 5-minute grace
#    Copy the ping URL → save as HEALTHCHECK_PING_URL in .env
#    NanoClaw will ping this every 5 minutes (added in PROMPT 1)
```

Then paste these prompts in sequence:

---

**PROMPT 1 — Setup + Slack Adapter**

```
Read the entire codebase first — all files in src/, the CLAUDE.md, package.json,
and the setup skill in .claude/skills/. Understand the architecture before making
any changes.

IMPORTANT: Study these existing channel adapters as your reference:
- .claude/skills/add-discord/ (complete skill package with manifest, add/, modify/)
- .claude/skills/add-telegram/ (same structure)
- src/channels/whatsapp.ts (the Channel interface implementation)
- src/types.ts (Channel interface, OnInboundMessage, OnChatMetadata, NewMessage)

Then do the following:

1. Run /setup — choose Docker as the container runtime. Complete the full setup.

2. Build an /add-slack skill package following the EXACT pattern from add-discord
   and add-telegram. The skill should be in .claude/skills/add-slack/ with:

   manifest.yaml:
     skill: slack
     adds: [src/channels/slack.ts, src/channels/slack.test.ts]
     modifies: [src/index.ts, src/config.ts, src/routing.test.ts]
     npm_dependencies: { "@slack/bolt": "^4.1.0", "@slack/web-api": "^7.8.0" }
     env_additions: [SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ONLY]

   SKILL.md: 5-phase instructions (matching Discord/Telegram pattern)

   add/src/channels/slack.ts:
     - Implements the Channel interface from src/types.ts
     - Constructor: (botToken, appToken, opts: SlackChannelOpts) where opts has
       { onMessage, onChatMetadata, registeredGroups } — same as Discord/Telegram
     - name = 'slack'
     - Uses @slack/bolt with Socket Mode (appToken is the xapp-... token)
       Socket Mode is correct for a VPS behind Tailscale — no public URL needed
     - JID prefix: sl:{channelId} (following dc: and tg: convention)
     - ownsJid(jid): jid.startsWith('sl:')
     - sendMessage(jid, text): strip 'sl:' prefix, send via Slack Web API
       Split messages at 4000 chars (Slack's limit for text blocks)

   CHANNEL → GROUP MAPPING:
     Each Slack channel maps to a NanoClaw group via the standard registration
     mechanism. When a message arrives in #pa (channel ID C0123...), it routes
     to the group registered with JID sl:C0123...

   MESSAGE HANDLING:
     - Listen for messages in channels where the bot is a member
     - Strip bot mentions: detect <@botUserId>, remove from text, prepend
       @{ASSISTANT_NAME} to match the trigger pattern (same as Discord adapter)
     - Handle message edits gracefully (ignore — same as other adapters)

   MEDIA HANDLING (v1 — text placeholders, matching Discord/Telegram):
     - Images: append [Image: filename] to content (do NOT download binary)
     - Videos: append [Video: filename]
     - Files: append [File: filename]
     - Captions on media messages are preserved as the text content
     - Vision/download support is deferred to Phase 2

   OUTPUT-ONLY CHANNELS (#briefing, #alerts):
     Do NOT register these as NanoClaw groups. Store their channel IDs as
     config constants (SLACK_BRIEFING_CHANNEL, SLACK_ALERTS_CHANNEL). The
     scheduler and Agent Mail poller call sendMessage('sl:{id}', text) directly.

   SENDING MESSAGES:
     - sendMessage(jid, text) posts to the channel (strip sl: prefix)
     - For long messages (>4000 chars), split at paragraph boundaries
     - No threading in v1 — messages go to the channel (not thread)
       Threading can be added later following OpenClaw's pattern

   TYPING INDICATOR:
     - setTyping calls chat.meMessage or sends a typing indicator via Slack API

   ERROR HANDLING:
     - If Slack connection drops, Bolt SDK handles reconnection for Socket Mode
     - Log all Slack API errors via pino logger
     - Queue messages sent while disconnected (same pattern as WhatsApp adapter)

   modify/src/index.ts:
     Follow the exact pattern from add-discord/modify/src/index.ts:
     - Import SlackChannel and config vars
     - Conditionally create: if (SLACK_BOT_TOKEN) { ... channels.push(slack) }
     - SLACK_ONLY controls whether WhatsApp also starts

   modify/src/config.ts:
     Add SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ONLY to readEnvFile() and exports

3. Apply the skill, then run npm install and npm run build to verify.

4. Update groups/global/CLAUDE.md formatting rules:
   - Remove WhatsApp-specific rules (single asterisks, no headings)
   - Add Slack formatting: real markdown, code blocks, headings supported

5. Add a /health endpoint and heartbeat to src/index.ts:

   HEALTH ENDPOINT:
   Add a lightweight HTTP server (node:http) on port 8443 (WEBHOOK_PORT env var),
   bound to TAILSCALE_IP. Single endpoint:

   GET /health → returns 200 with JSON:
   {
     "status": "ok" | "degraded",
     "slack": { "connected": boolean },
     "agentMail": { "status": "connected" | "degraded" | "down", "lastPollTs": iso8601 | null },
     "uptime": seconds
   }

   Return 200 if Slack is connected and Agent Mail last poll < 2 minutes ago.
   Return 503 if either is down.

   This endpoint is used by external health checks (UptimeRobot, gluon cron).

   HEARTBEAT (dead man's switch):
   Every 5 minutes, if HEALTHCHECK_PING_URL env var is set:
     fetch(HEALTHCHECK_PING_URL).catch(() => {})
   This pings Healthchecks.io to prove the process is alive. If it stops
   pinging, Healthchecks.io sends an alert (configured externally).

   Add env vars: WEBHOOK_PORT (default 8443), TAILSCALE_IP, HEALTHCHECK_PING_URL

6. Test: start the service and send a test message in #pa on Slack.
   Verify the agent receives it and responds.
   Also verify: curl http://<tailscale-ip>:8443/health returns 200.

REFERENCE IMPLEMENTATIONS (for guidance, not copying):
- mpociot/claude-code-slack-bot: @slack/bolt + Socket Mode + Claude SDK
- OpenClaw (docs.openclaw.ai/channels/slack): full adapter with threading and vision
- @modelcontextprotocol/server-slack: official MCP server for Slack
```

---

**PROMPT 2 — Agent Mail Integration**

This is the essential integration — it makes the PA a flywheel node.

```
Add Agent Mail integration so the PA can SEND and RECEIVE messages to/from
coding agents on the gluon VPSes. There are two parts:

PART A — Container-level MCP (PA agent can use Agent Mail during conversations):

Mount Agent Mail as an MCP server in the PA group's container. In
container-runner.ts, when building the PA group's container, add Agent Mail
to the mcpServers config in .claude/settings.json:

{
  "mcpServers": {
    "agent-mail": {
      "command": "npx",
      "args": ["-y", "mcp-agent-mail"],
      "env": {
        "AGENT_MAIL_PROJECT_KEY": "<from AGENT_MAIL_PROJECT_KEY env var>",
        "AGENT_MAIL_AGENT_NAME": "PA"
      }
    }
  }
}

This gives the PA agent direct access to: send_message, fetch_inbox,
reply_message, search_messages, register_agent, etc.

Pass AGENT_MAIL_MCP_URL and AGENT_MAIL_PROJECT_KEY through ContainerInput.secrets
(the mechanism already exists — see container-runner.ts).

Update groups/pa/CLAUDE.md to document the Agent Mail tools.

PART B — Host-level poller (PA watches for inbound messages even when idle):

Add src/agent-mail-poller.ts using @modelcontextprotocol/sdk as MCP client.
Connect to Agent Mail via SSE transport at AGENT_MAIL_MCP_URL.

On startup:
  - Call register_agent: { project_key, program: "nanoclaw", model: "claude-sonnet",
    name: "PA", task_description: "Personal Assistant - routes to Slack" }

Polling loop (every 30 seconds via setInterval):
  - Call fetch_inbox: { project_key, agent_name: "PA", since_ts: lastCheck,
    include_bodies: true, limit: 20 }
  - For each new message, triage by tag prefix:
    [BLOCKED] → post to #alerts (SLACK_ALERTS_CHANNEL) immediately
    [ERROR]   → post to #alerts
    [REVIEW]  → post to #alerts with summary
    [DONE]    → queue in SQLite briefing_digest table
    [FYI]     → queue in SQLite briefing_digest table
  - If no tag, infer from content keywords
  - Also check message importance field ("urgent"/"high" → treat as blocker)

CONNECTION STATE MACHINE (critical for resilience):
  The poller must track connection health:

    CONNECTED ──poll fails──► DEGRADED ──3 consecutive fails──► DOWN
        ▲                        │                                │
        │                        │ poll succeeds                  │ poll succeeds
        └────────────────── CONNECTED ◄───────────────────────────┘

  On transition to DEGRADED:
    → Log warning via pino
    → Switch to exponential backoff: 30s → 60s → 120s → cap at 5min

  On transition to DOWN:
    → Post to #alerts via DIRECT Slack API (the separate SLACK_ALERTS_WEBHOOK —
      NOT through Agent Mail, because Agent Mail is the thing that's broken):
      "Agent Mail is unreachable. Agent coordination is offline.
       Agents on gluon VPSes cannot escalate blockers until this is resolved."
    → Continue retry loop in background

  On transition back to CONNECTED:
    → Post to #alerts: "Agent Mail connection restored."
    → Resume normal 30s polling
    → Fetch any messages that arrived while disconnected (since_ts catches up)

  Export the current state so the /health endpoint can report it.

RATE LIMITER (prevents agent error loops from spamming #alerts):
  Per agent, per 5-minute sliding window:
    - Max 3 messages to #alerts
    - On limit hit: batch remaining into single summary:
      "{agent} sent {count} messages in 5 min. Latest: {subject}. Suppressing."
    - Always queue ALL messages for briefing digest (don't lose data)

RE-ESCALATION (stale blockers don't sit forever):
  When a [BLOCKED] message is posted to #alerts, track it in SQLite:

  Add to src/db.ts:
    CREATE TABLE blocker_escalation (
      agent_mail_message_id INTEGER PRIMARY KEY,
      slack_thread_ts TEXT,
      first_posted DATETIME,
      last_escalated DATETIME,
      escalation_level INTEGER DEFAULT 0,
      resolved BOOLEAN DEFAULT FALSE
    );

  Escalation timeline (check every 10 minutes via setInterval):
    T+0:     Post to #alerts (level 0)
    T+30min: Re-post reminder in same thread: "Still waiting: {summary}" (level 1)
    T+2h:    Email via Gmail if configured: "Unresolved blocker: {summary}" (level 2)
    T+8h:    Re-post to #alerts: "{agent} blocked for 8 hours" (level 3)

  Mark as resolved when:
    - User replies in the Slack thread (detected via message event)
    - Or manually: user reacts with ✅ emoji

AGENT LIVENESS MONITORING:
  Track last_message_ts per Agent Mail agent in SQLite:

  Add to src/db.ts:
    CREATE TABLE agent_liveness (
      agent_name TEXT PRIMARY KEY,
      last_message_ts DATETIME,
      task_description TEXT,
      vps_name TEXT
    );

  Update last_message_ts every time a message is received from that agent.

  Hourly check (setInterval, 60 min):
    For each agent where last_message_ts > 6 hours ago:
      → Post to #alerts:
        "{agent} on {vps} hasn't reported in {hours}h.
         Last task: {task_description}. Last message: {subject}"

  Start simple: 6-hour threshold, hard-coded. Refine later.

Reply forwarding:
  When user replies in a Slack thread created from an Agent Mail message:
  1. Lookup in agent_mail_threads table (add to src/db.ts)
  2. Call reply_message MCP tool back to original sender
  3. Post confirmation in Slack
  4. If the original was [BLOCKED], mark resolved in blocker_escalation

Wire into src/index.ts — start poller alongside main process.
Only start if AGENT_MAIL_MCP_URL is set (graceful if not configured).
Persist lastCheckTimestamp in router_state table (survives restarts).

Add env vars: AGENT_MAIL_MCP_URL, AGENT_MAIL_PROJECT_KEY, PA_AGENT_NAME,
              SLACK_ALERTS_WEBHOOK (separate incoming webhook URL for out-of-band alerts)

VERIFY:
- From a gluon box, send Agent Mail message to PA: "[BLOCKED] Need input"
  → appears in #alerts on Slack
- Reply in Slack thread → forwarded back via Agent Mail
- In #pa, ask PA: "Send a message to BlueLake: what's your status?"
  → PA uses Agent Mail MCP tool to send
- Disconnect Agent Mail (stop the server) → within 2 minutes, #alerts shows
  "Agent Mail is unreachable" via the separate Slack webhook
- Reconnect → #alerts shows "Agent Mail connection restored"
- Send 5 [ERROR] messages rapidly from one agent → rate limiter kicks in,
  only 3 appear individually, rest are batched
```

---

**PROMPT 3 — Beads Awareness**

```
The PA needs to understand project state via Beads. Beads are task/project
status files checked into GitHub repos.

1. Update groups/pa/CLAUDE.md to explain Beads:
   - Beads are YAML/JSON status files in GitHub repos
   - The PA can query them via GitHub API (using gh CLI or @octokit/rest)
   - Status values: new, in-progress, blocked, done, needs-review

2. Update groups/planner/CLAUDE.md:
   - The planner group's primary job is reading Beads status and coordinating
     agents via Agent Mail
   - Mount relevant GitHub repos (read-only) into the planner container via
     containerConfig.additionalMounts in the group registration

3. Add @octokit/rest to package.json for GitHub API access.
   Pass GITHUB_TOKEN through ContainerInput.secrets.

4. Test in #pa: "What's the status of Project X?"
   → PA uses GitHub API to read Beads files, summarizes in Slack

5. Test in #planner: "What tasks are blocked across all projects?"
   → Planner reads Beads, reports blocked items, optionally messages
     agents via Agent Mail to check on them
```

---

## Session 2: Human Contact Surfaces + Automation

These are all ways to reach the human — layered on top of the flywheel core.

---

**PROMPT 4 — Gmail**

```
Run /add-gmail

Follow the skill's instructions. When done, verify:
- The PA agent can read inbox
- The PA agent can draft/send emails
- Test: ask the PA "summarize my unread emails" in #pa
```

---

**PROMPT 5 — GitHub Webhooks + Beads Automation**

```
Add a webhook endpoint to NanoClaw that receives GitHub events. Here's the spec:

1. Add a lightweight HTTP server (use the built-in node:http module — no need
   for express/fastify for a single endpoint) that runs alongside the main
   NanoClaw process. It listens on port 8443 (configurable via WEBHOOK_PORT).

   IMPORTANT: Bind to the Tailscale interface IP, not 0.0.0.0. Defense in depth —
   don't rely on firewall rules alone. The Tailscale IP is stable and can be
   read from TAILSCALE_IP env var or detected via `tailscale ip -4`.

2. POST /webhook/github
   - Verify the X-Hub-Signature-256 header using GITHUB_WEBHOOK_SECRET env var
   - Parse the event type from X-GitHub-Event header
   - Handle these events:

   ISSUES (X-GitHub-Event: issues):
     action: opened
       → Determine if bug/feature/question from labels or title
       → Post summary to #alerts (bugs) or #planner (features/questions)
       → If it looks like a simple question, auto-respond on GitHub with a
         helpful comment (use the PA agent to generate the response)
     action: closed
       → Log for daily briefing digest

   PULL REQUESTS (X-GitHub-Event: pull_request):
     action: opened
       → Post to #alerts with: title, author, files changed count,
         and a 2-sentence summary of what the PR does (read the diff
         description, not the full diff)
     action: merged
       → Queue for #briefing digest
     action: closed (not merged)
       → Log only

   PUSH (X-GitHub-Event: push):
     → Check if the push includes changes to beads status files
     → If yes, diff the bead statuses and route:
         blocked    → #alerts (immediate)
         done       → #briefing (digest)
         needs-review → #alerts
         in-progress → #planner (info only)
     → If no beads changes, log for digest

   ISSUE COMMENTS (X-GitHub-Event: issue_comment):
     → Only alert if the comment is on an issue/PR you're involved in
       (your username appears in the issue, or you're assigned)
     → Post to #alerts with context

   SECURITY (X-GitHub-Event: security_advisory):
     → Always post to #alerts immediately

3. Add a helper module src/github.ts that wraps the GitHub API using @octokit/rest:
   - getIssue(owner, repo, number)
   - createComment(owner, repo, number, body)
   - addLabels(owner, repo, number, labels)
   - closeIssue(owner, repo, number)
   - listOpenPRs(owner, repo)
   - getRepoPushes(owner, repo, since)

4. Add @octokit/rest to package.json (node:http is built-in, no extra dep needed).

5. Wire the webhook server startup into src/index.ts — it should start
   alongside the main NanoClaw process.

6. Add env vars: GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, WEBHOOK_PORT

After implementation, give me the exact GitHub webhook configuration:
- URL to set
- Content type
- Events to subscribe to
- How to set the secret
```

---

**PROMPT 6 — Morning Briefing Scheduler**

```
Add a scheduled morning briefing task. Here's the spec:

1. Create groups/briefing/CLAUDE.md with this content:

---
# Briefing Agent

You are a briefing compiler. Each morning you gather data from multiple sources
and compose a concise daily briefing for posting to Slack.

## Your data sources (check all of them):

### Email (Gmail)
- Count of unread emails
- Any emails flagged as important or from VIP contacts
- Brief subject-line summary of the top 5 unread

### Calendar (Google Calendar)
- Today's events with times
- Tomorrow's first event (so I can plan my evening)
- Any conflicts or double-bookings

### Agent Mail Activity
- Messages received overnight (stored in briefing digest queue)
- Summary of what agents worked on
- Any outstanding [BLOCKED] items still waiting for my input

### GitHub Activity
- New issues opened since yesterday
- PRs merged since yesterday
- Any open PRs waiting for review
- Beads status changes

## Output format

Post a single message to #briefing. Keep it scannable:

**Morning Briefing — {date}**

**Email** — {count} unread
{top items}

**Today**
{calendar items}

**Agents**
{overnight activity summary}
{any blocked items needing attention}

**GitHub**
{new issues, merged PRs, review needed}

{any alerts or action items at the bottom}
---

2. Add a scheduled task in the NanoClaw scheduler:
   - Name: "morning-briefing"
   - Schedule: Every weekday at 07:30 (configurable via BRIEFING_TIME env var)
   - Action: Pre-fetch data, then invoke the briefing agent

   IMPORTANT — DATA PRE-FETCH PATTERN:
   Container agents can't call Gmail/Calendar/GitHub APIs directly (no OAuth
   tokens, no API clients inside the container). Instead, the scheduler
   pre-fetches all data BEFORE spawning the container and writes it as JSON
   files to the group's mounted directory:

   Before container launch, write to groups/briefing/:
   - briefing-data/email-summary.json    (from Gmail API: unread count, top 5 subjects)
   - briefing-data/calendar-today.json   (from Google Calendar API: today's events)
   - briefing-data/agent-digest.json     (from SQLite briefing_digest table)
   - briefing-data/github-activity.json  (from GitHub API: issues, PRs, commits since yesterday)

   The briefing CLAUDE.md tells the agent to read these JSON files from
   /workspace/group/briefing-data/ and synthesize the briefing. The agent
   posts the result via the IPC send_message MCP tool to #briefing channel.

   This is the same pattern used for current_tasks.json — pre-computed
   data written to the mount before container launch.

3. Add a second scheduled task:
   - Name: "evening-summary"
   - Schedule: Every weekday at 18:00
   - Action: Same pre-fetch pattern, but shorter — just unread email count,
     tomorrow's calendar, and any unresolved #alerts items

4. The digest queue (for [FYI] and [DONE] Agent Mail messages) should be:
   - Stored in SQLite: briefing_digest table (add to src/db.ts)
   - Cleared after each morning briefing is posted
   - Exported as JSON to groups/briefing/briefing-data/agent-digest.json before launch
```

---

**PROMPT 7 — Calendar Integration**

```
Add Google Calendar integration. The Gmail OAuth credentials should already
be set up from /add-gmail — we need to add the Calendar API scope and
build a calendar tool the PA agent can use.

1. Add the Google Calendar API scope to the existing OAuth flow:
   https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/calendar.events
   (The user may need to re-authorize to grant the new scope)

2. Add src/tools/google-calendar.ts with these functions:
   - getTodayEvents(): Event[]
   - getUpcomingEvents(days: number): Event[]
   - createEvent(title, start, end, description?, location?)
   - deleteEvent(eventId)
   - findFreeSlots(date, durationMinutes): TimeSlot[]

3. Make these available to the PA agent inside the container.

   There are three approaches — choose one:

   a) IPC TOOLS (simplest, matches NanoClaw's existing pattern):
      Add calendar tools to the IPC MCP server (container/agent-runner/src/ipc-mcp-stdio.ts).
      The host process handles the actual Google Calendar API calls. The agent calls
      MCP tools like `calendar_get_today`, `calendar_create_event`. Same pattern as
      `send_message` and `schedule_task` already work.

   b) EXTERNAL MCP SERVER:
      Use an existing Google Calendar MCP server (several exist on npm/GitHub).
      Mount its config into the container's .claude/settings.json mcpServers section.
      Requires passing OAuth tokens through ContainerInput.secrets.

   c) PRE-FETCH (for read-only, like the briefing):
      Write today's calendar as JSON to the group's mounted directory before
      container launch. Agent reads the file. Only works for queries, not mutations.

   Recommendation: Start with (a) for the PA group. It's consistent with how
   NanoClaw already works and doesn't require external MCP servers.

4. Update groups/pa/CLAUDE.md to tell the PA agent about calendar capabilities.

5. Test: ask in #pa "What's on my calendar today?" and "Schedule a focus block
   tomorrow from 9-11am"
```

---

## Group CLAUDE.md Files

Create these after the sessions above. These are the PA "personality" files.

### groups/pa/CLAUDE.md

```
Save this as groups/pa/CLAUDE.md:

---
# PA — Personal Assistant

You are Klaas's personal assistant. You communicate via Slack.

## Personality
- Concise and direct. No fluff.
- Proactive — if you notice something actionable, flag it.
- When in doubt, ask. Don't guess on important decisions.
- Format messages for Slack (use markdown, emoji sparingly, code blocks for technical content).

## Capabilities
- **Email**: You can read, search, draft, and send Gmail. Use /add-gmail tools.
- **Calendar**: You can read and create Google Calendar events.
- **Screenshots**: Users can paste images. Use your vision to analyze them.
- **Agent Mail**: You can send messages to coding agents on gluon VPSes via Agent Mail.

## Communication Rules
- In #pa: respond to everything directed at you
- In #alerts: only post urgent items — blockers, errors, security alerts
- In #briefing: only post via scheduled briefings, not ad-hoc
- When you receive an inbound Agent Mail message, triage it:
  - [BLOCKED] → #alerts immediately
  - [ERROR] → #alerts, attempt auto-resolution first
  - [REVIEW] → #alerts with summary
  - [DONE] / [FYI] → queue for morning briefing

## Context
- Klaas runs a multi-agent coding setup (gluon) on Hetzner VPSes via Tailscale
- Agents coordinate via Agent Mail and track work via Beads (in GitHub)
- This PA runs on a separate VPS alongside the gluon fleet
- If asked about project status, check Agent Mail and Beads (GitHub)

## Email Handling
- When asked to check email: summarize unread, highlight urgent
- When asked to draft: write the draft, post it in Slack for approval before sending
- Never send an email without explicit approval
- Learn sender patterns over time — flag unusual activity

## Agent Coordination
- You can message any registered Agent Mail participant
- When forwarding a user reply to an agent, include full context
- If an agent is blocked and the answer seems obvious from context, suggest it but ask for confirmation
---
```

### groups/planner/CLAUDE.md

```
Save this as groups/planner/CLAUDE.md:

---
# Planner

You are a project planner and agent coordinator.

## Role
- Track project status via Beads (checked into GitHub)
- Coordinate coding agents via Agent Mail
- Break down tasks into actionable items
- Prioritize work and flag bottlenecks

## Tools
- **Agent Mail**: Send tasks to coding agents, check status
- **GitHub API**: Read issues, PRs, beads status
- **Beads**: Read project task graphs from GitHub

## Communication
- Post in #planner for status updates and planning discussions
- Escalate to #alerts if something is blocked and needs Klaas
- Queue completed items for #briefing digest

## Principles
- Don't micro-manage agents. Give clear tasks with context and let them work.
- When assigning via Agent Mail, include: what to do, why, acceptance criteria,
  which repo, and which branch.
- Monitor for agents working on overlapping files — flag potential merge conflicts.
---
```

---

## AGENTS.md Update for Gluon Boxes

Add this section to AGENTS.md on each gluon VPS:

```
Save this as a snippet to append to AGENTS.md on gluon VPSes:

---
## PA (Personal Assistant) via Agent Mail

A PA agent is listening on Agent Mail. You can message it to:
- Report status updates
- Escalate blockers that need human input
- Request information or decisions
- Report task completion

### Message Format
Prefix your message with a priority tag:

- `[BLOCKED]` — You cannot continue without human input. PA will alert Klaas immediately.
- `[ERROR]` — Something failed that you can't fix. PA will attempt auto-resolution or escalate.
- `[FYI]` — Informational update. PA queues for daily briefing.
- `[DONE]` — Task complete. PA logs and includes in briefing.
- `[REVIEW]` — Work ready for human review. PA alerts with summary and link.

### Example Messages

```
[BLOCKED] Need decision: should the new API endpoint use REST or GraphQL?
Context: the frontend team's existing code uses REST but the spec says GraphQL.
Waiting for direction before proceeding.
```

```
[DONE] Completed refactor of auth module. PR #47 ready for review.
All tests passing. No breaking changes.
```

```
[ERROR] Build failing on test suite — timeout after 300s.
Tried increasing timeout, still fails. May be a resource issue on this VPS.
```

### PA Agent Name
Send messages to agent name: "PA"
---
```

---

## Verification Checklist

After all sessions, verify each capability:

```
=== SESSION 1 TESTS (Flywheel Core) ===

TEST 1 — Basic Slack round-trip:
  Send "hello" in #pa → get a response

TEST 2 — Health endpoint:
  curl http://<tailscale-ip>:8443/health → 200 with status JSON

TEST 3 — Agent Mail outbound (PA → agent):
  In #pa: "Send a message to BlueLake: check the build status"
  → PA uses Agent Mail MCP tool to send

TEST 4 — Agent Mail inbound (agent → PA → Slack):
  From a gluon box, send an Agent Mail message to PA:
  "[BLOCKED] Need input on database schema"
  → See it appear in #alerts on Slack

TEST 5 — Reply forwarding (Slack → Agent Mail):
  Reply in the Slack thread from Test 4 →
  PA forwards your reply via Agent Mail →
  confirm "Forwarded to {agent_name}"

TEST 6 — Beads query:
  In #pa: "What's the status of Project X?"
  → PA reads Beads from GitHub, summarizes

=== SESSION 1 TESTS (Resilience) ===

TEST 7 — Process restart:
  Kill NanoClaw process → systemd restarts within 5s
  Verify: systemctl status nanoclaw shows active

TEST 8 — Agent Mail failure detection:
  Stop Agent Mail server on gluon VPS →
  Within 2 minutes, #alerts shows "Agent Mail is unreachable"
  (via separate webhook, not through Agent Mail)
  Restart → #alerts shows "Agent Mail connection restored"

TEST 9 — Re-escalation:
  Send [BLOCKED], don't reply for 30+ minutes →
  Reminder appears in same Slack thread

TEST 10 — Rate limiting:
  Send 5 [ERROR] messages rapidly from one agent →
  Only 3 appear individually in #alerts, rest are batched

TEST 11 — External health check:
  Stop NanoClaw → external monitor (UptimeRobot/gluon cron) fires alert
  via separate Slack webhook

TEST 12 — Heartbeat:
  Check Healthchecks.io dashboard shows regular pings
  Stop NanoClaw → Healthchecks.io reports missed ping

=== SESSION 2 TESTS (Contact Surfaces) ===

TEST 13 — Email:
  "Summarize my unread emails" in #pa → get email summary

TEST 14 — GitHub webhook:
  Create a test issue on one of your repos → see it appear in #alerts or #planner

TEST 15 — Beads status change (automated via webhook):
  Push a beads status change to GitHub →
  PA detects it via webhook and posts to appropriate channel

TEST 16 — Calendar:
  "What's on my calendar today?" in #pa → get today's events

TEST 17 — Morning briefing:
  Manually trigger the briefing task →
  see a formatted briefing in #briefing

=== PHASE 3 TESTS ===

TEST 18 — Screenshot processing (after vision pipeline is built):
  Paste a screenshot in #pa → PA describes what it sees
  (v1: will show [Image: filename] placeholder instead)
```

---

## Post-Setup Notes

### What to iterate on
- The PA's `CLAUDE.md` is where most tuning happens. Adjust tone, add rules,
  add context about your contacts and projects as you go.
- The escalation triage will need calibration — you'll find some [FYI]s that
  should be [BLOCKED]s and vice versa. Adjust the inference rules.
- Channel routing may evolve — you might want more channels or different splits.

### What comes next (Phase 2+)
- Screenshot/vision pipeline (extend NewMessage, ContainerInput, agent-runner for multimodal)
- Thread support (follow OpenClaw's `thread.historyScope` pattern)

### What comes next (Phase 3+)
- Signal as backup channel (signal-cli-rest-api in Docker)
- Whisper voice note transcription
- Research group for web deep-dives
- CRM-like contacts in PA memory

---

## Reference Implementations

These projects solve similar problems and are useful reference material:

### Slack + Claude

| Project | What to learn from it |
|---------|----------------------|
| **mpociot/claude-code-slack-bot** | Full thread context management, file uploads with auto-cleanup, `@slack/bolt` + Socket Mode + Claude Code SDK. Closest to what we're building. |
| **106-/claude-code-slack-agent** | Simpler: thread replies, "thinking" messages while processing, Docker deployment. |
| **Anthropic Claude Code in Slack** | Official integration. Thread = conversation unit. Progress updates in-thread. |

### MCP Servers for Slack

| Server | Tools provided |
|--------|--------------|
| **@modelcontextprotocol/server-slack** (official) | `slack_post_message`, `slack_reply_to_thread`, `slack_get_channel_history`, `slack_get_thread_replies`, `slack_add_reaction`. Text only, no files. |
| **korotovsky/slack-mcp-server** | Stealth mode (no permissions needed), thread support via `conversations_replies`, built-in caching, SSE transport. |

### Full Frameworks

| Framework | Architecture pattern |
|-----------|---------------------|
| **OpenClaw** | Most complete. Configurable thread scoping (`thread.historyScope`), image download (20MB cap), output-only channels (`allow: false`), broadcast groups. Hub-and-spoke gateway. |
| **MicroClaw** (Rust) | Channel-agnostic agent loop. One adapter per platform, canonical message format (`chat_id`, `sender`, `content_blocks`). Per-thread sessions. |

### Slack Developer Patterns

| Resource | What it covers |
|----------|---------------|
| **Slack Bolt.js AI Assistant tutorial** | `Assistant` class, `threadContextStore`, `chatStream()` for streaming responses. The recommended Slack-native pattern. |
| **Slack Chat Streaming** (Oct 2025) | `chatStream()` helper for real-time LLM response updates in Slack messages. |
| **Slack File API** | Private file URLs require `Authorization: Bearer <bot-token>` with `files:read` scope. Use `url_private_download`, not `url_private`. |
