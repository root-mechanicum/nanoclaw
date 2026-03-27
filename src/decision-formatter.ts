/**
 * Decision Template Formatter
 *
 * Formats structured decision templates (from DECISION-TEMPLATE.md schema)
 * for delivery via Slack, email, and Agent Mail.
 *
 * PA collects decision data from bd kv, builds the template, then calls
 * these formatters before posting.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type DecisionType =
  | 'approve-plan'
  | 'approve-desire'
  | 'ship-feature'
  | 'deploy-prod'
  | 'accept-quality'
  | 'custom';

export type EvidenceStatus = 'green' | 'yellow' | 'red';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ResponseAction = 'approve' | 'reject' | 'defer' | 'iterate';

export interface DecisionTemplate {
  decision: {
    id: string;
    formula: string;
    step: string;
    title: string;
    type: DecisionType;
  };
  context: {
    summary: string;
    trigger: string;
    scope: string;
    timeline?: string;
  };
  evidence: Array<{
    source: string;
    finding: string;
    status: EvidenceStatus;
  }>;
  risk: {
    level: RiskLevel;
    factors: string[];
    mitigation: string;
    blast_radius: string;
  };
  recommendation: {
    action: ResponseAction;
    rationale: string;
    conditions?: string;
  };
  responses: {
    approve: string;
    reject: string;
    defer: string;
    iterate?: string;
  };
}

// ── Status icons ───────────────────────────────────────────────────────

const STATUS_ICON: Record<EvidenceStatus, string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
};

const RISK_ICON: Record<RiskLevel, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
};

const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk',
  critical: 'CRITICAL',
};

// ── Slack formatter ────────────────────────────────────────────────────

/**
 * Format a decision template for Slack delivery.
 * Compact, scannable, action-oriented.
 */
export function formatForSlack(dt: DecisionTemplate): string {
  const lines: string[] = [];

  // Header
  const riskBadge = `${RISK_ICON[dt.risk.level]} ${RISK_LABEL[dt.risk.level]}`;
  lines.push(`*🔔 Decision Needed* — ${riskBadge}`);
  lines.push(`*${dt.decision.title}*`);
  lines.push(`_${dt.decision.formula}/${dt.decision.step}_ · \`${dt.decision.id}\``);
  lines.push('');

  // Context (brief)
  lines.push(`> ${dt.context.summary}`);
  if (dt.context.timeline && dt.context.timeline !== 'no deadline') {
    lines.push(`> ⏰ ${dt.context.timeline}`);
  }
  lines.push('');

  // Evidence (compact table)
  lines.push('*Evidence:*');
  for (const e of dt.evidence) {
    lines.push(`${STATUS_ICON[e.status]} \`${e.source}\` — ${e.finding}`);
  }
  lines.push('');

  // Risk (only if medium+)
  if (dt.risk.level !== 'low') {
    lines.push('*Risk:*');
    for (const f of dt.risk.factors) {
      lines.push(`• ${f}`);
    }
    lines.push(`_Mitigation:_ ${dt.risk.mitigation}`);
    lines.push(`_Blast radius:_ ${dt.risk.blast_radius}`);
    lines.push('');
  }

  // Recommendation
  const recIcon = dt.recommendation.action === 'approve' ? '✅' : '⚠️';
  lines.push(`*Recommendation:* ${recIcon} *${dt.recommendation.action.toUpperCase()}*`);
  lines.push(dt.recommendation.rationale);
  if (dt.recommendation.conditions) {
    lines.push(`_Condition:_ ${dt.recommendation.conditions}`);
  }
  lines.push('');

  // Response options
  lines.push('*Reply with:*');
  lines.push(`\`approve ${dt.decision.id}\` — ${dt.responses.approve}`);
  lines.push(`\`reject ${dt.decision.id} <reason>\` — ${dt.responses.reject}`);
  lines.push(`\`defer ${dt.decision.id}\` — ${dt.responses.defer}`);
  if (dt.responses.iterate) {
    lines.push(`\`iterate ${dt.decision.id} <feedback>\` — ${dt.responses.iterate}`);
  }

  return lines.join('\n');
}

// ── Email formatter ────────────────────────────────────────────────────

/**
 * Format a decision template for email delivery (plain text).
 * Full detail, all fields, readable without Slack formatting.
 */
export function formatForEmail(dt: DecisionTemplate): { subject: string; body: string } {
  const subject = `[DECISION] ${dt.decision.title} (${RISK_LABEL[dt.risk.level]})`;

  const lines: string[] = [];

  lines.push(`DECISION NEEDED: ${dt.decision.title}`);
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Formula: ${dt.decision.formula}`);
  lines.push(`Step:    ${dt.decision.step}`);
  lines.push(`Bead:    ${dt.decision.id}`);
  lines.push(`Type:    ${dt.decision.type}`);
  lines.push(`Risk:    ${RISK_LABEL[dt.risk.level]}`);
  lines.push('');

  // Context
  lines.push('CONTEXT');
  lines.push('-'.repeat(40));
  lines.push(dt.context.summary);
  lines.push('');
  lines.push(`Trigger: ${dt.context.trigger}`);
  lines.push(`Scope:   ${dt.context.scope}`);
  if (dt.context.timeline) {
    lines.push(`Timeline: ${dt.context.timeline}`);
  }
  lines.push('');

  // Evidence
  lines.push('EVIDENCE');
  lines.push('-'.repeat(40));
  for (const e of dt.evidence) {
    const icon = e.status === 'green' ? '[OK]' : e.status === 'yellow' ? '[!!]' : '[XX]';
    lines.push(`${icon} ${e.source}`);
    lines.push(`    ${e.finding}`);
  }
  lines.push('');

  // Risk
  lines.push('RISK ASSESSMENT');
  lines.push('-'.repeat(40));
  lines.push(`Level: ${dt.risk.level.toUpperCase()}`);
  for (const f of dt.risk.factors) {
    lines.push(`  - ${f}`);
  }
  lines.push(`Mitigation:   ${dt.risk.mitigation}`);
  lines.push(`Blast radius: ${dt.risk.blast_radius}`);
  lines.push('');

  // Recommendation
  lines.push('RECOMMENDATION');
  lines.push('-'.repeat(40));
  lines.push(`Action: ${dt.recommendation.action.toUpperCase()}`);
  lines.push(dt.recommendation.rationale);
  if (dt.recommendation.conditions) {
    lines.push(`Condition: ${dt.recommendation.conditions}`);
  }
  lines.push('');

  // Response options
  lines.push('HOW TO RESPOND');
  lines.push('-'.repeat(40));
  lines.push(`Reply "approve" — ${dt.responses.approve}`);
  lines.push(`Reply "reject <reason>" — ${dt.responses.reject}`);
  lines.push(`Reply "defer" — ${dt.responses.defer}`);
  if (dt.responses.iterate) {
    lines.push(`Reply "iterate <feedback>" — ${dt.responses.iterate}`);
  }

  return { subject, body: lines.join('\n') };
}

// ── Agent Mail formatter ───────────────────────────────────────────────

/**
 * Format for Agent Mail delivery. Returns structured subject + body.
 * Body is the raw JSON template for machine consumers, with a human-readable
 * summary prepended.
 */
export function formatForAgentMail(dt: DecisionTemplate): { subject: string; body: string } {
  const subject = `[DECISION] ${dt.decision.formula}/${dt.decision.step} — ${dt.decision.title}`;

  const summary = [
    `Decision: ${dt.decision.title}`,
    `Risk: ${RISK_LABEL[dt.risk.level]}`,
    `Recommendation: ${dt.recommendation.action.toUpperCase()} — ${dt.recommendation.rationale}`,
    '',
    'Evidence:',
    ...dt.evidence.map((e) => `  ${STATUS_ICON[e.status]} ${e.source}: ${e.finding}`),
    '',
    `Reply with: approve / reject <reason> / defer / iterate <feedback>`,
    '',
    '--- Raw template (JSON) ---',
    JSON.stringify(dt, null, 2),
  ].join('\n');

  return { subject, body: summary };
}

// ── Briefing integration ───────────────────────────────────────────────

/**
 * Format a list of pending decisions for the briefing prompt.
 * Replaces the current freeform "Decisions Needed" section with
 * structured summaries when decision templates are available.
 */
export function formatDecisionsForBriefing(
  decisions: Array<{
    id: string;
    title: string;
    priority: number;
    template?: DecisionTemplate;
  }>,
): string {
  if (decisions.length === 0) return '';

  const lines: string[] = [];
  lines.push('\n## ⚠️ Decisions Needed');

  for (const d of decisions) {
    if (d.template) {
      const dt = d.template;
      const risk = RISK_ICON[dt.risk.level];
      const rec = dt.recommendation.action.toUpperCase();
      lines.push(`- ${risk} **${d.id}** (P${d.priority}): ${dt.decision.title}`);
      lines.push(`  _Rec: ${rec}_ — ${dt.recommendation.rationale}`);
      const evidenceSummary = dt.evidence
        .map((e) => `${STATUS_ICON[e.status]} ${e.source}`)
        .join(', ');
      lines.push(`  _Evidence: ${evidenceSummary}_`);
    } else {
      // Fallback for decisions without a template
      lines.push(`- **${d.id}** (P${d.priority}): ${d.title}`);
    }
  }
  lines.push('  _Reply with bead ID + decision to approve/adjust._');

  return lines.join('\n');
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validate a decision template has all required fields.
 * Returns list of missing/invalid fields, or empty array if valid.
 */
export function validateTemplate(dt: Partial<DecisionTemplate>): string[] {
  const errors: string[] = [];

  if (!dt.decision?.id) errors.push('decision.id required');
  if (!dt.decision?.formula) errors.push('decision.formula required');
  if (!dt.decision?.step) errors.push('decision.step required');
  if (!dt.decision?.title) errors.push('decision.title required');
  if (!dt.decision?.type) errors.push('decision.type required');

  if (!dt.context?.summary) errors.push('context.summary required');
  if (!dt.context?.trigger) errors.push('context.trigger required');
  if (!dt.context?.scope) errors.push('context.scope required');

  if (!dt.evidence || dt.evidence.length === 0) errors.push('at least 1 evidence entry required');

  if (!dt.risk?.level) errors.push('risk.level required');
  if (!dt.risk?.factors || dt.risk.factors.length === 0) errors.push('at least 1 risk factor required');
  if (!dt.risk?.mitigation) errors.push('risk.mitigation required');
  if (!dt.risk?.blast_radius) errors.push('risk.blast_radius required');

  if (!dt.recommendation?.action) errors.push('recommendation.action required');
  if (!dt.recommendation?.rationale) errors.push('recommendation.rationale required');

  if (!dt.responses?.approve) errors.push('responses.approve required');
  if (!dt.responses?.reject) errors.push('responses.reject required');
  if (!dt.responses?.defer) errors.push('responses.defer required');

  return errors;
}
