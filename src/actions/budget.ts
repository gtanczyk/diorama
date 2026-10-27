// Budget: what the models were asked for real (memo hits are free), across every world, and what that
// cost when prices are known. Prices and the limit live in ~/.config/diorama/budget.json; they are not
// secrets, only numbers from the Meta and ElevenLabs billing pages.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ModelName } from '../meta/memo.ts';
import { configDir } from '../secrets.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';

const MODELS = ['spark', 'muse', 'sam', 'sound', 'music', 'voice', 'space'] as const satisfies readonly ModelName[];

export const BudgetConfig = z.object({
  /** US dollars per call sent, per model. A model without a price is counted, not priced. */
  prices: z.record(z.enum(MODELS), z.number().min(0)).default({}),
  /** Dollars the Studio warns at; the hackathon gives $150 of Meta credits. */
  limitUsd: z.number().min(0).optional(),
  /** A build that leaves places unplayable wakes the Studio agent to repair them. */
  autoRepair: z.boolean().default(true),
});
type BudgetConfig = z.infer<typeof BudgetConfig>;

const file = () => path.join(configDir(), 'budget.json');

export function readBudget(): BudgetConfig {
  try {
    return BudgetConfig.parse(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return BudgetConfig.parse({});
  }
}

type Tally = Partial<Record<ModelName, number>>;

/** Calls sent per model in one world, all time and since `since` (an ISO time). */
function tally(dir: string, since: string): { all: Tally; recent: Tally } {
  const all: Tally = {};
  const recent: Tally = {};
  const log = path.join(dir, 'memo', 'calls.jsonl');
  if (!fs.existsSync(log)) return { all, recent };
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const c = JSON.parse(line) as { at: string; model: ModelName; hit: boolean };
      if (c.hit) continue;
      all[c.model] = (all[c.model] ?? 0) + 1;
      if (c.at >= since) recent[c.model] = (recent[c.model] ?? 0) + 1;
    } catch {}
  }
  return { all, recent };
}

const usd = (t: Tally, prices: BudgetConfig['prices']) => {
  let sum = 0;
  let priced = true;
  for (const [m, n] of Object.entries(t) as [ModelName, number][]) {
    const p = prices[m as (typeof MODELS)[number]];
    if (p === undefined) priced = false;
    else sum += p * n;
  }
  return { usd: Math.round(sum * 100) / 100, priced };
};

const add = (a: Tally, b: Tally) => {
  for (const [m, n] of Object.entries(b) as [ModelName, number][]) a[m] = (a[m] ?? 0) + n;
};

defineAction({
  name: 'budget',
  reads: true,
  description: 'Model calls actually sent (memo hits cost nothing) per model, today and in total, across every world or for one, '
    + 'and their cost in dollars where prices are set; plus the limit to warn at.',
  input: z.object({ slug: Slug.optional() }),
  async run({ slug }, ctx) {
    const config = readBudget();
    const today = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    const slugs = slug ? [slug] : fs.existsSync(ctx.root) ? fs.readdirSync(ctx.root, { withFileTypes: true }).filter((d) => d.isDirectory() && Slug.safeParse(d.name).success).map((d) => d.name) : [];
    const total: Tally = {};
    const day: Tally = {};
    const worlds = slugs.map((s) => {
      const t = tally(path.join(ctx.root, s), today);
      add(total, t.all);
      add(day, t.recent);
      return { slug: s, calls: t.all, ...usd(t.all, config.prices) };
    }).filter((w) => Object.keys(w.calls).length > 0).sort((a, b) => b.usd - a.usd);
    const spent = usd(total, config.prices);
    return {
      total: { calls: total, ...spent },
      today: { calls: day, ...usd(day, config.prices) },
      worlds,
      prices: config.prices,
      limitUsd: config.limitUsd ?? null,
      autoRepair: config.autoRepair,
      over: config.limitUsd !== undefined && spent.usd >= config.limitUsd,
      file: file(),
    };
  },
});

defineAction({
  name: 'budget_set',
  description: 'Set the dollars per call of a model (from its billing page), the dollar limit the Studio warns at, and whether a build that '
    + 'leaves places unplayable wakes the agent to repair them (autoRepair, on by default).',
  input: z.object({
    prices: z.record(z.enum(MODELS), z.number().min(0)).optional(),
    limitUsd: z.number().min(0).optional(),
    autoRepair: z.boolean().optional(),
  }),
  async run({ prices, limitUsd, autoRepair }) {
    const was = readBudget();
    const next = BudgetConfig.parse({ prices: { ...was.prices, ...prices }, limitUsd: limitUsd ?? was.limitUsd, autoRepair: autoRepair ?? was.autoRepair });
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  },
});
