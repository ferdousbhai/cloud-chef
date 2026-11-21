import { z } from 'zod';
import { getJson, postJson } from '~/lib/json-request';
import { billingStatusSchema, type BillingStatus } from '~/lib/managed-space';

const stripePageSchema = z.object({ url: z.url() });

export function readBillingStatus(): Promise<BillingStatus> {
  return getJson('/api/billing', billingStatusSchema, 'Unable to load your subscription.');
}

/** Leaves for Stripe's checkout, which returns to the builder with the space ready. */
export async function startCheckout(): Promise<void> {
  const { url } = await postJson('/api/billing/checkout', {}, stripePageSchema, 'Unable to start the subscription.');
  window.location.assign(url);
}

/** Leaves for Stripe's own page for the card, invoices and cancelling. */
export async function openBillingPortal(): Promise<void> {
  const { url } = await postJson('/api/billing/portal', {}, stripePageSchema, 'Unable to open your subscription.');
  window.location.assign(url);
}
