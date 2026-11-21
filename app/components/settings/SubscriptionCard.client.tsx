import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { messageOf } from '~/lib/json-request';
import { usd, type BillingStatus } from '~/lib/managed-space';
import { openBillingPortal, readBillingStatus } from '~/lib/managed-space-requests';
import { errorFeedback, FeedbackLine } from './Feedback';
import { SettingsCard, StatusBadge } from './SettingsLayout';

function day(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * A person's subscription to a space CloudChef runs: where it stands, what the space has used of this
 * month's building allowance, and the way to Stripe's page for the card, invoices and cancelling. Shown only
 * to someone who has subscribed.
 */
export function SubscriptionCard() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [opening, setOpening] = useState(false);
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
  const trialing = subscription.status === 'trialing';
  const ends = subscription.currentPeriodEndsAt ?? subscription.trialEndsAt;
  return (
    <SettingsCard
      id="subscription"
      title="Your space"
      description="A space CloudChef runs for you. Stripe takes the payment; CloudChef never sees your card."
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
                ? `Free until ${day(subscription.trialEndsAt)}, then ${usd(billing.monthlyPriceUsd)} a month.`
                : ends
                  ? `${usd(billing.monthlyPriceUsd)} a month. Next payment on ${day(ends)}.`
                  : `${usd(billing.monthlyPriceUsd)} a month.`}
        </span>
        {subscription.hasSpace ? (
          <StatusBadge tone="success">{trialing ? 'Free month' : 'Active'}</StatusBadge>
        ) : (
          <StatusBadge tone="warning">Paused</StatusBadge>
        )}
      </div>
      {billing.usage ? (
        <p className="mt-2 text-xs text-content-tertiary">
          Building this month: {usd(Math.min(billing.usage.usedUsd, billing.usage.allowanceUsd))} of{' '}
          {usd(billing.usage.allowanceUsd)} used. It starts again on {day(billing.usage.resetsAt)}.
        </p>
      ) : null}
      <FeedbackLine feedback={errorFeedback(error)} className="mt-3" />
    </SettingsCard>
  );
}
