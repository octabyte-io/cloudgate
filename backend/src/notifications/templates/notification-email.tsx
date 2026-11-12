import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { EmailLogo } from '../../mail/templates/email-header';
import { emailTailwindConfig } from '../../mail/templates/tailwind-config';

// The one React Email template every notification event renders through:
// heading, intro line, a grey details box of label/value rows, and an
// optional action button, under the Cloudgate logo and wordmark. The header is
// white, unlike the transactional emails' dark one (mail/templates/
// email-header.tsx), so it takes the logo's deeper-violet variant; the image
// arrives as an inline attachment that renderEventEmail adds.

export type NotificationEmailProps = {
  previewText: string;
  heading: string;
  intro: string;
  details: { label: string; value: string }[];
  link?: { label: string; url: string };
};

export const NotificationEmailTemplate = ({
  previewText,
  heading,
  intro,
  details,
  link,
}: NotificationEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Tailwind config={emailTailwindConfig}>
        <Body className="bg-white my-auto mx-auto font-sans px-2">
          <Container className="border border-solid border-[#eaeaea] rounded-lg my-[40px] mx-auto p-[20px] max-w-[465px]">
            <Section className="mt-[32px] text-center">
              <EmailLogo on="light" />
              <Heading className="text-black text-[20px] font-semibold m-0">
                Cloudgate
              </Heading>
            </Section>
            <Heading className="text-black text-[24px] font-normal text-center p-0 my-[30px] mx-0">
              {heading}
            </Heading>
            <Text className="text-black text-[14px] leading-[24px]">
              Hello,
            </Text>
            <Text className="text-black text-[14px] leading-[24px]">
              {intro}
            </Text>
            <Section className="flex text-black text-[14px] leading-[24px] bg-[#F4F4F5] rounded-lg p-2">
              <Text className="!leading-3 font-bold">Details: </Text>
              {details.map((detail) => (
                <Text className="!leading-3" key={detail.label}>
                  {detail.label}: <strong>{detail.value}</strong>
                </Text>
              ))}
            </Section>
            {link ? (
              <>
                <Section className="text-center mt-[32px] mb-[32px]">
                  <Button
                    href={link.url}
                    className="bg-[#000000] rounded text-white text-[12px] font-semibold no-underline text-center px-5 py-3"
                  >
                    {link.label}
                  </Button>
                </Section>
                <Text className="text-black text-[14px] leading-[24px]">
                  or copy and paste this URL into your browser:{' '}
                  <Link href={link.url} className="text-blue-600 no-underline">
                    {link.url}
                  </Link>
                </Text>
              </>
            ) : null}
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default NotificationEmailTemplate;
