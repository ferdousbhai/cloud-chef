import { z } from 'zod';

/**
 * The plan for a space CloudChef runs, as the pages say it. The price itself is the Stripe price
 * `STRIPE_PRICE_ID` names, and Stripe is what charges it: these are kept equal to it by hand.
 */
export const MANAGED_SPACE_MONTHLY_PRICE_USD = 20;
/** The free first month a person's first subscription starts with. */
export const MANAGED_SPACE_TRIAL_DAYS = 30;

/** What `GET /api/billing` answers: the plan, whether it can be bought here, and where this person stands. */
export const billingStatusSchema = z.object({
  available: z.boolean(),
  monthlyPriceUsd: z.number(),
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
  usage: z.object({ usedUsd: z.number(), allowanceUsd: z.number(), resetsAt: z.number() }).nullable(),
});

export type BillingStatus = z.infer<typeof billingStatusSchema>;

/** Dollars as the pages write them: whole ones bare, otherwise two decimals. */
export function usd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}
