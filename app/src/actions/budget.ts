// Budget: what the models were asked for real (memo hits are free), across every world, and what that
// cost when prices are known. Prices and the limit live in ~/.config/diorama/budget.json; they are not
// secrets, only numbers from the Meta and ElevenLabs billing pages.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ModelName } from '../meta/memo.ts';
import { imageVia } from '../meta/muse.ts';
import { sparkTier, sparkVia } from '../meta/spark.ts';
import { configDir } from '../secrets.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';

const MODELS = ['spark', 'muse', 'sam', 'sound', 'music', 'voice', 'space'] as const satisfies readonly ModelName[];

export const BudgetConfig = z.object({
  /** US dollars per call sent, per model. A model without a price is counted, not priced. */
  prices: z.record(z.enum(MODELS), z.number().min(0)).default({}),
  /** Dollars the Studio warns at; the hackathon gives $150 of Meta credits. */
  limitUsd: z.number().min(0).optional(),
  /** Meta credits left as the billing page showed them at `creditsAt` (an ISO time); spend since then is taken off. */
  creditsUsd: z.number().min(0).optional(),
  creditsAt: z.string().optional(),
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

/**
 * List prices for calls logged before calls carried their own cost (memo/calls.jsonl "usd"). Spark's is the
 * average a standard-tier build call cost (about 5k tokens in, 4k out); newer calls log their real token cost.
 */
const LIST: Partial<Record<ModelName, number>> = { muse: 0.01, sam: 0.0025, spark: 0.03 };

/** Calls sent per model in one world, all time and since `since` (an ISO time), and the Meta dollars they cost. */
function tally(dir: string, since: string, credits?: string) {
  const all: Tally = {};
  const recent: Tally = {};
  const usd = { all: 0, recent: 0, sinceCredits: 0, elsewhereCalls: 0, elsewhereUsd: 0 };
  const log = path.join(dir, 'memo', 'calls.jsonl');
  if (!fs.existsSync(log)) return { all, recent, usd };
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const c = JSON.parse(line) as { at: string; model: ModelName; hit: boolean; usd?: number; via?: string };
      if (c.hit) continue;
      // Answered by another model (Claude, Gemini through OpenRouter): not on Meta's bill, counted apart.
      if (c.via && c.via !== 'contributor') {
        usd.elsewhereCalls++;
        usd.elsewhereUsd += c.usd ?? 0;
        continue;
      }
      all[c.model] = (all[c.model] ?? 0) + 1;
      const cost = c.usd ?? LIST[c.model] ?? 0;
      usd.all += cost;
      if (c.at >= since) (recent[c.model] = (recent[c.model] ?? 0) + 1), (usd.recent += cost);
      if (credits && c.at >= credits) usd.sinceCredits += cost;
    } catch {}
  }
  return { all, recent, usd };
}

/** Meta models are priced from the calls themselves; others (ElevenLabs, Spaces) only when a price is set. */
const cost = (t: Tally, meta: number, prices: BudgetConfig['prices']) => {
  let sum = meta;
  let priced = true;
  for (const [m, n] of Object.entries(t) as [ModelName, number][]) {
    if (m in LIST) continue;
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
    // Calls made before a world had a folder (world_new reading the idea) are in .start/ and count too.
    const slugs = slug ? [slug] : fs.existsSync(ctx.root) ? fs.readdirSync(ctx.root, { withFileTypes: true }).filter((d) => d.isDirectory() && (Slug.safeParse(d.name).success || d.name === '.start')).map((d) => d.name) : [];
    const total: Tally = {};
    const day: Tally = {};
    const meta = { all: 0, recent: 0, sinceCredits: 0, elsewhereCalls: 0, elsewhereUsd: 0 };
    const worlds = slugs.map((s) => {
      const t = tally(path.join(ctx.root, s), today, config.creditsAt);
      add(total, t.all);
      add(day, t.recent);
      for (const k of Object.keys(meta) as (keyof typeof meta)[]) meta[k] += t.usd[k];
      return { slug: s, calls: t.all, ...cost(t.all, t.usd.all, config.prices) };
    }).filter((w) => Object.keys(w.calls).length > 0).sort((a, b) => b.usd - a.usd);
    const spent = cost(total, meta.all, config.prices);
    const creditsLeft = config.creditsUsd === undefined ? null : Math.round((config.creditsUsd - meta.sinceCredits) * 100) / 100;
    return {
      total: { calls: total, ...spent },
      today: { calls: day, ...cost(day, meta.recent, config.prices) },
      worlds,
      prices: config.prices,
      limitUsd: config.limitUsd ?? null,
      // Meta credits left by the last balance typed in, minus what was sent since. Agent turns (Muse Code) are not counted.
      creditsLeft,
      sparkTier: sparkTier(),
      sparkVia: sparkVia(),
      imageVia: imageVia(),
      elsewhere: { calls: meta.elsewhereCalls, usd: Math.round(meta.elsewhereUsd * 100) / 100 },
      autoRepair: config.autoRepair,
      over: (config.limitUsd !== undefined && spent.usd >= config.limitUsd) || (creditsLeft !== null && creditsLeft <= 5),
      file: file(),
    };
  },
});

defineAction({
  name: 'budget_set',
  description: 'Set the dollars per call of a non-Meta model, the dollar limit the Studio warns at, the Meta credits left as the billing page shows them now, and whether a build that '
    + 'leaves places unplayable wakes the agent to repair them (autoRepair, on by default).',
  input: z.object({
    prices: z.record(z.enum(MODELS), z.number().min(0)).optional(),
    limitUsd: z.number().min(0).optional(),
    creditsUsd: z.number().min(0).optional().describe('Meta credits left as the billing page shows them now'),
    autoRepair: z.boolean().optional(),
  }),
  async run({ prices, limitUsd, creditsUsd, autoRepair }) {
    const was = readBudget();
    const credits = creditsUsd === undefined ? { creditsUsd: was.creditsUsd, creditsAt: was.creditsAt } : { creditsUsd, creditsAt: new Date().toISOString() };
    const next = BudgetConfig.parse({ prices: { ...was.prices, ...prices }, limitUsd: limitUsd ?? was.limitUsd, ...credits, autoRepair: autoRepair ?? was.autoRepair });
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  },
});
