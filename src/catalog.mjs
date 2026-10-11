// The shop's catalogue: one product (a personalised airport maze book) × the airports we can draw today.
// Prices live here and only here — the agent picks *what*, never *how much*.
export const PRODUCT = {
  sku: 'taxiway-maze-book',
  title: 'Personalised Airport Maze Book',
  blurb: '2–3 mazes on the real taxiways of your airport (how many depends on its layout; the proof cover shows the count), a colouring page, a pilot certificate with their name, answer keys. Printable PDF (Letter + A4), ages 4–8.',
  price: '9.99',
  currency: 'USD',
};

// icao · iata · airport name · city · extra words people use for it
export const AIRPORTS = [
  ['KLAX', 'LAX', 'Los Angeles International', 'Los Angeles', 'la, l.a., socal'],
  ['KJFK', 'JFK', 'John F. Kennedy International', 'New York', 'nyc, kennedy, queens'],
  ['KSFO', 'SFO', 'San Francisco International', 'San Francisco', 'sf, bay area'],
  ['KORD', 'ORD', "O'Hare International", 'Chicago', 'ohare, o hare'],
  ['KATL', 'ATL', 'Hartsfield–Jackson Atlanta International', 'Atlanta', 'hartsfield'],
  ['KDFW', 'DFW', 'Dallas/Fort Worth International', 'Dallas', 'fort worth, dfw'],
  ['KDEN', 'DEN', 'Denver International', 'Denver', 'colorado'],
  ['KSEA', 'SEA', 'Seattle–Tacoma International', 'Seattle', 'seatac, sea-tac, tacoma'],
  ['KLAS', 'LAS', 'Harry Reid International', 'Las Vegas', 'vegas, mccarran'],
  ['KMCO', 'MCO', 'Orlando International', 'Orlando', 'disney world'],
  ['KBUR', 'BUR', 'Hollywood Burbank', 'Burbank', 'bob hope, hollywood'],
  ['KSNA', 'SNA', 'John Wayne', 'Santa Ana', 'orange county, irvine'],
  ['KSAN', 'SAN', 'San Diego International', 'San Diego', 'lindbergh'],
  ['KAUS', 'AUS', 'Austin–Bergstrom International', 'Austin', 'bergstrom'],
  ['KPDX', 'PDX', 'Portland International', 'Portland', 'oregon'],
  ['KSDL', 'SCF', 'Scottsdale', 'Scottsdale', 'phoenix area'],
  ['EGLL', 'LHR', 'Heathrow', 'London', 'heathrow, uk'],
  ['RKSI', 'ICN', 'Incheon International', 'Seoul', 'incheon, korea'],
].map(([icao, iata, name, city, aka]) => ({ icao, iata, name, city, aka: aka.split(',').map((s) => s.trim()) }));

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

// Ranked matches for free text ("we fly out of LAX", "o'hare", "Chicago"). Codes beat names beat aliases.
export function findAirports(query, limit = 3) {
  const q = norm(query);
  if (!q) return [];
  // codes count only when written as codes ("LAX", or the whole query is "lax") — "san francisco" must not hit SAN
  const raw = String(query).trim();
  const codes = new Set(/^[a-z]{3,4}$/i.test(raw) ? [raw.toUpperCase()] : raw.match(/\b[A-Z]{3,4}\b/g) || []);
  const scored = AIRPORTS.map((a) => {
    let s = 0;
    if (codes.has(a.iata) || codes.has(a.icao)) s = 100;
    else if (q.includes(norm(a.city))) s = 60;
    else if (q.includes(norm(a.name))) s = 55;
    else if (a.aka.some((k) => k && ` ${q} `.includes(` ${norm(k)} `))) s = 40;
    return { a, s };
  }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  return scored.slice(0, limit).map((x) => x.a);
}

export const byIcao = (icao) => AIRPORTS.find((a) => a.icao === String(icao || '').toUpperCase());
export const label = (a) => `${a.city} (${a.iata})`;
