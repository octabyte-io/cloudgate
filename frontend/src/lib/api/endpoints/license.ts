import { api } from "../client";

/**
 * `enterprise/license/license.controller.ts` — whether this Organization's
 * enterprise features are unlocked, and the two things that decide it.
 *
 * **`GET /license/status` is the route the whole of F18 hangs off**, and it is
 * the only one here any member may call: it takes no permission check beyond an
 * active Organization. It answers the four things the `license_key` row knows
 * it used to answer
 * a bare JSON boolean, so `status.data` is now an object and **every read of it
 * has to go through `licensed`** — an object is always truthy, and a gate that
 * forgot would unlock every licensed section on an unlicensed instance.
 *
 * Everything else in this module is **owner-only** (`assertOwner`, a 403 with
 * "You are not authorized to …"), which is stricter than the rest of the
 * enterprise surface — SSO, SCIM and forward-auth take owner *or* admin. So an
 * admin can see that the Organization is licensed and cannot read or change the
 * key. The screen says that rather than rendering an empty form.
 *
 * ## Two states that look alike and are not
 *
 * `enableEnterpriseFeatures` is an opt-in **separate from the key**, and
 * `activate` refuses until it is on ("Please activate enterprise features to
 * activate license key"). `deactivate` deliberately leaves it on. So the
 * honest state machine has three positions, not two:
 *
 * | opt-in | key | `GET /license/status` |
 * |---|---|---|
 * | off | — | `false` — nothing is unlocked |
 * | on | none | `false` — ready to take a key |
 * | on | active, unexpired | `true` |
 *
 * A fourth position exists and is the one worth naming on screen: **expiry is
 * derived, not stored.** `isValid` compares `validUntil` to now at read time, so
 * a licence lapses with nothing having written to the row. That is why the
 * report carries `status` *and* `licensed` separately rather than collapsing
 * them: a lapsed licence reports `licensed: false` while its stored `status`
 * still reads `active`, and "you have no licence" is a different sentence from
 * "your licence was refused" (`invalid`) and from "it ran out" (`validUntil` in
 * the past). `validUntil` is also what makes a warning possible at all — a
 * banner at 14 days is a comparison, and was impossible while this was a boolean.
 *
 * ## The key comes back in plain text, and that is the route's job
 *
 * `getEnterpriseSettings` returns the stored key so a form can prefill with it.
 * It is owner-only and it is the key that owner pasted in, so this is no
 * leak — but it is still a purchase credential sitting in a query cache, so the
 * screen masks it and offers a reveal rather than printing it.
 */

/** What the stored key's own row says about it, independent of whether it is
 * currently in force. `inactive` means no key has been activated here. */
export type LicenseStatus = "inactive" | "active" | "invalid";

/**
 * `GET /license/status`. `licensed` is the derived answer — the only field that
 * decides whether a section is open. The other three are what the row stores.
 */
export interface LicenseStatusReport {
  licensed: boolean;
  status: LicenseStatus;
  /** ISO-8601, or `null` when no key has been activated. */
  validUntil: string | null;
  /** The named features the key grants; `hasFeature` gates on these. */
  features: string[];
  /**
   * The opt-in, which `status` does not reflect: turning it off leaves the
   * row `active` with its `validUntil`. The renewal bar reads it to stay away
   * once Enterprise features are off.
   */
  enableEnterpriseFeatures: boolean;
}

/** `GET /license/settings`. `licenseKey` is `""` when none is stored. */
export interface EnterpriseSettings {
  enableEnterpriseFeatures: boolean;
  licenseKey: string;
}

export const licenseApi = {
  /**
   * `GET /license/status` — open to every member of the Organization, which is
   * what lets `LicenseGate` wrap sections whose own reads would 403. Read
   * `licensed` for the gate; the rest is for saying *why* on screen.
   */
  status: () => api.get<LicenseStatusReport>("/license/status"),

  /** `GET /license/settings` — owner only. */
  settings: () => api.get<EnterpriseSettings>("/license/settings"),

  /** `PATCH /license/settings` — answers a bare `true`. */
  setEnterpriseFeatures: (enableEnterpriseFeatures: boolean) =>
    api.patch<boolean>("/license/settings", { enableEnterpriseFeatures }),

  /**
   * `POST /license/activate`. Always refused with a 400, which is the right
   * status for every way this fails and is why the message is what gets shown.
   *
   * The message is now one of **three** sentences, not two
   * the licence
   * server's own words when it refused the key, a sentence naming the HTTP
   * status when the server answered something that is not a decision about the
   * key, and `LICENSE_SERVER_UNREACHABLE`'s sentence when the host was never
   * reached. The middle one is the one that used to be missing — an nginx 404
   * on the activation path read as a refused key. `license-api.client.ts`
   * carries the classification and the reason the discriminator is the body
   * rather than the status family.
   */
  activate: (licenseKey: string) =>
    api.post<{ success: true }>("/license/activate", { licenseKey }),

  /**
   * `POST /license/validate` — re-asks the licence server about the stored key
   * and **writes the answer**: a `false` marks the row `invalid`, which means
   * this button can turn a working screen off. The confirmation says so.
   */
  validate: () => api.post<boolean>("/license/validate"),

  /**
   * `POST /license/check-now` — owner only: "I've renewed, check now".
   * Re-runs activate with the stored key and answers with the status that
   * results, so a later `validUntil` arrives without the key being pasted
   * again. Unlike `validate`, a refusal writes nothing: the 400's message is
   * the licence server's, and the licence stays as it was.
   */
  checkNow: () => api.post<LicenseStatusReport>("/license/check-now"),

  /** `POST /license/deactivate` — releases the key and clears it locally. */
  deactivate: () => api.post<{ success: true }>("/license/deactivate"),
};
