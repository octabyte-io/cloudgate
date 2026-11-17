import type {
  BoughtServerCatalogue,
  CatalogueSize,
  SizeFamily,
  TodayView,
} from "@/lib/api/endpoints/bought-servers";
import type { Project } from "@/lib/api/endpoints/projects";
import type { AskedInput, SetupDomain } from "@/lib/api/endpoints/templates";

/**
 * The prototype's data: a catalogue shaped like the provider's real one
 * (the Standard and Arm lines are sold in Europe only, Singapore and the US
 * sell Performance and Dedicated at a higher price), a customer near
 * Singapore, and flatnotes' setup form. Nothing here is read from a backend.
 */

const LOCATIONS: BoughtServerCatalogue["locations"] = [
  { id: "fsn1", city: "Falkenstein", country: "DE", latitude: 50.47, longitude: 12.37 },
  { id: "nbg1", city: "Nuremberg", country: "DE", latitude: 49.45, longitude: 11.08 },
  { id: "hel1", city: "Helsinki", country: "FI", latitude: 60.17, longitude: 24.94 },
  { id: "ash", city: "Ashburn, VA", country: "US", latitude: 39.04, longitude: -77.49 },
  { id: "hil", city: "Hillsboro, OR", country: "US", latitude: 45.52, longitude: -122.99 },
  { id: "sin", city: "Singapore", country: "SG", latitude: 1.35, longitude: 103.82 },
];

const EUROPE = ["fsn1", "nbg1", "hel1"];
const ELSEWHERE = ["ash", "hil", "sin"];

/** One size, priced the same across `europe` and at `far` elsewhere (null: not sold there). */
function size(
  id: string,
  family: SizeFamily,
  [vcpus, memoryGb, diskGb]: [number, number, number],
  europe: number,
  far: number | null,
  soldOutIn: string[] = [],
): CatalogueSize {
  const offer = (locationId: string, monthly: number) => ({
    locationId,
    monthly,
    backupsMonthly: Math.max(1, Math.round(monthly / 5)),
    available: !soldOutIn.includes(locationId),
  });
  return {
    id,
    family,
    architecture: family === "arm" ? "arm" : "x86",
    vcpus,
    memoryGb,
    diskGb,
    offers: [
      ...EUROPE.map((at) => offer(at, europe)),
      ...(far === null ? [] : ELSEWHERE.map((at) => offer(at, far))),
    ],
  };
}

export const CATALOGUE: BoughtServerCatalogue = {
  locations: LOCATIONS,
  sizes: [
    size("cx23", "shared", [2, 4, 40], 5, null),
    size("cx33", "shared", [4, 8, 80], 8, null),
    size("cx43", "shared", [8, 16, 160], 14, null, ["nbg1"]),
    size("cx53", "shared", [16, 32, 320], 26, null),
    size("cpx22", "amd", [2, 4, 80], 9, 15),
    size("cpx32", "amd", [4, 8, 160], 16, 26),
    size("cpx42", "amd", [8, 16, 320], 30, 48),
    size("cax11", "arm", [2, 4, 40], 5, null),
    size("cax21", "arm", [4, 8, 80], 9, null),
    size("cax31", "arm", [8, 16, 160], 17, null),
    size("ccx13", "dedicated", [2, 8, 80], 18, 25),
    size("ccx23", "dedicated", [4, 16, 160], 36, 50),
  ],
  storage: { minGb: 10, maxGb: 10240, perGbMonthly: 0.06 },
  images: [
    {
      id: "ubuntu-24.04",
      label: "Ubuntu 24.04",
      architectures: ["x86", "arm"],
    },
    { id: "debian-13", label: "Debian 13", architectures: ["x86", "arm"] },
  ],
  defaultImage: "ubuntu-24.04",
};

/** Where the prototype takes the customer to be: Singapore, as on staging. */
export const CUSTOMER = { latitude: 1.29, longitude: 103.85, near: "Singapore" };

/** A Server image: an operating system and version the machine is made from. */
export type ServerImage = { id: string; label: string; detail: string };

/** What the provider offers today that Server setup can finish: Ubuntu and Debian. */
export const IMAGES: ServerImage[] = [
  { id: "ubuntu-24.04", label: "Ubuntu 24.04", detail: "LTS, the default" },
  { id: "ubuntu-22.04", label: "Ubuntu 22.04", detail: "LTS" },
  { id: "debian-13", label: "Debian 13", detail: "Trixie" },
  { id: "debian-12", label: "Debian 12", detail: "Bookworm" },
];
export const DEFAULT_IMAGE = "ubuntu-24.04";

const DAY = 86_400;
const NOW = Math.floor(Date.parse("2026-11-18T09:00:00Z") / 1000);

/** Today's charge in the Free trial, for a Server costing `monthlyUsd` a month. */
export function todayFor(monthlyUsd: number): TodayView {
  const monthly = monthlyUsd * 100;
  return {
    state: "trial",
    today: monthly - 1,
    monthly,
    currency: "usd",
    from: NOW,
    to: NOW + 30 * DAY,
    prorationDate: NOW,
    plan: null,
    addOn: null,
  } as TodayView;
}

export const TEMPLATE = { id: "flatnotes", name: "flatnotes" };

/** flatnotes' one asked value; its password is made for the person. */
export const ASKED: AskedInput[] = [
  {
    name: "FLATNOTES_USERNAME",
    label: "Username",
    description:
      "The name you sign in with. Cloudgate creates a strong password for it, shown afterwards on the app's variables page.",
    default: "admin",
    required: true,
    secret: false,
    format: null,
    pattern: null,
  },
];

export const DOMAINS: SetupDomain[] = [
  { name: "flatnotes", service: "flatnotes", port: 8080, path: "/" },
];

/** The host Cloudgate generates on the bought Server, carrying its address. */
export const GENERATED = {
  flatnotes: "flatnotes-k3x9.5-223-48-10.sslip.io",
};

const project = (projectId: string, name: string, description: string | null): Project => ({
  projectId,
  name,
  description,
  createdAt: "2026-11-01T00:00:00Z",
  organizationId: "org_proto",
  env: "",
});

export const PROJECTS: Project[] = [
  project("p_notes", "Notes", "Personal notes and wikis"),
  project("p_site", "Marketing site", null),
];

/** The bought Server while it is being set up. */
export const BOUGHT = { name: "Singapore 2 vCPU", address: "5.223.48.10" };
