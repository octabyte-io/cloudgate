import { Card } from "@/components/console/card";
import { Picker } from "@/components/console/picker";
import type { CatalogueImage } from "@/lib/api/endpoints/bought-servers";

/**
 * The **Server image** a Bought Server is made from: Ubuntu or Debian, any
 * version offered now, Ubuntu 24.04 unless another is picked. Only the
 * images built for the chosen size's architecture are listed, so an Arm
 * size never offers one it cannot run.
 */
export function ImageCard({
  images,
  chosen,
  onChoose,
}: {
  images: readonly CatalogueImage[];
  chosen: CatalogueImage | null;
  onChoose: (id: string) => void;
}) {
  return (
    <Card>
      <Card.Header
        title="3. Operating system"
        sub="Cloudgate sets up Ubuntu and Debian, so those are the ones offered."
        headingLevel={2}
      />
      <Card.Body className="grid gap-1.5">
        <label htmlFor="server-image" className="text-body font-medium text-tx">
          Image
        </label>
        <Picker
          id="server-image"
          options={images.map((image) => ({
            value: image.id,
            label: image.label,
          }))}
          value={chosen?.id ?? ""}
          onValueChange={onChoose}
          placeholder="No image can run on this size"
          disabled={images.length === 0}
          className="max-w-64"
        />
      </Card.Body>
    </Card>
  );
}
