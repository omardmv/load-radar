// "Should this truck take this load?": the facts, and the dispatch policy written down.
// The policy is the answer key for the agent's evals (ml/agent) and the same rules the model is told in its prompt.
// What the model adds over this code: reading the broker's free-text comments ("TARPS REQUIRED" vs "NO TARP",
// "-10F FROZEN") and explaining the decision. In production the labels would come from dispatchers' real choices.
import type { Equip } from '../shared/types.ts';

export type AgentLoad = {
  load_id: string; origin: string; origin_market: string; dest: string; equipment: Equip; equipment_detail: string;
  rate: number | null; miles: number; weight_lbs: number; pickup_date: string; comments: string; broker: string; board: string;
};
export type Truck = {
  location: string; lat: number; lon: number; equipment: Equip; has_tarps: boolean; frozen_capable: boolean;
  max_weight_lbs: number; max_deadhead_mi: number; min_rate_per_mile: number | null;
};
export type Facts = { load: AgentLoad; truck: Truck; market_rate_per_mile: number; deadhead_miles: number };
export type Verdict = 'book' | 'negotiate' | 'ask' | 'skip';
export type Decision = { verdict: Verdict; target_rate: number | null; reasons: string[] };

export const needsTarps = (comments: string) => /\b(TARPS REQUIRED|\d+\s*FT TARPS|TARPED|W\/TARPS)\b/i.test(comments) && !/\bNO TARPS?\b/i.test(comments);
export const needsFrozen = (comments: string) => /-\d+\s*F\b|\bFROZEN\b/i.test(comments);
const round25 = (x: number) => Math.round(x / 25) * 25;

export const POLICY_TEXT = `Dispatch policy, apply in order:
1. Skip if the truck can't do it: deadhead (truck to pickup) above the truck's max deadhead; load weight above the truck's max weight; the comments require tarps (e.g. "TARPS REQUIRED", "8FT TARPS"; "NO TARP" means none needed) and the truck has none; the comments say frozen (e.g. "-10F FROZEN") and the truck isn't frozen-capable.
2. Target rate per mile = the higher of the market rate per mile and the truck's minimum rate per mile (if it has one).
3. No rate posted: verdict "ask", target_rate = target rate per mile x load miles.
4. Posted rate per mile (rate / miles) at or above the target: verdict "book", target_rate = the posted rate.
5. Posted rate per mile at least 85% of the target: verdict "negotiate", target_rate = target rate per mile x load miles.
6. Otherwise: verdict "skip" (too far below target).
Round every target_rate to the nearest $25.`;

// The reference answer: what a careful dispatcher following the policy decides.
export function decide(f: Facts): Decision {
  const { load: l, truck: t } = f;
  if (f.deadhead_miles > t.max_deadhead_mi) return { verdict: 'skip', target_rate: null, reasons: [`deadhead ${f.deadhead_miles} mi is above the truck's max ${t.max_deadhead_mi} mi`] };
  if (l.weight_lbs > t.max_weight_lbs) return { verdict: 'skip', target_rate: null, reasons: [`weight ${l.weight_lbs} lbs is above the truck's max ${t.max_weight_lbs} lbs`] };
  if (needsTarps(l.comments) && !t.has_tarps) return { verdict: 'skip', target_rate: null, reasons: ['load needs tarps; truck has none'] };
  if (needsFrozen(l.comments) && !t.frozen_capable) return { verdict: 'skip', target_rate: null, reasons: ['frozen load; truck is not frozen-capable'] };
  const target = Math.max(f.market_rate_per_mile, t.min_rate_per_mile ?? 0);
  if (l.rate === null) return { verdict: 'ask', target_rate: round25(target * l.miles), reasons: ['no rate posted'] };
  const rpm = l.rate / l.miles;
  if (rpm >= target) return { verdict: 'book', target_rate: l.rate, reasons: [`$${rpm.toFixed(2)}/mi is at or above the $${target.toFixed(2)}/mi target`] };
  if (rpm >= 0.85 * target) return { verdict: 'negotiate', target_rate: round25(target * l.miles), reasons: [`$${rpm.toFixed(2)}/mi is below the $${target.toFixed(2)}/mi target`] };
  return { verdict: 'skip', target_rate: null, reasons: [`$${rpm.toFixed(2)}/mi is too far below the $${target.toFixed(2)}/mi target`] };
}
