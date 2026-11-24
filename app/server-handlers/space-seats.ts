import { billingConfig, setSubscriptionSeats, StripeError } from '~/lib/.server/billing/stripe';
import { countSpaceSeats, givesSpace } from '~/lib/cloudflare/data/managed-subscriptions.server';

/**
 * Makes a space's subscription pay for everyone in it now: counted again after someone joins or leaves, and
 * whenever Stripe reports on the subscription, so a count Stripe could not be told is put right the next time.
 * A team that is not a space CloudChef runs has no subscription, and nothing happens. Returns the people counted.
 */
export async function syncSpaceSeats(env: Env, orgId: string): Promise<number | null> {
  const counted = await countSpaceSeats(env.DB, orgId);
  const config = billingConfig(env);
  if (!counted) {
    return null;
  }
  if (counted.subscriptionId && config && givesSpace(counted.status)) {
    try {
      await setSubscriptionSeats(config, counted.subscriptionId, counted.seats);
    } catch (error) {
      if (!(error instanceof StripeError)) {
        throw error;
      }
      console.error({ event: 'space_seats_not_synced', seats: counted.seats });
    }
  }
  return counted.seats;
}
