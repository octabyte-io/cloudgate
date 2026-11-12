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

// The reset-password counterpart of verify-email.tsx, same shell and wordmark
// header. The copy matches what the /forgot-password screen already promises:
// the link lasts one hour and works once.

export type ResetPasswordProps = {
  userName: string;
  resetUrl: string;
};

export const ResetPasswordTemplate = ({
  userName = 'User',
  resetUrl,
}: ResetPasswordProps) => {
  const previewText = 'Set a new password for your Cloudgate account';
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
                Reset Your Password
              </Heading>
              <Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[24px]">
                Hello {userName}, someone asked for a new password for your
                Cloudgate account. Use the button below to choose one. The link
                is good for one hour and works once.
              </Text>

              {/* CTA Button */}
              <Section className="text-center mb-[24px]">
                <Button
                  href={resetUrl}
                  className="bg-[#09090b] rounded-lg text-white text-[14px] font-semibold no-underline text-center px-[24px] py-[12px]"
                >
                  Choose a New Password
                </Button>
              </Section>

              <Text className="text-[#a1a1aa] text-[13px] leading-[20px] m-0 text-center mb-[16px]">
                If the button above doesn&apos;t work, copy and paste the
                following link into your browser:
              </Text>
              <Text className="text-[#71717a] text-[12px] leading-[18px] m-0 text-center break-all">
                {resetUrl}
              </Text>
            </Section>

            {/* Footer */}
            <Section className="bg-[#fafafa] rounded-b-xl px-[40px] py-[24px] text-center border-t border-solid border-[#e4e4e7]">
              <Text className="text-[#a1a1aa] text-[12px] leading-[18px] m-0">
                This is an automated email from Cloudgate. If you didn&apos;t
                ask for a new password, you can safely ignore this email — your
                current one still works.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default ResetPasswordTemplate;
