import { Card } from "@/components/console/card";

/**
 * What a Deployment actually does, in the rail beside the list
 * (the reference's aside at `e-console.html:4218-4227`).
 *
 * It stays because the vocabulary distinction at the end of it is real and this
 * is the one screen where it gets confused: **a build is a phase of a Deployment,
 * not another word for one.** Someone reading "5 deployments, 2 failed" needs to
 * know whether the failure was the build or the release, and the four steps are
 * where that question is answered.
 *
 * The steps are the ones this backend runs, in this order —
 * `deployment-engine.service.ts` composes exactly these commands, and the push
 * step is conditional on a registry being set, which is why it says so — and
 * never runs for a Docker-image source, which is released by the operator's
 * own reference and builds nothing to push.
 *
 * **Phase 4 waits, and it is the one phase that can end three ways.** It did not
 * always: at first `mechanize.ts` awaited the Docker API *accepting* the spec
 * and returned, and the Deployment was stamped `done` while the Service was
 * still converging — so this card said "its tasks converge afterwards" and
 * nothing anywhere said whether they had. A later change added the poll
 * (`deployment-engine/await-convergence.ts`), and the three endings listed
 * under phase 4 are the same three lines that poll writes into the log well
 * beside this card — deliberately, so the card explains what the operator is
 * about to read rather than paraphrasing it.
 *
 * The wait is **bounded by the Service's own spec** — replicas, update
 * parallelism, health check — and capped, so this card promises a wait and not a
 * guarantee. That is why the third ending exists at all: a Deployment whose
 * budget ran out with nothing converged and nothing failed is still `done`, and
 * its status pill in the list is still green. The distinction lives here and in
 * the log, because a failure is never invented from a clock.
 */
export function PhasesCard() {
  return (
    <Card>
      <Card.Header title="Phases of a Deployment" headingLevel={2} />
      <Card.Body>
        <ol className="flex flex-col gap-2.5 text-body text-tx-2">
          <Phase n={1} title="Clone">
            The source is fetched at the commit being deployed.
          </Phase>
          <Phase n={2} title="Build">
            The builder turns the code into an image. A Docker-image source skips
            this entirely.
          </Phase>
          <Phase n={3} title="Push">
            The built image goes to the registry, if one is set. Without a
            registry it stays on the Server that built it. A Docker-image source
            pushes nothing — every Server pulls its image for itself.
          </Phase>
          <Phase n={4} title="Update">
            The Swarm service is updated, and the Deployment waits for its tasks
            to be running before it reports. The wait ends one of three ways, and
            the log says which:
            <ul className="mt-1.5 flex flex-col gap-1 text-meta text-tx-2">
              <Ending marker="✅">
                the tasks are running, and the Deployment is done.
              </Ending>
              <Ending marker="❌">
                Swarm rolled it back to its previous spec, and the Deployment
                failed — the image built, but what is serving is the Deployment
                before this one.
              </Ending>
              <Ending marker="⚠️">
                the wait ran out with neither. The Deployment is still done,
                because a slow Service is not a failed one, but its tasks were
                never confirmed running.
              </Ending>
            </ul>
          </Phase>
        </ol>
        <p className="mt-3.5 text-meta text-tx-2">
          A <strong className="font-medium text-tx">build</strong> is a phase of a
          Deployment, not another word for one — which is why a failed Deployment
          can still be serving the one before it.
        </p>
      </Card.Body>
    </Card>
  );
}

function Phase({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.25 grid size-5 flex-none place-items-center rounded-pill border border-line bg-panel-2 text-chip text-tx-3"
      >
        {n}
      </span>
      {/* A div, not a span: phase 4 carries a list of its endings, and flow
          content inside a span is invalid however well it renders. */}
      <div className="min-w-0">
        <strong className="font-medium text-tx">{title}</strong> {children}
      </div>
    </li>
  );
}

/**
 * One way phase 4 can end. The marker is the **same glyph the backend prints**
 * into the deployment log (`await-convergence.ts`), not a decoration chosen
 * here: `log-tones.ts` already tones the log well on those three characters, so
 * an operator reading this card and then the log is matching like for like.
 */
function Ending({
  marker,
  children,
}: {
  marker: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-1.5">
      {/* Not aria-hidden, unlike the phase numbers: the ordered list already
          conveys those, while these three glyphs are the distinction itself. */}
      <span className="flex-none">{marker}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
