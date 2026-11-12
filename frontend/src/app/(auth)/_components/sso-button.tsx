import { useId, useState } from "react";

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { unwrap } from "@/lib/auth/auth-error";
import { signIn } from "@/lib/auth/client";
import { SELECT_ORGANIZATION_PATH, withNext } from "@/lib/auth/routes";
import { Icon } from "@/lib/design/icons";

/**
 * Sign in through the organization's identity provider.
 *
 * Rendered only when `GET /sso/show-sign-in` says so — which the backend answers
 * from `hasAnyValidLicense()`, so on an unlicensed instance this never appears at
 * all. That also means this is the one control on these screens that cannot be
 * driven without a licence; see the F06 notes in `00-INDEX.md`.
 *
 * The email is what identifies the provider: `POST /sign-in/sso` takes an address
 * and matches its domain against the ones an admin claimed for each provider.
 * Asking for it is not a step we invented — listing the providers needs a session,
 * so the address is the only unprivileged way to know which IdP to send someone to.
 *
 * The response is a URL to leave for, not a session: better-auth answers
 * `{ url, redirect: true }` and the browser has to go there itself.
 *
 * **`Label` and `Input` rather than `Field`.** This input belongs to this button,
 * not to the password form it is rendered beside — and `Field` registers its child
 * with any surrounding `FormProvider`, which would put an address this schema does
 * not have into that form and block the password submit until it was filled in.
 */
export function SsoButton({ next }: { next: string }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);

  async function go() {
    setPending(true);
    try {
      const result = await unwrap(
        signIn.sso({
          email,
          // Absolute, because the IdP sends the browser back here from its own
          // origin and a path would resolve against theirs.
          //
          // Through `/select-organization` rather than straight to `next`
          // this sign-in never returns to a form that could ask
          // `resolveOrganizationDestination`, and a session with several
          // memberships and no default starts in no Organization. That screen
          // asks when there is a question and forwards to `next` when there
          // is not.
          callbackURL: new URL(
            withNext(SELECT_ORGANIZATION_PATH, next),
            window.location.origin,
          ).toString(),
        }),
      );
      const url = (result as { url?: string }).url;
      if (!url) {
        throw new Error("The SSO endpoint did not return a URL to continue to");
      }
      window.location.assign(url);
    } catch (error) {
      setPending(false);
      toast.error(error);
    }
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="text-body font-medium text-tx">
        Work email
      </Label>
      <Input
        id={id}
        type="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="you@company.com"
        aria-describedby={`${id}-hint`}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-meta text-tx-2">
        We read the domain to find your identity provider.
      </p>
      <Button
        type="button"
        variant="gh"
        disabled={pending || email.trim() === ""}
        aria-busy={pending || undefined}
        onClick={() => void go()}
        className="mt-0.5 w-full"
      >
        <Icon name="shield" size={15} />
        Continue with SSO
      </Button>
    </div>
  );
}
