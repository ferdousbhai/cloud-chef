import { Fragment, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import {
  TRUST_DOCUMENT_EFFECTIVE_DATE,
  TRUST_DOCUMENT_EFFECTIVE_ISO_DATE,
  TRUST_DOCUMENT_STATUS,
  TRUST_DOCUMENT_VERSION,
} from '~/lib/trust';
import { TrustLinks } from './TrustLinks';

export function TrustPage({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <div className="trust-page min-h-svh">
      <header className="trust-page__header">
        <BrandLink />
        <TrustLinks />
      </header>
      <div className="trust-page__layout">
        {/* Version and effective date are a labelled pair, not three loose lines. The eyebrow that
            used to sit above the title is gone: it repeated the page's own name from the nav
            directly above it. */}
        <aside className="trust-page__rail" aria-label="Document status">
          <dl>
            <dt>Version</dt>
            <dd>{TRUST_DOCUMENT_VERSION}</dd>
            <dt>Effective</dt>
            <dd>
              <time dateTime={TRUST_DOCUMENT_EFFECTIVE_ISO_DATE}>{TRUST_DOCUMENT_EFFECTIVE_DATE}</time>
            </dd>
          </dl>
        </aside>
        <article className="trust-page__article">
          <h1>{title}</h1>
          <p className="trust-page__summary">{summary}</p>
          {/* Small print rather than a boxed callout: the same sentence appears on all four pages
              and is never what the reader came for. */}
          <p className="trust-page__notice" role="note">
            <strong>Public beta.</strong> {TRUST_DOCUMENT_STATUS}
          </p>
          <div className="trust-page__prose">{children}</div>
        </article>
      </div>
    </div>
  );
}

export function TrustSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Paired facts — a channel and its target, a record and its window — scan as rows, not sentences. */
export function TrustPairs({ items }: { items: readonly { term: string; detail: ReactNode }[] }) {
  return (
    <dl className="trust-page__pairs">
      {items.map(({ term, detail }) => (
        <Fragment key={term}>
          <dt>{term}</dt>
          <dd>{detail}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
