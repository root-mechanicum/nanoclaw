# NanoClaw Corp PA — Architecture Design

## Context

**Goal:** A private AI executive assistant accessible via multiple channels, with email management, scheduling, and proactive briefings — running on Hetzner VPS infrastructure alongside the gluon system.

**Constraints:**
- Gluon scales to 4 VPS instances eventually
- Tailscale mesh already in place
- ACFS flywheel tooling on the VPS
- NanoClaw provides: container isolation, per-group memory, scheduled tasks, agent orchestration

---

## Contact Surfaces

The PA needs multiple communication channels — not just one. Each surface has different strengths and the right mix gives you coverage for different contexts: at your desk, on the go, in a meeting, offline.

### 1. Slack — Primary Command Surface

**Role:** Main interface. Where you talk to the PA, give instructions, get reports.

**Why Slack:**
- Channels map naturally to PA roles (#pa, #planner, #briefing, #alerts)
- Threads keep conversations organized — ask a follow-up without losing context
- Rich formatting: code blocks, file uploads, link previews
- Solid mobile app — usable while walking around
- Well-documented Bot API (Bolt SDK, TypeScript native)
- No ToS grey area (unlike reverse-engineered WhatsApp via baileys)
- Can be both input AND output — PA posts proactively to channels

**Integration effort:** Medium. NanoClaw needs `/add-slack` skill (replace `src/channels/whatsapp.ts`). Bolt SDK is straightforward. NanoClaw's `/customize` flow can guide this.

**NanoClaw mapping:** Slack channels = NanoClaw groups. Each channel gets its own `CLAUDE.md`, container, and isolated context.

```
#pa          → groups/pa/CLAUDE.md          (email, calendar, life admin)
#planner     → groups/planner/CLAUDE.md     (projects, agents, tasks)
#briefing    → output-only channel          (scheduler posts here)
#alerts      → output-only channel          (urgent items)
```

---

### 2. Signal — Private / Secure Fallback

**Role:** Backup command channel for when Slack is down or for truly private messages you don't want on a work-oriented platform.

**Why Signal:**
- End-to-end encrypted by default — more trustworthy than Slack for sensitive content
- Clean mobile experience, very low friction to send a quick message
- Good for quick pings: "remind me to call X" while in a conversation
- No corporate data retention concerns

**Integration effort:** Medium-high. There's a [NanoClaw issue (#29)](https://github.com/qwibitai/nanoclaw/issues/29) requesting `/add-signal`. The recommended integration tool is `signal-cli-rest-api` (Docker, 2.3k stars) — fits well on a VPS. Not officially supported by Signal, but widely used and stable.

**Watch out for:**
- Signal's anti-bot stance — they don't offer a bot API. `signal-cli` is community-maintained
- Requires linking a phone number
- Less rich than Slack (no threads, limited formatting)

**Best used as:** A secondary channel alongside Slack. Quick commands, sensitive topics, or a "hey PA, urgent" escalation path when you're away from Slack.

---

### 3. Gmail — Email Management

The PA doesn't just *send* via email — it manages your inbox. This is a tool surface, not a chat surface.

**Role:** Full email management — triage, draft, send, search, flag.

**Integration effort:** Low. NanoClaw already has `/add-gmail` as a built-in skill. Google's API is mature, well-documented, OAuth is standard.

**What the PA can do:**
- Morning inbox summary → posted to #briefing
- "Draft a reply to X's email, tone: professional but warm"
- "Flag anything from Y as urgent and alert me in #alerts"
- "What did Z send me last week about the proposal?"
- Scheduled: "Every Friday at 5pm, summarize the week's email threads"

---

### 4. Google Calendar — Schedule Management

**Role:** Schedule management, meeting awareness, proactive reminders.

**Integration effort:** Low. Google Calendar API is well-documented. OAuth pairs with Gmail auth. MCP servers exist for this.

**What the PA can do:**
- "What's on my calendar today?" → responds in Slack
- "Schedule a call with X next Tuesday at 2pm"
- "Block 2 hours tomorrow morning for deep work"
- Morning briefing includes today's schedule
- "Warn me 30 minutes before any meeting"

---

### 5. Voice / Phone — The Outlier

**Role:** Hands-free interaction when you can't type. Driving, cooking, walking.

**Integration effort:** Very high. This is the hardest surface but potentially the most transformative.

**Options:**

| Approach | How it works | Effort |
|----------|-------------|--------|
| **Twilio Voice** | PA gets a phone number. You call it, speech-to-text → Claude → text-to-speech back. | High — Twilio API, STT/TTS pipeline, telephony handling |
| **Voice note via Signal/Slack** | Send a voice message, PA transcribes (Whisper) and responds as text. | Medium — Whisper on VPS or API, integrate into message handler |
| **Siri/Google Assistant → Slack** | Use phone's voice assistant to send a Slack message to #pa. Hack but works. | Zero — no PA changes, just use "Hey Siri, send a Slack message to PA channel" |
| **Custom SIP/VoIP** | Self-hosted Asterisk/FreeSWITCH on VPS, call via SIP client. | Very high — overkill for a PA |

**Recommendation:** Start with the Siri/Google Assistant → Slack hack for zero-effort voice input. Then add Whisper-based voice note transcription in Signal or Slack as a Phase 3 item. Full voice calling via Twilio is Phase 4+ — it's cool but not essential when text works.

---

---

## Additional Surfaces

### 6. GitHub — Repo Awareness

**Role:** The PA watches your GitHub repos and acts as a triage layer between the outside world and you.

**Integration:** GitHub Webhooks → PA VPS webhook endpoint (bind to Tailscale IP, not 0.0.0.0; verify `X-Hub-Signature-256`).

**What it does:**

**Inbound triage (things happening TO your repos):**
- New issue opened → PA reads it, labels it (bug/feature/question), posts summary to #alerts
- PR submitted → PA reads the diff, flags potential concerns, summarizes scope in #alerts
- Comment on issue/PR → PA decides if it needs your attention or if it can auto-respond ("Thanks, we'll look into this")
- Star/fork spike → "Your wagara project got 15 stars in the last hour, looks like it hit HN"
- Dependabot / security alert → PA escalates immediately to #alerts with severity assessment

**Outbound actions (PA acting on your behalf):**
- You say in Slack: "Close that stale issue about the SVG export" → PA finds it, closes with a polite comment
- "Create an issue for the API refactor, assign it to the planner" → PA creates the issue, planner picks it up via Agent Mail
- "What PRs are open across all my repos?" → PA queries GitHub API, summarizes in Slack
- "Release v0.3 of project X" → PA creates the release, generates changelog from commits

**Beads integration:** PA already reads Beads from GitHub. Now it also writes — updating task status based on what it observes in issues and PRs. The loop closes: GitHub events → PA → Beads → coding agents → commits → GitHub events.

**GitHub API setup:**
```
Webhook:  POST https://<pa-vps-tailscale-ip>:8443/webhook/github
          Secret: <shared-secret>
          Events: issues, pull_request, issue_comment, push, star,
                  release, security_advisory

API:      Personal Access Token (fine-grained)
          Scopes: repo, issues:write, pull_requests:write
```

**Slack channel routing:**
```
Issue opened (bug)        → #alerts (immediate)
Issue opened (feature)    → #planner (queued for review)
Issue opened (question)   → PA auto-responds if confident, else #pa
PR opened                 → #alerts with diff summary
PR merged                 → #briefing (included in daily digest)
Security alert            → #alerts (high priority)
Star spike                → #briefing (vanity, but nice to know)
```

---

### 7. Slack Screenshots — Visual Input (Phase 2+)

**Role:** Send screenshots to the PA directly in Slack. Claude has vision — the PA can see and interpret images.

**How it works:** Slack supports image uploads and paste-from-clipboard. You paste a screenshot into a Slack channel, PA processes it.

> **Codebase reality:** This is NOT a simple adapter feature. NanoClaw's entire pipeline
> is text-only today. Making vision work requires changes at every layer:
>
> 1. `Channel` interface (`types.ts`): `sendMessage(jid, text)` — no media parameter
> 2. `NewMessage` type: has only `content: string` — no image fields
> 3. `ContainerInput`: passes a text `prompt` — no image field
> 4. Agent-runner `query()`: sends string prompt to Claude SDK — no vision content blocks
> 5. `formatMessages()` in `router.ts`: produces XML with text-only `<message>` tags
>
> The existing Discord and Telegram adapters handle media with **text placeholders only**
> (e.g., `[Image: screenshot.png]`). They never download binary data.
>
> **Effort: Medium-High, not Low.** Defer to Phase 2 after text-only Slack is working.
> Reference: OpenClaw handles this with private URL download + 20MB size cap + vision routing.
> Reference: mpociot/claude-code-slack-bot downloads files temporarily for processing.

**What it would unlock:**

- Paste a screenshot of an error → "What's wrong here?"
- Photo of a whiteboard → PA transcribes and creates action items
- Screenshot of a flight confirmation → PA adds to calendar
- Architecture diagram → PA summarizes and files

**Implementation path (when ready):**

1. Add `images?: { base64: string, mediaType: string }[]` to `NewMessage` type
2. Add same field to `ContainerInput`
3. In Slack adapter: download via `url_private` with bearer token auth (`files:read` scope)
4. In agent-runner: convert to Claude SDK multimodal content blocks
5. Size cap: 20MB per OpenClaw's pattern (configurable via env var)

```typescript
// Slack adapter: download private file with bot token
async function downloadSlackFile(url: string, token: string): Promise<Buffer> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return Buffer.from(await resp.arrayBuffer());
}
```

---

### Contact Surface Summary (Updated)

| Surface | Role | Priority | Effort | Status |
|---------|------|----------|--------|--------|
| **Slack** | Primary command & output | P0 | Medium | Build first — replace whatsapp.ts |
| **Gmail** | Email management tool | P0 | Low | `/add-gmail` skill exists |
| **Google Calendar** | Schedule management | P1 | Low | API + MCP, shares Gmail OAuth |
| **GitHub Webhooks** | Repo awareness + triage | P1 | Low-Medium | Webhook endpoint + GitHub API |
| **Slack Screenshots** | Visual input via Claude vision | P2 | Medium-High | Requires pipeline changes at every layer (see Section 7) |
| **Signal** | Secure backup channel | P2 | Medium-High | signal-cli-rest-api in Docker |
| **Voice (passive)** | Siri → Slack shortcut | P2 | Zero | Phone-side config only |
| **Voice (active)** | Whisper transcription | P3 | Medium | Whisper + message handler |
| **Voice (phone)** | Twilio voice calls | P4 | Very High | Future |

### Multi-Channel Architecture

```
                        ┌─────────────────────────┐
                        │       YOU (mobile)       │
                        └──┬────┬────┬────┬───┬────┘
                           │    │    │    │   │
                    Slack  │  Signal │  Voice │  Siri→Slack
                   + imgs  │    │    │    │   │
┌──────────────────────────▼────▼────▼────▼───▼───────────────┐
│                    PA VPS (NanoClaw)                         │
│                                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
│  │ Slack   │  │ Signal   │  │ Whisper   │  │ Scheduler  │  │
│  │ Adapter │  │ Adapter  │  │ STT       │  │ (cron)     │  │
│  │ + imgs  │  └────┬─────┘  └─────┬─────┘  └─────┬──────┘  │
│  └────┬────┘       │              │               │         │
│       │            │              │               │         │
│       └────────────┴──────┬───────┘               │         │
│                           │                       │         │
│                    ┌──────▼──────┐                 │         │
│  GitHub ──webhook──►  NanoClaw   │◄────────────────┘         │
│                    │  Core       │                           │
│                    └──────┬──────┘                           │
│                           │                                 │
│              ┌────────────┼────────────┐                    │
│              │            │            │                    │
│         ┌────▼───┐  ┌────▼────┐  ┌────▼────┐               │
│         │ Gmail  │  │ Google  │  │ GitHub  │               │
│         │ API    │  │ Cal API │  │ API     │               │
│         └────────┘  └─────────┘  └─────────┘               │
│                                                             │
│         ┌──────────────┐                                    │
│         │ Agent Mail   │──── Tailscale ──── Gluon VPSes    │
│         │ (MCP)        │                                    │
│         └──────────────┘                                    │
└─────────────────────────────────────────────────────────────┘
```

## Approach A: "Next To Gluon"

NanoClaw runs as an independent service on its own VPS. It talks to gluon VPSes over Tailscale when it needs to, but is otherwise self-contained.

### Topology

```
┌─────────────────────────────────────────────────────────────┐
│                     TAILSCALE MESH                          │
│                                                             │
│  ┌──────────────┐   ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │  PA VPS      │   │ Gluon 1  │ │ Gluon 2  │ │ Gluon 3  │ │
│  │              │   │          │ │          │ │          │ │
│  │ NanoClaw     │   │ ACFS     │ │ ACFS     │ │ ACFS     │ │
│  │ ├─ Slack bot │   │ Agents   │ │ Agents   │ │ Agents   │ │
│  │ ├─ Gmail     │   │ Repos    │ │ Repos    │ │ Repos    │ │
│  │ ├─ Calendar  │   │          │ │          │ │          │ │
│  │ ├─ Scheduler │   │          │ │          │ │          │ │
│  │ └─ Containers│   │          │ │          │ │          │ │
│  └──────┬───────┘   └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│         │                │            │             │       │
│         └──── Agent Mail over Tailscale ────────────┘       │
│                                                             │
│  ┌──────────┐                                               │
│  │ Gluon 4  │                                               │
│  │ (future) │                                               │
│  └──────────┘                                               │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

- **Dedicated PA VPS** (small — 4-8GB RAM is plenty): runs NanoClaw with Slack adapter, Gmail integration, scheduler
- **Gluon VPSes** run ACFS, coding agents, repos — business as usual
- **Agent Mail over Tailscale** is the coordination protocol. PA agent registers as a participant and communicates with coding agents natively — no bridges, no SSH
- **Beads via GitHub** — PA pulls project/task status from the same repos your coding agents commit to
- PA has its own persistence: email state, conversation history, your preferences, CRM-like context

### Communication Examples

```
"What did the agents work on overnight?"  → PA queries Agent Mail over Tailscale
"Start the API refactor on gluon-2"       → PA sends task via Agent Mail to coding agent
"What's the status of Project X?"         → PA reads Beads from GitHub
"Summarize my unread email"               → PA reads Gmail API directly
```

### Slack Channel Map

```
#pa-inbox        → Email triage, drafts, approvals
#pa-daily        → Morning briefing (auto-posted by scheduler)
#pa-requests     → Ad-hoc asks: research, drafting, reminders
#gluon-status    → Project updates pulled from gluon VPSes
#gluon-planner   → Task planning, agent coordination commands
```

### Pros

- **Clean separation of concerns.** PA never interferes with gluon workloads. Different failure domains.
- **Scales independently.** Gluon grows to 4 VPS — PA doesn't care, just adds more Tailscale endpoints.
- **Cheap.** PA VPS is lightweight. A €4-8/month Hetzner box handles it easily.
- **Simple mental model.** PA is "over here," gluon is "over there."
- **Easy to rebuild.** Blow away the PA VPS and re-setup without touching gluon.
- **Agent Mail already reachable.** Agent Mail is on Tailscale — PA agent registers and coordinates with gluon agents natively. No bridge code needed.
- **Beads already portable.** Beads status is checked into GitHub — PA reads project state via git pull, not filesystem access.
- **No SSH needed.** All coordination happens through Agent Mail (Tailscale) + GitHub. No fragile SSH wrappers.

### Cons

- ~~**Latency on gluon queries.**~~ Agent Mail over Tailscale is fast enough. Not a real concern.
- ~~**Bridge code needed.**~~ Agent Mail IS the bridge. Already solved.
- **Another box to manage.** Patching, monitoring, backups — though minimal.
- ~~**Context gap.**~~ Agent Mail gives conversation context, Beads/GitHub gives project context. Gap is narrow.

### Build Order

1. Provision small Hetzner VPS, add to Tailscale mesh
2. Clone NanoClaw, run `/setup` with Docker
3. Swap WhatsApp → Slack (replace `src/channels/whatsapp.ts`)
4. Run `/add-gmail` skill
5. Configure scheduled morning briefing
6. Install Agent Mail MCP in containers — register as flywheel participant over Tailscale
7. Add calendar integration (Google Calendar API or MCP)
8. Iterate on `CLAUDE.md` persona and capabilities

---

## Approach B: "Around Gluon"

NanoClaw lives *on* one of the gluon VPSes (or on a designated "hub" VPS) and acts as the front door to the entire infrastructure. It doesn't just talk to gluon — it orchestrates it.

### Topology

```
┌──────────────────────────────────────────────────────────────┐
│                      TAILSCALE MESH                          │
│                                                              │
│  ┌─────────────────────────────────────┐                     │
│  │         GLUON HUB VPS               │                     │
│  │                                     │                     │
│  │  ┌───────────────────────────────┐  │                     │
│  │  │        NANOCLAW               │  │                     │
│  │  │  ┌─────────┐  ┌───────────┐  │  │                     │
│  │  │  │ Slack   │  │ Scheduler │  │  │                     │
│  │  │  │ Adapter │  │ & Cron    │  │  │                     │
│  │  │  └────┬────┘  └─────┬─────┘  │  │                     │
│  │  │       │             │        │  │                     │
│  │  │  ┌────▼─────────────▼────┐   │  │                     │
│  │  │  │   Agent Containers    │   │  │                     │
│  │  │  │                       │   │  │                     │
│  │  │  │  PA ── Gmail, Cal     │   │  │  ┌──────────┐       │
│  │  │  │  Planner ── Repos     │───┼──┼──│ Gluon 2  │       │
│  │  │  │  DevOps ── CI/CD      │───┼──┼──│ Gluon 3  │       │
│  │  │  │  Research ── Web      │   │  │  │ Gluon 4  │       │
│  │  │  │                       │   │  │  └──────────┘       │
│  │  │  └───────────────────────┘   │  │                     │
│  │  └───────────────────────────────┘  │                     │
│  │                                     │                     │
│  │  ACFS / Flywheel / Agent Mail       │                     │
│  │  Local repos & agents               │                     │
│  └─────────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

### How It Works

- **NanoClaw IS the control plane.** It wraps gluon rather than sitting beside it.
- **Gluon hub VPS** runs both NanoClaw and ACFS. NanoClaw containers have direct filesystem access to repos, CASS databases, Agent Mail SQLite, etc.
- **Agent groups map to roles:**
  - **PA group** — email, calendar, reminders, drafting. Mounted: `~/mail-cache`, `~/calendar`, `~/contacts`
  - **Planner group** — project management, task breakdown. Mounted: project repos, `beads` data, Agent Mail DB
  - **DevOps group** — build status, deployments, monitoring. Mounted: CI logs, Docker/service configs across Tailscale
  - **Research group** — web access, document analysis. Minimal mounts, max web access.
- **Agent Mail as the backbone.** NanoClaw agents register with Agent Mail. Your existing coding agents on gluon boxes also use Agent Mail. They can coordinate natively — the PA agent can ask a coding agent for a status update via Agent Mail, no custom bridge needed.
- **Slack channels are views into NanoClaw groups.** Each group = each channel. The Slack adapter routes messages to the right container.

### Slack Channel Map

```
#pa              → Personal assistant (email, calendar, life admin)
#planner         → Sprint planning, task priority, agent delegation
#devops          → Infrastructure, builds, deployments
#research        → Deep dives, competitive analysis, technical research
#briefing        → Auto-posted daily by scheduler (synthesis of all groups)
#alerts          → Urgent items from any group (agent-initiated)
```

### The Agent Mail Bridge

```
You (Slack) → NanoClaw PA Agent → Agent Mail → Coding Agent (any gluon)
                                                        │
                                                        ▼
                                              Coding Agent replies
                                                        │
                                                        ▼
                                  Agent Mail → NanoClaw PA Agent → Slack
```

NanoClaw agents are first-class participants in the flywheel.

**Note:** This same flow works identically in Approach A — see revised analysis below.

### Pros

- **Zero-hop access to local repos.** PA can read/write files directly if it needs to interact with code on the hub box.
- **Agent Mail integration.** Same as Approach A — Agent Mail over Tailscale works from anywhere. Not a differentiator.
- **No extra cost.** No additional VPS.
- **Richer local context.** PA can read CASS session history directly on the hub — though this is a minor advantage since most coordination goes through Agent Mail anyway.

### Cons

- **Resource contention.** PA + coding agents share RAM/CPU on the hub VPS. Solvable with a beefier box or cgroup limits.
- **Coupled failure domains.** If the hub VPS goes down, you lose both PA and that gluon node.
- **More complex hub.** The hub VPS is doing a lot — NanoClaw, ACFS, Docker containers, Agent Mail, repos. Needs careful resource management.
- **Migration complexity.** If gluon-1 (hub) needs to move, NanoClaw moves with it.
- **Scaling friction.** As gluon grows to 4 VPSes, the hub gets heavier. May eventually need to split PA off anyway.

### Build Order

1. On your existing Hetzner VPS (gluon hub), clone NanoClaw
2. Run `/setup` with Docker
3. Swap WhatsApp → Slack
4. Run `/add-gmail`
5. Mount project repos into planner group container
6. Install Agent Mail MCP into NanoClaw containers
7. Register NanoClaw agents with Agent Mail (PA, Planner, DevOps, Research)
8. Configure scheduled briefings that pull from CASS + Agent Mail + Gmail
9. Add calendar integration
10. Build `#alerts` channel with agent-initiated Slack posting

---

## Comparison

| Dimension              | A: Next To              | B: Around               |
|------------------------|-------------------------|-------------------------|
| **Complexity**         | Lower                   | Higher                  |
| **Coupling**           | Loose                   | Tight                   |
| **Agent Mail access**  | Via Tailscale            | Local                   |
| **Beads / project state** | Via GitHub             | Local filesystem        |
| **Failure isolation**  | Independent             | Shared with hub         |
| **Cost**               | Extra €4-8/month VPS    | No extra box            |
| **Scaling to 4 VPS**   | Trivial                 | Hub gets heavier        |
| **Resource contention** | None                   | Competes with agents    |
| **Rebuild ease**       | Blow away, gluon untouched | Entangled            |
| **Migration needed?**  | No — this IS the end state | Will likely need to split |

---

## Recommendation

**Go with A (Next To Gluon).**

The original case for B was tight integration — but that argument collapses now:

- **Agent Mail over Tailscale** means the PA is a native flywheel participant from anywhere. No bridge code. No SSH. The same `agent-mail` MCP calls work whether the PA is on the same box or across the mesh.
- **Beads in GitHub** means project state is already distributed. `git pull` is all the PA needs.
- **B's remaining advantage** is direct filesystem access to repos and CASS on the hub — but a PA agent doesn't need to read raw code files. It needs status, summaries, and coordination. That's exactly what Agent Mail and Beads provide.

Meanwhile A gives you failure isolation, zero resource contention, clean scaling to 4 VPSes, and no future migration. The extra €4-8/month is trivially worth it.

**A is both the starting point and the end state.** No migration path needed.

---

## Architecture (Final — Approach A)

```
┌──────────────────────────────────────────────────────────────┐
│                      TAILSCALE MESH                          │
│                                                              │
│  ┌──────────────────┐                                        │
│  │   PA VPS (small)  │                                       │
│  │                   │                                       │
│  │  NanoClaw         │        Agent Mail (Tailscale)         │
│  │  ├─ Slack ◄───────┼──── You (phone/desktop)              │
│  │  ├─ Gmail         │              ▲                        │
│  │  ├─ Calendar      │              │                        │
│  │  ├─ Scheduler     │        ┌─────┴──────┐                 │
│  │  │                │        │ Agent Mail  │                 │
│  │  └─ PA Agent ─────┼───────►│  (shared)   │◄───┐           │
│  │    Planner Agent ─┼───────►│             │    │           │
│  └──────────────────┘        └──────┬──────┘    │           │
│                                     │           │           │
│  ┌──────────┐  ┌──────────┐  ┌──────┴───┐  ┌───┴──────┐    │
│  │ Gluon 1  │  │ Gluon 2  │  │ Gluon 3  │  │ Gluon 4  │    │
│  │ Coding   │  │ Coding   │  │ Coding   │  │ (future) │    │
│  │ Agents   │  │ Agents   │  │ Agents   │  │          │    │
│  │ Repos    │  │ Repos    │  │ Repos    │  │          │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                                                              │
│          Beads status ←── GitHub (all nodes pull)             │
└──────────────────────────────────────────────────────────────┘
```

### Communication Flows

```
You ──Slack──► PA Agent ──Agent Mail──► Coding Agent (any gluon)
                                              │
                                         works on task
                                              │
                                        Agent Mail reply
                                              │
PA Agent ◄────────────────────────────────────┘
    │
    └──Slack──► You

Screenshot flow:
  You paste image in Slack → Slack file API → PA downloads image
    → Claude vision processes → responds in thread

GitHub webhook flow:
  Issue/PR/push → POST /webhook/github → PA evaluates
    → Routes to #alerts / #planner / #briefing
    → Optionally auto-responds on GitHub (label, comment, close)

Morning briefing:
  Scheduler ──► PA Agent pulls:
                  ├─ Gmail API → unread summary
                  ├─ Google Calendar API → today's schedule
                  ├─ Agent Mail → overnight agent activity
                  ├─ GitHub API → open PRs, new issues, overnight commits
                  └─ GitHub (Beads) → project status
                PA Agent posts synthesis → #briefing
```

---

## Flywheel → PA Communication

Everything above describes the PA reaching out. But the flywheel needs to reach *in* — a coding agent hits a blocker, a bead completes, an agent wants approval. The PA must be a listener, not just a speaker.

### Agent Mail: Inbound Monitoring

The PA is a registered Agent Mail participant. Any agent on any gluon box can message it. The PA runs a polling loop that watches for incoming mail.

> **Codebase reality:** Agent Mail is an **MCP server**, not a REST API. There are
> no HTTP endpoints like `GET /agents/{id}/messages`. All interaction happens via
> MCP tool calls: `register_agent`, `fetch_inbox`, `send_message`, `reply_message`.
>
> **Two integration approaches:**
> 1. **Host-level poller** (recommended for inbound triage): Use `@modelcontextprotocol/sdk`
>    MCP client in `src/agent-mail-poller.ts` to call `fetch_inbox` every 30s.
> 2. **Container-level MCP**: Mount Agent Mail as an MCP server config in the container
>    so the PA agent can call `send_message`/`fetch_inbox` directly during conversations.
>
> Do both: host poller for "push" (agents → PA → Slack), container MCP for "pull"
> (PA agent queries on demand).

**Polling loop (in NanoClaw's scheduler or a dedicated watcher):**
```
Every 30-60 seconds:
  → MCP call: fetch_inbox(agent_name="PA", since_ts=last_check, include_bodies=true)
  → For each new message:
      → Evaluate urgency (see escalation protocol below)
      → Route to appropriate Slack channel
      → If auto-resolvable, handle and reply via Agent Mail (MCP: reply_message)
      → If not, post to Slack and wait for your response
      → Forward your Slack reply back via Agent Mail (MCP: reply_message)
```

**Example flows:**

```
Coding agent → Agent Mail → PA:
  "Blocked: need decision on REST vs GraphQL for new endpoint"
  PA evaluates: decision needed, can't auto-resolve
  PA → #alerts: "Agent on gluon-3 needs input: REST vs GraphQL?"
  You reply in Slack: "GraphQL, use the schema from project Y"
  PA → Agent Mail → Coding agent: unblocked

Coding agent → Agent Mail → PA:
  "FYI: refactor complete, PR #47 submitted"
  PA evaluates: informational, no action needed
  PA → #briefing queue (included in next digest, not immediate alert)

Coding agent → Agent Mail → PA:
  "Error: build failing on gluon-2, test suite timeout after 300s"
  PA evaluates: operational issue, might be auto-resolvable
  PA → Agent Mail → DevOps agent: "Check gluon-2 test environment"
  DevOps agent fixes → Agent Mail → PA: "Resolved, disk was full"
  PA → #alerts: "Build issue on gluon-2 auto-resolved (disk space)"
```

### Beads: Status Change Monitoring

Beads status is in GitHub. The PA already watches GitHub via webhooks. When a Beads commit lands, PA diffs the status:

```
Bead status changes:
  → in-progress → blocked    : #alerts (immediate, include reason)
  → in-progress → done       : #briefing (digest, include PR link)
  → blocked → in-progress    : #planner (info only, agent self-unblocked)
  → new → in-progress        : #planner (info only, agent picked it up)
  → done → needs-review      : #alerts (you need to act)
```

No extra infrastructure — this piggybacks on the GitHub webhook already in Phase 2. When a push to the Beads repo arrives, PA reads the diff and reacts.

### Escalation Protocol

Not every agent message should interrupt you. The PA triages inbound agent communication the same way it triages email:

```
┌─────────────────────────────────────────────────────────────┐
│              INBOUND MESSAGE TRIAGE                         │
│                                                             │
│  Agent Mail / Beads event arrives                           │
│           │                                                 │
│           ▼                                                 │
│  ┌─── Is it a blocker needing human decision? ───┐          │
│  │ YES                                     NO    │          │
│  ▼                                          ▼    │          │
│  #alerts (immediate)              Is it an error? │          │
│  + Slack notification             │          │   │          │
│                              YES  │    NO    │   │          │
│                               ▼   │     ▼    │   │          │
│                     Can PA/DevOps  │  Is it    │  │          │
│                     auto-resolve?  │  task     │  │          │
│                      │        │   │  complete? │  │          │
│                 YES  │   NO   │   │  │    │    │  │          │
│                  ▼   │    ▼   │   │ YES   NO  │  │          │
│           Auto-fix   │ #alerts│   │  ▼     ▼   │  │          │
│           + log to   │(urgent)│   │#brief  Log │  │          │
│           #alerts    │        │   │-ing   only │  │          │
│           (resolved) │        │   │            │  │          │
└─────────────────────────────────────────────────────────────┘
```

### Agent Mail Message Convention

For this to work cleanly, agents should tag their messages with a priority hint. Add this to your `AGENTS.md` across gluon boxes:

```markdown
## Messaging the PA via Agent Mail

When sending a message to PA, prefix with a tag:

- `[BLOCKED]` — You cannot continue without human input. PA will alert immediately.
- `[ERROR]` — Something failed. PA will attempt auto-resolution, escalate if needed.
- `[FYI]` — Informational. PA queues for daily briefing digest.
- `[DONE]` — Task complete. PA logs and includes in briefing.
- `[REVIEW]` — Work ready for human review. PA alerts with summary.
```

This gives the PA structured data to triage with, while keeping the protocol simple enough that any agent can follow it.

### The Full Loop

```
You (Slack) ──► PA ──Agent Mail──► Coding Agent (gluon)
                                        │
                                   works on task
                                        │
                              ┌─────────┴──────────┐
                              │                    │
                         hits blocker          completes
                              │                    │
                    Agent Mail [BLOCKED]    Agent Mail [DONE]
                              │                    │
                              ▼                    ▼
                         PA triages           PA triages
                              │                    │
                        #alerts (now)      #briefing (digest)
                              │
                         You reply
                              │
                    PA ──Agent Mail──► Agent unblocks
```

This is the critical difference between "PA that sends commands" and "PA that's part of the team." The flywheel includes the PA as a node — agents can ask it questions, report status, escalate problems. You're not polling tmux sessions anymore. The work comes to you, filtered and prioritized.

---

## Resilience: Bad Weather Engineering

The architecture above works in good weather. This section is about what happens when things break — because the PA is a single point of visibility into the entire gluon fleet. If it goes down silently, you're blind.

### Principle: Every failure should be visible

If a component fails, the human must know — through *some* channel, even if the primary channel is the thing that failed. No silent failures. No "agents sat idle for 8 hours because nobody noticed."

### 1. Process Supervision

The PA VPS runs Ubuntu. NanoClaw must auto-restart on crash.

```ini
# /etc/systemd/system/nanoclaw.service
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

[Install]
WantedBy=multi-user.target
```

`WatchdogSec=120`: if NanoClaw doesn't notify systemd within 2 minutes, it's killed and restarted. Requires a `sd_notify` call in the main loop (or use `Type=notify` with `sd-notify` wrapper).

This is Phase 1, not optional. Without it, a single OOM or uncaught exception takes out your entire flywheel visibility.

### 2. PA Self-Monitoring (External Heartbeat)

Nothing internal can monitor itself reliably. Use an **external** watchdog.

**Option A — Free uptime monitor (simplest):**
- UptimeRobot, Betterstack, or Healthchecks.io (free tier)
- NanoClaw exposes `GET /health` on the Tailscale IP (same webhook server, port 8443)
- Returns 200 if: Slack connected, Agent Mail last poll < 2 minutes ago, main loop alive
- Monitor pings every 60 seconds. On failure: sends email/SMS directly (bypasses the PA entirely)

**Option B — Cron on a gluon VPS:**
```bash
# On gluon-1, crontab:
*/5 * * * * curl -sf http://<pa-tailscale-ip>:8443/health || \
  curl -X POST https://hooks.slack.com/services/XXX -d '{"text":"PA VPS health check FAILED"}'
```

Uses a **separate Slack webhook** (not the PA's bot token) so it works even if NanoClaw is dead.

**Option C — Dead man's switch:**
The PA posts a heartbeat to a dedicated Slack channel or Healthchecks.io every 5 minutes. If the heartbeat stops, the external service alerts. This catches both process crashes and Tailscale network failures.

**Recommendation:** Do both A and C. Belt and suspenders. The PA is your single pane of glass — it's worth two health checks.

### 3. Agent Mail Failure Detection

The Agent Mail poller must detect and surface connection failures.

```
Agent Mail poller state machine:

  CONNECTED ──poll fails──► DEGRADED ──3 consecutive fails──► DOWN
      ▲                        │                                │
      │                        │ poll succeeds                  │ poll succeeds
      │                        ▼                                │
      └────────────────── CONNECTED ◄───────────────────────────┘

On transition to DEGRADED:
  → Log warning
  → Continue polling with exponential backoff (30s, 60s, 120s, cap at 5min)

On transition to DOWN:
  → Post to #alerts via DIRECT Slack API (not through Agent Mail):
    "Agent Mail is unreachable. Agent coordination is offline.
     Agents on gluon VPSes cannot escalate blockers until this is resolved."
  → Continue retry loop in background

On transition back to CONNECTED:
  → Post to #alerts: "Agent Mail connection restored."
  → Resume normal 30s polling
  → Fetch any messages that arrived while disconnected (since_ts catches up)
```

The critical detail: the DOWN alert goes through Slack's API directly, not through Agent Mail. You can't use the broken thing to report that it's broken.

### 4. Re-escalation for Stale Blockers

A [BLOCKED] message that gets no human response within a timeout should not sit forever.

```
Escalation timeline for [BLOCKED] messages:

  T+0:     Post to #alerts
  T+30min: Re-post with reminder: "Still waiting for input on: {summary}"
  T+2h:    Escalate to email (if Gmail configured):
           "Unresolved blocker for {agent}: {summary}"
  T+4h:    Escalate to Signal (if configured)
  T+8h:    Re-post to #alerts with: "Agent {name} has been blocked for 8 hours"
```

Track escalation state in SQLite:
```sql
CREATE TABLE blocker_escalation (
  agent_mail_message_id INTEGER PRIMARY KEY,
  first_posted DATETIME,
  last_escalated DATETIME,
  escalation_level INTEGER DEFAULT 0,  -- 0=initial, 1=reminder, 2=email, 3=signal, 4=re-alert
  resolved BOOLEAN DEFAULT FALSE
);
```

When the human replies (detected via Slack thread → Agent Mail forwarding), mark as resolved.

### 5. Slack Down Fallback

If the Slack connection drops and can't reconnect:

```
Slack adapter state:

  CONNECTED ──disconnect──► RECONNECTING ──5 failures──► DOWN
      ▲                          │                          │
      │                          │ reconnects               │
      └──────────────────────────┘                          │
                                                            ▼
  On DOWN:
    → Switch inbound Agent Mail routing to email:
      [BLOCKED] messages → send via Gmail to human's email
    → Log all messages to SQLite for replay when Slack returns
    → If Signal is configured, route [BLOCKED] there instead

  On reconnect:
    → Post summary of what happened while Slack was down
    → Resume normal routing
```

This requires Gmail to be configured. Without it, [BLOCKED] messages queue in SQLite and wait. The PA should at minimum log that it's accumulating undelivered blockers.

### 6. Agent Liveness Monitoring

The PA should know when agents go silent.

```
For each registered Agent Mail agent, track:
  - last_message_ts: when they last sent any message
  - expected_cadence: how often they typically communicate (auto-learned or configured)

Every hour, check:
  If last_message_ts > expected_cadence * 2:
    → Post to #alerts:
      "{agent} on {vps} hasn't reported in {hours}h.
       Last known task: {task_description}.
       Last message: {subject}"
```

Start simple: hard-code expected cadence to 6 hours. Any agent silent longer than that gets flagged. Refine later based on actual patterns.

This catches: crashed agents, stuck containers, VPS outages, Tailscale disconnects — all the things where an agent silently stops working.

### 7. Rate Limiting on Agent→Slack

An agent in an error loop can spam hundreds of [ERROR] messages.

```
Rate limiter per agent:
  - Window: 5 minutes
  - Max messages to #alerts: 3 per agent per window
  - On limit hit: batch remaining into single summary:
    "{agent} sent {count} messages in {window}. Latest: {last_subject}.
     Suppressing until next window."
  - Always queue ALL messages for briefing digest (don't lose data)
```

### 8. Operational Runbook

| Scenario | Impact | Detection | Recovery |
|----------|--------|-----------|----------|
| **PA VPS down** | Total blackout: no Slack bot, no polling, no webhooks | External health check fires | SSH in, check systemd: `journalctl -u nanoclaw`. If hardware: rebuild from git clone + env vars. |
| **NanoClaw crash** | Same, but systemd auto-restarts in 5s | Self-heals. If restart loop: health check fires. | Check logs: `journalctl -u nanoclaw -n 100`. Fix root cause. |
| **Agent Mail down** | Agents can't escalate. PA posts Slack warning. | Poller detects, posts to #alerts. | Check Agent Mail VPS. Agents continue working but can't report status. |
| **Slack down** | Human can't interact. PA routes [BLOCKED] to email. | Bolt SDK disconnect event. PA logs it. | Wait for Slack. Check queued messages on reconnect. |
| **Tailscale partitioned** | PA can't reach Agent Mail or webhooks. Health check may still work (external). | Agent Mail poller fails. External health check may catch it. | Check Tailscale: `tailscale status`. Restart if needed. |
| **GitHub down** | No Beads updates, no webhook events. Email/Calendar/Agent Mail unaffected. | Webhook errors in logs. | Wait for GitHub. Beads queries return stale data (git cache). |
| **SQLite corruption** | Message history lost, group state lost, escalation tracking lost. | NanoClaw crashes on DB access. | Restore from backup. If no backup: re-register groups, messages start fresh. |
| **Agent error loop** | #alerts spam. | Rate limiter triggers. | PA suppresses after 3 messages per 5-min window. Fix the agent. |

### 9. Daily Backup

```bash
# Cron on PA VPS (add to Phase 1 setup):
0 3 * * * sqlite3 /srv/nanoclaw/store/messages.db ".backup /srv/nanoclaw/backups/messages-$(date +\%Y\%m\%d).db" && \
  find /srv/nanoclaw/backups -name "*.db" -mtime +7 -delete
```

Keeps 7 days of SQLite backups. Cheap insurance.

---

## Codebase Reality Notes

These notes capture how NanoClaw actually works today, informing what needs to change.

### Channel Interface (`src/types.ts`)

```typescript
interface Channel {
  name: string;                                           // 'whatsapp', 'discord', 'telegram'
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;  // Text only — no media parameter
  isConnected(): boolean;
  ownsJid(jid: string): boolean;                          // Pattern match on JID prefix
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

Constructor takes `(botToken, { onMessage, onChatMetadata, registeredGroups })`.

### JID Prefix Convention

Each channel adapter "owns" JIDs matching its prefix:
- WhatsApp: `*@g.us`, `*@s.whatsapp.net`
- Discord: `dc:{channelId}`
- Telegram: `tg:{chatId}`
- **Slack should be: `sl:{channelId}`**

Routing via `findChannel(channels, jid)` in `router.ts` calls `ownsJid()` on each channel.

### Skill Package Pattern

Existing channel skills (`add-discord`, `add-telegram`) follow an identical structure:

```
.claude/skills/add-{channel}/
  SKILL.md              # 5-phase instructions
  manifest.yaml         # adds, modifies, deps, env vars
  add/
    src/channels/{channel}.ts       # New adapter
    src/channels/{channel}.test.ts  # Tests
  modify/
    src/index.ts                    # Multi-channel wiring
    src/config.ts                   # Env var exports
    src/routing.test.ts             # JID ownership tests
```

The Slack adapter should follow this pattern exactly, packaged as an `/add-slack` skill.

### Media Handling Today

**No channel downloads binary media.** Both Discord and Telegram adapters store **text placeholders only**:
- `[Image: screenshot.png]`
- `[Video: clip.mp4]`
- `[Voice message]`

The `NewMessage` type has only `content: string`. To support actual vision, changes are needed at every layer (see Section 7 above).

### Output-Only Channels

NanoClaw has no concept of "write-only" channels. Every registered group is bidirectional.

**Pattern for #briefing and #alerts:** Don't register them as NanoClaw groups. Store their Slack channel IDs as config constants. The scheduler and Agent Mail poller call `sendMessage(BRIEFING_CHANNEL_ID, text)` directly on the Slack adapter — no container, no group, no processing pipeline.

### Container Secrets

`ContainerInput` already has a `secrets` field. The agent-runner deletes the temp file after reading. Gmail, Calendar, and GitHub tokens should be passed through `ContainerInput.secrets` — the mechanism exists.

### Briefing Agent Data Access

Container agents can't call Gmail/Calendar/GitHub APIs directly unless those are exposed as MCP servers inside the container. **Simpler approach:** before spawning the briefing container, the scheduler pre-fetches raw data (email summaries, calendar events, digest queue, GitHub activity) and writes it as JSON files to the group's mounted directory. The briefing agent reads and synthesizes.

### Multi-Channel Already Supported

`index.ts` maintains `channels: Channel[]` and `routeOutbound(channels, jid, text)` iterates them. You don't have to rip out WhatsApp — you can run both simultaneously. The `{CHANNEL}_ONLY` env var pattern (from Discord/Telegram skills) controls whether WhatsApp is also started.

### Formatting Rules Need Updating

`groups/global/CLAUDE.md` currently has WhatsApp-specific formatting rules:
- "Use single asterisks for bold"
- "No markdown headings"
- "Bullet points not numbered lists"

For Slack: real markdown, code blocks, headings, and rich formatting are all supported. Update `global/CLAUDE.md` when switching.

### Reference Implementations

These existing projects solve similar problems:

| Project | Key Patterns | URL |
|---------|-------------|-----|
| **mpociot/claude-code-slack-bot** | `@slack/bolt` + Socket Mode + Claude SDK, full thread context, file downloads | github.com/mpociot/claude-code-slack-bot |
| **OpenClaw** | Configurable thread scoping, image download (20MB cap), output-only channels (`allow: false`), broadcast groups | docs.openclaw.ai/channels/slack |
| **@modelcontextprotocol/server-slack** | Official MCP server: `slack_post_message`, `slack_reply_to_thread`, `slack_get_thread_replies` | npm: @modelcontextprotocol/server-slack |
| **Slack Bolt.js AI Assistant** | `Assistant` class, `threadContextStore`, `chatStream()` for streaming responses | docs.slack.dev/tools/bolt-js/tutorials/ai-assistant |
| **Anthropic Claude Code in Slack** | Official integration, thread-as-conversation, progress updates in thread | code.claude.com/docs/en/slack |

### Thread Model Decision

Slack threads are well-supported across all reference implementations. However, NanoClaw's message model is fundamentally flat (batch all messages since `lastAgentTimestamp`). Adding thread isolation requires tracking `threadTs` through the DB, changing how messages are batched, and routing responses back to the correct thread.

**v1 recommendation:** Keep it flat — treat each channel as one conversation stream (matching WhatsApp behavior). This works, ships fast, and thread support can be added later following OpenClaw's `thread.historyScope` pattern.

---

## Design Principle: Flywheel First, Contact Surfaces Second

The PA has two sides:

1. **Flywheel side** (essential) — Agent Mail + Beads. This is what makes the PA useful. Without it, you have a chatbot. With it, you have a coordination node: agents can reach you, you can reach agents, project state is visible.

2. **Human side** (layered) — Slack, Gmail, Calendar, Signal, voice. These are all just different ways to talk to you. Any one of them works. Slack is the most convenient, but the PA's value doesn't come from which chat app it's in.

**Phase 1 builds both sides.** Phase 2+ adds more contact surfaces and polish.

---

## Phase 1 — Flywheel Node: Slack + Agent Mail + Beads (Week 1-2)

The PA becomes a reachable node in the flywheel with one human contact surface. It must survive bad weather from day one.

### Infrastructure: Keep It Alive
- [ ] Provision small Hetzner VPS (4-8GB RAM), add to Tailscale mesh
- [ ] Clone NanoClaw, run `/setup` with Docker
- [ ] Create systemd unit (`/etc/systemd/system/nanoclaw.service`) with `Restart=always`
- [ ] Add `/health` endpoint to webhook server (returns 200 if Slack connected + Agent Mail last poll < 2min)
- [ ] Set up external health check (UptimeRobot/Betterstack free tier → emails you if PA dies)
- [ ] Set up dead man's switch: PA posts heartbeat to Healthchecks.io every 5 min
- [ ] Add daily SQLite backup cron (3 AM, keep 7 days)

### Contact Surface: Slack
- [ ] Create Slack workspace + app with bot token + app-level token (Socket Mode)
- [ ] Create a **separate Slack incoming webhook** (not the bot token) for out-of-band alerts
  - Used by: external health check, Agent Mail DOWN notification, gluon cron monitor
  - This webhook works even when the NanoClaw process is dead
- [ ] Build `/add-slack` skill following the `add-telegram`/`add-discord` pattern:
  - JID prefix: `sl:{channelId}` (following `dc:` and `tg:` convention)
  - `@slack/bolt` with Socket Mode (no public URL needed behind Tailscale)
  - Env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY`
  - Media: text placeholders initially (`[Image: name]`), matching Discord/Telegram pattern
  - Bot mention: strip `<@botUserId>`, translate to `@{ASSISTANT_NAME}` trigger
- [ ] Test basic Slack ↔ NanoClaw text round-trip
- [ ] Write PA persona in `groups/pa/CLAUDE.md` (Slack markdown, not WhatsApp formatting)
- [ ] Update `groups/global/CLAUDE.md` formatting rules for Slack (real markdown, code blocks)

### Flywheel: Agent Mail
- [ ] Mount Agent Mail MCP config in NanoClaw containers (PA agent gets `send_message`/`fetch_inbox` tools)
- [ ] Build host-level Agent Mail poller (`src/agent-mail-poller.ts`) using `@modelcontextprotocol/sdk` MCP client
  - Calls `register_agent` on startup, `fetch_inbox` every 30s with `since_ts`
  - **State machine**: CONNECTED → DEGRADED (poll fails) → DOWN (3 consecutive fails)
  - On DOWN: post to #alerts via **direct Slack API** (not through Agent Mail)
  - Exponential backoff: 30s → 60s → 120s → cap at 5min
- [ ] **Add escalation triage** — PA routes inbound by [BLOCKED]/[ERROR]/[FYI]/[DONE]/[REVIEW] tags
- [ ] **Rate limiter**: max 3 messages per agent per 5-min window to #alerts; batch the rest
- [ ] **Re-escalation**: stale [BLOCKED] re-posted at T+30min, T+2h (email if configured), T+8h
- [ ] **Update AGENTS.md on gluon boxes** with PA messaging convention (tag prefixes)
- [ ] Route Agent Mail inbound to appropriate Slack channels (#alerts for blockers, queue for digest)
- [ ] Reply forwarding: Slack thread reply → Agent Mail reply to original sender

### Flywheel: Beads
- [ ] Add planner group — reads Beads from GitHub, coordinates via Agent Mail
- [ ] PA agent can query project/task status via Beads in GitHub repos
- [ ] Beads status changes trigger Slack notifications (manual query initially; webhook-driven in Phase 2)

### Flywheel: Agent Liveness
- [ ] Track `last_message_ts` per registered Agent Mail agent
- [ ] Hourly check: flag any agent silent > 6 hours to #alerts
  - "BlueLake on gluon-2 hasn't reported in 8h. Last task: API refactor."

### Verify
- [ ] You → Slack → PA → Agent Mail → coding agent (command flows out)
- [ ] Coding agent → Agent Mail → PA → Slack → you (status flows back)
- [ ] "What's the status of Project X?" → PA reads Beads, responds in Slack
- [ ] Kill NanoClaw process → systemd restarts it within 5s
- [ ] Disconnect Agent Mail → PA posts "Agent Mail unreachable" to #alerts within 2 min
- [ ] Send [BLOCKED], don't reply → re-escalation posts at T+30min

---

## Phase 2 — Human Contact Surfaces + Automation (Week 3-4)

More ways to reach the human. Automated briefings. GitHub awareness.

### Email + Calendar
- [ ] Run `/add-gmail` — connect email
- [ ] Google Calendar API integration (IPC tools or MCP server)
- [ ] First scheduled task: morning email summary → `#briefing`

### GitHub Webhooks
- [ ] Set up GitHub webhook endpoint on PA VPS (bind to Tailscale IP, verify signatures)
- [ ] Configure webhooks on your repos: issues, PRs, comments, push, security
- [ ] GitHub API token (fine-grained) for PA to read/write issues, PRs
- [ ] **Beads status change detection** via GitHub webhook push events (automates what was manual in Phase 1)
- [ ] Route GitHub events to appropriate Slack channels

### Briefings
- [ ] Morning briefing: pre-fetch data (email, calendar, digest queue, GitHub) → write to group mount → container synthesizes
- [ ] Evening summary: unread email count, tomorrow's calendar, unresolved blockers
- [ ] Build `#alerts` channel for agent-initiated and PA-escalated messages

### Polish
- [ ] Tune `CLAUDE.md` files based on first weeks of usage
- [ ] Set up Siri → Slack shortcut on phone (zero-effort voice input)

---

## Phase 3 — Vision + More Surfaces (Month 2)

- [ ] **Screenshot/vision pipeline** — extend `NewMessage`, `ContainerInput`, agent-runner for multimodal
- [ ] Deploy signal-cli-rest-api in Docker on PA VPS
- [ ] Add Signal as secondary NanoClaw channel (control + notification)
- [ ] Add Whisper-based voice note transcription (Slack/Signal voice messages → text → agent)

## Phase 4 — Research + Voice + Polish (Month 3+)

- [ ] Add Research group (web access, document analysis)
- [ ] CRM-like contacts context in PA's `CLAUDE.md`
- [ ] Richer briefings pulling from Agent Mail + Beads + Gmail + Calendar
- [ ] Evaluate Twilio for voice calling (nice-to-have, not essential)
- [ ] Gluon scales to 4 VPS — PA already connected via Tailscale, no changes needed
