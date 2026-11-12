import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * A password field you can read back.
 *
 * Worth the component rather than a bare `type="password"`: every one of these
 * screens asks someone to type a long string they cannot see, on a phone
 * keyboard, with the penalty for a typo being a refusal that names neither field
 * (a wrong password is deliberately not distinguished from a wrong address —
 * `auth-error.ts`). Being able to look is what turns that from a guess into a
 * check.
 *
 * Three details that are the whole job:
 *
 * - **The toggle is a real button, `type="button"`.** Inside a form, a bare
 *   `<button>` submits it, so revealing the password would sign you in.
 * - **It is not in the tab order between the field and the submit.** Reading the
 *   password back is a pointer-and-choice affordance; a keyboard user tabbing
 *   from password to "Sign in" should not land on an eye first. `tabIndex={-1}`,
 *   and it keeps its `aria-label` so it is still reachable to anyone who wants it.
 * - **Everything it is handed goes to the `<input>`.** `Field` clones its child
 *   with the `id`, the `aria-*` wiring and react-hook-form's registration
 *   (`name`, `onChange`, `onBlur`, `ref`), so a component that swallowed any of
 *   them would look right and be invisible to the form.
 */
export function PasswordInput({
  className,
  ref,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [shown, setShown] = React.useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        type={shown ? "text" : "password"}
        // Room for the toggle. Without it a long password runs under the eye.
        className={cn("pr-9.5", className)}
      />
      <Button
        type="button"
        variant="qt"
        size="icon-sm"
        tabIndex={-1}
        aria-pressed={shown}
        aria-label={shown ? "Hide password" : "Show password"}
        onClick={() => setShown((was) => !was)}
        className="absolute inset-y-0 right-1 my-auto text-tx-3"
      >
        <Icon name={shown ? "eyeOff" : "eye"} size={15} />
      </Button>
    </div>
  );
}
