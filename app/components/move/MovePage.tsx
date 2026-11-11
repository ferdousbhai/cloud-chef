import { BrandLink } from '~/components/BrandLink';
import { TrustFooter, TrustLinks } from '~/components/trust/TrustLinks';
import type { MovePlatform } from '~/lib/move-requests';
import { MoveRequestForm } from './MoveRequestForm';

/** Which address the page was opened at: `/move`, or `/shopify` and `/wordpress`, which open on their own platform. */
export type MoveVariant = 'move' | 'shopify' | 'wordpress';

const REQUEST_SECTION_ID = 'request-a-move';

/** What each address opens with. The rest of the page is the same on all three. */
const OPENINGS = {
  move: {
    path: '/move',
    eyebrow: 'Move your site',
    title: 'Leave the rented platform. Keep what works. Own the rest.',
    lede: 'CloudChef rebuilds your Shopify shop, WordPress site or other hosted site as your own web app, and publishes it to your own Cloudflare account. Your code and your data, with no themes, plugins or app subscriptions between you and a change you want.',
    platform: 'other',
    cases: ['sara', 'forbidden', 'bohemian'],
  },
  shopify: {
    path: '/shopify',
    eyebrow: 'For a Shopify shop',
    title: 'Keep Shopify behind the counter. Own everything your customers see.',
    lede: 'CloudChef rebuilds your storefront as your own web app and publishes it to your own Cloudflare account. Products, inventory, checkout, payments, tax and shipping stay with Shopify, and you keep your Shopify plan. Your code, with no themes or app subscriptions between you and a change you want.',
    platform: 'shopify',
    cases: ['bohemian', 'sara', 'forbidden'],
  },
  wordpress: {
    path: '/wordpress',
    eyebrow: 'For a WordPress site',
    title: 'Move off WordPress. Keep your content. Own the site.',
    lede: 'CloudChef rebuilds your WordPress site as your own web app and publishes it to your own Cloudflare account. Your content moves into it, with an editor you sign in to. Your code and your data, with no themes or plugins between you and a change you want.',
    platform: 'wordpress',
    cases: ['sara', 'forbidden', 'bohemian'],
  },
} satisfies Record<
  MoveVariant,
  { path: string; eyebrow: string; title: string; lede: string; platform: MovePlatform; cases: readonly CaseId[] }
>;

type CaseId = 'sara' | 'forbidden' | 'bohemian';

/** The three sites already moved or being moved, all one client's and named with her permission. */
const CASES = {
  sara: {
    name: 'saraadolfsen.com',
    address: 'saraadolfsen.com',
    href: 'https://saraadolfsen.com',
    state: 'Moved 4 October 2026',
    was: 'A WordPress site hosted on Hostinger.',
    now: 'Its own web app on Cloudflare: content in a database, images in object storage, an editor in Finnish and English that the owner signs in to, and mail routed through Cloudflare. The old WordPress addresses redirect to the new ones.',
  },
  forbidden: {
    name: 'The Forbidden Feminine',
    address: 'theforbiddenfeminine.com',
    href: 'https://theforbiddenfeminine.com',
    state: 'Moved',
    was: 'A site whose content lived in Sanity, a hosted content service.',
    now: 'A custom web app with its own content store and editor, subscribers, sign-in by emailed link, and payments through Stripe.',
  },
  bohemian: {
    name: 'Bohemian Goddess',
    address: 'bohemiangoddess.com',
    href: 'https://bohemiangoddess.com',
    state: 'In review',
    inReview: true,
    was: 'A Shopify shop on a Shopify theme.',
    now: 'The new storefront is built: its own front end over Shopify’s Storefront API, with no third-party JavaScript. It is in review with the owner, and the address above shows the Shopify theme until she approves the new one.',
  },
} satisfies Record<
  CaseId,
  { name: string; address: string; href: string; state: string; inReview?: boolean; was: string; now: string }
>;

type Row = { what: string; moves: boolean; detail: string };

const SHOPIFY_ROWS: readonly Row[] = [
  { what: 'Products and inventory', moves: false, detail: 'With Shopify, as now.' },
  { what: 'Checkout and payments', moves: false, detail: 'With Shopify.' },
  { what: 'Tax and shipping', moves: false, detail: 'With Shopify.' },
  { what: 'Your Shopify plan', moves: false, detail: 'You keep it. Shopify remains the backend of the shop.' },
  {
    what: 'Everything a customer sees',
    moves: true,
    detail: 'Into your own web app, which reads the shop through Shopify’s Storefront API.',
  },
  { what: 'The code', moves: true, detail: 'Yours, published to your own Cloudflare account.' },
  { what: 'Your current storefront', moves: false, detail: 'Up until you say the new one is right.' },
];

const WORDPRESS_ROWS: readonly Row[] = [
  { what: 'Your content', moves: true, detail: 'Into the new app, in your own Cloudflare account.' },
  { what: 'Editing', moves: true, detail: 'To an editor in the new app that you sign in to.' },
  { what: 'The code and the data', moves: true, detail: 'Yours, published to your own Cloudflare account.' },
  { what: 'Your old site', moves: false, detail: 'Up until you say the new one is right.' },
];

/**
 * The public page that sells moving a site in (`docs/proposals/move-in.md`): what moves and what stays, the three
 * sites done so far, how a move is done today, and the form that asks for one. Every claim on it is one the
 * proposal states as fact; it gives no prices, speeds or dates, and promises no self-serve import.
 */
export function MovePage({ variant }: { variant: MoveVariant }) {
  const opening = OPENINGS[variant];
  return (
    <div className="move-page min-h-svh">
      <header className="trust-page__header">
        <BrandLink />
        <TrustLinks />
      </header>
      <div className="move-page__main">
        <section className="move-page__hero">
          <p className="move-page__eyebrow">{opening.eyebrow}</p>
          <h1>{opening.title}</h1>
          <p className="move-page__lede">{opening.lede}</p>
          <div className="move-page__actions">
            <a className="move-page__cta" href={`#${REQUEST_SECTION_ID}`}>
              Request a move
            </a>
            <a className="move-page__link text-sm" href="#sites-moved">
              See the three sites
            </a>
          </div>
        </section>

        <section aria-labelledby="what-changes">
          <h2 id="what-changes">What changes, and what does not</h2>
          <div className="move-page__grid">
            <div className="move-page__card">
              <h3>For a shop: Shopify stays as the backend</h3>
              <p>
                Products, inventory, checkout, payments, tax and shipping remain with Shopify, and your new storefront
                reads them through Shopify’s Storefront API. <strong>You keep your Shopify plan.</strong> What changes
                is everything a customer sees.
              </p>
              <StaysAndMoves caption="A Shopify shop: what stays and what moves" rows={SHOPIFY_ROWS} />
            </div>
            <div className="move-page__card">
              <h3>For WordPress and other sites: the content moves in</h3>
              <p>
                Your content moves into the new app, with an editor you sign in to. The site is your own web app in your
                own Cloudflare account.
              </p>
              <StaysAndMoves caption="A WordPress site: what stays and what moves" rows={WORDPRESS_ROWS} />
            </div>
          </div>
        </section>

        <section id="sites-moved" aria-labelledby="sites-moved-title">
          <h2 id="sites-moved-title">Three sites, one owner</h2>
          <p className="move-page__intro">
            All three belong to one client, who agreed to have them named here. Two have moved; the third is built and
            waiting for her to approve it.
          </p>
          <div className="move-page__grid">
            {opening.cases.map((id) => (
              <CaseStudy key={id} id={id} />
            ))}
          </div>
        </section>

        <section aria-labelledby="how-it-works">
          <h2 id="how-it-works">How it works today: we do it with you</h2>
          <p className="move-page__intro">
            A move is done by a person, with you. CloudChef does not import a site by itself: you ask, and a person
            answers.
          </p>
          <ol className="move-page__steps">
            <li>
              <h3>You ask</h3>
              <p>Tell us your site’s address and what it runs on, with the form below.</p>
            </li>
            <li>
              <h3>We move it with you</h3>
              <p>
                CloudChef’s maintainer does the move with you, using CloudChef, in a Cloudflare account that you own.
              </p>
            </li>
            <li>
              <h3>You say when it is right</h3>
              <p>Your old site stays up until you say the new one is right.</p>
            </li>
          </ol>
        </section>

        <section id={REQUEST_SECTION_ID} aria-labelledby="request-title">
          <h2 id="request-title">Request a move</h2>
          <p className="move-page__intro">
            Your request goes to CloudChef’s maintainer together with the email address you signed in with. You can
            withdraw it here at any time.
          </p>
          <div className="move-page__request">
            <MoveRequestForm platform={opening.platform} returnTo={`${opening.path}#${REQUEST_SECTION_ID}`} />
          </div>
        </section>

        <p className="move-page__fine">
          CloudChef is not affiliated with, endorsed by or sponsored by Shopify or WordPress. Shopify and WordPress are
          trademarks of their owners.
        </p>
      </div>
      <TrustFooter />
    </div>
  );
}

function StaysAndMoves({ caption, rows }: { caption: string; rows: readonly Row[] }) {
  return (
    <table className="move-page__table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">What</th>
          <th scope="col">
            <span className="sr-only">Stays or moves</span>
          </th>
          <th scope="col">Where</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ what, moves, detail }) => (
          <tr key={what}>
            <th scope="row">{what}</th>
            <td>
              <span className="move-page__pill" data-kind={moves ? 'moves' : 'stays'}>
                {moves ? 'Moves' : 'Stays'}
              </span>
            </td>
            <td>{detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaseStudy({ id }: { id: CaseId }) {
  const site = CASES[id];
  return (
    <article className="move-page__card">
      <div className="move-page__case-head">
        <h3>{site.name}</h3>
        <span className="move-page__pill" data-kind={'inReview' in site ? 'review' : 'moves'}>
          {site.state}
        </span>
      </div>
      <p className="move-page__case-address">
        <a href={site.href} rel="noopener">
          {site.address}
        </a>
      </p>
      <dl className="move-page__facts">
        <div>
          <dt>Was</dt>
          <dd>{site.was}</dd>
        </div>
        <div>
          <dt>Now</dt>
          <dd>{site.now}</dd>
        </div>
      </dl>
    </article>
  );
}
