import Link from "next/link";

import { Banner, BannerRow } from "@/components/console/banner";

/**
 * "Deploy to pick up the new value": a source's Output this
 * Service links to changed outside a plan — a login edited in the console,
 * a link saved — and the running container still has the value it started
 * with. Nothing was deployed for it; the next deploy builds the variable
 * again and the notice goes.
 */
export function WiredChangedNotice({
  wiredChangedAt,
  deploymentsHref,
}: {
  wiredChangedAt: string | null | undefined;
  /** Where this Service is deployed from, when it has such a tab. */
  deploymentsHref?: string;
}) {
  if (!wiredChangedAt) return null;
  return (
    <Banner icon="info" title="A wired variable has a new value.">
      <BannerRow
        tone="warn"
        title="Deploy to pick up the new value."
        description="A linked Output changed since this Service last deployed. The running container keeps the value it started with until the next deploy."
        action={
          deploymentsHref ? (
            <Link
              href={deploymentsHref}
              className="text-body font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
            >
              Go to Deployments
            </Link>
          ) : undefined
        }
      />
    </Banner>
  );
}
