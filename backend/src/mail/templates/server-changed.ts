import type { RenderedEmail } from './index';
import { renderConfirmationEmail } from './confirmation';

/**
 * What a finished change made of a **Bought Server**, as the email says it:
 * backups on or off, the extra storage grown to a size, or a new size,
 * described by what it is (`3 vCPU · 4 GB RAM`, never the provider's code),
 * or null when the catalogue could not say.
 */
export type ServerChange =
  | { kind: 'backups'; on: boolean }
  | { kind: 'storage'; storageGb: number }
  | { kind: 'size'; size: string | null }
  /**
   * A Restore (#180): the backup's date as the email says it, how the
   * Server setup run after it ended, the name of each Service whose
   * redeploy it started because it was deployed after that backup (#181),
   * and apart from those each one refused before it started, with why.
   */
  | {
      kind: 'restore';
      backupTakenAt: string;
      setupOk: boolean;
      redeployed: readonly string[];
      notRedeployed: readonly { name: string; reason: string }[];
    };

/**
 * What a Restore redeployed, by name, then what it could not, one sentence
 * per reason; or that nothing was deployed after the backup. Only a
 * redeploy that started is called redeployed.
 */
function restoreRedeploysSentences(
  names: readonly string[],
  refused: readonly { name: string; reason: string }[],
): string[] {
  if (names.length === 0 && refused.length === 0) {
    return [
      'No Service on it was deployed after that backup, so none was redeployed.',
    ];
  }
  const sentences: string[] = [];
  if (names.length > 0) {
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    sentences.push(
      names.length === 1
        ? `Cloudgate redeployed ${sorted[0]}, which was deployed after that backup, so it runs its current version again. How the redeploy went shows on that Service.`
        : `Cloudgate redeployed ${listed(sorted)}, which were deployed after that backup, so they run their current version again. How each redeploy went shows on its Service.`,
    );
  }
  const byReason = new Map<string, string[]>();
  for (const one of refused) {
    byReason.set(one.reason, [...(byReason.get(one.reason) ?? []), one.name]);
  }
  for (const [reason, group] of byReason) {
    const sorted = [...group].sort((a, b) => a.localeCompare(b));
    sentences.push(
      sorted.length === 1
        ? `Cloudgate could not redeploy ${sorted[0]}, which was deployed after that backup: ${reason}. It shows as failed on its Service, and runs the version the backup holds until it is deployed again.`
        : `Cloudgate could not redeploy ${listed(sorted)}, which were deployed after that backup: ${reason}. Each shows as failed on its Service, and runs the version the backup holds until it is deployed again.`,
    );
  }
  return sentences;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A change to a **Bought Server** finished (spec #69, #75): backups turned on
 * or off, its extra storage grown, or its size changed. It says what changed
 * and what the Server now costs a month. A change refunded because the
 * provider refused it never gets this email, only its refund email.
 */
export async function renderServerChangedEmail({
  userName,
  organizationName,
  serverName,
  change,
  monthlyPrice,
  serverUrl,
}: {
  userName: string;
  organizationName: string;
  serverName: string;
  change: ServerChange;
  /** Every line of the Server together, formatted: `$30.00`. */
  monthlyPrice: string;
  serverUrl: string;
}): Promise<RenderedEmail> {
  const where = `the Server ${serverName} in ${organizationName}`;
  let subject: string;
  let what: string;
  const more: string[] = [];
  switch (change.kind) {
    case 'backups':
      subject = `Backups are ${change.on ? 'on' : 'off'} for your Server ${serverName}`;
      what = change.on
        ? `Backups are now on for ${where}.`
        : `Backups are now off for ${where}, and its backups were deleted.`;
      break;
    case 'storage':
      subject = `Your Server ${serverName} now has ${change.storageGb} GB of extra storage`;
      what = `The extra storage of ${where} is now ${change.storageGb} GB.`;
      break;
    case 'size':
      subject = `Your Server ${serverName} has a new size`;
      what = `The Server ${serverName} in ${organizationName} now runs on ${change.size ?? 'its new size'}.`;
      break;
    case 'restore':
      subject = `Your Server ${serverName} was restored from a backup`;
      what = `The Server ${serverName} in ${organizationName} was restored from its backup of ${change.backupTakenAt}. Everything written to its disk since then is gone.`;
      more.push(
        change.setupOk
          ? 'Server setup ran on it again.'
          : 'Server setup ran on it again and failed: open its Setup card and press Run setup.',
      );
      more.push(
        ...restoreRedeploysSentences(change.redeployed, change.notRedeployed),
      );
      break;
  }
  return renderConfirmationEmail(userName, {
    subject,
    heading: `${serverName} changed`,
    paragraphs: [
      what,
      ...more,
      `${serverName} now costs ${monthlyPrice} a month.`,
    ],
    action: { label: 'Open the Server', url: serverUrl },
  });
}
