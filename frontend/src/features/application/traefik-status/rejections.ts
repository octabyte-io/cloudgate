import { counted } from "@/lib/format/plural";
import type {
  TraefikConfigRejection,
  TraefikConfigStatus,
  TraefikConfigSubject,
} from "@/lib/api/endpoints/traefik";

/**
 * Turning one Traefik rejection into the rows a person can go and correct.
 *
 * **Why the set and not the culprit.** Traefik's `router.go` builds a router's
 * middleware chain and, when any link fails to construct, drops the whole
 * router — logging *which router* and never which link. The backend carries
 * that honestly (`config/names.ts`: "the honest answer is the set"), so this
 * file's job is to say the set in words an operator recognises and to mark every
 * row in it on the screen that owns it. Narrowing it further here would mean
 * reading Traefik's prose for meaning, which is the one thing H-38 refused to
 * build.
 *
 * Ids are not rendered. `red_abc123` names nothing a person has seen; the rows
 * are marked *in place* on the Domains and Advanced tabs instead, and the
 * sentence gives the count so a reader knows how many marks to look for.
 */

/** Every row of one kind the chain names, without repeats. */
const idsOfKind = (
  rejections: TraefikConfigRejection[],
  pick: (subject: TraefikConfigSubject) => string | null,
): Set<string> => {
  const ids = new Set<string>();
  for (const rejection of rejections) {
    for (const subject of rejection.subjects) {
      const id = pick(subject);
      if (id !== null) ids.add(id);
    }
  }
  return ids;
};

/** The Domains a current rejection darkened, by `domainId`. */
export function rejectedDomainIds(
  status: TraefikConfigStatus | undefined,
): Set<string> {
  return idsOfKind(status?.rejections ?? [], (subject) =>
    subject.kind === "domain" || subject.kind === "forwardAuth"
      ? subject.domainId
      : null,
  );
}

/** The Redirects named by a dropped router's chain, by `redirectId`. */
export function rejectedRedirectIds(
  status: TraefikConfigStatus | undefined,
): Set<string> {
  return idsOfKind(status?.rejections ?? [], (subject) =>
    subject.kind === "redirect" ? subject.redirectId : null,
  );
}

/** The basic-auth users named by a dropped router's chain, by `securityId`. */
export function rejectedSecurityIds(
  status: TraefikConfigStatus | undefined,
): Set<string> {
  return idsOfKind(status?.rejections ?? [], (subject) =>
    subject.kind === "security" ? subject.securityId : null,
  );
}

/**
 * The chain of one rejection, as a sentence: "the Domain itself, 1 Redirect and
 * 2 basic-auth users".
 *
 * The Domain is named first and without a count because there is always exactly
 * one — a router *is* a Domain — and "1 Domain" beside a heading that already
 * names the host reads like a second, different domain.
 */
export function describeChain(rejection: TraefikConfigRejection): string {
  const parts: string[] = ["the Domain itself"];

  const redirects = rejection.subjects.filter(
    (subject) => subject.kind === "redirect",
  ).length;
  if (redirects > 0) parts.push(counted(redirects, "Redirect", "Redirects"));

  const users = rejection.subjects.filter(
    (subject) => subject.kind === "security",
  ).length;
  if (users > 0) {
    parts.push(counted(users, "basic-auth user", "basic-auth users"));
  }

  if (rejection.subjects.some((subject) => subject.kind === "forwardAuth")) {
    parts.push("the sign-in gate on it");
  }

  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
