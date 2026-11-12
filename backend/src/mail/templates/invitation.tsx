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

// The organization-invitation counterpart of reset-password.tsx, same shell and
// wordmark header.
//
// It says who invited them, into what, and as what, because an invitation to an
// unnamed organization from an unnamed person reads like a phishing attempt. The
// link is `/accept-invitation/<id>` on the console's own origin: the one address
// that already works, and the same one the invite dialog offers to copy.

export type InvitationProps = {
  /** The organization they are being invited into. */
  organizationName: string;
  /** Who invited them — their name, or their address when the name is blank. */
  invitedBy: string;
  /** The role the invitation carries, better-auth's own vocabulary. */
  role: string;
  /** `<origin>/accept-invitation/<invitation id>`. */
  acceptUrl: string;
};

export const InvitationTemplate = ({
  organizationName,
  invitedBy,
  role,
  acceptUrl,
}: InvitationProps) => {
  const previewText = `Join ${organizationName} on Cloudgate`;
  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Tailwind config={emailTailwindConfig}>
        <Body className="bg-[#f4f4f5] my-auto mx-auto font-sans">
          <Container className="my-[40px] mx-auto max-w-[520px]">
            {/* Header */}
            <EmailHeader />

            {/* Body */}
            <Section className="bg-white px-[40px] py-[32px]">
              <Heading className="text-[#09090b] text-[22px] font-semibold m-0 mb-[8px]">
                Join {organizationName}
              </Heading>
              <Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[24px]">
                {invitedBy} invited you to {organizationName} on Cloudgate as{' '}
                {role}. Use the button below to accept — you can create an
                account from the invitation if you do not have one. The link is
                good for 48 hours.
              </Text>

              {/* CTA Button */}
              <Section className="text-center mb-[24px]">
                <Button
                  href={acceptUrl}
                  className="bg-[#09090b] rounded-lg text-white text-[14px] font-semibold no-underline text-center px-[24px] py-[12px]"
                >
                  Accept Invitation
                </Button>
              </Section>

              <Text className="text-[#a1a1aa] text-[13px] leading-[20px] m-0 text-center mb-[16px]">
                If the button above doesn&apos;t work, copy and paste the
                following link into your browser:
              </Text>
              <Text className="text-[#71717a] text-[12px] leading-[18px] m-0 text-center break-all">
                {acceptUrl}
              </Text>
            </Section>

            {/* Footer */}
            <Section className="bg-[#fafafa] rounded-b-xl px-[40px] py-[24px] text-center border-t border-solid border-[#e4e4e7]">
              <Text className="text-[#a1a1aa] text-[12px] leading-[18px] m-0">
                This is an automated email from Cloudgate. If you were not
                expecting an invitation to {organizationName}, you can safely
                ignore this email — nothing happens until you accept.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default InvitationTemplate;
