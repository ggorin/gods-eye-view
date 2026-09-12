/**
 * Parse a facing out of the caption NYC DOT encoders burn into the top strip
 * of a frame: "Facing West Sat Sep 12 2026 06:16:41 AM". The text arrives via
 * OCR, so the compass words tolerate the misreads the bitmap font produces
 * ("Wiest", "Nortn", "Eest") while still refusing anything that is not one
 * of the eight compass points.
 *
 * @param {string} text - OCR output for the caption strip.
 * @returns {{facing: string, headingDeg: number}|null}
 */
const COMPASS = [
  ['northeast', 45, /nort[hn]?\s*-?\s*e[ae]st/i],
  ['northwest', 315, /nort[hn]?\s*-?\s*w[iíl]?est/i],
  ['southeast', 135, /sout[hn]?\s*-?\s*e[ae]st/i],
  ['southwest', 225, /sout[hn]?\s*-?\s*w[iíl]?est/i],
  ['north', 0, /nort[hn]?\b/i],
  ['south', 180, /sout[hn]?\b/i],
  ['east', 90, /\be[ae]st\b/i],
  ['west', 270, /\bw[iíl]?est\b/i],
];

export function parseCaptionFacing(text) {
  const raw = String(text || '');
  const m = /facing\s*[:\-]?\s*([A-Za-zíÍ\s-]{4,20})/i.exec(raw);
  if (!m) return null;
  const words = m[1].trim();
  for (const [facing, headingDeg, re] of COMPASS) {
    if (re.test(words)) return { facing, headingDeg };
  }
  return null;
}
