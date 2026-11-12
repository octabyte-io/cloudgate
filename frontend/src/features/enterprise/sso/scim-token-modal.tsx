import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { SCIM_BASE_PATH, type ScimTokenIssued } from "@/lib/api/endpoints/scim";

/**
 * The second state: the three values the identity provider needs, once.
 *
 * **The token is here and nowhere else, ever.** `listProviders` projects it away,
 * the column is encrypted at rest, and nothing regenerates one — replacing it
 * means deleting the provider and creating another, which stops whatever is
 * already provisioning. F16 established this treatment for an API key and an
 * invitation link, and the argument is the same: the dialog holds the only copy,
 * so it says so where the copy button is rather than in a toast that has already
 * gone.
 *
 * ## The base URL is read off the browser, not configured
 *
 * The IdP-facing half of SCIM is better-auth's own `/api/auth/scim/v2` surface,
 * which this app proxies on **its own origin** — `lib/config.ts` explains why
 * that has to be true: `BETTER_AUTH_URL` is this app's origin, or better-auth
 * refuses the requests. So `window.location.origin` is not a convenient guess,
 * it is the same value by construction, and reading it beats introducing a
 * setting that could disagree with reality.
 *
 * `keepOpen` is deliberately **not** set. `design-system.md` keeps it for a
 * value no route hands out again — the backup codes, a new personal key, an
 * Agent's first key. This is close — the same "only copy" argument — but a SCIM
 * token can be replaced by deleting a provider nobody has connected yet.
 */
export function ScimTokenModal({
  issued,
  onClose,
}: {
  issued: ScimTokenIssued;
  onClose: () => void;
}) {
  // Rendered inside a dialog opened by a click, so there is no server render to
  // disagree with — F07's fourth defect is about values that differ between the
  // two, and this component never has a first one.
  const baseUrl =
    typeof window === "undefined"
      ? SCIM_BASE_PATH
      : `${window.location.origin}${SCIM_BASE_PATH}`;

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={`${issued.providerId} is connected`}
        description="Paste these into your identity provider now. The token is not shown again."
      />
      <Modal.Body className="grid min-w-0 gap-3.5">
        <div className="rounded-lg border border-warn-line bg-warn-tint p-3 text-ui text-tx">
          This is the only time Cloudgate will show you this token. Closing this
          dialog without copying it means deleting the provider and creating
          another one.
        </div>

        {/*
          **`min-w-0` on the row, and it is load-bearing** — found by driving it.
          A SCIM token is one unbreakable ~90-character string, and `truncate`
          only takes effect when every ancestor will actually shrink. This row is
          a grid item, whose default `min-width: auto` is the content's intrinsic
          width, so the flex row grew to fit the token and the whole dialog
          scrolled sideways with its labels cut off. F13 paid for this once
          already with an SSH public key in a `Field`; the rule is the same and it
          has to be on the *ancestor*, not the `<code>`.
        */}
        <div className="grid min-w-0 gap-1.5">
          <p className="text-meta font-medium text-tx-3">Bearer token</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-ui text-tx">
              {issued.scimToken}
            </code>
            <CopyButton value={issued.scimToken} label="SCIM token" />
          </div>
        </div>

        <KVList>
          <KVRow
            label="SCIM base URL"
            mono
            title={baseUrl}
            value={baseUrl}
            action={<CopyButton value={baseUrl} label="SCIM base URL" size="icon-xs" />}
          />
          <KVRow
            label="Provider id"
            mono
            value={issued.providerId}
            title={issued.providerId}
          />
        </KVList>

        <p className="text-meta text-tx-2">
          Your identity provider sends the token as{" "}
          <code className="font-mono">Authorization: Bearer …</code>. Users it
          creates are linked to this provider id, so changing the id later is not
          possible — there is no update route, and a new one would orphan every
          account already provisioned.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="pri" onClick={onClose}>
          I have copied it
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
