const isHighSurrogate = (unit: number): boolean =>
  unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean =>
  unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Caps an error message at `limit` UTF-16 code units without cutting a
 * character in half — the one truncation Discord, Lark and Teams all need, at
 * nine call sites over three limits (800, 1010 and 500).
 *
 * One function rather than nine copies of `substring` because the property has
 * to hold over the *set*: every one of those nine was written the same wrong
 * way, and H-122 was found because a sibling module's identical cap (H-117) had
 * just been fixed one file at a time. The three limits stay each caller's
 * business — they are the field limits of three different products — but where
 * the cut lands is not.
 *
 * `String.prototype.substring` is indexed in code units, so a limit landing
 * between the high and the low half of a surrogate pair leaves a **lone
 * surrogate** at the end of the answer: not well-formed Unicode. Nothing on the
 * way out complains, which is why this survived. `JSON.stringify` escapes it as
 * `\ud83d` — an escape RFC 8259 permits — so the body is syntactically valid
 * JSON and reaches the wire as well-formed UTF-8. The damage is on the far side
 * of the receiver's parse, where the field is a string no UTF-8 encoder can
 * represent: Node's substitutes U+FFFD and Python's raises outright, so a
 * webhook receiver that re-encodes the field can fail the delivery rather than
 * garble one glyph. That is a *failure* notification, so losing it is the
 * expensive outcome. (Whether Discord, Lark or Teams in particular reject is
 * unverified and deliberately untested: it needs a payload sent outward.)
 *
 * The cut therefore steps **back** off a pair it would split — inwards, never
 * outwards, so the answer stays inside `limit`. A lone surrogate the input
 * already carried is left where it is: there is no partner to invent for it.
 * Only the end needs the check, because index 0 is always kept and so a leading
 * low surrogate cannot be created here.
 *
 * Code units rather than code points, for the same reason the sibling gave:
 * these limits sit under a platform's own field limit, and re-indexing on code
 * points would loosen each one by up to a factor of two in units — an emoji-only
 * message would pass a cap it currently fails. The cap is the caller's; this
 * function only refuses to end in half a character.
 */
export const capMessage = (message: string, limit: number): string => {
  if (message.length <= limit) return message;
  const end =
    isHighSurrogate(message.charCodeAt(limit - 1)) &&
    isLowSurrogate(message.charCodeAt(limit))
      ? limit - 1
      : limit;
  return message.substring(0, end);
};
