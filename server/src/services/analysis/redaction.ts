// Privacy redaction for evidence images: a shareable copy with all metadata removed (EXIF GPS, device,
// time) and faces / number plates pixelated. The original is kept unchanged for verification.
import sharp from 'sharp';

export interface RedactionRegion {
  kind: 'FACE' | 'LICENSE_PLATE';
  /** Relative box (0-1), origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extra margin around each box, as a fraction of its own size, so edges of faces/plates are covered. */
const MARGIN = 0.15;
/** Pixelation block size relative to the region (bigger = coarser). */
const BLOCKS = 8;

/**
 * Returns the redacted image in the same format. Orientation from EXIF is applied first, so boxes
 * computed by the model on the upright image line up; the output carries no metadata at all.
 */
export async function redactImage(bytes: Uint8Array, contentType: string, regions: RedactionRegion[]): Promise<Buffer> {
  const upright = sharp(bytes, { failOn: 'error' }).rotate();
  const { data, info } = await upright.clone().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  const overlays: sharp.OverlayOptions[] = [];
  for (const r of regions) {
    const mx = r.width * MARGIN;
    const my = r.height * MARGIN;
    const left = Math.max(0, Math.floor((r.x - mx) * W));
    const top = Math.max(0, Math.floor((r.y - my) * H));
    const right = Math.min(W, Math.ceil((r.x + r.width + mx) * W));
    const bottom = Math.min(H, Math.ceil((r.y + r.height + my) * H));
    const w = right - left;
    const h = bottom - top;
    if (w < 2 || h < 2) continue;
    const small = Math.max(1, Math.round(Math.min(w, h) / BLOCKS));
    const patch = await sharp(data, { raw: { width: W, height: H, channels: info.channels } })
      .extract({ left, top, width: w, height: h })
      .resize(Math.max(1, Math.round(w / small)), Math.max(1, Math.round(h / small)), { kernel: 'nearest' })
      .resize(w, h, { kernel: 'nearest' })
      .png()
      .toBuffer();
    overlays.push({ input: patch, left, top });
  }

  // Re-encoding from the raw pixels drops every metadata block (sharp writes none by default).
  let out = sharp(data, { raw: { width: W, height: H, channels: info.channels } }).composite(overlays);
  if (contentType === 'image/png') out = out.png();
  else if (contentType === 'image/webp') out = out.webp({ quality: 85 });
  else out = out.jpeg({ quality: 85, mozjpeg: true });
  return out.toBuffer();
}
