import { HOME_HERO_LEDE } from '~/lib/trust';

export function HomeBrandMark() {
  return <img className="cloudchef-home-mark" src="/cloudchef-logo.svg?v=2" alt="" width={160} height={160} />;
}

export function HomeHeroCopy({ headingId, reveal = false }: { headingId: string; reveal?: boolean }) {
  return (
    <div className={reveal ? 'cloudchef-home-reveal' : undefined}>
      <h1 id={headingId} className="cloudchef-home-title">
        If you can dream it,
        <br />
        <span>CloudChef will build it.</span>
      </h1>
      <p className="cloudchef-home-lede">{HOME_HERO_LEDE}</p>
    </div>
  );
}
