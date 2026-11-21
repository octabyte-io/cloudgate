"use client";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { CopyButton } from "@/components/console/copy-button";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { OCTABYTE_CONTACT } from "@/lib/contact";
import { Icon } from "@/lib/design/icons";

import { HelpLinkList } from "./help-link-list";
import { ALL_DOCS, ANSWERS, GUIDES } from "./help-links";

/**
 * Help & support: where to read, and who to write to.
 *
 * Everything on it is static — the docs live on the public website and the
 * address is `OCTABYTE_CONTACT`, the one the billing and license screens
 * already name — so the screen fetches nothing and cannot fail.
 *
 * The guides are the main column because reading comes before writing; the
 * support address sits in the rail beside them, with the answers people most
 * often need before emailing (troubleshooting, the FAQ) under it.
 */
export function HelpScreen() {
  return (
    <Page>
      <PageHeader
        title="Help & support"
        icon="buoy"
        lede="Read the Cloudgate docs, or email support when you are stuck."
        actions={
          <LinkButton
            href={ALL_DOCS}
            reload
            target="_blank"
            rel="noreferrer noopener"
          >
            All docs
            <Icon name="ext" size={14} />
          </LinkButton>
        }
      />
      <Cols
        asideLabel="Support"
        aside={
          <>
            <Card>
              <Card.Header title="Contact support" headingLevel={2} />
              <Card.Body className="flex flex-col gap-3">
                <p className="text-meta text-tx-2">
                  Email us with your Organization name and what you were doing.
                </p>
                <div className="flex min-w-0 items-center gap-1.5">
                  <a
                    href={`mailto:${OCTABYTE_CONTACT}`}
                    className="min-w-0 truncate font-mono text-meta tracking-mono text-brand-tx underline-offset-2 hover:underline"
                  >
                    {OCTABYTE_CONTACT}
                  </a>
                  <CopyButton value={OCTABYTE_CONTACT} label="support email" />
                </div>
                <LinkButton
                  href={`mailto:${OCTABYTE_CONTACT}`}
                  reload
                  variant="pri"
                >
                  <Icon name="mail" size={14} />
                  Email support
                </LinkButton>
              </Card.Body>
            </Card>
            <Card>
              <Card.Header title="Common answers" headingLevel={2} />
              <Card.Body flush>
                <HelpLinkList links={ANSWERS} />
              </Card.Body>
            </Card>
          </>
        }
      >
        <Card>
          <Card.Header
            title="Guides"
            sub="Published on cloudgate.octabyte.io."
            headingLevel={2}
          />
          <Card.Body flush>
            <HelpLinkList links={GUIDES} />
          </Card.Body>
        </Card>
      </Cols>
    </Page>
  );
}
