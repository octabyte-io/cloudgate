import { Controller, useFormContext } from "react-hook-form";

import { Field } from "@/components/console/field";
import { lockedProps } from "@/components/console/resource-field";
import { Segmented } from "@/components/console/segmented";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import type { PathSpec } from "./providers";
import type { GitSourceValues } from "./git-source-values";

/**
 * What to build from the chosen branch, and — where a push can deploy it at
 * all — what a push should do about it.
 *
 * These three are the half of the form that no provider changes — only the path's
 * label and column vary, and `PathSpec` in `providers.ts` says why.
 */
export function GitSourceBuildFields({
  path,
  pushDeploys,
  locked,
}: {
  path: PathSpec;
  /** Why the path is not this form's to change. */
  locked?: string;
  /**
   * Whether a push from this source can deploy this row at all —
   * `pushCanDeploy`, the rule the Source card reads. Where it cannot,
   * Deploy on and Deploy automatically would be switches over a trigger that
   * does not exist, so the card's answer is said instead. The row's saved
   * `triggerType` and `autoDeploy` still ride along in the form untouched.
   */
  pushDeploys: boolean;
}) {
  const form = useFormContext<GitSourceValues>();

  const pathField = (
    <Field name="buildPath" label={path.label} hint={path.hint}>
      <Input
        placeholder={path.placeholder}
        {...lockedProps(locked)}
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  );

  if (!pushDeploys) {
    return (
      <>
        {pathField}
        <p className="text-meta text-tx-2">
          Deploys on: Nothing — deploys are manual. No push from this source
          reaches Cloudgate yet, so every deploy is one someone starts.
        </p>
      </>
    );
  }

  return (
    <>
      {pathField}

      {/* Tag stays offered rather than dropped so a row saved with it still
          reads as what it is and can be moved to Push; the hint says plainly
          that it deploys nothing, as the card does. */}
      <Field
        name="triggerType"
        label="Deploy on"
        hint="Push deploys on a push to the branch above. A new tag deploys nothing yet: a tag push names no branch, so with Tag every deploy is one someone starts."
        manual
      >
        <Controller
          name="triggerType"
          control={form.control}
          render={({ field }) => (
            <Segmented<"push" | "tag">
              label="Deploy on"
              value={field.value}
              onChange={(next) => field.onChange(next)}
              options={[
                { value: "push", label: "Push" },
                { value: "tag", label: "Tag" },
              ]}
            />
          )}
        />
      </Field>

      <Field
        name="autoDeploy"
        label="Deploy automatically"
        hint="Off means a push builds nothing; the next deploy waits until someone presses Deploy."
        orientation="horizontal"
        manual
      >
        <Controller
          name="autoDeploy"
          control={form.control}
          render={({ field }) => (
            <Switch
              checked={field.value}
              onCheckedChange={(next) => field.onChange(next)}
            />
          )}
        />
      </Field>
    </>
  );
}
