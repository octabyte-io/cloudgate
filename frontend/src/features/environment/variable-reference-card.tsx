import { Card } from "@/components/console/card";

/**
 * How a variable reaches a service, and why setting one here is not enough on
 * its own.
 *
 * The reference's Inheritance aside (`e-console.html:4018-4024`) is about
 * *runtime* inheritance, which does not exist — `environment.runtime` is not a
 * column. **F19 rewrote this card because the thing it replaced it with did not
 * exist either.**
 *
 * The original said the Project sets what every Environment starts with, the
 * Environment layers its own over those, and a service layers its own over both.
 * None of that happens. `prepareEnvironmentVariables` (`docker/docker.utils.ts`)
 * maps over the **service's own** blob and returns only that; the Project and
 * Environment blobs are *interpolation sources* for `${{project.KEY}}` and
 * `${{environment.KEY}}`, and are never merged. Reproduced against the real
 * function: a key set only on a Project resolves to nothing.
 *
 * That is a costly sentence to get wrong, because it fails silently and in the
 * one direction nobody checks: an operator sets `DATABASE_URL` once on the
 * Project, reads this card, and ships a container that never receives it. So the
 * consequence is now stated outright — *a key nobody references reaches no
 * container* — rather than left to be inferred from "is not added to them".
 * F11's Variables tab said "not inherited" and showed the reference form rather
 * than describing it; this says the same thing in the same words.
 *
 * **Renamed off `InheritanceCard` / `inheritance-card.tsx`.** The name was the
 * last thing in this file still asserting the merge, and the one part of the
 * rename a grep for "inherit" could not tell apart from the copy it was about.
 *
 * **It renders on the Variables tab only, and in three sentences**. It
 * used to sit on the Services tab too, beside a list with no variables on it,
 * as a bulleted design note. What is left is the rule ("only its own"), the
 * form a reference takes, and what fails. "A key nobody references reaches no
 * container" is said by the meta strip on the variables it is about.
 * Encryption at rest went: nothing on the screen asks about it.
 */
export function VariableReferenceCard() {
  return (
    <Card>
      <Card.Header
        title="How variables reach a service"
        sub="By reference, not by inheritance."
        headingLevel={2}
      />
      <Card.Body>
        <p className="text-ui text-tx-2">
          A service is deployed with{" "}
          <strong className="font-medium text-tx">only its own</strong>{" "}
          variables. To use one set on the Environment or the Project, it names
          it:
        </p>
        <pre className="mt-1.5 overflow-x-auto rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-meta text-tx">
          <code>{"CACHE_URL=${{environment.REDIS_URL}}"}</code>
        </pre>
        <p className="mt-3 text-meta text-tx-2">
          An unset name fails the deploy. A change reaches a service on its
          next deployment.
        </p>
      </Card.Body>
    </Card>
  );
}
