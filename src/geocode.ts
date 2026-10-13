// UK postcode lookup via postcodes.io (free, no API key, Open Government Licence).
// Used when a customer's postcode is set through the API so the customer can be
// plotted on a map. Seed data carries its own coordinates, so startup never
// needs the network.

export interface Geocoded {
  postcode: string;        // normalised, e.g. "LS1 4AP"
  latitude: number;
  longitude: number;
  area: string | null;     // admin district, e.g. "Leeds", "Westminster"
}

export type GeocodeResult =
  | { ok: true; location: Geocoded }
  | { ok: false; reason: "invalid_postcode" }
  | { ok: false; reason: "unavailable"; message: string };

const BASE = process.env.POSTCODES_API ?? "https://api.postcodes.io";
const TIMEOUT_MS = 4000;

/** Loose shape check before calling out: 5-8 characters, letters and digits, optional space. */
export const looksLikePostcode = (s: string) => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(s.trim());

/** Normalise user input: upper case, single space before the inward code. */
export function normalisePostcode(s: string): string {
  const compact = s.toUpperCase().replace(/\s+/g, "");
  return compact.length > 3 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : compact;
}

export async function geocodePostcode(input: string): Promise<GeocodeResult> {
  if (!looksLikePostcode(input)) return { ok: false, reason: "invalid_postcode" };
  const postcode = normalisePostcode(input);
  try {
    const res = await fetch(`${BASE}/postcodes/${encodeURIComponent(postcode)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { ok: false, reason: "invalid_postcode" };
    if (!res.ok) return { ok: false, reason: "unavailable", message: `postcodes.io responded ${res.status}` };
    const data = (await res.json()) as { result?: { postcode: string; latitude: number | null; longitude: number | null; admin_district: string | null } };
    const r = data.result;
    if (!r || r.latitude === null || r.longitude === null) return { ok: false, reason: "invalid_postcode" };
    return { ok: true, location: { postcode: r.postcode, latitude: r.latitude, longitude: r.longitude, area: r.admin_district } };
  } catch (err) {
    return { ok: false, reason: "unavailable", message: (err as Error).message };
  }
}
