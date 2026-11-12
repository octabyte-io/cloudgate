import { describe, expect, it } from "vitest";

import { AuthError } from "@/lib/auth/auth-error";

import { ApiError } from "./api-error";
import { errorMessage, fieldSentence, sentence } from "./error-message";

/**
 * The sentence a refusal becomes, and the one refusal a status cannot describe.
 *
 * H-26: `errorMessage()` answered every 403 with the role sentence without ever
 * reading anything else off the error, so a **banned** caller's `/servers` and
 * `/projects` 403s — which have carried "This account is banned" on the wire
 * — were reported to the person as a role problem, and the fix they
 * were told to ask for (a different role) does not exist for a ban. H-08 closed
 * the same complaint on better-auth's surface only.
 *
 * The expectations name the sentence in full rather than asserting "not the role
 * one". A test that only says what a message is *not* passes for a message that
 * is wrong in a new way.
 */

const ROLE_SENTENCE =
  "Your role in this Organization does not allow this. Ask an owner or an admin to do it, or to change your role.";
const BANNED_SENTENCE =
  "This account has been banned. Ask an owner to lift the ban.";

describe("errorMessage", () => {
  it("says a Server in maintenance by the name the Server has, lowercase included", () => {
    const error = new ApiError(409, "edge-1 is in maintenance", {
      path: "/applications/app-1/deployments",
      code: "SERVER_IN_MAINTENANCE",
    });

    expect(errorMessage(error)).toBe("edge-1 is in maintenance.");
  });

  /**
   * The finding. A plain `ApiError` because that is what `client.ts` builds from
   * a Cloudgate route's error body — not an `AuthError`, which is the type the
   * code branch used to be gated on and the reason this case fell through.
   */
  it("names the ban when a Cloudgate route's 403 carries the banned code", () => {
    const error = new ApiError(403, "This account is banned", {
      path: "/servers",
      code: "BANNED_USER",
    });

    expect(errorMessage(error)).toBe(BANNED_SENTENCE);
  });

  /**
   * The control, and the half that says the fix is narrow: a 403 the backend did
   * not name is still a role refusal, which is the right answer for every route
   * that turns a member down for their role.
   */
  it("keeps the role sentence for a 403 that carries no code", () => {
    const error = new ApiError(403, "Forbidden resource", { path: "/servers" });

    expect(errorMessage(error)).toBe(ROLE_SENTENCE);
  });

  /**
   * One code for one fact, whichever surface refused (H-08, H-26). The
   * sign-in screen reaches this through `AuthError` and the console reaches it
   * through `ApiError`; both must arrive at the same words, because the person
   * reading them is the same person and their next move is the same move.
   */
  it("names the ban identically when better-auth is the surface that refused", () => {
    const error = new AuthError({
      status: 403,
      code: "BANNED_USER",
      message: "This account is banned",
    });

    expect(errorMessage(error)).toBe(errorMessage(
      new ApiError(403, "This account is banned", { code: "BANNED_USER" }),
    ));
    expect(errorMessage(error)).toBe(BANNED_SENTENCE);
  });

  /**
   * A code the map has nothing to say about falls through to the status rules
   * rather than to the unrecognised-error sentence — the branch is an addition,
   * not a replacement.
   */
  it("falls back to the status when the code is one it has no sentence for", () => {
    const error = new ApiError(403, "Forbidden resource", {
      code: "SOME_CODE_WITH_NO_SENTENCE",
    });

    expect(errorMessage(error)).toBe(ROLE_SENTENCE);
  });
});

/**
 * H-36. The three 403s better-auth raises that a Cloudgate route reaches, and
 * the sentence each one becomes now that `callAuthApi` stops flattening its
 * code away (`backend/src/auth/auth-api.util.ts`).
 *
 * All three answered `ROLE_SENTENCE` through a Cloudgate route before the fix —
 * two of them because the code never arrived, the third because no sentence was
 * written for it. The pins are here rather than in one `it` per code because the
 * finding is about them being *the same status*: a test that reads them together
 * is the one that fails if a later edit collapses them back onto the status.
 *
 * `ApiError` and not `AuthError` throughout, because the door under test is the
 * Cloudgate one — the same refusal through better-auth's own client was already
 * right, and `errorMessage`'s own case above proves the two doors agree.
 */
describe("errorMessage, for the codes a Cloudgate route now carries", () => {
  /**
   * The one that needed a new sentence. `SESSION_NOT_FRESH` had none, so the
   * status rules answered for it — and `sessions-card.tsx` was matching its
   * English precisely because this lookup could not be made to work.
   */
  it("says what to do about a session that is not fresh enough", () => {
    const error = new ApiError(403, "Session is not fresh", {
      path: "/users/me/sessions",
      code: "SESSION_NOT_FRESH",
    });

    expect(errorMessage(error)).toBe(
      "This needs a more recent sign-in than the one you are on. Sign out, then sign in again.",
    );
  });

  /**
   * Already in the map since F06 and already correct through better-auth's
   * client; what was missing was the code on this door. Named in full so that
   * "the sentence did not get worse" is a thing this file can be read for.
   */
  it("names the wrong recipient when a Cloudgate route refuses the accept", () => {
    const error = new ApiError(403, "You are not the recipient of the invitation", {
      path: "/organizations/invitations/abc/accept",
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    });

    expect(errorMessage(error)).toBe(
      "This invitation was sent to a different email address. Sign out, then sign in as the person it was sent to.",
    );
  });

  /**
   * The second 403 on that same route, and the reason a status cannot answer:
   * this one and the one above are indistinguishable by status, method and path.
   */
  it("names a full Organization on the same route and the same status", () => {
    const error = new ApiError(403, "Organization membership limit reached", {
      path: "/organizations/invitations/abc/accept",
      code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
    });

    expect(errorMessage(error)).toBe(
      "This organization is full, so the invitation cannot be accepted. Ask an owner to remove a member or raise the limit.",
    );
  });

  /**
   * The negative assertion the three above are worth nothing without: none of
   * them is the sentence they all used to be.
   */
  it("gives none of the three the role sentence", () => {
    for (const code of [
      "SESSION_NOT_FRESH",
      "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
      "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
    ]) {
      expect(errorMessage(new ApiError(403, "Refused", { code }))).not.toBe(
        ROLE_SENTENCE,
      );
    }
  });
});

/**
 * Somebody removed from an Organization while signed in keeps a
 * session pointed at it, and every screen told them their *role* was the
 * problem. Two surfaces refuse them with the one code — better-auth's member
 * routes, and every Cloudgate route through `PermissionService.findMember` —
 * so both are pinned, and neither may be the role sentence.
 */
describe("errorMessage, for a session pointed at an Organization it left", () => {
  const NOT_A_MEMBER_SENTENCE =
    "You are no longer a member of this Organization. Switch to one you belong to, or sign out.";

  it("says they are not a member when better-auth's member route refuses", () => {
    const error = new ApiError(403, "You are not a member of this organization", {
      path: "/organizations/members",
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
    });

    expect(errorMessage(error)).toBe(NOT_A_MEMBER_SENTENCE);
  });

  it("says the same when a Cloudgate route refuses for want of a member row", () => {
    const error = new ApiError(403, "Permission denied", {
      path: "/projects",
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
    });

    expect(errorMessage(error)).toBe(NOT_A_MEMBER_SENTENCE);
    expect(errorMessage(error)).not.toBe(ROLE_SENTENCE);
  });
});

/**
 * The stop this puts on the end, and the messages that already have one without
 * a full stop in them.
 *
 * Both cases below were measured on a real VPS, on the same two screens: a
 * volume restore's abort block ends `Local backup file cleaned up ✅` and a
 * failed listing's folded S3 tail ends `status code: 403, request id: , host
 * id:`. The old rule appended to anything not already ending in `.!?`, so the
 * console printed `✅.` and `host id:.` — punctuation of ours inside what reads
 * as the backend's own sentence.
 *
 * `sentence` rather than `errorMessage` for the four punctuation cases because
 * it is the exported unit whose whole job is this rule; `errorMessage`'s own
 * case at the end is the finding as it was actually seen, through a 400.
 */
describe("sentence", () => {
  /**
   * `appName`, lowercase as the request spells it — the capital this used to
   * assert renamed the field the message is about (X12-5a). The stop is what
   * this case is for and it is unchanged: a message ending in a letter gets one
   * whether or not its first word was capitalised.
   */
  it("adds the stop a message ending in a letter is missing", () => {
    expect(sentence("appName already exists")).toBe("appName already exists.");
  });

  it("adds the stop after a trailing digit too", () => {
    expect(sentence("port must be at most 65535")).toBe(
      "Port must be at most 65535.",
    );
  });

  it("leaves a message that ends in a tick alone", () => {
    expect(sentence("Local backup file cleaned up ✅")).toBe(
      "Local backup file cleaned up ✅",
    );
  });

  it("leaves a message that ends in a colon alone", () => {
    expect(sentence("status code: 403, request id: , host id:")).toBe(
      "Status code: 403, request id: , host id:",
    );
  });

  it("leaves a message that ends in an ellipsis alone", () => {
    expect(sentence("Creating new volume and restoring data…")).toBe(
      "Creating new volume and restoring data…",
    );
  });

  /** The rule it always had, unchanged: a stop already there is not doubled. */
  it("does not double a stop the backend already wrote", () => {
    expect(sentence("That is not here any more.")).toBe(
      "That is not here any more.",
    );
    expect(sentence("Is that the volume you meant?")).toBe(
      "Is that the volume you meant?",
    );
  });

  it("still answers for a message with nothing in it", () => {
    expect(sentence("   ")).toBe(
      "The backend refused that request without saying why.",
    );
  });
});

/**
 * The finding, through the door it came in: the restore dialog renders
 * `errorMessage()` on a 400 in place, and the backend's abort block is four lines
 * ending in a tick.
 */
describe("errorMessage, for a 400 carrying a tool's own block", () => {
  it("keeps the abort block's last line as the script wrote it", () => {
    const block = [
      "❌ Volume restore aborted - the archive would not extract",
      "   Read the 'tar' errors above for why.",
      "Local backup file cleaned up ✅",
    ].join("\n");

    expect(errorMessage(new ApiError(400, block))).toBe(block);
  });
});

/**
 * X11-4. The docker and swarm reads answer 503 `HOST_UNREACHABLE` for a Server the
 * SSH connection never reached, and the status alone lands in the 502/503/504 case
 * — *"The backend is not answering"* — which is a confident sentence about the wrong
 * machine. The three cards on a Server's Docker tab write their own; this is what
 * every other reader of those routes gets, and the compose Containers panel is the
 * one that renders it today.
 */
describe("errorMessage, for a Server that was never reached", () => {
  const notReached = new ApiError(503, "This Server could not be reached", {
    code: "HOST_UNREACHABLE",
  });

  it("names the Server rather than the backend", () => {
    const said = errorMessage(notReached);

    expect(said).toContain("could not reach that Server");
    expect(said).not.toContain("The backend is not answering");
  });

  it("keeps the backend's own sentence for an unnamed 503", () => {
    expect(errorMessage(new ApiError(503, "Service Unavailable"))).toBe(
      "The backend is not answering. Check that it is running, then try again.",
    );
  });
});

/**
 * The other machine those routes are pointed at.
 *
 * A docker read with no `serverId` addresses the **platform host**, and once
 * both subjects shared one code — so this sentence was the Server's, said
 * about a machine with no `server` row to check the state of and no SSH key in
 * the loop. Both halves of it were about something else. `LiveCard` reaches it
 * by construction: `dockerApi.containers(null)` has no server id to give.
 *
 * The two are asserted **against each other**, because the property is that
 * they differ: a fix that gave the platform host the Server's words, or the
 * Server the platform host's, passes either test written alone.
 */
describe("errorMessage, for the platform host", () => {
  const platformHost = new ApiError(
    503,
    "The platform host could not be reached",
    { code: "PLATFORM_HOST_UNREACHABLE" },
  );
  const onServer = new ApiError(503, "This Server could not be reached", {
    code: "HOST_UNREACHABLE",
  });

  it("names the platform host, and neither a Server nor the backend", () => {
    const said = errorMessage(platformHost);

    expect(said).toContain("could not reach the platform host");
    // The two things that were wrong: it named a machine that is not involved,
    // and told the operator to check a credential that is not used.
    expect(said).not.toContain("Server");
    expect(said).not.toContain("SSH key");
    expect(said).not.toContain("The backend is not answering");
  });

  it("says something different from what a Server gets", () => {
    expect(errorMessage(platformHost)).not.toBe(errorMessage(onServer));
  });

  it("leaves the Server's sentence to the Server", () => {
    // The platform arm is tested first in `fromApiError`, so this is the
    // assertion that the ordering did not swallow the Server arm with it.
    const said = errorMessage(onServer);

    expect(said).toContain("could not reach that Server");
    expect(said).not.toContain("platform host");
  });
});

/**
 * X12-5a. §2.5 writes a validation message *about* the field it names, so most
 * of them open with that field's own camelCase identifier — `filePath must stay
 * inside the service files directory`. Capitalising the first letter renames the
 * field: the console printed `FilePath`, and there is no `FilePath` on the
 * request the person is being asked to go and fix. 40 of the 57 messages in
 * `backend/src` that open with a field name are camelCase ones.
 *
 * Reachable through both doors this file feeds, and it was the field one that
 * was seen: `mounts-spec.tsx` holds `filePath` to a non-empty trimmed string
 * and carries no traversal rule, so a file mount at `../../../etc/hosts`
 * passes the console form and only the backend's `filePathSchema` refuses it —
 * whereupon `use-api-form.ts` finds `filePath` among the form's own fields and
 * renders `sentence(issue.message)` beside the input.
 *
 * The controls are half of this: the capital is not switched *off*, only
 * withheld from a first word that is an identifier rather than a word. An
 * all-lowercase field name keeps its capital, because nothing distinguishes
 * `port` or `name` from the English words they also are.
 */
describe("sentence, for a message that opens with the field it is about", () => {
  it("leaves a camelCase field name spelled the way the request spells it", () => {
    expect(
      sentence("filePath must stay inside the service files directory"),
    ).toBe("filePath must stay inside the service files directory.");
  });

  it("still adds the stop to a message it does not capitalise", () => {
    expect(sentence("environmentId cannot be empty")).toBe(
      "environmentId cannot be empty.",
    );
  });

  it("leaves the identifier alone in a message that closes itself", () => {
    expect(sentence('previewWildcard must start with "*."')).toBe(
      'previewWildcard must start with "*."',
    );
  });

  /**
   * The control that stops a later edit turning capitalisation off wholesale:
   * every message whose first word is a word still gets its capital.
   */
  it("capitalises an all-lowercase field name, which reads as a word", () => {
    expect(sentence("port must be a whole number from 1 to 65535")).toBe(
      "Port must be a whole number from 1 to 65535.",
    );
    expect(sentence("name cannot be empty")).toBe("Name cannot be empty.");
  });

  /**
   * The reason an all-lowercase first token cannot be in scope. This one is
   * prose, not a field — `traefik.dto.ts` writes it about a setting — and it is
   * indistinguishable from `port` or `name` by shape alone.
   */
  it("capitalises a message that merely begins lowercase", () => {
    expect(
      sentence("it is a TLS certificate setting this guard cannot read"),
    ).toBe("It is a TLS certificate setting this guard cannot read.");
  });

  it("keeps a sentence-shaped message exactly as the backend wrote it", () => {
    expect(sentence("This account is banned")).toBe("This account is banned.");
  });
});

/**
 * The same finding through the two `errorMessage()` doors it actually arrives
 * by: the validation branch that maps every issue through `asSentence`, and the
 * bare 400 for a refusal the pipe did not path onto a field.
 */
describe("errorMessage, for a refusal named after a camelCase field", () => {
  it("does not rename the field in a validation issue", () => {
    const error = new ApiError(400, "Validation failed", {
      path: "/mounts",
      issues: [
        {
          path: "filePath",
          message: "filePath must stay inside the service files directory",
        },
      ],
    });

    expect(errorMessage(error)).toBe(
      "filePath must stay inside the service files directory.",
    );
  });

  it("does not rename the field in a plain 400", () => {
    expect(
      errorMessage(
        new ApiError(400, "publishDirectory must stay inside the build directory"),
      ),
    ).toBe("publishDirectory must stay inside the build directory.");
  });

  it("joins several issues without renaming any of their fields", () => {
    const error = new ApiError(400, "Validation failed", {
      issues: [
        { path: "accessKey", message: "accessKey cannot be empty" },
        { path: "bucket", message: "bucket cannot be empty" },
      ],
    });

    expect(errorMessage(error)).toBe(
      "accessKey cannot be empty. Bucket cannot be empty.",
    );
  });
});

/**
 * A catalogue read on an instance with templates off. The status alone would
 * say "The backend is not answering" about a backend that answered; the
 * backend's own sentence says which setting and what to set.
 */
describe("errorMessage, for an instance with templates off", () => {
  it("says what the backend said, and does not claim the backend is down", () => {
    const sentence =
      "`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read. Set `CLOUDGATE_TEMPLATES_URL`, or remove the old setting to use the official catalogue.";
    const said = errorMessage(
      new ApiError(503, sentence, {
        code: "TEMPLATES_CATALOGUE_NOT_CONFIGURED",
      }),
    );

    expect(said).toBe(sentence);
  });
});

/**
 * A member refused a Service for want of a Manage access grant was told
 * their role was the problem. Three causes reach the console as a 403 — the
 * role, a missing grant, and no membership at all. The last two are told apart
 * by the grant's code; no membership carries none, so until it has a
 * sentence of its own it reads as the role's refusal, and what this pins is
 * that it is not mistaken for a missing grant.
 */
describe("errorMessage, for a refusal of something not granted", () => {
  const notGranted = (code: string) =>
    new ApiError(403, "You don't have access to this service", { code });

  it("says a Service was not granted and names Manage access", () => {
    expect(errorMessage(notGranted("SERVICE_ACCESS_NOT_GRANTED"))).toBe(
      "You have not been given access to this Service. Ask an owner or an admin to grant it under Members → Manage access.",
    );
  });

  it("names the Environment and the Project it was not given, too", () => {
    expect(errorMessage(notGranted("ENVIRONMENT_ACCESS_NOT_GRANTED"))).toBe(
      "You have not been given access to this Environment. Ask an owner or an admin to grant it under Members → Manage access.",
    );
    expect(errorMessage(notGranted("PROJECT_ACCESS_NOT_GRANTED"))).toBe(
      "You have not been given access to this Project. Ask an owner or an admin to grant it under Members → Manage access.",
    );
  });

  it("keeps the role sentence for the role's own uncoded refusal", () => {
    expect(
      errorMessage(new ApiError(403, "You are not allowed to access resource: service")),
    ).toBe(ROLE_SENTENCE);
  });

  it("does not call a caller who is no member a missing grant", () => {
    // The wire shape of that refusal as it is sent: `PermissionService`'s
    // `findMember` throws a bare `ForbiddenException('Permission denied')`, so
    // the body is `{ statusCode: 403, message: "Permission denied" }` with no
    // code — which `toApiError` turns into an `ApiError` whose `code` is `""`.
    // It reads as the role's refusal, not as a grant that was never made.
    const noMember = errorMessage(new ApiError(403, "Permission denied"));
    expect(noMember).toBe(ROLE_SENTENCE);
  });

  it("reads the status as well as the code", () => {
    expect(
      new ApiError(404, "Not found", { code: "SERVICE_ACCESS_NOT_GRANTED" })
        .accessNotGrantedTo,
    ).toBeNull();
  });
});

/**
 * A 5xx the backend did not name.
 *
 * The sentence used to end "…so nothing changed", and the console cannot know
 * that: a route that does work before it fails has changed something by the
 * time it answers 500. A database backup's Run now recorded a failed run and
 * then got that sentence, and a Rebuild removed the service first. So
 * the fallback says what it knows — the backend failed — and sends the person
 * to look before they try again, rather than promising a state it never saw.
 */
describe("errorMessage, for a 5xx nothing named", () => {
  const unexplained = new ApiError(500, "Internal server error");

  it("does not claim that nothing changed", () => {
    expect(errorMessage(unexplained)).not.toMatch(/nothing changed/i);
  });

  it("says part of it may have happened, and to look before trying again", () => {
    expect(errorMessage(unexplained)).toBe(
      "The backend hit an error handling that, and part of it may have happened first. Reload to see what is current before trying again, and check the backend logs if it keeps happening.",
    );
  });

  it("gives any other unnamed 5xx the same sentence", () => {
    expect(errorMessage(new ApiError(507, "Insufficient Storage"))).toBe(
      errorMessage(unexplained),
    );
  });
});

/**
 * A failed read is not a failed mutation.
 *
 * A GET has done nothing when it answers 500, so the partial-change sentence —
 * "part of it may have happened first" — told someone whose card failed to load
 * that something might have changed. The sentence is picked by method; every
 * other method, and an error built without one, keeps it.
 */
describe("errorMessage, for a 5xx on a read", () => {
  const read = new ApiError(500, "Internal server error", { method: "get" });

  it("says the read failed and to try again, and claims nothing changed or may have", () => {
    expect(errorMessage(read)).toBe(
      "Cloudgate could not load this. Try again, and check the backend logs if it keeps happening.",
    );
    expect(errorMessage(read)).not.toMatch(/may have happened/);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "keeps the mutation sentence for a %s",
    (method) => {
      expect(
        errorMessage(new ApiError(500, "Internal server error", { method })),
      ).toBe(errorMessage(new ApiError(500, "Internal server error")));
    },
  );

  it("leaves a named 5xx on a read to its own sentence", () => {
    expect(
      errorMessage(new ApiError(502, "Bad Gateway", { method: "GET" })),
    ).toBe("The backend is not answering. Check that it is running, then try again.");
  });
});

/**
 * What a failed Run now is answered with — the backend's own
 * sentence, on the status the console renders it for.
 */
describe("errorMessage, for a database backup run that failed", () => {
  it("renders the backend's sentence naming the step, the destination and the log", () => {
    const message =
      "Uploading the dump of ui_pg to ui-bad-dest failed. The run is listed on Deployments as a failed Database backup, and its log has the full output. The upload stopped with: Failed to rcat: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key and signing method.";
    expect(errorMessage(new ApiError(400, message))).toBe(message);
  });

  it("closes the backend's reasonless form, which ends without a stop (§2.5)", () => {
    const message =
      "Dumping ui_pg to ui-bad-dest did not start: the database has no running container. The run is listed on Deployments as a failed Database backup, and its log has the full output";
    expect(errorMessage(new ApiError(400, message))).toBe(`${message}.`);
  });
});

/** A field's refusal, in the field's label. */
describe("fieldSentence", () => {
  it("opens with the label where the backend opened with the identifier", () => {
    expect(
      fieldSentence("secretAccessKey cannot be empty", "secretAccessKey", "Secret access key"),
    ).toBe("Secret access key cannot be empty.");
  });

  it("says a value zod found missing is needed, in the label's words", () => {
    for (const raw of [
      "Invalid input: expected string, received undefined",
      "Too small: expected string to have >=1 characters",
    ]) {
      expect(fieldSentence(raw, "webhookUrl", "Webhook URL")).toBe(
        "Webhook URL is needed.",
      );
    }
  });

  it("keeps the identifier, uncapitalised, without a label", () => {
    expect(
      fieldSentence("Too small: expected string to have >=1 characters", "model"),
    ).toBe("Model is needed.");
    expect(fieldSentence("Invalid input: expected string, received undefined", "apiUrl")).toBe(
      "apiUrl is needed.",
    );
  });

  it("leaves any other message as the backend wrote it", () => {
    expect(fieldSentence("appName already exists", "appName", "App name")).toBe(
      "App name already exists.",
    );
    expect(fieldSentence("must be a valid URL", "url", "URL")).toBe(
      "Must be a valid URL.",
    );
  });
});
