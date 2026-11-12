import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MailAttachment } from './senders/smtp';

/**
 * The Cloudgate logo mark in an email header, as an inline CID attachment
 *.
 *
 * **Inline, never a remote URL.** A Self-hosted instance may run without
 * internet access or not know its own address yet (`renderLicenseExpiringEmail`
 * takes a null `licenseUrl` for that), and a linked image would also need the
 * recipient's mail client to reach it. So the PNG travels in the message and
 * the `<img>` points at it by `cid:`.
 *
 * **A PNG, never the SVG.** Gmail and Outlook render no SVG. Each PNG is the
 * console's mark (`frontend/public/cloudgate-mark*.svg`) rasterised at twice
 * {@link EMAIL_LOGO_WIDTH} × {@link EMAIL_LOGO_HEIGHT} on a transparent
 * background, so it stays sharp on a 2× screen: the light-violet `-dark`
 * variant for the transactional emails' dark header, the deeper violet one for
 * the notification email's white header.
 */
export const EMAIL_LOGO_CID = 'cloudgate-logo';

/** The display size in CSS pixels; the PNGs are twice this. */
export const EMAIL_LOGO_WIDTH = 58;
export const EMAIL_LOGO_HEIGHT = 37;

/** The header the logo sits on. */
export type EmailLogoBackground = 'dark' | 'light';

/**
 * Where the PNGs are committed: `backend/assets/mail/`, two folders above both
 * `src/mail/` and `dist/mail/`, so a test and the built backend read the same
 * file.
 */
const ASSETS_DIRECTORY = resolve(__dirname, '..', '..', 'assets', 'mail');

const FILE_ON: Record<EmailLogoBackground, string> = {
  dark: 'cloudgate-logo-on-dark.png',
  light: 'cloudgate-logo-on-light.png',
};

const loaded = new Map<EmailLogoBackground, Buffer>();

/** The logo as the one inline attachment an email's header references. */
export function emailLogoAttachment(on: EmailLogoBackground): MailAttachment {
  let content = loaded.get(on);
  if (!content) {
    content = readFileSync(resolve(ASSETS_DIRECTORY, FILE_ON[on]));
    loaded.set(on, content);
  }
  return {
    filename: 'cloudgate-logo.png',
    content,
    contentType: 'image/png',
    cid: EMAIL_LOGO_CID,
  };
}
