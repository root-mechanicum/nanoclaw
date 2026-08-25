import fs from 'fs';
import path from 'path';
import os from 'os';

interface Totals {
  sessions: Set<string>;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
}

function add(
  t: Totals,
  sid: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
) {
  t.sessions.add(sid);
  t.input += input;
  t.output += output;
  t.cacheRead += cacheRead;
  t.cacheCreate += cacheCreate;
  t.total += input + output + cacheRead + cacheCreate;
}

function inferActor(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              c && typeof c === 'object' && 'text' in c
                ? String((c as { text?: unknown }).text || '')
                : '',
            )
            .join(' ')
        : '';
  const m = text.match(/You are ([A-Za-z][A-Za-z0-9_-]+)/);
  return m?.[1] || 'Unknown';
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

const args = process.argv.slice(2);
const dateArg = args.includes('--date')
  ? args[args.indexOf('--date') + 1]
  : undefined;
const targetDate = dateArg || new Date().toISOString().slice(0, 10);

const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
if (!fs.existsSync(claudeRoot)) {
  console.error(`No Claude projects dir at ${claudeRoot}`);
  process.exit(1);
}

const projectAgg = new Map<string, Totals>();
const actorAgg = new Map<string, Totals>();
const modelAgg = new Map<string, Totals>();

for (const dir of fs.readdirSync(claudeRoot)) {
  const fullDir = path.join(claudeRoot, dir);
  if (!fs.statSync(fullDir).isDirectory()) continue;

  const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const sid = file.replace(/\.jsonl$/, '');
    const fp = path.join(fullDir, file);
    let actor = 'Unknown';

    const lines = fs.readFileSync(fp, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (actor === 'Unknown' && rec?.type === 'user') {
        actor = inferActor(rec?.message?.content);
      }

      const ts = rec?.timestamp;
      if (!ts || String(ts).slice(0, 10) !== targetDate) continue;
      if (rec?.type !== 'assistant') continue;

      const u = rec?.message?.usage || {};
      const input = Number(u.input_tokens || 0);
      const output = Number(u.output_tokens || 0);
      const cacheRead = Number(u.cache_read_input_tokens || 0);
      const cacheCreate = Number(u.cache_creation_input_tokens || 0);
      const model = String(rec?.message?.model || 'unknown');

      if (!projectAgg.has(dir))
        projectAgg.set(dir, {
          sessions: new Set(),
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          total: 0,
        });
      if (!actorAgg.has(actor))
        actorAgg.set(actor, {
          sessions: new Set(),
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          total: 0,
        });
      if (!modelAgg.has(model))
        modelAgg.set(model, {
          sessions: new Set(),
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          total: 0,
        });

      add(projectAgg.get(dir)!, sid, input, output, cacheRead, cacheCreate);
      add(actorAgg.get(actor)!, sid, input, output, cacheRead, cacheCreate);
      add(modelAgg.get(model)!, sid, input, output, cacheRead, cacheCreate);
    }
  }
}

function printSection(name: string, data: Map<string, Totals>) {
  console.log(`\n${name}`);
  console.log('name\tsessions\ttotal\tinput\toutput\tcache_read\tcache_create');
  const rows = [...data.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [k, v] of rows) {
    console.log(
      `${k}\t${v.sessions.size}\t${fmt(v.total)}\t${fmt(v.input)}\t${fmt(v.output)}\t${fmt(v.cacheRead)}\t${fmt(v.cacheCreate)}`,
    );
  }
}

console.log(`Token usage report (UTC day ${targetDate})`);
printSection('By project', projectAgg);
printSection('By actor', actorAgg);
printSection('By model', modelAgg);
