// Deterministic brief reader — the no-model path. Keeps the shop working when the LLM is down or unset:
// "my 5-year-old Mia loves planes, we fly out of LAX" → { child: 'Mia', airports: [KLAX] }.
import { findAirports } from './catalog.mjs';
import { NAME_RE } from './proof.mjs';

const STOP = new Set(`I My We Our Me Us He She They His Her Their Hi Hello Hey Please Thanks Thank The A An And Or But
For From Of Out To In At On With Who Is Are Was Loves Love Likes Planes Plane Airport Airports Fly Flies Flying Book Maze Mazes
Yes No Ok Okay Sure Gift Birthday Christmas Son Daughter Kid Kids Child Grandson Granddaughter Nephew Niece Boy Girl Year Old`
  .split(/\s+/));

export function readBrief(text) {
  const t = String(text || '');
  const airports = findAirports(t);
  let child = null;
  const cues = [
    /\b(?:named|called|name is|name's)\s+(\p{Lu}[\p{L}'-]{1,19})/u,
    /\b(?:for|son|daughter|grandson|granddaughter|nephew|niece|kid|boy|girl)\s+(\p{Lu}[\p{L}'-]{1,19})/u,
    /(\p{Lu}[\p{L}'-]{1,19})\s+(?:loves|likes|is \d|turns)/u,
  ];
  for (const re of cues) {
    const m = t.match(re);
    if (m && !STOP.has(m[1]) && NAME_RE.test(m[1])) { child = m[1]; break; }
  }
  if (!child) {
    const caps = [...t.matchAll(/\b(\p{Lu}[\p{Ll}'-]{1,19})\b/gu)].map((m) => m[1])
      .filter((w) => !STOP.has(w) && !airports.some((a) => a.city.includes(w) || a.name.includes(w)));
    if (caps.length === 1) child = caps[0];
  }
  return { child, airports };
}
