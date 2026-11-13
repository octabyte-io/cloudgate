import { authSentence } from "@/lib/auth/auth-error";
import { backendOrigin } from "@/lib/config";

import { ApiError, isApiError } from "./api-error";
import { SERVER_IN_MAINTENANCE_CODE } from "./endpoints/servers";

/**
 * A failure, in one sentence a person can act on.
 *
 * The rules this file exists to keep: say what went wrong, then what to do
 * about it. Active voice, sentence case. No apology, no "something went wrong",
 * no exclamation mark, and never the raw exception — `ApiError.message` is
 * written for whoever reads the logs.
 *
 * F03 renders the result in a toast; a form renders `ApiError.issueFor(field)`
 * beside the field instead.
 */
export function errorMessage(error: unknown): string {
  // Before the status-based rules below, because the status misdescribes what
  // happened: a wrong password is a 401 and a wrong recipient is a 403, so
  // "your session has ended" and "your role does not allow this" are both
  // waiting to be said to the wrong person. A code that has nothing special to
  // say falls straight through, so this adds a branch rather than a second
  // vocabulary.
  //
  // **Any `ApiError` with a code, not only an `AuthError`** (H-26). It was
  // `isAuthError` while better-auth's client was the only thing that published
  // a code, and that is exactly what left the ban mislabelled here: a banned
  // caller's `/servers` and `/projects` 403s are plain `ApiError`s, so they
  // reached `fromApiError`'s single 403 sentence and were reported as a *role*
  // problem to somebody no role change can help. Matching the backend's English
  // ("This account is banned") would also have worked and is the failure mode
  // `auth-error.ts` records as deleted, so the
  // backend publishes `code` instead (`AllExceptionsFilter`).
  if (isApiError(error) && error.code) {
    const sentence = authSentence(error);
    if (sentence) return sentence;
  }

  if (isApiError(error)) return fromApiError(error);

  // fetch rejects with a TypeError when the request never landed — the backend
  // is down, or the browser is offline.
  if (error instanceof TypeError) {
    return `Could not reach the backend. Check your connection, and that the backend is running on ${backendOrigin()}.`;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "That request was cancelled before it finished. Try again.";
  }

  return "The console hit an error it does not recognise. Reload the page; if it comes back, check the browser console.";
}

function fromApiError(error: ApiError): string {
  if (error.isValidation) {
    return error.issues
      .map((issue) => fieldSentence(issue.message, issue.path))
      .join(" ");
  }

  // Ahead of the switch, because the switch is wrong about this one: a 503 lands
  // in the 502/503/504 case and answers "The backend is not answering", and the
  // backend answered — in 28 ms — about a Server it could not reach (X11-4).
  // Same failure as H-26 one status family over: a named refusal must not be
  // given the sentence its status implies. The three cards on a Server's Docker
  // tab write their own, richer version of this; every other reader of a docker
  // or swarm route gets this one rather than a claim about the wrong machine.
  //
  // **Two sentences, because the backend was pointed at two machines**.
  // The platform host is what a docker read with no `serverId` addresses, and
  // it was getting the Server sentence below: it has no `server` row to check
  // the state of and no SSH key in the loop, so both halves of that sentence
  // were about something else. `LiveCard` reaches this by construction. The
  // platform arm is tested first and the Server sentence is therefore the
  // Server's alone, even though `isUnreachableHost` covers both — that getter
  // is the union its other callers want, and ordering is what narrows it here.
  // Templates are off: the backend's own sentence names the setting that
  // turned them off and what to set instead.
  if (error.isCatalogueNotConfigured) return error.message;
  // A Server in Maintenance (spec #1420): "<name> is in maintenance". It opens
  // with the Server's own name, which the 409 case below would capitalise
  // into a name the Server does not have ("Edge-1"), so it gets only the stop.
  if (error.code === SERVER_IN_MAINTENANCE_CODE) {
    const refusal = error.message.trim();
    return ENDS_UNFINISHED.test(refusal) ? `${refusal}.` : refusal;
  }
  if (error.isUnreachablePlatformHost) {
    return "Cloudgate could not reach the platform host, the machine it runs on, so nothing was read. Check that Docker is running there and that the backend can reach its socket.";
  }
  if (error.isUnreachableHost) {
    return "Cloudgate could not reach that Server, so nothing was read. Check that it is up and that its SSH key still works.";
  }

  // A member missing a Manage access grant is not refused by their role, and
  // the role sentence below sent an owner to change it. The wording
  // reuses the Manage access dialog's own: a role decides what someone can do,
  // a grant what they can see at all.
  const withheld = error.accessNotGrantedTo;
  if (withheld) {
    return `You have not been given access to this ${withheld}. Ask an owner or an admin to grant it under Members → Manage access.`;
  }

  switch (error.status) {
    case 400:
      return asSentence({ message: error.message });

    case 401:
      return "Your session has ended. Sign in again to pick up where you left off.";

    case 403:
      // The 403 is the point: they are signed in, and their role in this
      // Organization does not carry this action. Saying so is the fix.
      //
      // The fallback, and only the fallback (H-26). This sentence is right for
      // every 403 the backend does not name, and wrong for the ones it does —
      // the ban, and a missing Manage access grant — which is why those
      // branches above run first rather than this one growing more cases.
      return "Your role in this Organization does not allow this. Ask an owner or an admin to do it, or to change your role.";

    case 404:
      return "That is not here any more. Someone may have deleted it — reload to see what is current.";

    case 402:
      // A refused payment: the backend says what was and was not charged,
      // and the bank's reason, which is the whole of what to do next.
      return asSentence({ message: error.message });

    case 409:
      // The backend's own words are specific here ("appName already exists"),
      // and specific beats anything generic this could say instead.
      return asSentence({ message: error.message });

    case 429:
      // The throttle's own figure when it gave one. "Wait a few
      // seconds" had the person guessing, and a guess lands inside the window
      // and is refused again. Without a figure, a minute is the honest bound:
      // better-auth's longest default window (password reset) is 60 seconds.
      if (error.retryAfter !== undefined) {
        const unit = error.retryAfter === 1 ? "second" : "seconds";
        return `Too many attempts. Try again in ${error.retryAfter} ${unit}.`;
      }
      return "Too many attempts. Wait a minute, then try again.";

    case 502:
    case 503:
    case 504:
      return "The backend is not answering. Check that it is running, then try again.";

    default:
      // No claim about what state things are in. It used to end "so
      // nothing changed", which the console cannot know from a 500: a route
      // that does work before it fails has changed something by then — a
      // backup's Run now had recorded a failed run, a Rebuild had removed the
      // service. What it does know is that the backend failed, so it
      // says that and sends the person to look before trying again.
      //
      // **A read is the exception**. A GET does nothing before it
      // fails, so "part of it may have happened" told someone whose card had
      // failed to load that something might have changed when nothing had.
      // The partial-change sentence stays for every other method, and for an
      // error that carries none.
      if (error.status >= 500 && error.isRead) {
        return "Cloudgate could not load this. Try again, and check the backend logs if it keeps happening.";
      }
      if (error.status >= 500) {
        return "The backend hit an error handling that, and part of it may have happened first. Reload to see what is current before trying again, and check the backend logs if it keeps happening.";
      }
      return asSentence({ message: error.message });
  }
}

/**
 * The one sentence rule, exported because a *field* error needs it too: the
 * backend's issue messages arrive as fragments ("appName already exists") and
 * a form renders them straight beside the input. Without this they sit next to
 * our own zod messages, which are written as sentences, in two different
 * voices (`components/console/use-api-form.ts`).
 */
export function sentence(message: string): string {
  return asSentence({ message });
}

/**
 * zod's own wording for a value that is missing or empty — the default a schema
 * gets when it gives no message of its own. "Invalid input: expected string,
 * received undefined" and "Too small: expected string to have >=1 characters"
 * reached the screen from a channel's webhook URL and an AI provider's model
 * both mean the same thing to the person reading them.
 */
const ZOD_MISSING =
  /^(Required|Invalid input: expected \w+, received (undefined|null)|Too small: expected string to have >=1 characters?)\.?$/i;

/**
 * A field's refusal from the backend, in the words of the field's **label**
 * when the form knows it.
 *
 * The backend writes a field message opening with the field's identifier —
 * `secretAccessKey cannot be empty` — and a form that knows the label says
 * "Secret access key cannot be empty." instead. zod's default for a missing
 * value becomes "<label> is needed.", so neither a code name nor zod's own
 * vocabulary reaches the screen. Without a label the identifier stays, as the
 * opening of a backend sentence always has (`OPENS_WITH_IDENTIFIER`).
 */
export function fieldSentence(
  message: string,
  path: string,
  label?: string,
): string {
  const field = path.split(".").pop() ?? path;
  const name = label?.trim() || field;
  if (ZOD_MISSING.test(message.trim())) {
    return asSentence({ message: `${name} is needed` });
  }
  if (label && field && message.trim().startsWith(`${field} `)) {
    return asSentence({
      message: `${label.trim()}${message.trim().slice(field.length)}`,
    });
  }
  return asSentence({ message });
}

/**
 * The zod messages are already written about their field ("name cannot be
 * empty"), and Nest's are already written as statements. Both want a capital
 * and a full stop, and neither wants to be rewritten by us.
 *
 * **The stop is only for a message that ends in a letter or a digit.** It used
 * to be for anything not already ending in `.!?`, which is right for the
 * sentences this was written against and wrong for everything else a 400 can
 * carry. Two were measured on a real VPS: a volume restore's abort block ends
 * `Local backup file cleaned up ✅` and reached the screen as `✅.`, and an S3
 * refusal's folded tail ends `status code: 403, request id: , host id:` and
 * reached it as `host id:.` — a full stop after a colon, which reads as a typo
 * in the backend's own words rather than as punctuation of ours.
 *
 * A trailing symbol already closes the line: a tick, a colon introducing what
 * follows, an ellipsis, a bracket, a closing quote, a slash. A trailing letter
 * or digit does not, so `appName already exists` still becomes a sentence. One
 * predicate rather than a list of symbols to keep in step with whatever the
 * backend writes next.
 */
const ENDS_UNFINISHED = /[\p{L}\p{N}]$/u;

/**
 * **The capital is withheld when the first word is the field's own name.**
 *
 * The backend writes a validation message *about* a field and opens it with
 * that field's identifier — `filePath must stay inside the service files
 * directory`, `environmentId cannot be empty` (CODING_STANDARDS §2.5). A
 * capital renames the field: the console printed `FilePath`, and there is no
 * `FilePath` on the request the person is being sent back to go and fix
 * (X12-5a). It is general rather than one screen's problem: the clear majority
 * of `backend/src`'s field-initial messages open with a camelCase identifier,
 * and the rest with an all-lowercase one. **No count is quoted, deliberately** —
 * `backend/eslint.config.mjs`'s §1.6 selector makes the same call for the same
 * reason (*"a number that rots is worse than the direction it was standing in
 * for"*), and three greps over that population gave three different totals
 * depending on whether template literals and double-quoted strings were in the
 * net.
 *
 * The shape is **an interior capital in a word that starts lowercase**, which
 * is what an identifier looks like and what English prose does not: the class
 * between the two cannot match a space, so only the first word is ever read.
 * Derived from the population the backend actually emits rather than invented.
 *
 * **An all-lowercase field name is deliberately left in scope of the capital**
 * — `port must be a whole number from 1 to 65535` and `name cannot be empty`
 * still become `Port` and `Name`. Nothing tells those apart from the English
 * words they also are, and `traefik/dto` opens a real sentence with `it is a
 * TLS certificate setting this guard cannot read …`, which must keep its
 * capital. Any predicate covering both would have to be wrong about one of
 * them, and prose is the worse half to be wrong about: a lowercase `port` reads
 * as our typo, whereas `Port` reads as the field it names.
 *
 * The stop is untouched — `filePath … directory` still gets the one
 * {@link ENDS_UNFINISHED} gives it. Only the opening is left alone.
 */
const OPENS_WITH_IDENTIFIER = /^\p{Ll}[\p{L}\p{N}_$]*\p{Lu}/u;

function asSentence({ message }: { message: string }): string {
  const trimmed = message.trim();
  if (!trimmed) return "The backend refused that request without saying why.";
  const opened = OPENS_WITH_IDENTIFIER.test(trimmed)
    ? trimmed
    : trimmed[0].toUpperCase() + trimmed.slice(1);
  return ENDS_UNFINISHED.test(opened) ? `${opened}.` : opened;
}
