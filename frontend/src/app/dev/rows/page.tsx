import type { Metadata } from "next";

import { Card } from "@/components/console/card";
import { PageHeader } from "@/components/console/page-header";
import { ThemeToggle } from "@/components/console/theme-toggle";

import { Gallery } from "./_components/gallery";

export const metadata: Metadata = {
  title: "Shared rows",
  description:
    "The three row shapes the home page and four scope shells all render — Servers, services and Deployments.",
};

/**
 * The gallery for F07's three shared row shapes.
 *
 * It exists because when it was written **nothing in the product could render two
 * of them.** Neither an Environment's services nor an Organization's Deployments
 * had a list route, so `ServiceTable` and `DeploymentTable` were built here for
 * F08–F14 to import and driven against fixtures, rather than shipped unlooked-at.
 *
 * `ServiceTable` has a real caller now — an Environment's Services tab, on the
 * `services` array an Environment now has — so this page has stopped being its
 * only home and become the place its awkward cases live. `DeploymentTable`
 * renders per service in the product; the organization-wide feed the console
 * does not read yet would be its widest caller.
 *
 * The fixtures are the awkward cases on purpose (`_lib/fixtures.ts`): a queued
 * Deployment with no duration, a database with no branch and no domain, a
 * description long enough to want the whole column.
 */
export default function RowsPage() {
  return (
    <div className="mx-auto flex w-full max-w-col flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          className="mb-0"
          title="Shared rows"
          lede="One declaration per row shape, holding its header and its cells together — the reference writes each of these twice, as srvRow/srvHead, and a column inserted into one of a pair lands over the wrong header. Every column here is backed by a real field; the reference's Origin, Region, Size, Cost, Services, CPU and By columns are absent rather than full of em dashes."
          strap="Primitives are at /dev/primitives and /dev/primitives/data. Tokens are at /dev/tokens."
        />
        <ThemeToggle className="mt-1" />
      </div>

      <Gallery />

      <Card>
        <Card.Header title="What each of them is for" headingLevel={2} />
        <Card.Body className="text-body text-tx-2">
          <p>
            <strong className="font-semibold text-tx">ServerTable</strong>{" "}
            is the fleet list and the home page&rsquo;s Servers card in one
            shape.{" "}
            <strong className="font-semibold text-tx">ServiceTable</strong>{" "}
            takes a view model rather than a row type, because an
            Environment&rsquo;s three kinds of service are three tables with
            three id columns and no list endpoint to type against yet — F08, F11
            and F12 each map their own rows into it.{" "}
            <strong className="font-semibold text-tx">DeploymentTable</strong>{" "}
            grows its Service column only when the caller can name what was
            deployed; a `deployment` row carries an id and no name, and no route
            resolves ids to names in bulk.
          </p>
        </Card.Body>
      </Card>
    </div>
  );
}
