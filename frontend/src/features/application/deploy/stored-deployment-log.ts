import { isApiError } from "@/lib/api/api-error";
import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { errorMessage } from "@/lib/api/error-message";
import {
  LiveLog,
  type LogAbout,
  type LogEnding,
} from "@/lib/realtime/live-log";
import {
  COULD_NOT_CONNECT,
  NO_LONGER_AUTHORIZED,
} from "@/lib/realtime/refusal";
import { StoredLog, type StoredRead } from "@/lib/realtime/stored-log";

import { splitLogText } from "./log-tones";

/** How many lines a finished build's read asks for — the page box's own. */
export const STORED_LOG_TAIL = 10_000;

/**
 * How `GET /deployments/:id/logs` opens its answer for a log the retention
 * sweep has deleted (ADR-0020): backend `reapedLogNotice`, up to its colon.
 *
 * **A prefix of the sentence, because the route answers nothing else.** It
 * says a reaped log in `text/plain` as the body, with a 200, so that it
 * composes with a log tail — so the sentence is the only signal there is.
 * Matched on the opening only, which names no number: the retention window
 * after it is the backend's to change. Rejected: a header or a status for it,
 * which would be a backend change this console-only ticket (#1340) does not
 * make.
 */
const REAPED_OPENING =
  "This deployment's log is no longer on the machine that wrote it:";

/** The tab's end word for a record the retention sweep deleted. */
export const REAPED_WORDS = "Log deleted";

/**
 * What one answered read of a finished Deployment's log says, as a stored
 * record's read: its lines, or — past the retention window — the reaped
 * sentence as its ending, with no line added for it.
 */
export function readStoredDeploymentLog(text: string): StoredRead {
  const trimmed = text.trim();
  if (trimmed.startsWith(REAPED_OPENING) && !trimmed.includes("\n")) {
    return {
      ending: { mark: "stopped", words: REAPED_WORDS, sentence: trimmed },
    };
  }
  return { lines: splitLogText(text) };
}

/**
 * A read that failed: a refusal (401, 403, or 404 — the Deployment deleted)
 * ends it as refused, in a Docked shell's end words, and nothing is read
 * again; any other failure's words are said beside its ending.
 */
function failedRead(error: unknown): StoredRead {
  if (
    isApiError(error) &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  ) {
    return {
      ending: {
        mark: "stopped",
        words: error.status === 404 ? COULD_NOT_CONNECT : NO_LONGER_AUTHORIZED,
        sentence: `${errorMessage(error)} Reading it again stopped; the lines it had read stay.`,
        refused: true,
      },
    };
  }
  return { failed: `Reading it again failed: ${errorMessage(error)}` };
}

/**
 * A finished Deployment's log as a Live log the Dock can take: the stored
 * record the page read (`text`), ended the way its build did, under the key
 * its live log has (`useDeploymentLog`'s), so the Dock holds it at most once
 * whichever version was docked first. Built at the Dock press, from what the
 * page box read by then; Reload reads the same route again and never dials.
 */
export function storedDeploymentLog(options: {
  key: string;
  deploymentId: string;
  text: string;
  ending: LogEnding;
  about: LogAbout;
}): LiveLog {
  const { key, deploymentId, text, about } = options;
  const first = readStoredDeploymentLog(text);
  const lines = "lines" in first ? first.lines : [];
  const ending = "ending" in first ? first.ending : options.ending;
  const read = () =>
    deploymentsApi
      .readLogs(deploymentId, STORED_LOG_TAIL)
      .then(readStoredDeploymentLog, failedRead);
  const log = new LiveLog(key, "page", {
    source: new StoredLog(read, lines, ending),
  });
  log.describe(about);
  return log;
}
