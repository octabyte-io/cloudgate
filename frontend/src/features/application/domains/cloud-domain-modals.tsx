import { useState } from "react";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  CloudDomainRemoval,
  CreateDomainInput,
  Domain,
  UpdateDomainInput,
} from "@/lib/api/endpoints/domains";
import { errorMessage } from "@/lib/api/error-message";

import { servedByWords } from "./cloud-domains-card";
import { useDeleteDomain } from "./use-domains";
import type { CloudDomainParent } from "./use-domains";

/**
 * Add or edit a Domain of a cloud Service: a host and a path, and
 * nothing Traefik-only — no certificate choice (it is always the Domain's
 * own ACM certificate, always HTTPS), no entrypoint, middlewares, strip path
 * or forward auth, which the API refuses on AWS anyway. A static site's
 * Domain (`cloudFront`) is its whole host on its CloudFront
 * distribution, so it takes no path.
 */
export function CloudDomainFormModal({
  domain,
  cloudFront = false,
  cloudRun = false,
  open,
  onOpenChange,
  create,
  update,
}: {
  /** `null` to add one. */
  domain: Domain | null;
  /** A static site on AWS: the Domain goes on its CloudFront distribution. */
  cloudFront?: boolean;
  /** A `web` on Cloud Run: the Domain is a rule on the Environment network. */
  cloudRun?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  create: (
    input: Omit<CreateDomainInput, "applicationId" | "domainType">,
  ) => Promise<Domain>;
  update: (domainId: string, input: UpdateDomainInput) => Promise<Domain>;
}) {
  const [host, setHost] = useState(domain?.host ?? "");
  const [path, setPath] = useState(domain?.path ?? "/");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [missing, setMissing] = useState<string | undefined>(undefined);

  async function save() {
    // Said under Host rather than by a disabled button.
    if (host.trim() === "") {
      setMissing("Enter the host to serve this site on.");
      return;
    }
    setMissing(undefined);
    setRefusal(null);
    setPending(true);
    try {
      const input = {
        host: host.trim(),
        path: cloudFront ? "/" : path.trim() || "/",
      };
      if (domain) await update(domain.domainId, input);
      else await create(input);
      toast.done(
        domain
          ? `${input.host} is changing on ${servedByWords(cloudFront)}.`
          : `${input.host} is being added; its DNS records appear in a moment.`,
      );
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={domain ? `Edit ${domain.host}` : "Add a domain"}
        description={
          cloudFront
            ? "Served over HTTPS by this site's CloudFront distribution, with its own ACM certificate, once it is issued. Cloudgate never writes DNS: you add the records it shows at your DNS provider."
            : cloudRun
              ? "Served over HTTPS by the Environment network's Google Cloud load balancer, with its own Google-managed certificate. A host takes one Domain. Cloudgate never writes DNS: you add the records it shows at your DNS provider."
              : "Served over HTTPS by the Environment's AWS load balancer, with its own ACM certificate. Cloudgate never writes DNS: you add the records it shows at your DNS provider."
        }
      />
      <Modal.Body>
        <div className="flex flex-col gap-4">
          <Field
            name="host"
            label="Host"
            error={missing}
            hint={
              cloudRun
                ? "An A record to the network's fixed IP, a bare name too."
                : "A subdomain gets a CNAME; a bare name an ALIAS, ANAME or flattened CNAME — never an A record."
            }
          >
            <Input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="shop.example.com"
              autoComplete="off"
            />
          </Field>
          {cloudFront ? null : (
            <Field name="path" label="Path" optional>
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/"
                autoComplete="off"
              />
            </Field>
          )}
          {domain && host.trim() !== domain.host ? (
            <p className="text-meta text-tx-2">
              A new host needs a new certificate and new DNS records.
            </p>
          ) : null}
        </div>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button
          type="button"
          variant="pri"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={save}
        >
          {domain ? "Save" : "Add domain"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * Remove a cloud Domain: its rule and certificate go in a short
 * Deployment. Cloudgate never wrote its DNS, so once removed the dialog
 * names the two records left at the DNS provider, to copy.
 */
export function CloudRemoveDomainModal({
  parent,
  domain,
  cloudFront = false,
  cloudRun = false,
  open,
  onOpenChange,
}: {
  parent: CloudDomainParent;
  domain: Domain | null;
  /** A static site on AWS: the host comes off its distribution. */
  cloudFront?: boolean;
  /** A `web` on Cloud Run: its rule comes off the Environment network. */
  cloudRun?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteDomain(parent);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [left, setLeft] = useState<CloudDomainRemoval["dnsRecordsLeft"] | null>(
    null,
  );

  if (!domain) return null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        setLeft(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={left ? `${domain.host} removed` : `Remove ${domain.host}?`}
        description={
          left
            ? `${cloudFront ? "It is" : "Its rule and certificate are"} being removed from ${cloudRun ? "Google Cloud" : "AWS"}. Cloudgate never writes DNS, so remove these records at your DNS provider.`
            : cloudFront
              ? "The host comes off the CloudFront distribution and its certificate is removed, in a short Deployment. The site still answers at its CloudFront name."
              : "Its rule and certificate are removed from the load balancer in a short Deployment."
        }
      />
      <Modal.Body>
        {left ? (
          <ul className="flex flex-col gap-2">
            {left.map((record) => (
              <li
                key={`${record.type}-${record.name}`}
                className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-panel-2 p-3 font-mono text-meta"
              >
                <span className="text-tx-2">{record.type}</span>
                <span className="truncate text-tx" title={record.name}>
                  {record.name}
                </span>
                <CopyButton value={record.name} label="record name" />
                <span className="text-tx-3">→</span>
                <span className="truncate text-tx-2" title={record.value}>
                  {record.value}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-tx-2">
            This {parent.composeId ? "stack" : "Service"} stops answering on{" "}
            <strong className="font-medium text-tx">{domain.host}</strong> once
            the run has removed {cloudFront ? "it" : "its rule"}.
          </p>
        )}
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        {left ? (
          <Modal.Close render={<Button type="button">Done</Button>} />
        ) : (
          <>
            <Modal.Close render={<Button type="button">Keep it</Button>} />
            <Button
              type="button"
              variant="dngr"
              disabled={remove.isPending}
              aria-busy={remove.isPending || undefined}
              onClick={async () => {
                setRefusal(null);
                try {
                  const removed = await remove.mutateAsync(domain.domainId);
                  setLeft(removed.dnsRecordsLeft ?? []);
                } catch (error) {
                  setRefusal(errorMessage(error));
                }
              }}
            >
              Remove domain
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
