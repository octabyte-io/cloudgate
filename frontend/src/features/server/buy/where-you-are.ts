/**
 * Where the customer roughly is, for *Buy a Server*'s distance sort
 * (ADR-0071, #1384's prototype).
 *
 * **Worked out in the browser and never sent.** The default is a guess from
 * the browser's time zone, which asks nothing and reveals nothing; *Show
 * where I am* asks the browser's own location only on a press. A lookup of
 * the IP address on Cloudgate's server was rejected: it would put the
 * customer's position on a server for the sake of a sort. Nothing here is
 * passed to any request, which `buy-screen.test.tsx` holds.
 */

export type Position = { latitude: number; longitude: number };

/** A guess, with the city it is near when the zone names one. */
export type Guess = Position & { near: string | null };

/** Where a time zone puts someone, roughly: `[latitude, longitude, city]`. */
const ZONES: Record<string, [number, number, string]> = {
  "Europe/London": [51.5, -0.1, "London"],
  "Europe/Dublin": [53.3, -6.3, "Dublin"],
  "Europe/Lisbon": [38.7, -9.1, "Lisbon"],
  "Europe/Paris": [48.9, 2.4, "Paris"],
  "Europe/Berlin": [52.5, 13.4, "Berlin"],
  "Europe/Madrid": [40.4, -3.7, "Madrid"],
  "Europe/Rome": [41.9, 12.5, "Rome"],
  "Europe/Amsterdam": [52.4, 4.9, "Amsterdam"],
  "Europe/Stockholm": [59.3, 18.1, "Stockholm"],
  "Europe/Warsaw": [52.2, 21.0, "Warsaw"],
  "Europe/Helsinki": [60.2, 24.9, "Helsinki"],
  "Europe/Istanbul": [41.0, 29.0, "Istanbul"],
  "Europe/Moscow": [55.8, 37.6, "Moscow"],
  "Europe/Kyiv": [50.5, 30.5, "Kyiv"],
  "Africa/Lagos": [6.5, 3.4, "Lagos"],
  "Africa/Cairo": [30.0, 31.2, "Cairo"],
  "Africa/Johannesburg": [-26.2, 28.0, "Johannesburg"],
  "Africa/Nairobi": [-1.3, 36.8, "Nairobi"],
  "Asia/Dubai": [25.2, 55.3, "Dubai"],
  "Asia/Karachi": [24.9, 67.0, "Karachi"],
  "Asia/Kolkata": [22.6, 88.4, "Kolkata"],
  "Asia/Calcutta": [22.6, 88.4, "Kolkata"],
  "Asia/Dhaka": [23.8, 90.4, "Dhaka"],
  "Asia/Bangkok": [13.8, 100.5, "Bangkok"],
  "Asia/Jakarta": [-6.2, 106.8, "Jakarta"],
  "Asia/Singapore": [1.35, 103.8, "Singapore"],
  "Asia/Shanghai": [31.2, 121.5, "Shanghai"],
  "Asia/Hong_Kong": [22.3, 114.2, "Hong Kong"],
  "Asia/Tokyo": [35.7, 139.7, "Tokyo"],
  "Asia/Seoul": [37.6, 127.0, "Seoul"],
  "Asia/Manila": [14.6, 121.0, "Manila"],
  "Australia/Sydney": [-33.9, 151.2, "Sydney"],
  "Australia/Perth": [-31.9, 115.9, "Perth"],
  "Pacific/Auckland": [-36.8, 174.8, "Auckland"],
  "America/New_York": [40.7, -74.0, "New York"],
  "America/Toronto": [43.7, -79.4, "Toronto"],
  "America/Chicago": [41.9, -87.6, "Chicago"],
  "America/Denver": [39.7, -105.0, "Denver"],
  "America/Phoenix": [33.4, -112.1, "Phoenix"],
  "America/Los_Angeles": [34.1, -118.2, "Los Angeles"],
  "America/Vancouver": [49.3, -123.1, "Vancouver"],
  "America/Mexico_City": [19.4, -99.1, "Mexico City"],
  "America/Bogota": [4.7, -74.1, "Bogotá"],
  "America/Lima": [-12.0, -77.0, "Lima"],
  "America/Sao_Paulo": [-23.6, -46.6, "São Paulo"],
  "America/Argentina/Buenos_Aires": [-34.6, -58.4, "Buenos Aires"],
};

/** A zone's region, as a latitude, for a zone the table does not name. */
const REGION_LATITUDE: Record<string, number> = {
  Europe: 50,
  America: 35,
  Asia: 30,
  Africa: 5,
  Australia: -28,
  Pacific: -15,
};

/**
 * Where `timeZone` puts someone: its city when the table names it, or else
 * a latitude from its region and a longitude from the UTC offset
 * (`offsetMinutes` east of UTC, today's by default).
 */
export function guessFromTimeZone(
  timeZone: string,
  offsetMinutes: number = -new Date().getTimezoneOffset(),
): Guess {
  const known = ZONES[timeZone];
  if (known) return { latitude: known[0], longitude: known[1], near: known[2] };
  return {
    latitude: REGION_LATITUDE[timeZone.split("/")[0]] ?? 30,
    longitude: Math.max(-170, Math.min(170, (offsetMinutes / 60) * 15)),
    near: null,
  };
}

/** The browser's own time zone, or London when it will not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
  } catch {
    return "Europe/London";
  }
}

/** Great-circle kilometres between two points. */
export function distanceKm(a: Position, b: Position): number {
  const radius = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

/** A distance as it is said: to 50 km under 500, to 100 km above. */
export function roughKm(km: number): number {
  return km < 500 ? Math.round(km / 50) * 50 : Math.round(km / 100) * 100;
}

/** Locations nearest first from `me`, each with its distance; as given when `me` is unknown. */
export function byDistance<T extends Position>(
  locations: T[],
  me: Position | null,
): Array<{ location: T; km: number | null }> {
  if (!me) return locations.map((location) => ({ location, km: null }));
  return locations
    .map((location) => ({ location, km: distanceKm(me, location) }))
    .sort((a, b) => a.km - b.km);
}
