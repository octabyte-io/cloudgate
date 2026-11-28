/**
 * Why a Bought Server's changes wait, shared by the cards, rows and lists of
 * its tab (`ServerBackupsCard`, `ServerBackupList`, `BackUpNow`), in its own
 * file so none imports another for it.
 */

/** Said while a change waits because the Server is busy or not made yet; a Restore and Back up now too. */
export const CHANGE_WAITS_FOR_READY =
  "This Server can be changed once it is Ready.";

/**
 * The ids of the two sentences on the Server backups card that a held
 * control points `aria-describedby` at: the card's own note (Ready, and
 * backups no longer sold) and the note under its strip (the role, and
 * maintenance). Fixed rather than `useId`, because Back up now sits in the
 * page header, outside the card, and the tab shows one Server.
 */
export const BACKUPS_READY_NOTE_ID = "server-backups-ready-note";
export const BACKUPS_NOTE_ID = "server-backups-note";
