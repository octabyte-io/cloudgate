import { Heading, Img, Section } from '@react-email/components';
import {
  EMAIL_LOGO_CID,
  EMAIL_LOGO_HEIGHT,
  EMAIL_LOGO_WIDTH,
} from '../email-logo';
import type { EmailLogoBackground } from '../email-logo';

/**
 * The logo mark, centred above the wordmark. It points at the inline
 * attachment by `cid:` (why, in `email-logo.ts`); the fixed size and the
 * "Cloudgate" alt text keep the header's shape when a client blocks images,
 * and the wordmark under it still says whose email this is.
 */
export const EmailLogo = ({ on }: { on: EmailLogoBackground }) => (
  <Img
    src={`cid:${EMAIL_LOGO_CID}`}
    alt="Cloudgate"
    width={EMAIL_LOGO_WIDTH}
    height={EMAIL_LOGO_HEIGHT}
    style={{
      display: 'block',
      margin: '0 auto 12px',
      color: on === 'dark' ? '#ffffff' : '#000000',
    }}
  />
);

/**
 * The transactional emails' header: the logo and the "Cloudgate" wordmark on
 * the dark band at the top of the card. One copy for all six templates, which
 * each had their own.
 */
export const EmailHeader = () => (
  <Section className="bg-[#09090b] rounded-t-xl px-[40px] py-[32px] text-center">
    <EmailLogo on="dark" />
    <Heading className="text-white text-[24px] font-semibold m-0">
      Cloudgate
    </Heading>
  </Section>
);
