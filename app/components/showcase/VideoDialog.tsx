import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StopIcon, UploadIcon, VideoIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { messageOf } from '~/lib/json-request';
import { uploadVideo } from '~/lib/showcase-api';
import { VIDEO_LIMITS } from '~/lib/showcase';

/** A video ready to upload, with what the browser read from it. */
type Clip = { blob: Blob; url: string; durationMs: number; width: number; height: number };

/**
 * "Record a video" and "Upload a video" on a post: a short clip of the live site (at most 30 seconds and 25 MB),
 * recorded right here (the site opens in a frame, and the browser records this tab) or chosen from the person's
 * files. A poster frame is taken from it in the browser, and both go up together.
 */
export function VideoDialog({
  postId,
  title,
  siteUrl,
  mode,
  onUploaded,
  onClose,
}: {
  postId: string;
  title: string;
  siteUrl: string;
  mode: 'record' | 'upload';
  onUploaded: () => void;
  onClose: () => void;
}) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [recording, setRecording] = useState(mode === 'record');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => () => (clip ? URL.revokeObjectURL(clip.url) : undefined), [clip]);

  const choose = async (file: File | undefined) => {
    setError(null);
    if (!file) {
      return;
    }
    if (file.size > VIDEO_LIMITS.bytes) {
      setError('Choose a video of up to 25 MB.');
      return;
    }
    if (file.type && file.type !== 'video/mp4' && file.type !== 'video/webm') {
      setError('Choose an MP4 or WebM video.');
      return;
    }
    try {
      const read = await readClip(file);
      if (read.durationMs > VIDEO_LIMITS.seconds * 1000 + 500) {
        URL.revokeObjectURL(read.url);
        setError('Choose a video of up to 30 seconds.');
        return;
      }
      setClip(read);
    } catch {
      setError('That video couldn’t be read. Choose an MP4 or WebM video.');
    }
  };

  const upload = async () => {
    if (!clip) {
      return;
    }
    setError(null);
    setProgress(0);
    try {
      const poster = await posterOf(clip.url).catch(() => null);
      await uploadVideo(
        { postId, video: clip.blob, poster, durationMs: clip.durationMs, width: clip.width, height: clip.height },
        setProgress,
      );
      onUploaded();
    } catch (cause) {
      setError(messageOf(cause, 'The video could not be uploaded. Try again.'));
      setProgress(null);
    }
  };

  if (recording && !clip) {
    return (
      <Recorder
        siteUrl={siteUrl}
        title={title}
        onRecorded={(recorded) => {
          setRecording(false);
          setClip(recorded);
        }}
        onFailed={(message) => {
          setRecording(false);
          setError(message);
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal
      onClose={progress === null ? onClose : undefined}
      title={clip ? 'Your video' : 'Add a video'}
      description={title}
    >
      <div className="grid gap-3 text-sm">
        {clip ? (
          <video
            src={clip.url}
            controls
            playsInline
            className="aspect-video w-full rounded-md bg-black object-contain"
            aria-label={`Your video of ${title}`}
          />
        ) : (
          <div className="grid gap-2 text-content-secondary">
            <p>Show people what it does, in up to 30 seconds (25 MB at most, MP4 or WebM).</p>
            <div className="flex flex-wrap gap-2">
              <label className="cc-button inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md bg-accent-500 px-3 py-2 font-medium">
                <UploadIcon />
                Choose a video
                <input
                  type="file"
                  accept="video/mp4,video/webm"
                  className="sr-only"
                  onChange={(event) => void choose(event.target.files?.[0])}
                />
              </label>
              {canRecord() ? (
                <Button variant="neutral" icon={<VideoIcon />} onClick={() => setRecording(true)}>
                  Record instead
                </Button>
              ) : null}
            </div>
          </div>
        )}
        {progress !== null ? (
          <div className="grid gap-1" role="status">
            <div className="h-1.5 overflow-hidden rounded-full bg-bolt-elements-background-depth-3">
              <div
                className="h-full bg-(--cc-accent) transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <span className="text-xs text-content-tertiary">Uploading… {Math.round(progress * 100)}%</span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-content-error wrap-anywhere">
            {error}
          </p>
        ) : null}
        {clip ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="neutral"
              disabled={progress !== null}
              onClick={() => {
                setClip(null);
                setRecording(mode === 'record');
              }}
            >
              {mode === 'record' ? 'Record again' : 'Choose another'}
            </Button>
            <Button loading={progress !== null} onClick={() => void upload()}>
              Add to post
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** Whether this browser can record its own tab. */
function canRecord(): boolean {
  return 'MediaRecorder' in globalThis && 'getDisplayMedia' in (globalThis.navigator?.mediaDevices ?? {});
}

/** Chrome's own choices for what to record: offer this tab first, and let it be chosen. */
const CHROME_DISPLAY_OPTIONS = { preferCurrentTab: true, selfBrowserSurface: 'include' };

/**
 * Region Capture (Chrome): records just the site's frame, not CloudChef around it. Elsewhere the whole tab is
 * recorded.
 */
async function cropToFrame(track: MediaStreamTrack, element: HTMLIFrameElement): Promise<void> {
  // SAFETY: Region Capture is Chrome's alone and absent from the DOM types; both members are checked before use.
  const regionCapture = globalThis as typeof globalThis & {
    CropTarget?: { fromElement: (element: Element) => Promise<CropTarget> };
  };
  // SAFETY: as above, `cropTo` is checked before it is called.
  const croppable = track as MediaStreamTrack & { cropTo?: (target: CropTarget) => Promise<void> };
  if (!regionCapture.CropTarget || !croppable.cropTo) {
    return;
  }
  const target = await regionCapture.CropTarget.fromElement(element).catch(() => null);
  if (target) {
    await croppable.cropTo(target).catch(() => undefined);
  }
}

/** A region of the page a recording can be cut to; the browser's own value, passed back to it as it is. */
type CropTarget = { readonly __cropTarget: never };

/** The best recording format this browser has: WebM (VP9, then VP8), else MP4 (Safari). */
function recordingType(): string | undefined {
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/**
 * The site in a frame filling the screen, with a small bar to start and stop. The browser asks which tab to record
 * (this one is offered first); where it can, only the frame is recorded, not CloudChef around it. Recording stops
 * by itself at 30 seconds.
 */
function Recorder({
  siteUrl,
  title,
  onRecorded,
  onFailed,
  onClose,
}: {
  siteUrl: string;
  title: string;
  onRecorded: (clip: Clip) => void;
  onFailed: (message: string) => void;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => () => recorder.current?.stream.getTracks().forEach((track) => track.stop()), []);

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
        ...CHROME_DISPLAY_OPTIONS,
      });
    } catch {
      return; // The person chose not to share: they can start again or close.
    }
    const [track] = stream.getVideoTracks();
    if (track && frame.current) {
      await cropToFrame(track, frame.current);
    }
    const type = recordingType();
    const media = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    media.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
    media.onstop = () => {
      stream.getTracks().forEach((each) => each.stop());
      const blob = new Blob(chunks, { type: (media.mimeType || 'video/webm').split(';')[0] });
      if (blob.size > VIDEO_LIMITS.bytes) {
        onFailed('That recording is over 25 MB. Record a shorter one.');
        return;
      }
      const settings = track?.getSettings();
      onRecorded({
        blob,
        url: URL.createObjectURL(blob),
        durationMs: Math.min(Date.now() - startedAt, VIDEO_LIMITS.seconds * 1000),
        width: settings?.width ?? 1280,
        height: settings?.height ?? 720,
      });
    };
    // Sharing stopped from the browser's own bar ends the recording too.
    track?.addEventListener('ended', () => media.state === 'recording' && media.stop());
    recorder.current = media;
    media.start(1000);
    setElapsed(0);
  };

  useEffect(() => {
    if (elapsed === null) {
      return;
    }
    if (elapsed >= VIDEO_LIMITS.seconds) {
      if (recorder.current?.state === 'recording') {
        recorder.current.stop();
      }
      return;
    }
    const timer = window.setTimeout(() => setElapsed((seconds) => (seconds ?? 0) + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [elapsed]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-label={`Recording ${title}`}>
      <iframe
        ref={frame}
        src={siteUrl}
        title={title}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 bg-bolt-elements-background-depth-1 px-4 py-3 text-sm text-content-primary">
        <span className="min-w-0 text-content-secondary">
          {elapsed === null
            ? 'Start, choose this tab, then use the site as you’d show it to a friend. Up to 30 seconds.'
            : `Recording… 0:${String(elapsed).padStart(2, '0')} of 0:30`}
        </span>
        <span className="flex gap-2">
          {elapsed === null ? (
            <>
              <Button variant="neutral" onClick={onClose}>
                Cancel
              </Button>
              <Button icon={<VideoIcon />} onClick={() => void start()}>
                Start recording
              </Button>
            </>
          ) : (
            <Button variant="danger" icon={<StopIcon />} onClick={() => recorder.current?.stop()}>
              Stop
            </Button>
          )}
        </span>
      </div>
    </div>,
    document.body,
  );
}

/** Reads a chosen file's length and size from a video element. */
function readClip(file: File): Promise<Clip> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () =>
      resolve({
        blob: file,
        url,
        durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    video.src = url;
  });
}

/** A poster frame from half a second in, as WebP (JPEG where WebP can't be written). */
function posterOf(url: string): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    };
    video.onseeked = () => {
      const scale = Math.min(1, 1280 / (video.videoWidth || 1280));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((video.videoWidth || 1280) * scale);
      canvas.height = Math.round((video.videoHeight || 720) * scale);
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob?.type === 'image/webp' ? resolve(blob) : canvas.toBlob(resolve, 'image/jpeg', 0.85)),
        'image/webp',
        0.85,
      );
    };
    video.onerror = () => reject(new Error('unreadable'));
    video.src = url;
  });
}
