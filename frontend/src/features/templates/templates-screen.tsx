"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";

import type { TemplateSummary } from "@/lib/api/endpoints/templates";

import { CatalogueView } from "./catalogue-view";
import { setupPlaceOf } from "./setup-place";
import { TemplateSetup } from "./template-setup";
import { useTemplateCatalogue } from "./use-templates";

/**
 * The Template catalogue screen.
 *
 * Reading the catalogue is not gated on anything: `templatesApi.list` answers
 * any member. `?template=<id>` opens that Template's setup form in place of
 * the catalogue (#1369); the setup itself asks every statement its Apply will,
 * so the form is not gated here either.
 *
 * The search, the tag filter and the page live here, above the view, so a
 * later view switch on this screen does not lose them.
 */
export function TemplatesScreen() {
  const catalogue = useTemplateCatalogue();

  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const params = useSearchParams();
  const templateId = params.get("template");
  const place = setupPlaceOf(params);
  // The setup screen is headed by the Template it sets up, not the catalogue.
  const setting = templateId
    ? (catalogue.data?.templates.find((one) => one.id === templateId) ?? null)
    : null;

  return (
    <Page>
      {templateId ? (
        <SetupHeader templateId={templateId} template={setting} />
      ) : (
        <PageHeader
          title="Templates"
          icon="book"
          lede="Ready-made apps from the Template catalogue, to set up in one of your Environments."
        />
      )}
      {templateId ? (
        <TemplateSetup templateId={templateId} place={place} />
      ) : (
        <CatalogueView
          templates={catalogue.data?.templates ?? []}
          copy={catalogue.data?.copy}
          pending={catalogue.isPending}
          error={catalogue.error}
          onRetry={() => void catalogue.refetch()}
          query={query}
          onQuery={setQuery}
          tags={tags}
          onTags={setTags}
          page={page}
          onPage={setPage}
          place={place}
        />
      )}
    </Page>
  );
}

/**
 * The setup screen's header: the Template's logo, "Set up <name>" and its
 * version, with its description under it. Until the catalogue is read it
 * names the id, which is the Template's folder name.
 */
function SetupHeader({
  templateId,
  template,
}: {
  templateId: string;
  template: TemplateSummary | null;
}) {
  return (
    <PageHeader
      title={
        <>
          {template ? (
            <span className="grid size-9 flex-none place-items-center rounded-lg border border-line bg-panel-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={template.logo}
                alt=""
                className="size-5.5 object-contain"
              />
            </span>
          ) : null}
          Set up {template?.name ?? templateId}
        </>
      }
      badges={
        template?.version ? (
          <span className="font-mono text-meta text-tx-3">
            {template.version}
          </span>
        ) : null
      }
      lede={template?.description}
    />
  );
}
