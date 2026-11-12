import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudDomainView, Domain } from "@/lib/api/endpoints/domains";

import { CloudDomainsCard, timeLeft } from "./cloud-domains-card";

afterEach(cleanup);

const ALB = "cg-1.eu-central-1.elb.amazonaws.com";

function domainWith(
  cloud: Partial<CloudDomainView>,
  host = "shop.example.com",
) {
  return {
    domainId: "d1",
    host,
    path: "/",
    https: true,
    certificateType: "none",
    cloud: {
      status: "waiting-for-dns",
      failure: null,
      requestedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 41.5 * 3_600_000).toISOString(),
      loadBalancer: ALB,
      records: {
        validation: {
          name: `_abc.${host}.`,
          type: "CNAME",
          value: "_def.acm-validations.aws.",
          seen: true,
        },
        pointing: {
          name: host,
          type: "CNAME",
          value: ALB,
          seen: false,
          note: "A CNAME to the load balancer — never an A record",
        },
      },
      ...cloud,
    },
  } as unknown as Domain;
}

function renderCard(
  domains: Domain[],
  site: {
    cloudFront?: boolean;
    cloudRun?: boolean;
    cloudCdn?: boolean;
    stackVm?: boolean;
    generated?: string | null;
  } = {},
) {
  const client = new QueryClient();
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <CloudDomainsCard
      parent={{ applicationId: "a1" }}
      domains={domains}
      {...site}
      onAdd={vi.fn()}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
    />,
    { wrapper: wrap },
  );
}

describe("CloudDomainsCard", () => {
  it("shows Waiting for DNS with both records to copy, ticked when seen, and the time left", () => {
    const { container, getByText, getByLabelText } = renderCard([
      domainWith({}),
    ]);
    expect(getByText("Waiting for DNS")).toBeTruthy();
    expect(getByText("_abc.shop.example.com.")).toBeTruthy();
    expect(getByText(ALB)).toBeTruthy();
    expect(getByLabelText("Seen in DNS")).toBeTruthy();
    expect(getByLabelText("Not seen in DNS yet")).toBeTruthy();
    expect(container.textContent).toContain("41 hours left of 72 hours");
  });

  it("says Checking can take up to 30 minutes", () => {
    const { getByText } = renderCard([domainWith({ status: "checking" })]);
    expect(getByText("Checking")).toBeTruthy();
    expect(getByText(/this can take up to 30 minutes/)).toBeTruthy();
  });

  it("offers Ask again on a failed certificate, saying why it failed", () => {
    const { getByText, getByRole } = renderCard([
      domainWith({
        status: "failed",
        failure: "ACM ended the certificate FAILED (CAA_ERROR)",
      }),
    ]);
    expect(getByText("Failed")).toBeTruthy();
    expect(getByText(/CAA_ERROR/)).toBeTruthy();
    expect(getByRole("button", { name: "Ask again" })).toBeTruthy();
    expect(
      getByText(/or edit or remove the Domain if the host itself is wrong/),
    ).toBeTruthy();
  });

  it("offers no edit-or-remove hint under a Domain that has not failed", () => {
    const { queryByText } = renderCard([
      domainWith({ status: "waiting-for-dns" }),
    ]);
    expect(queryByText(/if the host itself is wrong/)).toBeNull();
  });

  it("shows a live Domain without its records once its host points at the load balancer", () => {
    const live = domainWith({ status: "live" });
    live.cloud!.records!.pointing.seen = true;
    const { getByText, queryByText } = renderCard([live]);
    expect(getByText("Live")).toBeTruthy();
    expect(queryByText("_abc.shop.example.com.")).toBeNull();
  });

  it("shows a bare name its ALIAS instruction", () => {
    const bare = domainWith({}, "example.com");
    bare.cloud!.records!.pointing = {
      ...bare.cloud!.records!.pointing,
      type: "ALIAS",
      note: "example.com is a bare name: make it an ALIAS, ANAME or flattened CNAME — never an A record",
    };
    const { getByText } = renderCard([bare]);
    expect(getByText(/never an A record/)).toBeTruthy();
  });
});

describe("CloudDomainsCard on a static site", () => {
  const CLOUDFRONT = "d111111abcdef8.cloudfront.net";

  it("shows the distribution's name as the generated Domain, before any Domain", () => {
    const { getByText, container } = renderCard([], {
      cloudFront: true,
      generated: CLOUDFRONT,
    });
    expect(getByText(`https://${CLOUDFRONT}`)).toBeTruthy();
    expect(getByText("Generated")).toBeTruthy();
    expect(container.textContent).toContain("takes one Domain");
    expect(container.textContent).toContain("reached at its CloudFront name");
  });

  it("says the Domain's record points at the CloudFront distribution", () => {
    const { getByText } = renderCard(
      [domainWith({ loadBalancer: CLOUDFRONT, servedBy: "cloudfront" })],
      { cloudFront: true, generated: CLOUDFRONT },
    );
    expect(
      getByText(/Points the host at the CloudFront distribution/),
    ).toBeTruthy();
  });

  it("shows no generated Domain on a web", () => {
    const { queryByText } = renderCard([], { generated: CLOUDFRONT });
    expect(queryByText("Generated")).toBeNull();
  });
});

describe("CloudDomainsCard on a static site on Google Cloud", () => {
  it("says it answers nowhere until a Domain is added, with no generated Domain", () => {
    const { queryByText, container } = renderCard([], { cloudCdn: true });
    expect(queryByText("Generated")).toBeNull();
    expect(container.textContent).toContain(
      "Until one is added this site answers nowhere",
    );
    expect(container.textContent).not.toContain("CloudFront");
    expect(container.textContent).not.toContain("AWS");
  });
});

describe("CloudDomainsCard on a web on Cloud Run (S11)", () => {
  const RUN_APP = "cloudgate-abc-6qzq3k7vqa-ew.a.run.app";

  it("shows its run.app address as the generated Domain, before any Domain", () => {
    const { getByText, container } = renderCard([], {
      cloudRun: true,
      generated: RUN_APP,
    });
    expect(getByText(`https://${RUN_APP}`)).toBeTruthy();
    expect(getByText("Generated")).toBeTruthy();
    expect(container.textContent).toContain("Cloud Run’s own address");
    expect(container.textContent).toContain("reached at its run.app address");
    expect(container.textContent).not.toContain("CloudFront");
  });

  it("shows no generated Domain before its first deploy has applied", () => {
    const { queryByText } = renderCard([], { cloudRun: true, generated: null });
    expect(queryByText("Generated")).toBeNull();
  });

  it("names Certificate Manager and an A record to the fixed IP, never ACM", () => {
    const ip = "34.120.0.7";
    const { container, getByText } = renderCard(
      [
        domainWith({
          loadBalancer: ip,
          servedBy: "fixed-ip",
          records: {
            validation: {
              name: "_acme-challenge.shop.example.com.",
              type: "CNAME",
              value: "abc.1.authorize.certificatemanager.goog.",
              seen: false,
            },
            pointing: {
              name: "shop.example.com",
              type: "A",
              value: ip,
              seen: false,
              note: "An A record to the load balancer's fixed IP, which stays as long as the Environment network does",
            },
          },
        }),
      ],
      { cloudRun: true, generated: "x.a.run.app" },
    );
    expect(getByText(ip)).toBeTruthy();
    expect(container.textContent).toContain(
      "Authorization, for Certificate Manager",
    );
    expect(container.textContent).toContain("Certificate Manager checks");
    expect(container.textContent).toContain("Environment network");
    expect(container.textContent).not.toContain("ACM");
  });
});

describe("CloudDomainsCard, a stack on its Stack VM (#1371)", () => {
  it("shows each Domain's service and port, and its DNS records, with no generated host", () => {
    const stackDomain = {
      ...domainWith({}),
      serviceName: "web",
      port: 2368,
    } as unknown as Domain;
    const { container, getByText } = renderCard([stackDomain], {
      stackVm: true,
    });
    expect(getByText("→ web on port 2368")).toBeTruthy();
    expect(container.textContent).toContain("A Stack VM has no generated host");
    expect(getByText(ALB)).toBeTruthy();
    expect(container.textContent).toContain("Validation, for ACM");
    expect(container.textContent).not.toContain("Generated");
  });

  it("says, before any Domain, that the stack is reached only inside the network", () => {
    const { container } = renderCard([], { stackVm: true });
    expect(container.textContent).toContain(
      "A Stack VM has no generated host and no public address",
    );
  });
});

describe("timeLeft", () => {
  it("counts hours, then minutes", () => {
    const now = new Date("2026-10-17T10:00:00Z");
    expect(timeLeft("2026-10-18T12:30:00Z", now)).toBe("26 hours left");
    expect(timeLeft("2026-10-17T10:20:00Z", now)).toBe("20 minutes left");
    expect(timeLeft("2026-10-17T09:00:00Z", now)).toBe("no time left");
  });
});
