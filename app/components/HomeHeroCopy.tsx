import { HOME_HERO_LEDE } from '~/lib/trust';

// Block-art mascot for the terminal hero. Leading spaces do the aligning, so
// short rows need no trailing padding.
const GHOST_ASCII = [
  '    ████████',
  '  ████████████',
  ' ██████████████',
  '████████████████',
  '███    ██    ███',
  '███ ██ ██ ██ ███',
  '███ ██ ██ ██ ███',
  '███    ██    ███',
  '████████████████',
  '████████████████',
  '████████████████',
  '██ ████ ████ ███',
  '█  ███   ███  ██',
].join('\n');

/**
 * The mascot is its own element because on a laptop it sits *beside* the copy
 * rather than above it. Stacked, its thirteen rows cost more vertical space than
 * anything else on the page, on the axis a laptop has least of.
 */
export function HomeGhostMark() {
  return (
    <pre className="ghost-home-ascii" aria-hidden="true">
      {GHOST_ASCII}
    </pre>
  );
}

export function HomeHeroCopy({ headingId, reveal = false }: { headingId: string; reveal?: boolean }) {
  return (
    <div className={reveal ? 'ghost-home-reveal' : undefined}>
      <h1 id={headingId} className="ghost-home-title">
        If you can dream it,
        <br />
        <span>CloudChef will build it.</span>
      </h1>
      <p className="ghost-home-lede">{HOME_HERO_LEDE}</p>
    </div>
  );
}
