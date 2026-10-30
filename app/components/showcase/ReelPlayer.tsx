import { PauseIcon, PlayIcon, ReloadIcon, SpeakerLoudIcon, SpeakerOffIcon } from '@radix-ui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { reelSeconds, type ReelFraming, type ReelStep, type ReelTimeline } from '~/lib/reel';

/**
 * CloudChef's own player for a post's clip: the timeline's pictures one after another, each with its slow pan or
 * zoom, caption, tap mark and spoken line. It draws only pictures and text from a checked timeline, so nothing of
 * the project runs here. Muted until the person turns the sound on; with reduced motion each picture holds still at
 * its final framing and the tap mark doesn't pulse. Loaded only when a clip is played.
 */
export default function ReelPlayer({
  timeline,
  fileUrl,
  title,
  autoPlay = false,
}: {
  timeline: ReelTimeline;
  /** Where each of the timeline's files is. */
  fileUrl: (ref: string) => string;
  title: string;
  autoPlay?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const total = reelSeconds(timeline);
  const starts = useMemo(() => stepStarts(timeline.steps), [timeline]);
  const hasSound = timeline.steps.some((step) => step.audio);
  const [index, setIndex] = useState(0);
  // A player is made when someone pressed play, so it may start at once.
  const [playing, setPlaying] = useState(autoPlay);
  const [ended, setEnded] = useState(false);
  const [muted, setMuted] = useState(true);
  const elapsed = useRef(0);
  const stills = useRef<(HTMLImageElement | null)[]>([]);
  const taps = useRef<(HTMLSpanElement | null)[]>([]);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const sounds = useRef<(HTMLAudioElement | null)[]>([]);
  const indexRef = useRef(0);

  /** Draws the moment `elapsed` seconds in: each picture's framing, the tap marks, the progress bars. */
  const draw = useCallback(() => {
    const at = elapsed.current;
    const current = stepAt(starts, at);
    timeline.steps.forEach((step, stepIndex) => {
      const local = Math.min(Math.max(at - starts[stepIndex]!, 0), step.seconds);
      const progress = stepIndex < current ? 1 : stepIndex > current ? 0 : local / step.seconds;
      const still = stills.current[stepIndex];
      if (still) {
        still.style.transform = framingTransform(step, reducedMotion ? 1 : ease(progress));
      }
      const tap = taps.current[stepIndex];
      if (tap && step.tap) {
        const since = stepIndex === current ? local - step.tap.at : -1;
        const framing = framingAt(step, reducedMotion ? 1 : ease(progress));
        const point = pointInView(step.tap, framing);
        tap.style.left = `${point.x * 100}%`;
        tap.style.top = `${point.y * 100}%`;
        tap.dataset.shown = String(since >= 0 && since < (reducedMotion ? 1.2 : 0.9));
      }
      const bar = bars.current[stepIndex];
      if (bar) {
        bar.style.transform = `scaleX(${progress})`;
      }
    });
    if (current !== indexRef.current) {
      indexRef.current = current;
      setIndex(current);
    }
  }, [timeline, starts, reducedMotion]);

  useEffect(draw, [draw]);

  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsed.current = Math.min(total, elapsed.current + (now - last) / 1000);
      last = now;
      draw();
      if (elapsed.current >= total) {
        setPlaying(false);
        setEnded(true);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total, draw]);

  // The step's spoken line plays from where the step is, only while playing with the sound on.
  useEffect(() => {
    sounds.current.forEach((sound, stepIndex) => {
      if (!sound) {
        return;
      }
      if (!playing || muted || stepIndex !== index) {
        sound.pause();
        return;
      }
      const local = elapsed.current - starts[stepIndex]!;
      if (Number.isFinite(sound.duration) && local >= sound.duration) {
        return;
      }
      sound.currentTime = Math.max(0, local);
      void sound.play().catch(() => undefined);
    });
  }, [playing, muted, index, starts]);

  const toggle = () => {
    if (ended) {
      elapsed.current = 0;
      setEnded(false);
      draw();
      setPlaying(true);
      return;
    }
    setPlaying(!playing);
  };

  const step = timeline.steps[index]!;
  // With the sound off, a spoken line with no caption of its own is shown as one.
  const caption = step.caption ?? (muted || !hasSound ? step.say : undefined);
  const first = timeline.steps[0]!;
  const ratio = first.width / first.height;
  return (
    <div
      className="relative size-full select-none overflow-hidden bg-[#0c0d12] text-white"
      style={{ containerType: 'size' }}
      role="group"
      aria-roledescription="clip"
      aria-label={`${title}, a short clip`}
    >
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden"
        style={{ aspectRatio: `${ratio}`, width: `min(100cqw, calc(100cqh * ${ratio}))` }}
      >
        {timeline.steps.map((item, stepIndex) => (
          <div
            key={stepIndex}
            className="absolute overflow-hidden transition-opacity duration-300 ease-out motion-reduce:transition-none"
            style={{ ...boxIn(item, ratio), opacity: stepIndex === index ? 1 : 0 }}
            aria-hidden={stepIndex !== index}
          >
            <img
              ref={(element) => {
                stills.current[stepIndex] = element;
              }}
              src={fileUrl(item.still)}
              alt={stepIndex === index ? (item.caption ?? item.say ?? `${title}, moment ${stepIndex + 1}`) : ''}
              width={item.width}
              height={item.height}
              draggable={false}
              decoding="async"
              className="block size-full origin-top-left will-change-transform"
            />
            {item.tap ? (
              <span
                ref={(element) => {
                  taps.current[stepIndex] = element;
                }}
                className="reel-tap pointer-events-none absolute"
                data-shown="false"
                aria-hidden
              />
            ) : null}
            {item.audio ? (
              <audio
                ref={(element) => {
                  sounds.current[stepIndex] = element;
                }}
                src={fileUrl(item.audio)}
                preload="auto"
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-x-2.5 top-2.5 flex gap-1" aria-hidden>
        {timeline.steps.map((item, stepIndex) => (
          <span
            key={stepIndex}
            className="h-[3px] overflow-hidden rounded-full bg-white/30"
            style={{ flexGrow: item.seconds }}
          >
            <span
              ref={(element) => {
                bars.current[stepIndex] = element;
              }}
              className="block h-full origin-left scale-x-0 bg-white"
            />
          </span>
        ))}
      </div>
      {caption ? (
        <p
          className="pointer-events-none absolute inset-x-0 bottom-14 mx-auto w-fit max-w-[88%] rounded-lg bg-black/72 px-3 py-1.5 text-center text-[15px] font-medium leading-snug sm:text-base"
          aria-live={playing ? 'polite' : 'off'}
        >
          {caption}
        </p>
      ) : null}
      {!playing ? (
        <button
          type="button"
          onClick={toggle}
          className="absolute inset-0 flex items-center justify-center bg-black/10 focus-visible:outline-none"
          aria-label={ended ? `Play ${title}’s clip again` : `Play ${title}’s clip`}
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-black/60 shadow-lg ring-1 ring-white/25 backdrop-blur-sm">
            {ended ? <ReloadIcon className="size-6" /> : <PlayIcon className="ml-0.5 size-7" />}
          </span>
        </button>
      ) : null}
      <div className="absolute inset-x-2 bottom-2 flex items-center justify-between">
        <button
          type="button"
          onClick={toggle}
          className="flex size-9 items-center justify-center rounded-full bg-black/55 hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-white"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <PauseIcon className="size-4.5" /> : <PlayIcon className="size-4.5" />}
        </button>
        {hasSound ? (
          <button
            type="button"
            onClick={() => setMuted(!muted)}
            className="flex size-9 items-center justify-center rounded-full bg-black/55 hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-white"
            aria-pressed={!muted}
            aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
          >
            {muted ? <SpeakerOffIcon className="size-4.5" /> : <SpeakerLoudIcon className="size-4.5" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener('change', changed);
      return () => query.removeEventListener('change', changed);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

function stepStarts(steps: readonly ReelStep[]): number[] {
  let at = 0;
  return steps.map((step) => {
    const start = at;
    at += step.seconds;
    return start;
  });
}

function stepAt(starts: readonly number[], at: number): number {
  let current = 0;
  starts.forEach((start, index) => {
    if (at >= start) {
      current = index;
    }
  });
  return current;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const WHOLE: ReelFraming = { x: 0.5, y: 0.5, zoom: 1 };

function framingAt(step: ReelStep, progress: number): ReelFraming {
  if (!step.pan) {
    return WHOLE;
  }
  const { from, to } = step.pan;
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return { x: mix(from.x, to.x), y: mix(from.y, to.y), zoom: mix(from.zoom, to.zoom) };
}

/** The part of the picture in view at a framing: its top-left corner, as fractions, kept inside the picture. */
function viewOrigin(framing: ReelFraming) {
  const span = 1 / framing.zoom;
  const clamp = (centre: number) => Math.min(Math.max(centre - span / 2, 0), 1 - span);
  return { left: clamp(framing.x), top: clamp(framing.y) };
}

function framingTransform(step: ReelStep, progress: number): string {
  const framing = framingAt(step, progress);
  const { left, top } = viewOrigin(framing);
  return `scale(${framing.zoom}) translate(${-left * 100}%, ${-top * 100}%)`;
}

/** Where a point of the picture is in view at a framing, as fractions of the view. */
function pointInView(point: { x: number; y: number }, framing: ReelFraming) {
  const { left, top } = viewOrigin(framing);
  return { x: (point.x - left) * framing.zoom, y: (point.y - top) * framing.zoom };
}

/** A picture of another shape than the first is fitted inside the frame, centred. */
function boxIn(step: ReelStep, frameRatio: number) {
  const ratio = step.width / step.height;
  if (Math.abs(ratio - frameRatio) < 0.01) {
    return { left: '0', top: '0', width: '100%', height: '100%' };
  }
  if (ratio > frameRatio) {
    const height = (frameRatio / ratio) * 100;
    return { left: '0', top: `${(100 - height) / 2}%`, width: '100%', height: `${height}%` };
  }
  const width = (ratio / frameRatio) * 100;
  return { left: `${(100 - width) / 2}%`, top: '0', width: `${width}%`, height: '100%' };
}
