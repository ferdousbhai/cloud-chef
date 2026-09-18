import { HOME_HEADING } from '~/lib/trust';

export function HomeHeroCopy({ headingId }: { headingId: string }) {
  return (
    <h1 id={headingId} className="cloudchef-home-title">
      {HOME_HEADING}
    </h1>
  );
}
