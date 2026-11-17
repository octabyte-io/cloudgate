import { Card } from "@/components/console/card";
import { Segmented } from "@/components/console/segmented";
import type {
  BoughtServerCatalogue,
  CatalogueLocation,
} from "@/lib/api/endpoints/bought-servers";

import { FAMILIES } from "./buy-model";
import { ExtrasCard } from "./extras-card";
import { ImageCard } from "./image-card";
import { SizeTable } from "./size-table";
import { Suggested } from "./suggestion-cards";
import type { BuyForm } from "./use-buy-form";

/**
 * Every option of one Buy, in the order both buy forms show them:
 * Suggested, then 1. Location, 2. Size, 3. Operating system and 4. Extras.
 * The Location card's body is the caller's: the Buy screen's has the map,
 * the wizard's only the cards.
 */
export function BuyOptions({
  catalogue,
  ordered,
  form,
  locationSub,
  locationBody,
}: {
  catalogue: BoughtServerCatalogue;
  ordered: ReadonlyArray<{ location: CatalogueLocation }>;
  form: BuyForm;
  locationSub?: string;
  locationBody: React.ReactNode;
}) {
  const { location, size, offer } = form;
  return (
    <>
      <Suggested
        ordered={ordered}
        sizes={catalogue.sizes}
        chosen={{ locationId: location?.id ?? null, sizeId: size?.id ?? null }}
        onChoose={form.chooseSuggestion}
      />

      <Card>
        <Card.Header title="1. Location" sub={locationSub} headingLevel={2} />
        <Card.Body className="grid gap-3">{locationBody}</Card.Body>
      </Card>

      <Card>
        <Card.Header
          title={location ? `2. Size in ${location.city}` : "2. Size"}
          headingLevel={2}
          actions={
            <Segmented
              label="Kind of Server"
              options={FAMILIES.map(({ value, label }) => ({ value, label }))}
              value={form.family}
              onChange={form.setFamily}
            />
          }
        />
        <Card.Body flush>
          <SizeTable
            sizes={catalogue.sizes}
            family={form.family}
            location={location}
            chosen={size?.id ?? null}
            onChoose={form.setSizeId}
          />
        </Card.Body>
      </Card>

      <ImageCard
        images={form.images}
        chosen={form.image}
        onChoose={form.setImageId}
      />

      <ExtrasCard
        backups={form.backups}
        onBackups={form.setBackups}
        backupsMonthly={offer?.backupsMonthly ?? null}
        storageGb={form.storageGb}
        onStorageGb={form.setStorageGb}
        storage={catalogue.storage}
      />
    </>
  );
}
