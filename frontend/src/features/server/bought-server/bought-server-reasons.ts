/**
 * Why a Bought Server's changes wait, shared by the card and the rows and
 * lists inside it (`BoughtServerCard`, `ServerBackupList`), in its own file
 * so neither imports the other for it.
 */

/** Said while a change waits because the Server is busy or not made yet; a Restore and Back up now too. */
export const CHANGE_WAITS_FOR_READY =
  "This Server can be changed once it is Ready.";
