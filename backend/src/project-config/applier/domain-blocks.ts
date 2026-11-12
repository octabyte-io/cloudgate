/**
 * What an AWS Domain run does when its plan would change more than its
 * blocks or put back a hand change on them.
 */
export interface OnlyBlocksThen {
  other: string;
  drift: string;
  /**
   * Whether the run sets this field of this block itself, so a change
   * to it is the run's to make, not Drift: a failed run can leave the
   * state ahead of AWS on exactly these.
   */
  owns: (address: string, field: string) => boolean;
}

/**
 * A Domain run's plan may change its Domain blocks and nothing else (on Google
 * Cloud the network's URL map with them); `then` says what
 * to do when it would. Given the AWS form, it also never puts back a hand
 * change on them: that is Drift, which an operator sees in a plan
 * before Cloudgate undoes it.
 */
export function onlyBlocks(
  blocks: readonly string[],
  then: string | OnlyBlocksThen,
) {
  return (reading: {
    raw: { address: string; action: string }[];
    drift?: { address: string; fields: { field: string }[] }[];
  }): string | null => {
    if (typeof then !== 'string') {
      const handMade = (reading.drift ?? []).flatMap((entry) => {
        const fields = entry.fields
          .map((one) => one.field)
          .filter((field) => !then.owns(entry.address, field));
        return entry.fields.length > 0 && fields.length === 0
          ? []
          : [{ address: entry.address, fields }];
      });
      if (handMade.length > 0) {
        const changed = handMade.map((entry) =>
          entry.fields.length > 0
            ? `${entry.address} was changed in AWS by hand (${entry.fields.join(', ')})`
            : `${entry.address} was changed in AWS by hand`,
        );
        return `${changed.join('; ')}. Nothing was applied, and the hand change stays: Check for changes shows it under Drift; ${then.drift}`;
      }
    }
    const other = reading.raw.filter(
      (line) =>
        !blocks.some(
          (block) =>
            line.address === block || line.address.startsWith(`${block}[`),
        ),
    );
    const otherThen = typeof then === 'string' ? then : then.other;
    return other.length === 0
      ? null
      : `Applying the Domains would also ${other.map((line) => `${line.action} ${line.address}`).join('; ')}. Nothing was applied; ${otherThen}`;
  };
}
