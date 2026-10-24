// Computer-drawn test scenes for the resolution-verification part of the evaluation. They are clearly
// synthetic (drawn from SVG, with noise added), so the authenticity check is expected to flag them; the
// report therefore also scores verification with the authenticity signal set aside.
import sharp from 'sharp';

export type RoadDefect = 'pothole' | 'patched' | 'none';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Grain like a phone camera at dusk, so the scenes are not perfectly flat colour. */
async function finish(svg: string, seed: number): Promise<Buffer> {
  const W = 640;
  const H = 480;
  const r = rng(seed);
  const noise = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = Math.floor(r() * 255);
    noise[i * 4] = v;
    noise[i * 4 + 1] = v;
    noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 28;
  }
  return sharp(Buffer.from(svg))
    .resize(W, H)
    .composite([{ input: noise, raw: { width: W, height: H, channels: 4 }, blend: 'overlay' }])
    .blur(0.6)
    .jpeg({ quality: 82 })
    .toBuffer();
}

/** A road. Layout A: open fields, centre dashes, pole with crossbar. Layout B: buildings, double yellow line, curve. */
export function road(opts: { defect: RoadDefect; layout: 'A' | 'B'; seed: number; shift?: number }): Promise<Buffer> {
  const s = opts.shift ?? 0;
  const defect =
    opts.defect === 'pothole'
      ? `<ellipse cx="${300 + s}" cy="390" rx="105" ry="45" fill="#8a6d4b"/><ellipse cx="${300 + s}" cy="392" rx="92" ry="37" fill="#1d1b1a"/><ellipse cx="${312 + s}" cy="398" rx="44" ry="14" fill="#5d7488"/>`
      : opts.defect === 'patched'
        ? `<ellipse cx="${300 + s}" cy="392" rx="104" ry="44" fill="#262628"/>`
        : '';
  const scene =
    opts.layout === 'A'
      ? `<rect width="640" height="200" fill="#8cc3ea"/><rect y="200" width="640" height="280" fill="#4a8a3c"/>
         <polygon points="${262 + s},200 ${378 + s},200 640,480 0,480" fill="#4e4e52"/>
         <line x1="${320 + s}" y1="205" x2="${320 + s}" y2="480" stroke="#fff" stroke-width="7" stroke-dasharray="22,18"/>
         <rect x="${520 + s}" y="110" width="11" height="260" fill="#707070"/><rect x="${420 + s}" y="220" width="220" height="16" fill="#cfcfc9"/>
         ${defect}`
      : `<rect width="640" height="230" fill="#b9c7d3"/><rect y="230" width="640" height="250" fill="#8d8a7e"/>
         <rect x="0" y="80" width="150" height="190" fill="#c9a27e"/><rect x="20" y="110" width="40" height="40" fill="#4d5d6b"/><rect x="85" y="110" width="40" height="40" fill="#4d5d6b"/>
         <rect x="500" y="60" width="140" height="210" fill="#d8d0b8"/><rect x="520" y="90" width="35" height="50" fill="#5a4a3a"/><rect x="580" y="90" width="35" height="50" fill="#5a4a3a"/>
         <path d="M 230 230 Q 420 300 640 480 L 0 480 Q 220 330 290 230 Z" fill="#5a5a5e"/>
         <path d="M 262 232 Q 330 330 330 480" stroke="#e8c13a" stroke-width="5" fill="none"/><path d="M 272 232 Q 345 330 348 480" stroke="#e8c13a" stroke-width="5" fill="none"/>
         ${defect}`;
  return finish(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">${scene}</svg>`, opts.seed);
}

/** A footpath by a wall with a municipal bin; with or without a garbage heap. */
export function garbage(opts: { pile: boolean; seed: number; shift?: number }): Promise<Buffer> {
  const s = opts.shift ?? 0;
  const pile = opts.pile
    ? `<ellipse cx="${330 + s}" cy="370" rx="170" ry="70" fill="#6b5a3e"/>
       <rect x="${230 + s}" y="320" width="50" height="40" fill="#2c6fbf" transform="rotate(-15 ${255 + s} 340)"/><rect x="${360 + s}" y="330" width="60" height="38" fill="#d23c3c"/>
       <circle cx="${300 + s}" cy="350" r="22" fill="#e6e6e6"/><circle cx="${410 + s}" cy="372" r="18" fill="#3a3a3a"/><rect x="${270 + s}" y="370" width="70" height="26" fill="#f0c419"/>
       <rect x="${180 + s}" y="365" width="40" height="30" fill="#1f8f4a"/>`
    : '';
  const scene = `<rect width="640" height="480" fill="#d6d2c4"/>
    <rect x="0" y="0" width="640" height="250" fill="#b58a63"/><rect x="0" y="240" width="640" height="14" fill="#8e6a4c"/>
    <rect x="0" y="254" width="640" height="226" fill="#a9a9a2"/>
    <rect x="${520 + s}" y="210" width="80" height="110" fill="#2f7d32"/><rect x="${515 + s}" y="200" width="90" height="14" fill="#245f27"/>
    ${pile}`;
  return finish(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">${scene}</svg>`, opts.seed);
}

/** A street at night with one streetlight, on or off. */
export function streetlight(opts: { lit: boolean; seed: number; shift?: number }): Promise<Buffer> {
  const s = opts.shift ?? 0;
  const glow = opts.lit
    ? `<polygon points="${415 + s},118 ${300 + s},480 ${560 + s},480" fill="#f6d66b" opacity="0.35"/><circle cx="${415 + s}" cy="118" r="20" fill="#fff3b0"/>`
    : `<circle cx="${415 + s}" cy="118" r="14" fill="#3b3b3b"/>`;
  const scene = `<rect width="640" height="480" fill="#0f1726"/>
    <rect y="300" width="640" height="180" fill="#232327"/>
    <rect x="${405 + s}" y="110" width="12" height="260" fill="#555"/><rect x="${360 + s}" y="108" width="60" height="9" fill="#555"/>
    <rect x="40" y="200" width="160" height="110" fill="#1b2433"/><rect x="60" y="225" width="30" height="30" fill="${opts.lit ? '#3a3320' : '#2a3140'}"/>
    ${glow}`;
  return finish(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">${scene}</svg>`, opts.seed);
}

/** A park with a tree and a bench: unrelated to any of the reported problems. */
export function park(seed: number): Promise<Buffer> {
  return finish(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="260" fill="#9fd0f0"/><rect y="260" width="640" height="220" fill="#5c9e45"/>
     <rect x="290" y="150" width="40" height="190" fill="#6b4a2b"/><circle cx="310" cy="130" r="95" fill="#2f7a2f"/>
     <rect x="420" y="330" width="140" height="18" fill="#8b5a2b"/><rect x="430" y="348" width="10" height="35" fill="#555"/><rect x="540" y="348" width="10" height="35" fill="#555"/></svg>`,
    seed,
  );
}

export type ExifMode = 'ok' | 'far' | 'early' | 'none';

export interface PhotoCase {
  id: string;
  category: 'roads' | 'garbage' | 'streetlight';
  /** true = genuine, sufficient proof of the fix. */
  good: boolean;
  note: string;
  before: () => Promise<Buffer>;
  /** 'reuse-before' submits the citizen's own before photo bytes again. */
  after: (() => Promise<Buffer>) | 'reuse-before';
  exif: ExifMode;
}

export const PHOTO_CASES: PhotoCase[] = [
  // genuine fixes (10)
  { id: 'G01', category: 'roads', good: true, note: 'pothole patched', before: () => road({ defect: 'pothole', layout: 'A', seed: 1 }), after: () => road({ defect: 'patched', layout: 'A', seed: 101, shift: 6 }), exif: 'ok' },
  { id: 'G02', category: 'roads', good: true, note: 'pothole patched (re-framed)', before: () => road({ defect: 'pothole', layout: 'A', seed: 2 }), after: () => road({ defect: 'patched', layout: 'A', seed: 102, shift: -10 }), exif: 'ok' },
  { id: 'G03', category: 'roads', good: true, note: 'stretch resurfaced', before: () => road({ defect: 'pothole', layout: 'A', seed: 3 }), after: () => road({ defect: 'none', layout: 'A', seed: 103 }), exif: 'ok' },
  { id: 'G04', category: 'roads', good: true, note: 'pothole patched, town street', before: () => road({ defect: 'pothole', layout: 'B', seed: 4 }), after: () => road({ defect: 'patched', layout: 'B', seed: 104, shift: 5 }), exif: 'ok' },
  { id: 'G05', category: 'garbage', good: true, note: 'heap cleared', before: () => garbage({ pile: true, seed: 5 }), after: () => garbage({ pile: false, seed: 105 }), exif: 'ok' },
  { id: 'G06', category: 'garbage', good: true, note: 'heap cleared (re-framed)', before: () => garbage({ pile: true, seed: 6 }), after: () => garbage({ pile: false, seed: 106, shift: 12 }), exif: 'ok' },
  { id: 'G07', category: 'garbage', good: true, note: 'heap cleared', before: () => garbage({ pile: true, seed: 7, shift: -8 }), after: () => garbage({ pile: false, seed: 107, shift: -4 }), exif: 'ok' },
  { id: 'G08', category: 'streetlight', good: true, note: 'lamp working', before: () => streetlight({ lit: false, seed: 8 }), after: () => streetlight({ lit: true, seed: 108 }), exif: 'ok' },
  { id: 'G09', category: 'streetlight', good: true, note: 'lamp working (re-framed)', before: () => streetlight({ lit: false, seed: 9 }), after: () => streetlight({ lit: true, seed: 109, shift: 10 }), exif: 'ok' },
  { id: 'G10', category: 'streetlight', good: true, note: 'lamp working', before: () => streetlight({ lit: false, seed: 10, shift: -6 }), after: () => streetlight({ lit: true, seed: 110, shift: -2 }), exif: 'ok' },
  // fake or insufficient (15)
  { id: 'F01', category: 'roads', good: false, note: 'not fixed: pothole still there', before: () => road({ defect: 'pothole', layout: 'A', seed: 11 }), after: () => road({ defect: 'pothole', layout: 'A', seed: 111, shift: 8 }), exif: 'ok' },
  { id: 'F02', category: 'roads', good: false, note: 'not fixed: pothole still there', before: () => road({ defect: 'pothole', layout: 'B', seed: 12 }), after: () => road({ defect: 'pothole', layout: 'B', seed: 112, shift: -6 }), exif: 'ok' },
  { id: 'F03', category: 'garbage', good: false, note: 'not cleared', before: () => garbage({ pile: true, seed: 13 }), after: () => garbage({ pile: true, seed: 113, shift: 10 }), exif: 'ok' },
  { id: 'F04', category: 'streetlight', good: false, note: 'lamp still off', before: () => streetlight({ lit: false, seed: 14 }), after: () => streetlight({ lit: false, seed: 114, shift: 6 }), exif: 'ok' },
  { id: 'F05', category: 'roads', good: false, note: 'different place (another road)', before: () => road({ defect: 'pothole', layout: 'A', seed: 15 }), after: () => road({ defect: 'patched', layout: 'B', seed: 115 }), exif: 'ok' },
  { id: 'F06', category: 'roads', good: false, note: 'different place (another road)', before: () => road({ defect: 'pothole', layout: 'B', seed: 16 }), after: () => road({ defect: 'patched', layout: 'A', seed: 116 }), exif: 'ok' },
  { id: 'F07', category: 'roads', good: false, note: 'unrelated photo (clean footpath)', before: () => road({ defect: 'pothole', layout: 'A', seed: 17 }), after: () => garbage({ pile: false, seed: 117 }), exif: 'ok' },
  { id: 'F08', category: 'streetlight', good: false, note: 'unrelated photo (park)', before: () => streetlight({ lit: false, seed: 18 }), after: () => park(118), exif: 'ok' },
  { id: 'F09', category: 'roads', good: false, note: 'citizen’s own before photo re-submitted', before: () => road({ defect: 'patched', layout: 'A', seed: 19 }), after: 'reuse-before', exif: 'ok' },
  { id: 'F10', category: 'garbage', good: false, note: 'citizen’s own before photo re-submitted', before: () => garbage({ pile: false, seed: 20 }), after: 'reuse-before', exif: 'ok' },
  { id: 'F11', category: 'roads', good: false, note: 'taken about 3 km away', before: () => road({ defect: 'pothole', layout: 'A', seed: 21 }), after: () => road({ defect: 'patched', layout: 'A', seed: 121 }), exif: 'far' },
  { id: 'F12', category: 'garbage', good: false, note: 'taken about 3 km away', before: () => garbage({ pile: true, seed: 22 }), after: () => garbage({ pile: false, seed: 122 }), exif: 'far' },
  { id: 'F13', category: 'roads', good: false, note: 'taken 3 days before the work was assigned', before: () => road({ defect: 'pothole', layout: 'B', seed: 23 }), after: () => road({ defect: 'patched', layout: 'B', seed: 123 }), exif: 'early' },
  { id: 'F14', category: 'streetlight', good: false, note: 'taken 4 days before the work was assigned', before: () => streetlight({ lit: false, seed: 24 }), after: () => streetlight({ lit: true, seed: 124 }), exif: 'early' },
  { id: 'F15', category: 'roads', good: false, note: 'no GPS or time in the file (location unconfirmed)', before: () => road({ defect: 'pothole', layout: 'A', seed: 25 }), after: () => road({ defect: 'patched', layout: 'A', seed: 125 }), exif: 'none' },
];
