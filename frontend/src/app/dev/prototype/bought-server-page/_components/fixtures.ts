/**
 * The prototype's data: one Organization with three Bought Servers and one
 * still being bought, and the backups of the first. Nothing here is read
 * from a backend; the shapes follow `endpoints/bought-servers.ts`.
 */

export const ORGANIZATION = "Hopper Labs";

export type BoughtRow = {
  id: string;
  name: string;
  stage: "ready" | "changing" | "waiting_for_payment" | "setting_up";
  size: string;
  location: string;
  image: string;
  backups: boolean;
  /** The newest Server backup, ISO 8601; null with none. */
  lastBackup: string | null;
  storageGb: number | null;
  monthlyCents: number;
};

export const BOUGHT: BoughtRow[] = [
  {
    id: "srv_web",
    name: "web-eu-1",
    stage: "ready",
    size: "Standard · 4 vCPU · 8 GB RAM · 160 GB disk",
    location: "Falkenstein, Germany",
    image: "Ubuntu 24.04",
    backups: true,
    lastBackup: "2026-11-28T03:02:00Z",
    storageGb: 100,
    monthlyCents: 3400,
  },
  {
    id: "srv_db",
    name: "db-eu-1",
    stage: "ready",
    size: "Performance · 8 vCPU · 16 GB RAM · 240 GB disk",
    location: "Falkenstein, Germany",
    image: "Debian 12",
    backups: true,
    lastBackup: "2026-11-28T03:05:00Z",
    storageGb: null,
    monthlyCents: 4800,
  },
  {
    id: "srv_us",
    name: "edge-us-1",
    stage: "ready",
    size: "Arm · 2 vCPU · 4 GB RAM · 40 GB disk",
    location: "Ashburn, VA, United States",
    image: "Ubuntu 24.04",
    backups: false,
    lastBackup: null,
    storageGb: null,
    monthlyCents: 700,
  },
  {
    id: "srv_new",
    name: "worker-eu-2",
    stage: "waiting_for_payment",
    size: "Standard · 2 vCPU · 4 GB RAM · 80 GB disk",
    location: "Helsinki, Finland",
    image: "Ubuntu 24.04",
    backups: false,
    lastBackup: null,
    storageGb: null,
    monthlyCents: 900,
  },
];

/** The Server every per-Server variant opens. */
export const SERVER = BOUGHT[0];

/** What it is charged for, line by line, US cents a month. */
export const LINES = [
  { label: "Server", monthlyCents: 1900 },
  { label: "Backups", monthlyCents: 400 },
  { label: "Extra storage, 100 GB", monthlyCents: 1100 },
];

export type BackupRow = {
  id: number;
  takenAt: string;
  sizeGb: number | null;
  beingMade: boolean;
};

/** Newest first, as the API lists them: six daily ones and one taken by hand. */
export const BACKUPS: BackupRow[] = [
  { id: 7, takenAt: "2026-11-28T03:02:00Z", sizeGb: 38.4, beingMade: false },
  { id: 6, takenAt: "2026-11-27T15:41:00Z", sizeGb: 38.1, beingMade: false },
  { id: 5, takenAt: "2026-11-27T03:01:00Z", sizeGb: 37.9, beingMade: false },
  { id: 4, takenAt: "2026-11-26T03:03:00Z", sizeGb: 37.2, beingMade: false },
  { id: 3, takenAt: "2026-11-25T03:00:00Z", sizeGb: 36.8, beingMade: false },
  { id: 2, takenAt: "2026-11-24T03:02:00Z", sizeGb: 36.5, beingMade: false },
];

export function perMonth(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}/month`;
}

/** "Fri 28 Nov, 03:02", in UTC so every screenshot reads the same. */
export function takenOn(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(iso));
}
