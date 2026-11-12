import { Banner, BannerRow } from "@/components/console/banner";
import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { DataTable, type Column } from "@/components/console/data-table";
import { Button } from "@/components/ui/button";
import type {
  CloudResource,
  CloudResourceList,
  GoogleCloudResource,
} from "@/lib/api/endpoints/cloud-resources";
import { CLOUD_NAMES, type Cloud } from "@/lib/api/endpoints/cloud-accounts";

/**
 * What a resource a tag search cannot find is marked
 * IAM, what
 * carries no tag of Cloudgate's, and the network cards AWS made.
 */
export const NOT_FINDABLE = "not findable by tag";

/**
 * What a Google resource that carries no label of Cloudgate's is marked
 * networks, subnets and most compute kinds take none, and a plan finds
 * them again by their fixed name.
 */
export const NOT_FINDABLE_BY_MARK = "not findable by mark, checked by name";

/** A network card AWS made, which carries no tag of Cloudgate's. */
const AWS_MADE_CARD = "aws_network_interface";

const COLUMNS: Column<CloudResource>[] = [
  {
    id: "type",
    head: "Type",
    cell: (row) =>
      row.type === AWS_MADE_CARD ? `${row.type} (made by AWS)` : row.type,
    tone: "key",
  },
  {
    id: "awsId",
    head: "AWS id",
    cell: (row) => <span className="font-mono">{row.awsId}</span>,
    tone: "wrap",
  },
  { id: "region", head: "Region", cell: (row) => row.region },
  {
    id: "tags",
    head: "Tags",
    cell: (row) =>
      Object.keys(row.tags).length === 0 ? (
        "None"
      ) : (
        <ul className="font-mono text-meta">
          {Object.entries(row.tags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => (
              <li key={key}>
                {key}={value}
              </li>
            ))}
        </ul>
      ),
    tone: "wrap",
  },
  {
    id: "findable",
    head: "Tag search",
    cell: (row) =>
      row.findableByTag ? (
        "finds it"
      ) : (
        <span className="text-warn">{NOT_FINDABLE}</span>
      ),
  },
];

/** A Google state's resources: its labels in place of AWS's tags. */
const GOOGLE_COLUMNS: Column<GoogleCloudResource>[] = [
  { id: "type", head: "Type", cell: (row) => row.type, tone: "key" },
  {
    id: "googleName",
    head: "Google name",
    cell: (row) => <span className="font-mono">{row.googleName}</span>,
    tone: "wrap",
  },
  { id: "region", head: "Region", cell: (row) => row.region },
  {
    id: "labels",
    head: "Labels",
    cell: (row) =>
      Object.keys(row.labels).length === 0 ? (
        "None"
      ) : (
        <ul className="font-mono text-meta">
          {Object.entries(row.labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => (
              <li key={key}>
                {key}={value}
              </li>
            ))}
        </ul>
      ),
    tone: "wrap",
  },
  {
    id: "labelled",
    head: "Cloudgate’s labels",
    cell: (row) =>
      row.labelled ? (
        "carries them"
      ) : (
        <span className="text-warn">{NOT_FINDABLE_BY_MARK}</span>
      ),
  },
];

/** How each cloud's wording of Rebuild names what it takes back by, and where. */
const TAKEN_BACK_BY: Record<Cloud, { by: string; where: string }> = {
  aws: { by: "by Cloudgate’s tags", where: CLOUD_NAMES.aws },
  gcp: { by: "by the names Cloudgate gave it", where: CLOUD_NAMES.gcp },
};

/**
 * What Cloudgate made, from an Infrastructure state: each resource's
 * type, AWS id, region and tags — never a setting's value, which the API
 * never sends — and which ones a tag search cannot find, so Recovery by tag
 * could not take them back. On Google, each one's type, Google name,
 * region and labels, and which ones carry no label of Cloudgate's. The state
 * itself is shown nowhere.
 */
export function CloudResourceTable({
  list,
  label,
}: {
  list: CloudResourceList;
  label: string;
}) {
  if (list.failure && list.readable) {
    return <p className="text-body text-bad">{list.failure}</p>;
  }
  if (!list.readable) return null;
  if (list.resources.length === 0) {
    return (
      <p className="text-body text-tx-2">
        {list.stateId === null
          ? "Nothing yet: its first apply makes its Infrastructure state."
          : "Its Infrastructure state holds nothing."}
      </p>
    );
  }
  if (list.cloud === "gcp") {
    return (
      <DataTable
        label={label}
        rows={list.resources as GoogleCloudResource[]}
        columns={GOOGLE_COLUMNS}
        getRowId={(row) => `${row.type}:${row.googleName}`}
      />
    );
  }
  return (
    <div className="grid gap-2">
      <DataTable
        label={label}
        rows={list.resources as CloudResource[]}
        columns={COLUMNS}
        getRowId={(row) => `${row.type}:${row.awsId}`}
      />
      {list.networkCardsUnread ? (
        <p className="text-meta text-tx-2">
          The network cards AWS made could not be listed:{" "}
          {list.networkCardsUnread}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A state Cloudgate cannot read: corrupt, or `APP_ENCRYPTION_SECRET`
 * changed. Every run on it fails, naming it, and it is never written over;
 * Rebuild from the cloud is the way on.
 */
export function UnreadableStateBanner({
  cloud = "aws",
  failure,
  allowed,
  refusal,
  onRebuild,
}: {
  /** The state's cloud, whose wording Rebuild is offered in. */
  cloud?: Cloud;
  /** The run's or the list's own words, naming the state. */
  failure: string | null;
  /** The caller's verdict on Rebuild's statement. */
  allowed: boolean;
  /** What a role that may not rebuild it is told. */
  refusal: string;
  onRebuild: () => void;
}) {
  return (
    <Banner
      icon="alert"
      title="Cloudgate cannot read this Infrastructure state."
      className="border-bad-line"
    >
      <BannerRow
        tone="bad"
        title={
          failure ??
          "Every run on it fails, and it is never written over, until it is rebuilt."
        }
        description={`Rebuild from the cloud discards the state and plans to take back, ${TAKEN_BACK_BY[cloud].by}, what is still in ${TAKEN_BACK_BY[cloud].where}.`}
        action={
          <Button
            type="button"
            variant="dngr"
            disabled={!allowed}
            title={allowed ? undefined : refusal}
            onClick={onRebuild}
          >
            Rebuild from the cloud
          </Button>
        }
      />
    </Banner>
  );
}

/**
 * Rebuild from the cloud, confirmed by name: the state is discarded
 * and a plan is made, which adopts by tag what its resources still carry;
 * on Google, by the fixed name each one was given.
 */
export function RebuildStateModal({
  cloud = "aws",
  open,
  onOpenChange,
  confirmWord,
  mismatch,
  onConfirm,
}: {
  /** The state's cloud, whose wording the dialog is in. */
  cloud?: Cloud;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Service's name, or the Environment's for a network. */
  confirmWord: string;
  mismatch: string;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title="Rebuild from the cloud?"
      description="The unreadable Infrastructure state is discarded. This cannot be undone."
      confirmWord={confirmWord}
      mismatch={mismatch}
      button="Rebuild from the cloud"
      onConfirm={onConfirm}
    >
      {cloud === "gcp" ? (
        <div className="grid gap-2 text-body text-tx-2">
          <p>
            Cloudgate then checks for changes: the plan reads Google Cloud
            against an empty state, and takes back what a search by the names
            Cloudgate gave finds, when its description carries Cloudgate’s mark.
            Nothing changes in Google Cloud until you apply it, which imports
            it.
          </p>
          <p>
            What carries another mark is not taken back: the plan names it, to
            remove by hand.
          </p>
        </div>
      ) : (
        <div className="grid gap-2 text-body text-tx-2">
          <p>
            Cloudgate then checks for changes: the plan reads AWS against an
            empty state, and takes back what a search by Cloudgate’s tags finds.
            Nothing changes in AWS until you apply it.
          </p>
          <p>
            What a tag search cannot find — IAM roles, and the network cards AWS
            made — is not taken back: the plan makes it again, or names it.
          </p>
        </div>
      )}
    </ConfirmDeleteModal>
  );
}
