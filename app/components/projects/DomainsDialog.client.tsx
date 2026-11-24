import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { TextInput } from '@ui/TextInput';
import { messageOf } from '~/lib/json-request';
import { usd } from '~/lib/managed-space';
import { buyDomain, connectDomain, readProjectDomains, removeDomain, searchDomains } from '~/lib/space-domain-requests';
import { MAX_SPACE_DOMAINS, type DomainOffer, type SpaceDomain, type SpaceDomains } from '~/lib/space-domains';

/** How often a domain still being set up is asked about while the dialog is open. */
const PENDING_REFRESH_MS = 15_000;

/**
 * A project's own domains, in a space CloudChef runs: the ones that serve it and where each stands, a domain to
 * buy here by the year, and a domain bought elsewhere connected by a CNAME record.
 */
export function DomainsDialog({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const [domains, setDomains] = useState<SpaceDomains | null>(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState<'connect' | 'search' | string | null>(null);
  const [wanted, setWanted] = useState('');
  // Names that can be bought, for what was last looked for; null before any search.
  const [offers, setOffers] = useState<DomainOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Counted up to read the domains again: after a change, and while one is still being set up.
  const [reads, setReads] = useState(0);
  const reload = () => setReads((count) => count + 1);

  useEffect(() => {
    let canceled = false;
    void readProjectDomains(project.id).then(
      (read) => {
        if (!canceled) {
          setDomains(read);
        }
      },
      (cause: unknown) => {
        if (!canceled) {
          setError(messageOf(cause, 'Unable to load this project’s domains.'));
        }
      },
    );
    return () => {
      canceled = true;
    };
  }, [project.id, reads]);

  // A domain being set up is ready minutes after its DNS record is added: the dialog finds out on its own.
  const pending = domains?.domains.some((domain) => domain.status === 'pending') ?? false;
  useEffect(() => {
    if (!pending) {
      return undefined;
    }
    const timer = window.setInterval(() => setReads((count) => count + 1), PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [pending]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('connect');
    setError(null);
    try {
      await connectDomain(project.id, hostname);
      setHostname('');
      reload();
    } catch (cause) {
      setError(messageOf(cause, 'Unable to connect the domain.'));
    } finally {
      setBusy(null);
    }
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('search');
    setError(null);
    try {
      setOffers(await searchDomains(project.id, wanted));
    } catch (cause) {
      setError(messageOf(cause, 'Unable to look for domains.'));
    } finally {
      setBusy(null);
    }
  };

  const buy = async (offer: DomainOffer) => {
    setBusy(offer.hostname);
    setError(null);
    try {
      await buyDomain(project.id, offer.hostname);
    } catch (cause) {
      setError(messageOf(cause, 'Unable to buy the domain.'));
      // Stripe's page replaces this one on success.
      setBusy(null);
    }
  };

  const remove = async (domain: SpaceDomain) => {
    setBusy(domain.id);
    setError(null);
    try {
      await removeDomain(domain.id);
      reload();
    } catch (cause) {
      setError(messageOf(cause, 'Unable to remove the domain.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal onClose={onClose} title="Domains" description={project.name}>
      <div className="grid gap-4 text-sm">
        {domains === null && error === null ? (
          <p className="flex items-center gap-2 text-content-secondary" role="status">
            <Spinner /> Loading…
          </p>
        ) : null}
        {domains && !domains.available ? (
          <p className="text-content-secondary">Domains of your own aren’t available for this project yet.</p>
        ) : null}
        {domains?.available ? (
          <>
            {domains.domains.length > 0 ? (
              <ul className="grid divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
                {domains.domains.map((domain) => (
                  <li key={domain.id} className="grid gap-1 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-content-primary"
                        title={domain.hostname}
                      >
                        {domain.hostname}
                      </span>
                      <span className="text-xs text-content-tertiary">
                        {domain.status === 'active' ? 'Live' : domain.status === 'failed' ? 'Not set up' : 'Setting up'}
                      </span>
                      {domain.yearlyPriceUsd !== null ? (
                        <span className="text-xs text-content-tertiary">{usd(domain.yearlyPriceUsd)} a year</span>
                      ) : null}
                      {/* A bought domain that is registered is theirs for the year: it ends by cancelling its subscription. */}
                      {domain.kind === 'connected' || domain.status !== 'active' ? (
                        <Button
                          size="xs"
                          variant="neutral"
                          loading={busy === domain.id}
                          disabled={busy !== null}
                          onClick={() => void remove(domain)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                    {domain.waitingFor ? (
                      <p className="text-xs text-content-secondary wrap-anywhere">{domain.waitingFor}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {domains.buying ? (
              <form className="grid gap-2" onSubmit={(event) => void search(event)}>
                <label className="grid gap-1">
                  <span className="font-medium text-content-primary">Buy a domain</span>
                  <span className="flex gap-2">
                    <TextInput
                      required
                      minLength={2}
                      maxLength={80}
                      placeholder="A name, like sunrisebakery"
                      value={wanted}
                      onChange={(event) => setWanted(event.target.value)}
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="submit"
                      variant="neutral"
                      loading={busy === 'search'}
                      disabled={busy !== null || wanted.trim().length < 2}
                    >
                      Look
                    </Button>
                  </span>
                </label>
                {offers !== null && offers.length === 0 ? (
                  <p className="text-xs text-content-secondary">Nothing like that is free to buy. Try another name.</p>
                ) : null}
                {offers !== null && offers.length > 0 ? (
                  <ul className="grid divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
                    {offers.map((offer) => (
                      <li key={offer.hostname} className="flex min-w-0 items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-content-primary" title={offer.hostname}>
                          {offer.hostname}
                        </span>
                        <span className="text-xs text-content-tertiary">{usd(offer.yearlyPriceUsd)} a year</span>
                        <Button
                          size="xs"
                          loading={busy === offer.hostname}
                          disabled={busy !== null}
                          onClick={() => void buy(offer)}
                        >
                          Buy
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-xs text-content-secondary">
                  Registered in your name, with the name, address and phone you give on Stripe’s page, and renewed each
                  year until you cancel. Your card is charged once the domain is registered, and a registered domain is
                  not refunded.
                </p>
              </form>
            ) : null}
            <form className="grid gap-2" onSubmit={(event) => void connect(event)}>
              <label className="grid gap-1">
                <span className="font-medium text-content-primary">Connect a domain you own</span>
                <TextInput
                  required
                  maxLength={253}
                  placeholder="www.example.com"
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                />
              </label>
              <p className="text-xs text-content-secondary">
                Bought anywhere. After connecting, add one CNAME record where you manage the domain’s DNS, pointing the
                name to <span className="font-medium text-content-primary">{domains.cnameTarget}</span>. A name without
                “www” works only where your DNS provider allows a CNAME at the domain itself. A space can have{' '}
                {MAX_SPACE_DOMAINS} domains.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="neutral" onClick={onClose}>
                  Done
                </Button>
                <Button type="submit" loading={busy === 'connect'} disabled={busy !== null || hostname.trim() === ''}>
                  Connect
                </Button>
              </div>
            </form>
          </>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-bolt-elements-icon-error wrap-anywhere">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
