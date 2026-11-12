import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { EmailHeader } from './email-header';
import { emailTailwindConfig } from './tailwind-config';

// The Frozen Organization's time-based emails (ADR-0052), in
// payment-failed.tsx's wordmark shell: a heading, the sentences that say what
// happened and what happens next, and one button to the console's billing page
// when there is still something to do there. The copy is composed by
// `renderLapseEmail` (index.ts); this only lays it out.

/**
 * Who an email goes to, which its footer says: an Organization's owners and
 * admins (the billing emails), its owners alone (the Bought Server and
 * suspension emails), or the instance's Operators.
 */
export type NoticeAudience = 'owners-and-admins' | 'owners' | 'operators';

const FOOTERS: Record<NoticeAudience, string> = {
  'owners-and-admins':
    "This is an automated email from Cloudgate about your Organization's billing. It goes to every owner and admin, and cannot be turned off.",
  owners:
    "This is an automated email from Cloudgate about your Organization's billing. It goes to every owner, and cannot be turned off.",
  operators:
    'This is an automated email to the Operators of this Cloudgate instance: every owner and admin of its Instance organization. It cannot be turned off.',
};

export type LapseNoticeProps = {
  userName: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  /** Whom it goes to, for the footer; every owner and admin by default. */
  audience?: NoticeAudience;
};

export const LapseNoticeTemplate = ({
  userName = 'User',
  heading = 'Your Cloudgate plan has ended',
  paragraphs = [],
  action,
  audience = 'owners-and-admins',
}: LapseNoticeProps) => (
  <Html>
    <Head />
    <Preview>{heading}</Preview>
    <Tailwind config={emailTailwindConfig}>
      <Body className="bg-[#f4f4f5] my-auto mx-auto font-sans">
        <Container className="my-[40px] mx-auto max-w-[520px]">
          <EmailHeader />

          <Section className="bg-white px-[40px] py-[32px]">
            <Heading className="text-[#09090b] text-[22px] font-semibold m-0 mb-[8px]">
              {heading}
            </Heading>
            <Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[16px]">
              Hello {userName},
            </Text>
            {paragraphs.map((paragraph) => (
              <Text
                key={paragraph}
                className="text-[#3f3f46] text-[14px] leading-[22px] m-0 mb-[16px]"
              >
                {paragraph}
              </Text>
            ))}
            {action ? (
              <>
                <Section className="text-center my-[24px]">
                  <Button
                    href={action.url}
                    className="bg-[#09090b] rounded-lg text-white text-[14px] font-semibold no-underline text-center px-[24px] py-[12px]"
                  >
                    {action.label}
                  </Button>
                </Section>
                <Text className="text-[#71717a] text-[12px] leading-[18px] m-0 text-center break-all">
                  {action.url}
                </Text>
              </>
            ) : null}
          </Section>

          <Section className="bg-[#fafafa] rounded-b-xl px-[40px] py-[24px] text-center border-t border-solid border-[#e4e4e7]">
            <Text className="text-[#a1a1aa] text-[12px] leading-[18px] m-0">
              {FOOTERS[audience]}
            </Text>
          </Section>
        </Container>
      </Body>
    </Tailwind>
  </Html>
);

export default LapseNoticeTemplate;
