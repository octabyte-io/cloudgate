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

// The email-verification message: the logo-and-wordmark header
// (email-header.tsx), a button to the verification link, and the same link as
// text for when the button does not work.

export type VerifyEmailProps = {
  userName: string;
  verificationUrl: string;
  /**
   * A new account's address, or the new address a signed-in person asked to
   * move their account to — the same link, different words.
   */
  purpose?: 'sign-up' | 'email-change';
};

export const VerifyEmailTemplate = ({
  userName = 'User',
  verificationUrl,
  purpose = 'sign-up',
}: VerifyEmailProps) => {
  const changing = purpose === 'email-change';
  const previewText = changing
    ? 'Confirm the new email address for your Cloudgate account'
    : 'Verify your email address to get started with Cloudgate';
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
                {changing ? 'Confirm Your New Email' : 'Verify Your Email'}
              </Heading>
              {changing ? (
                <Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[24px]">
                  Hello {userName}, you asked to sign in to Cloudgate with this
                  address. Your account keeps its current address until you
                  confirm this one.
                </Text>
              ) : (
                <Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[24px]">
                  Hello {userName}, thank you for signing up for Cloudgate.
                  Please verify your email address to activate your account.
                </Text>
              )}

              {/* CTA Button */}
              <Section className="text-center mb-[24px]">
                <Button
                  href={verificationUrl}
                  className="bg-[#09090b] rounded-lg text-white text-[14px] font-semibold no-underline text-center px-[24px] py-[12px]"
                >
                  {changing ? 'Confirm New Address' : 'Verify Email Address'}
                </Button>
              </Section>

              <Text className="text-[#a1a1aa] text-[13px] leading-[20px] m-0 text-center mb-[16px]">
                If the button above doesn&apos;t work, copy and paste the
                following link into your browser:
              </Text>
              <Text className="text-[#71717a] text-[12px] leading-[18px] m-0 text-center break-all">
                {verificationUrl}
              </Text>
            </Section>

            {/* Footer */}
            <Section className="bg-[#fafafa] rounded-b-xl px-[40px] py-[24px] text-center border-t border-solid border-[#e4e4e7]">
              <Text className="text-[#a1a1aa] text-[12px] leading-[18px] m-0">
                {changing
                  ? "This is an automated email from Cloudgate. If you didn't ask for this change, you can safely ignore this email."
                  : "This is an automated email from Cloudgate. If you didn't create an account, you can safely ignore this email."}
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default VerifyEmailTemplate;
