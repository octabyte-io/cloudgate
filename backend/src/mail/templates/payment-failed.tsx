import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { EmailHeader } from './email-header';
import { emailTailwindConfig } from './tailwind-config';

// The failed-payment message, in invoice-notification.tsx's wordmark shell:
// invoice number, date and amount due, the warning that a payment still failing
// after Stripe's retries freezes the Organization (ADR-0052), and a link to the
// hosted invoice to update payment. Sent to every owner and admin, never
// opt-in.

export type PaymentFailedProps = {
  userName: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  date: string;
  hostedInvoiceUrl: string;
};

export const PaymentFailedTemplate = ({
  userName = 'User',
  invoiceNumber = 'INV-0001',
  amountDue = '$4.50',
  currency = 'usd',
  date = '2026-01-01',
  hostedInvoiceUrl = 'https://invoice.stripe.com/example',
}: PaymentFailedProps) => {
  const previewText = `Action required: Your Cloudgate payment for ${amountDue} failed`;
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
                Payment Failed
              </Heading>
              <Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[24px]">
                Hello {userName}, we were unable to process your payment. Please
                update your payment method to avoid service interruption.
              </Text>

              {/* Invoice details */}
              <Section className="border border-solid border-[#e4e4e7] rounded-lg overflow-hidden mb-[24px]">
                <Row className="bg-[#fafafa]">
                  <Column className="px-[20px] py-[14px] w-[50%]">
                    <Text className="text-[#71717a] text-[12px] font-medium uppercase tracking-wider m-0">
                      Invoice No.
                    </Text>
                    <Text className="text-[#09090b] text-[14px] font-semibold m-0 mt-[4px]">
                      {invoiceNumber}
                    </Text>
                  </Column>
                  <Column className="px-[20px] py-[14px] w-[50%]">
                    <Text className="text-[#71717a] text-[12px] font-medium uppercase tracking-wider m-0">
                      Date
                    </Text>
                    <Text className="text-[#09090b] text-[14px] font-semibold m-0 mt-[4px]">
                      {date}
                    </Text>
                  </Column>
                </Row>
                <Hr className="border-[#e4e4e7] m-0" />
                <Row>
                  <Column className="px-[20px] py-[14px]">
                    <Text className="text-[#71717a] text-[12px] font-medium uppercase tracking-wider m-0">
                      Amount Due
                    </Text>
                    <Text className="text-[#09090b] text-[20px] font-bold m-0 mt-[4px]">
                      {amountDue}{' '}
                      <span className="text-[#71717a] text-[12px] font-normal uppercase">
                        {currency}
                      </span>
                    </Text>
                  </Column>
                </Row>
              </Section>

              {/* Warning */}
              <Section className="bg-[#fefce8] border border-solid border-[#fef08a] rounded-lg px-[20px] py-[16px] mb-[24px]">
                <Text className="text-[#854d0e] text-[13px] leading-[20px] m-0">
                  Stripe will try again over the next two weeks, and nothing has
                  stopped. If the payment still fails, your Organization is
                  frozen: its Services keep running, but Cloudgate starts no
                  deploys, Cron runs, backups or Uptime checks for it, and 30
                  days later it is deleted.
                </Text>
              </Section>

              <Section className="text-center mb-[24px]">
                <Button
                  href={hostedInvoiceUrl}
                  className="bg-[#dc2626] rounded-lg text-white text-[14px] font-semibold no-underline text-center px-[24px] py-[12px]"
                >
                  Update Payment Method
                </Button>
              </Section>

              <Text className="text-[#71717a] text-[12px] leading-[18px] m-0 text-center break-all">
                {hostedInvoiceUrl}
              </Text>
            </Section>

            {/* Footer */}
            <Section className="bg-[#fafafa] rounded-b-xl px-[40px] py-[24px] text-center border-t border-solid border-[#e4e4e7]">
              <Text className="text-[#a1a1aa] text-[12px] leading-[18px] m-0">
                This is an automated email from Cloudgate about your billing.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default PaymentFailedTemplate;
