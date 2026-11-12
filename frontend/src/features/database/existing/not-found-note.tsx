/**
 * The status an Existing database's or cache's page shows once a plan's
 * lookup found nothing under its identifier: "AWS cannot find
 * acme-prod", the backend's own sentence. Plans are refused until a lookup
 * finds it again, which clears it.
 */
export function NotFoundNote({
  notFound,
}: {
  notFound: { sentence: string; since: string } | null | undefined;
}) {
  if (!notFound) return null;
  return (
    <p
      role="status"
      className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-body font-medium text-tx"
    >
      {notFound.sentence}.{" "}
      <span className="font-normal text-tx-2">
        Plans are refused until it is found: check the identifier below, then
        Check for changes.
      </span>
    </p>
  );
}
