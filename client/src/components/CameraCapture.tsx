import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { tagCapture, type CaptureStamp } from '../lib/captureStamp';
import { MAX_VIDEO_BYTES } from '../lib/media';
import { Button } from './Button';

/** Containers the browser may record in; the server converts WebM to MP4. Best first. */
const RECORDING_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
/** A native-camera file must have been created this recently to count as "just taken". */
const FRESH_FILE_MS = 3 * 60_000;
/** ~2.5 Mbit/s keeps a 60 s clip well under the 50 MB limit. */
const VIDEO_BITS_PER_SECOND = 2_500_000;

type Fix = { lat: number; lng: number; accuracy: number };

interface Props {
  /** Photos only, or photos and videos. */
  allowVideo?: boolean;
  maxVideoSeconds: number;
  onCapture: (file: File) => void;
  onClose: () => void;
}

/**
 * Takes a photo or records a video with the device camera inside the app (no gallery). Each capture is
 * stamped with the server's camera-session token and the time + GPS at that moment.
 */
export function CameraCapture({ allowVideo = true, maxVideoSeconds, onCapture, onClose }: Props) {
  const titleId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fixRef = useRef<Fix | null>(null);
  const tokenRef = useRef<string | null>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<'starting' | 'live' | 'native' | 'error'>('starting');
  const [message, setMessage] = useState<string | null>(null);
  const [gps, setGps] = useState<'waiting' | 'ok' | 'off'>('waiting');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Session token, GPS and camera stream for as long as the dialog is open.
  useEffect(() => {
    let cancelled = false;
    let watchId: number | null = null;

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          fixRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
          setGps('ok');
          setAccuracy(Math.round(pos.coords.accuracy));
        },
        () => setGps('off'),
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
      );
    } else {
      setGps('off');
    }

    (async () => {
      try {
        tokenRef.current = (await api.startCaptureSession()).token;
      } catch {
        if (!cancelled) {
          setState('error');
          setMessage('The camera could not be prepared. Check your connection and try again.');
        }
        return;
      }
      const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
      if (!media?.getUserMedia) {
        // Insecure page (plain http) or old browser: use the phone's own camera app instead.
        if (!cancelled) setState('native');
        return;
      }
      try {
        const video = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
        let stream: MediaStream;
        try {
          stream = await media.getUserMedia({ video, audio: allowVideo });
        } catch (err) {
          // Microphone refused or missing: retry with the camera only (photos and silent videos).
          if (!allowVideo) throw err;
          stream = await media.getUserMedia({ video, audio: false });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setState('live');
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException)?.name;
        setState(name === 'NotAllowedError' || name === 'NotFoundError' ? 'error' : 'native');
        setMessage(
          name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.'
            : name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : null,
        );
      }
    })();

    return () => {
      cancelled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      stopStream();
    };
  }, [allowVideo, stopStream]);

  // Recording timer and automatic stop at the length limit.
  useEffect(() => {
    if (recordingSince === null) return;
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - recordingSince) / 1000);
      setElapsed(seconds);
      if (seconds >= maxVideoSeconds) recorderRef.current?.stop();
    }, 250);
    return () => window.clearInterval(timer);
  }, [recordingSince, maxVideoSeconds]);

  function stamp(capturedAt: Date): CaptureStamp {
    const fix = fixRef.current;
    return {
      token: tokenRef.current ?? '',
      capturedAt: capturedAt.toISOString(),
      ...(fix && { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }),
    };
  }

  function finish(file: File, capturedAt: Date) {
    tagCapture(file, stamp(capturedAt));
    stopStream();
    onCapture(file);
  }

  function takePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const takenAt = new Date();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setMessage('The photo could not be saved. Please try again.');
          return;
        }
        finish(new File([blob], `photo-${takenAt.getTime()}.jpg`, { type: 'image/jpeg', lastModified: takenAt.getTime() }), takenAt);
      },
      'image/jpeg',
      0.9,
    );
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === 'undefined') {
      setMessage('Video recording is not supported in this browser. Take a photo instead.');
      return;
    }
    const mimeType = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
    const chunks: Blob[] = [];
    const startedAt = new Date();
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = () => {
      setRecordingSince(null);
      const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0]!;
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) return setMessage('Nothing was recorded. Please try again.');
      if (blob.size > MAX_VIDEO_BYTES) return setMessage('The video is too large. Record a shorter clip.');
      const ext = type === 'video/mp4' ? 'mp4' : 'webm';
      finish(new File([blob], `video-${startedAt.getTime()}.${ext}`, { type, lastModified: startedAt.getTime() }), startedAt);
    };
    recorderRef.current = recorder;
    recorder.start(1000);
    setElapsed(0);
    setRecordingSince(startedAt.getTime());
  }

  /** The phone's camera app (capture attribute). Only a file created moments ago is accepted. */
  function nativeCaptured(files: FileList | null) {
    const file = files?.[0];
    if (nativeInputRef.current) nativeInputRef.current.value = '';
    if (!file) return;
    if (Date.now() - file.lastModified > FRESH_FILE_MS) {
      setMessage('That file was not just taken. Use the camera to take a new photo or video.');
      return;
    }
    finish(file, new Date(file.lastModified));
  }

  const recording = recordingSince !== null;
  const remaining = Math.max(0, maxVideoSeconds - elapsed);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between gap-2 p-3">
        <h2 id={titleId} className="text-[1rem] font-semibold">
          Camera
        </h2>
        <p className="text-[0.75rem] text-white/80" aria-live="polite">
          {gps === 'ok' ? `Location on (±${accuracy} m)` : gps === 'waiting' ? 'Finding your location…' : 'Location off: allow location so staff can confirm the place'}
        </p>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <video ref={videoRef} playsInline muted autoPlay className={state === 'live' ? 'max-h-full max-w-full' : 'hidden'} aria-label="Camera preview" />
        {state === 'starting' && <p>Opening the camera…</p>}
        {state === 'native' && (
          <div className="flex max-w-sm flex-col items-center gap-3 p-4 text-center">
            <p>Your browser can't show the camera here. Use your phone's camera instead — the photo or video must be taken now.</p>
            <input
              ref={nativeInputRef}
              type="file"
              accept={allowVideo ? 'image/*,video/*' : 'image/*'}
              capture="environment"
              className="sr-only"
              aria-label="Open the phone camera"
              onChange={(e) => nativeCaptured(e.target.files)}
            />
            <Button onClick={() => nativeInputRef.current?.click()}>Open the phone camera</Button>
          </div>
        )}
        {state === 'error' && <p className="max-w-sm p-4 text-center">{message}</p>}
        {recording && (
          <p className="absolute left-3 top-3 bg-error px-2 py-1 text-[0.875rem]" aria-live="polite">
            ● Recording {elapsed}s · {remaining}s left
          </p>
        )}
      </div>

      {message && state !== 'error' && (
        <p role="alert" className="px-3 pb-2 text-center text-[0.875rem] text-warning">
          {message}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3 p-4">
        {state === 'live' && !recording && <Button onClick={takePhoto}>Take photo</Button>}
        {state === 'live' && allowVideo && !recording && (
          <Button variant="tertiary" onClick={startRecording}>
            Record video
          </Button>
        )}
        {recording && <Button onClick={() => recorderRef.current?.stop()}>Stop recording</Button>}
        <Button variant="ghost" onClick={onClose} disabled={recording}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
