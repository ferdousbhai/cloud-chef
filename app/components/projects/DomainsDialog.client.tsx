import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { TextInput } from '@ui/TextInput';
import { messageOf } from '~/lib/json-request';
import { connectDomain, readProjectDomains, removeDomain } from '~/lib/space-domain-requests';
import { MAX_SPACE_DOMAINS, type SpaceDomain, type SpaceDomains } from '~/lib/space-domains';

/** How often a domain still being set up is asked about while the dialog is open. */
const PENDING_REFRESH_MS = 15_000;

/**
 * A project's own domains, in a space CloudChef runs: the ones that serve it, a domain bought elsewhere
 * connected by a CNAME record, and where each stands.
 */
export function DomainsDialog({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const [domains, setDomains] = useState<SpaceDomains | null>(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState<'connect' | string | null>(null);
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
                      {domain.kind === 'connected' ? (
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
