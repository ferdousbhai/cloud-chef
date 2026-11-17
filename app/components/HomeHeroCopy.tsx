import { HOME_HEADING, HOME_PITCH } from '~/lib/trust';

/** `pitch`: one line on what CloudChef is, for someone who isn't signed in. */
export function HomeHeroCopy({ headingId, pitch = false }: { headingId: string; pitch?: boolean }) {
  return (
    <>
      <h1 id={headingId} className="cloudchef-home-title">
        {HOME_HEADING}
      </h1>
      {pitch ? <p className="cloudchef-home-pitch">{HOME_PITCH}</p> : null}
    </>
  );
}
