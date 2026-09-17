import { Fragment, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { TRUST_DOCUMENT_EFFECTIVE_DATE, TRUST_DOCUMENT_EFFECTIVE_ISO_DATE, TRUST_DOCUMENT_VERSION } from '~/lib/trust';
import { TrustLinks } from './TrustLinks';

export function TrustPage({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <div className="trust-page min-h-svh">
      <header className="trust-page__header">
        <BrandLink />
        <TrustLinks />
      </header>
      <div className="trust-page__layout">
        <article className="trust-page__article">
          {/* Version and date as one line above the title, not a column beside it. As a rail they
              were 205px wide and 74px tall on a page over a thousand pixels long, so the column was
              empty for the whole document and the article was narrowed to make room for the gap. */}
          <p className="trust-page__meta">
            <span>{TRUST_DOCUMENT_VERSION}</span>
            <span aria-hidden="true">·</span>
            <span>
              Effective <time dateTime={TRUST_DOCUMENT_EFFECTIVE_ISO_DATE}>{TRUST_DOCUMENT_EFFECTIVE_DATE}</time>
            </span>
          </p>
          <h1>{title}</h1>
          <p className="trust-page__summary">{summary}</p>
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
