import { z } from 'zod';

/**
 * The plan for a space CloudChef runs, as the pages say it. The price itself is the Stripe price
 * `STRIPE_PRICE_ID` names, and Stripe is what charges it: these are kept equal to it by hand.
 */
export const MANAGED_SPACE_MONTHLY_PRICE_USD = 30;
/**
 * What a space may use of building in a calendar month, at Cloudflare's prices. Less than the price: the rest pays
 * Stripe's fee and what the allowance does not count (publish builds, published applications, a container already
 * running when the allowance runs out).
 */
export const MANAGED_SPACE_MONTHLY_ALLOWANCE_USD = 20;
/**
 * The amounts of building credit a space's subscriber can buy, in dollars: one payment each, used after a month's
 * allowance and carried over until used. Each has a Stripe price in `STRIPE_CREDIT_PRICE_IDS`.
 */
export const MANAGED_SPACE_CREDIT_AMOUNTS_USD = [20, 50, 100, 200, 300, 500] as const;
/**
 * What building beyond the allowance takes from credit, for each dollar it costs at Cloudflare's prices: the same
 * margin the plan has, whose price is this many times its allowance. It pays Stripe's fee and what the count of
 * building leaves out.
 */
export const MANAGED_SPACE_CREDIT_PRICE_RATIO = MANAGED_SPACE_MONTHLY_PRICE_USD / MANAGED_SPACE_MONTHLY_ALLOWANCE_USD;
/** How a refusal for a used-up allowance starts, which the chat recognises to offer credit. */
export const ALLOWANCE_USED_MESSAGE = "This space has used this month's building allowance";
/**
 * Free days a person's first subscription starts with. None: the card is charged when they subscribe. Above 0,
 * checkout starts a trial of that length and the pages say so.
 */
export const MANAGED_SPACE_TRIAL_DAYS: number = 0;

/** What `GET /api/billing` answers: the plan, whether it can be bought here, and where this person stands. */
export const billingStatusSchema = z.object({
  available: z.boolean(),
  /** For each person in the space, its subscriber included. */
  monthlyPriceUsd: z.number(),
  /** How many people the subscription pays for; null without a space. */
  seats: z.number().nullable(),
  trialDays: z.number(),
  subscription: z
    .object({
      status: z.string(),
      hasSpace: z.boolean(),
      trialEndsAt: z.number().nullable(),
      currentPeriodEndsAt: z.number().nullable(),
      cancelsAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  usage: z
    .object({
      usedUsd: z.number(),
      allowanceUsd: z.number(),
      /** Bought credit not yet used, which building draws on once the month's allowance is used. */
      creditUsd: z.number(),
      resetsAt: z.number(),
    })
    .nullable(),
});

export type BillingStatus = z.infer<typeof billingStatusSchema>;

/** Dollars as the pages write them: whole ones bare, otherwise two decimals. */
export function usd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}
