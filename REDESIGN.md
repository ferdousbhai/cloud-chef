# Redesign audit: CloudChef web app

The audit follows the `redesign-existing-projects` skill, with `landing-page-design` as the reference for
visual values. Its scope is the browser UI in `app/` (Tailwind 3.4, `tailwind.config.ts`, CSS in `app/styles/` and two
CSS modules).

## Standing decisions that override the skill

These choices are deliberate (commit a3af859f, "Retheme the app as a retro terminal", and the comments in
`app/styles/variables.css` and `tailwind.config.ts`). The redesign keeps them until the owner decides otherwise:

- **One monospace face for the whole interface.** The skill wants one proportional face, with mono kept for code.
  The redesign keeps mono everywhere and only swaps the face (see Fix 1).
- **The Tokyo Night palette** (Storm in dark, Day in light). This conflicts with the skill in three places:
  - The dark ground `rgb(26 27 38)` is a tinted navy. The skill allows only `#000000`, `#181818`, `#1F1F1F`,
    `#272727`, `#313131` and `#131209`.
  - There are two accents: orange (`--cc-accent`) and blue (`--cc-content-link`, also aliased as
    `--cloudchef-home-accent-2` and used for rules on the legal pages). The skill allows one.
  - The greys are cool, slate-tinted ones.
- **Italics** in chat markdown emphasis and in highlighted code comments. The skill bans italics outright.

These are open questions for the owner, not defects to fix here.

## Diagnosis

### Typography

- **JetBrains Mono is not an approved face.** Geist Mono is approved, ships through the same fontsource package
  family (OFL), and has the same latin and latin-ext subsets plus a real italic. It drops in without changing the
  layout.
- **Two passages escape the mono face.**
  - The connect footnote under the home prompt ("Workers Paid required. By connecting, you agree to…") is set in
    `system-ui, sans-serif` (`.cloudchef-connect-note` in `home.css`). It is the only sans text on the page and
    reads as a mistake.
  - Chat markdown code uses its own stack (`--font-mono` in `Markdown.module.css`: `ui-monospace, 'Fira Code', …`),
    so code blocks render in a different monospace from the rest of the app.
- **Ultra bold weights.**
  - `font-black` (900) on the brand name in `Header.tsx` and `ClientRouteComponents.tsx`, and on the sidebar
    section headings in `Menu.client.tsx` and `OrgProjectsList.client.tsx`.
  - `font-weight: 800` on the legal page section headings (`trust.css`).
- **Off-scale sizes.** There are 18 arbitrary Tailwind sizes in components: `text-[9px]` ×4, `text-[10px]` ×2,
  `text-[11px]` ×7 and `text-[13px]` ×7. The CSS has a further 20 px and `clamp()` sizes (11, 12, 13, 14, 15, 16, 20
  and fluid 17 to 44px). The chat transcript body is 13px, between `text-xs` and `text-sm`.
- **Off-scale tracking and leading.** `tracking-[0.06em|0.08em|0.12em|0.14em]` and `leading-[1.4]` are arbitrary
  values.
- **Caps labels everywhere.** Uppercase with wide tracking appears on the brand wordmark, sidebar headings ("PROJECTS"),
  the model menu group labels, the model tier badges, the legal page meta line and the status badge.
- **No `text-wrap: balance` or `pretty`** on the hero, page titles or legal prose.
- **Measure.** The legal prose is capped at 70ch. That is close to the target, so the cap stays.

### Color and surfaces

- There are no background gradients. The only gradient is a mask fade on the reasoning preview, which is
  functional and stays.
- Shadows are pure black at low opacity (`--cc-shadow-raised`, `--cc-shadow-panel`), not tinted toward the ground.
  This is a token level fix, but it changes the theme's look, so it is left for the owner.
- Palette conflicts: see the standing decisions above.

### States

- **Focus.** There is a global `:focus-visible` outline in the accent, and the Button primitive adds a ring.
- **Hover and press.** `.cc-button` lifts on hover and drops 1px on press. The header menu button presses too.
  Icon buttons and settings tabs change color only.
- **Errors.** Projects and team projects have inline errors with "Try again". There is no `window.alert` in the UI.
- **Empty states.** These are present ("No projects yet. Describe an app above to start one.").
- **Loading.** "Loading projects…" is a line of text that shifts the layout when the cards arrive. A skeleton shaped
  like the project cards would hold the space. Inline spinners in buttons and tool rows are appropriate and stay.
- **Current page.** The settings tabs and legal page nav mark the current page.

### Motion

- The easing is not the base curve:
  - `.cc-button`, `.cc-icon-button`, the header menu button, `.skip-link` and the settings tabs use `120ms ease`;
  - the chat message entrance uses `220ms ease-out`;
  - the `cubicEasingFn` used by framer-motion, the `bolt-ease-cubic-bezier` utility and the chat slide-out use
    `cubic-bezier(0.4,0,0.2,1)`;
  - Tailwind's default `transition` is 150ms on the same curve and backs about 50 `transition-*` utilities.
- Durations are under the skill's 200ms floor: framer-motion uses 150 and 200ms for expanders, breadcrumbs, the
  sidebar and the workbench.
- Reduced motion is handled globally (`app-shell.css`) and per message (`BaseChat.module.css`).
- The workbench animates `left` and `width` (`transition-[left,width]` in `Workbench.client.tsx`). The fix would be
  a transform-based panel, which is a layout rewrite of the editor shell and out of scope here.

### Layout and code

- `min-h-screen` on the root "Refreshing…" fallback. Other full-height shells already use `svh` or `dvh`.
- `.skip-link` uses `z-index: 9999` while the app has a z-index scale (`z-index.css`, max 999).
- There is a skip-to-content link, a 404, legal links in the footer, and back navigation on the legal pages.
- A raw `rounded-[4px]` on the model badge duplicates the `rounded-sm` token.

### Components and icons

- **Icons are `@radix-ui/react-icons`** (36 files). These are not on the forbidden list (Lucide, Feather,
  Material), but they are not an approved set (Phosphor, Solar, Iconamoon) either. Replacing them means a new
  dependency and edits to every icon call. Deferred.
- **The theme toggle is a sun and moon button.** The skill prefers system detection or a settings entry. That is a
  behaviour change, so it is deferred to the owner.

## Fix plan, in the skill's priority order

1. **Font swap.** JetBrains Mono becomes Geist Mono in one revertible commit. The `@fontsource-variable` package is
   swapped, the latin and latin-ext faces in `fonts.css` and the preload in `__root.tsx` follow, and the license
   notices are regenerated. The connect footnote and markdown code join the single mono token.
2. **Color and surfaces.** Nothing beyond the font token, because the palette is a standing decision.
3. **States.** Icon buttons and settings tabs get a pressed state.
4. **Layout and spacing.** `min-h-screen` becomes `min-h-dvh`, the skip link goes on the z-index scale, and
   `rounded-[4px]` becomes `rounded-sm`.
5. **Motion.** One base curve, `cubic-bezier(0.22,1,0.36,1)`, everywhere:
   - Tailwind's default transition becomes the base curve at 300ms;
   - `cubicEasingFn` and `bolt-ease-cubic-bezier` move to the base curve;
   - CSS color and opacity transitions go to 300ms and movement to 300 or 500ms;
   - framer-motion durations are raised to the 300ms floor for opacity and collapse, and to 500ms for panel slides.
6. **Components.** The `font-black` and `font-weight: 800` headings are capped at bold.
7. **States.** The "Loading projects…" line becomes a skeleton of project cards, keeping the status text for
   screen readers.
8. **Copy.** No changes. The product copy is specific and calm, and the legal and security text is not marketing
   copy.
9. **Type scale.**
   - Arbitrary Tailwind sizes snap down to the nearest step: 9, 10 and 11px to `text-xs`, and 13px to `text-xs`.
     Where 13px is the chat transcript body, it moves up to `text-sm` instead, because snapping down would make the
     main reading text smaller. That is a deliberate exception, noted here.
   - CSS px and `clamp()` sizes snap to scale steps.
   - Arbitrary tracking moves to Tailwind's named tracking, and `text-balance` and `text-pretty` go on headings and
     prose.

## Deferred, for the owner to decide

- The Tokyo Night palette, the second (blue) accent, and the cool greys.
- Italics in chat emphasis and code comments.
- Black-based shadows rather than ones tinted toward the ground.
- Replacing Radix icons with Phosphor (36 files and a new dependency).
- The sun and moon theme toggle, against system detection or a settings entry.
- The workbench's `left` and `width` animation, against a transform-based panel.
- Uppercase caps labels. They were left in place because they are part of the terminal look. The skill would move
  them to sentence case.
- Skeletons for the chat and workbench restore paths (`Loading.tsx`, `WorkspacePreparing.tsx`).
