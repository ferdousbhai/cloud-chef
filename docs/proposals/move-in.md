# Proposal: move in from Shopify, WordPress or any hosted site

Status: proposal, written 2026-11-11. No product code changes with this document. Nothing here has been built or
tried; the "what CloudChef needs" section was written from the READMEs and handoffs of the sites below, not from a
reading of the agent's code, so check each item against the code before estimating it.

## Positioning

**Leave the rented platform. Keep what works. Own the rest.**

A person with a Shopify theme, a WordPress site or a page-builder site gives CloudChef the address. CloudChef reads
what is public there, rebuilds it as their own web app, and publishes it to their own Cloudflare account. The code is
theirs, the data is theirs, and there are no themes, plugins or app subscriptions between them and a change they want.

For a shop, **Shopify stays as the backend** (owner's decision, 2026-11-11): products, inventory, checkout, payments,
tax and shipping remain Shopify's, read through the Storefront API. What moves is everything a customer sees. The pitch
for a shop is therefore speed, design freedom and no app or theme bloat. It is not "stop paying Shopify", and the page
must not say or imply that.

## What Shopify itself offers, and the gap

The owner's rule (2026-11-11): fill a gap, do not compete with Shopify. From one web search on 2026-11-11, mostly
agency and vendor write-ups rather than Shopify's own pages, so confirm on shopify.dev before the page quotes any of it:

- **Hydrogen and Oxygen.** Shopify's own framework for a custom storefront over the Storefront API, and Shopify's own
  hosting for it. Building a custom storefront on the Storefront API is therefore something Shopify supports and
  encourages. It is a developer product: a merchant hires a developer or an agency to use it.
- **Agent skills for Hydrogen** were reported in a mid-2026 developer preview: coding agents scaffold a storefront. Still
  a developer's workflow, and reported as not production-ready.
- Nothing found that lets a merchant with no developer turn their existing theme into a custom storefront. Sidekick and
  Shopify Magic were not found doing this.

So the gap is the merchant who wants a custom storefront and has no developer. CloudChef builds it with them from the
shop they already have, on Shopify's own supported API, and Shopify keeps the checkout and the subscription. Two honest
differences from Hydrogen on Oxygen to state plainly: the storefront runs in the merchant's own Cloudflare account, not
on Shopify's hosting, and some Shopify features were reported as Oxygen-only (the storefront's own MCP server, for one).
Whether to generate Hydrogen itself, so a merchant can move to Oxygen later, is an open question below.

## Proof we already have

All three are one client's (Sara's), built by the owner and published through CloudChef or Workers Builds. The owner
confirmed on 2026-11-11 that they may be named and shown as case studies.

| Site                 | Was                                   | Now                                                                                                    | State                                                              |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| saraadolfsen.com     | WordPress on Hostinger                | TanStack Start on Workers, content in D1, images in R2, bilingual admin, mail routed through Cloudflare | Cut over 2026-10-04; old WordPress addresses redirect              |
| The Forbidden Feminine | Sanity for content                  | Custom web app: own content store and editor, subscribers, magic-link sign-in, Stripe                  | Live                                                               |
| Bohemian Goddess     | Shopify theme                         | Own storefront on Workers over the Storefront API, no third-party JavaScript                           | On its workers.dev link; the domain moves when Sara approves       |

Bohemian Goddess is the case study the shop pitch needs, and it is the one that is not finished. Before the page goes
up, measure both versions of it the same way: load time, page weight, number of third-party scripts, and the monthly
app fees the new storefront makes unnecessary. Ask Sara for a sentence we may quote.

## What CloudChef needs

### 1. An import step: "paste your site's address"

One entry point on the home page and in a new project. CloudChef fetches what the old site publishes and hands it to
the agent as files in the workspace, so the first build starts from the person's real content.

| Source      | What is public                                                                                              | Notes                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify     | `/products.json`, `/collections.json`, pages, the sitemap                                                   | Checked on bohemiangoddess.com on 2026-11-11: `/products.json` answers with titles, descriptions, images, options, variants and prices. A store can turn this off. Used for the first build and the demo only; the published storefront reads the Storefront API with the owner's token. |
| WordPress   | `/wp-json/wp/v2/posts`, `pages`, `media`, `categories`; the sitemap; an export file the owner can download | The REST API is on by default but some hosts and plugins close it. Fall back to the sitemap and the pages themselves.                    |
| Anything else | The sitemap and the pages                                                                                 | Read each page's text and images; take screenshots for the look. CloudChef already takes screenshots for the showcase.                   |

Rules for the step:

- Fetch only what the address serves to anyone. No passwords, no admin sign-in to the old platform.
- The person states the site is theirs before the import runs. Copying someone else's shop must not be a feature.
- Cap pages, images and bytes per import, and fetch slowly.
- Keep every old address the import saw, for redirects (below).

### 2. A content starter with an editor

Both of Sara's content sites use the same store and admin: documents in D1 with revision history, images in R2, a
schema-driven editor at `/admin`. saraadolfsen.com lifted it from forbidden-feminine. A person leaving WordPress
expects to keep editing their own pages, so an imported content site should start from this.

This conflicts with the handoff's "Not planned now: templates". It needs the owner's decision.

### 3. A shop starter over the Storefront API

The Bohemian Goddess storefront, with the brand taken out: product and collection pages, cart, hand-off to Shopify's
checkout, a strict content security policy, the token as a runtime secret. CloudChef walks the person through creating
the Storefront API token in Shopify's admin, since the import cannot do that for them.

### 4. A cutover checklist the agent follows

What the saraadolfsen.com move needed, as steps the agent proposes and the person approves one at a time:

1. Redirects from every old address to its new one.
2. The domain: nameservers to Cloudflare, or a custom domain on the Worker.
3. Mail: keep the existing mail records working before the nameservers move; Email Routing if they want it.
4. Image transformations on.
5. The old site stays up until the person says the new one is right. Bohemian Goddess is run this way now.

### 5. A page that sells it

`/move`, with `/shopify` and `/wordpress` as versions of it that open on their own case study. Each has the address
box at the top, the measured before and after, and what stays and what moves in one table.

## What stands in the way

- **A Cloudflare account.** A shop owner or a blogger mostly has none, and managed spaces wait on Tenant API access
  (`managed-spaces.md`). Until that ships, this is sold as a service: the owner does the move with CloudChef, in an
  account the client owns. Applying for Tenant API access is the step that unblocks self-serve.
- **One client.** All three proofs are Sara's. A second client, found through the page and done as a service, matters
  more than any of the build items above.
- **The showcase image check** (issue #154) is already required before sign-up is promoted. This promotes sign-up.

## Order

1. Finish and measure Bohemian Goddess.
2. `/move` with the three case studies and a "we'll do it with you" request form. No import step yet.
3. The Shopify import, then the shop starter. It is the best demo: a person sees their own products in a new
   storefront in a minute.
4. The WordPress import and the content starter.
5. Self-serve, when managed spaces open.

## Open questions for the owner

- Templates: allow the two starters, despite the handoff?
- Should the shop starter be Hydrogen, so nothing CloudChef builds is off Shopify's own path?
- Price of the done-with-you service, and whether it is fixed per site.
- The project's stated goal in the handoff is people building one project together. Does this replace that as the
  next thing built, or run beside it?
