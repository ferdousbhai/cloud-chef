import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { messageOf } from '~/lib/json-request';
import {
  MANAGED_SPACE_CREDIT_AMOUNTS_USD,
  MANAGED_SPACE_CREDIT_PRICE_RATIO,
  usd,
  type BillingStatus,
} from '~/lib/managed-space';
import { buyCredit, openBillingPortal, readBillingStatus } from '~/lib/managed-space-requests';
import { errorFeedback, FeedbackLine } from './Feedback';
import { OwnSpacePeople } from './OrganizationsCard.client';
import { SettingsCard, StatusBadge } from './SettingsLayout';

/** Credit left, to the cent below: never shown as more than there is. */
function roundedDown(amountUsd: number): number {
  return Math.floor(amountUsd * 100) / 100;
}

function day(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * A person's subscription to a space CloudChef runs: where it stands, what the space has used of this
 * month's building allowance, credit to buy for more, and the way to Stripe's page for the card, invoices and
 * cancelling. Shown only
 * to someone who has subscribed.
 */
export function SubscriptionCard() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [opening, setOpening] = useState(false);
  // The amount of credit whose checkout is opening; Stripe's page replaces this one.
  const [buying, setBuying] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void readBillingStatus()
      .catch(() => null)
      .then((status) => {
        if (!canceled) {
          setBilling(status);
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  const subscription = billing?.subscription;
  if (!billing || !subscription) {
    return null;
  }
  const manage = async () => {
    setOpening(true);
    setError(null);
    try {
      await openBillingPortal();
    } catch (failure) {
      setError(messageOf(failure, 'Unable to open your subscription.'));
      setOpening(false);
    }
  };
  const addCredit = async (amountUsd: number) => {
    setBuying(amountUsd);
    setError(null);
    try {
      await buyCredit(amountUsd);
    } catch (failure) {
      setError(messageOf(failure, 'Unable to add credit.'));
      setBuying(null);
    }
  };
  const trialing = subscription.status === 'trialing';
  // The plan is priced by the person: the subscriber pays for everyone in their space.
  const people = billing.seats ?? 1;
  const price =
    people > 1
      ? `${usd(billing.monthlyPriceUsd * people)} a month for ${people} people (${usd(billing.monthlyPriceUsd)} each)`
      : `${usd(billing.monthlyPriceUsd)} a month`;
  const ends = subscription.currentPeriodEndsAt ?? subscription.trialEndsAt;
  return (
    <SettingsCard
      id="subscription"
      title="Your space"
      description="Your own space to build in, run by CloudChef. It is yours alone until you invite someone, and paid for by the person: you, and each person who joins. Stripe takes the payment; CloudChef never sees your card."
      action={
        <Button size="sm" variant="neutral" loading={opening} onClick={() => void manage()}>
          Card, invoices, cancel
        </Button>
      }
    >
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-bolt-elements-borderColor px-3 py-2.5">
        <span className="min-w-0 flex-1 text-sm text-content-primary">
          {!subscription.hasSpace
            ? 'Not active. Your space is paused; what you published keeps running.'
            : subscription.cancelsAtPeriodEnd && ends
              ? `Ends on ${day(ends)}.`
              : trialing && subscription.trialEndsAt
                ? `Free until ${day(subscription.trialEndsAt)}, then ${price}.`
                : ends
                  ? `${price}. Next payment on ${day(ends)}.`
                  : `${price}.`}
        </span>
        {subscription.hasSpace ? (
          <StatusBadge tone="success">{trialing ? 'Free month' : 'Active'}</StatusBadge>
        ) : (
          <StatusBadge tone="warning">Paused</StatusBadge>
        )}
      </div>
      {billing.usage ? (
        <>
          <p className="mt-2 text-xs text-content-tertiary">
            Building this month: {usd(Math.min(billing.usage.usedUsd, billing.usage.allowanceUsd))} of{' '}
            {usd(billing.usage.allowanceUsd)} used. It starts again on {day(billing.usage.resetsAt)}.
            {billing.usage.creditUsd > 0 ? ` Credit left: ${usd(roundedDown(billing.usage.creditUsd))}.` : ''}
          </p>
          <div className="mt-4 grid gap-2">
            <h3 className="text-sm font-medium text-content-primary">
              {billing.usage.usedUsd >= billing.usage.allowanceUsd && billing.usage.creditUsd <= 0
                ? 'This month’s building is used up. Add credit to keep building now.'
                : 'Add credit'}
            </h3>
            <p className="text-xs text-content-tertiary">
              One payment, used after the month’s {usd(billing.usage.allowanceUsd)} for everyone building in your space,
              and kept until it is used. Building on credit is charged at {MANAGED_SPACE_CREDIT_PRICE_RATIO} times its
              cost at Cloudflare’s prices: {usd(MANAGED_SPACE_CREDIT_AMOUNTS_USD[0])} of credit buys about{' '}
              {usd(roundedDown(MANAGED_SPACE_CREDIT_AMOUNTS_USD[0] / MANAGED_SPACE_CREDIT_PRICE_RATIO))} of building.
            </p>
            <div className="flex flex-wrap gap-2">
              {MANAGED_SPACE_CREDIT_AMOUNTS_USD.map((amountUsd) => (
                <Button
                  key={amountUsd}
                  size="sm"
                  variant="neutral"
                  loading={buying === amountUsd}
                  disabled={buying !== null}
                  onClick={() => void addCredit(amountUsd)}
                >
                  {usd(amountUsd)}
                </Button>
              ))}
            </div>
          </div>
        </>
      ) : null}
      <FeedbackLine feedback={errorFeedback(error)} className="mt-3" />
      {subscription.hasSpace ? <OwnSpacePeople /> : null}
    </SettingsCard>
  );
}
