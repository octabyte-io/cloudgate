"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";

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
  // Opened from an Environment's "Set up a template", the setup starts there.
  const from = setupPlaceOf(params);

  return (
    <Page>
      {templateId ? (
        // The setup opens on the Template itself (`TemplateIntro`), not on
        // the catalogue's header.
        <TemplateSetup
          templateId={templateId}
          template={catalogue.data?.templates.find(
            (template) => template.id === templateId,
          )}
          cataloguePending={catalogue.isPending}
          from={from}
        />
      ) : (
        <>
          <PageHeader
            title="Templates"
            icon="book"
            lede="Ready-made apps from the Template catalogue, to set up in one of your Environments."
          />
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
            place={from}
          />
        </>
      )}
    </Page>
  );
}
