import { captureOf } from './captureStamp';

// Photo and video upload rules shared by the report form and the evidence uploader.
// The server re-checks everything from the file's bytes; these checks only give early, friendly errors.

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** MP4 and iPhone MOV. Other formats (e.g. WebM) are not accepted by the backend. */
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const ACCEPTED_MEDIA_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
/** Server default (MAX_VIDEO_SECONDS); the server's own limit is what counts. */
export const MAX_VIDEO_SECONDS = 60;

export const isVideoFile = (file: { type: string }) => file.type.startsWith('video/');

/** Why a file can't be uploaded, or undefined if it looks fine. */
export function mediaFileError(file: Blob): string | undefined {
  // Browsers record WebM; the server converts it, but only in-app camera recordings are expected in that format.
  const capturedWebm = file.type === 'video/webm' && captureOf(file) !== undefined;
  if (!ACCEPTED_MEDIA_TYPES.includes(file.type) && !capturedWebm) return 'Choose a JPEG, PNG or WebP photo, or an MP4 or MOV video.';
  if (isVideoFile(file) && file.size > MAX_VIDEO_BYTES) return 'Each video must be 50 MB or smaller.';
  if (!isVideoFile(file) && file.size > MAX_IMAGE_BYTES) return 'Each photo must be 10 MB or smaller.';
  return undefined;
}
