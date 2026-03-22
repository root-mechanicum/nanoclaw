#!/usr/bin/env bash
# cass-pa-digest.sh — Generate a CASS-based activity digest for PA briefings.
# Called by briefing.ts to inject agent activity patterns into briefing data.
#
# Usage: cass-pa-digest.sh [hours]
# Output: JSON with activity summary, outcome stats, and notable patterns.
# Default: last 24 hours.

set -euo pipefail

HOURS="${1:-24}"
CASS="/home/ubuntu/.local/bin/cass"
OUTCOMES="/srv/gluon/dev/.cass/outcomes.jsonl"

# Check CASS is available
if ! "$CASS" health &>/dev/null; then
  echo '{"error":"cass not available","agent_sessions":0}'
  exit 0
fi

# Get timeline session count
TOTAL_SESSIONS=$("$CASS" timeline --since "${HOURS}h" --json 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_sessions',0))" 2>/dev/null \
  || echo 0)

# Get cutoff timestamp
CUTOFF_TS=$(date -u -d "${HOURS} hours ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")

# Single python3 script does outcome parsing + JSON assembly
python3 << PYEOF
import json, sys, os

hours = ${HOURS}
total_sessions = ${TOTAL_SESSIONS}
cutoff = "${CUTOFF_TS}"
outcomes_file = "${OUTCOMES}"

# Parse outcomes
outcome_stats = {"total": 0, "success": 0, "failure": 0, "avg_duration_sec": 0, "unique_agents": 0, "success_rate": 0.0}

if cutoff and os.path.isfile(outcomes_file):
    success = 0
    failure = 0
    total_duration = 0
    count = 0
    agents = set()

    with open(outcomes_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            recorded = rec.get("recordedAt", "")
            if recorded < cutoff:
                continue
            if rec.get("outcome") == "success":
                success += 1
            else:
                failure += 1
            total_duration += rec.get("durationSec", 0)
            count += 1
            sid = rec.get("sessionId", "")
            parts = sid.rsplit("/", 1)
            if len(parts) == 2:
                agents.add(parts[1].split("-")[0])

    if count > 0:
        outcome_stats = {
            "total": count,
            "success": success,
            "failure": failure,
            "avg_duration_sec": round(total_duration / count),
            "unique_agents": len(agents),
            "success_rate": round(success / count * 100, 1),
        }

digest = {
    "period_hours": hours,
    "agent_sessions": total_sessions,
    "outcomes": outcome_stats,
}

print(json.dumps(digest))
PYEOF
