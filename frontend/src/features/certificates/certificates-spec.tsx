import { z } from "zod";

import { Chip } from "@/components/console/chip";
import type { ResourceSpec } from "@/components/console/resource-spec";
import { certificatesApi, type Certificate } from "@/lib/api/endpoints/certificates";

const isPem = (value: string) => value.includes("-----BEGIN");
const NOT_PEM = "That does not look like PEM — it should start with a -----BEGIN line.";

const schema = z
  .object({
    /**
     * Which saved certificate this form is editing, or `""` on an add.
     *
     * Not a control — no `FieldSpec` names it, so nothing renders it. It is in
     * the values because `ResourceList` builds one spec, and so one schema, for
     * both dialogs, and whether the private key is required turns on it.
     */
    certificateId: z.string(),
    name: z.string().min(1, "A certificate needs a name."),
    certificateData: z
      .string()
      .min(1, "Paste the certificate, including the BEGIN and END lines.")
      .refine(isPem, NOT_PEM),
    privateKey: z.string().refine((value) => value === "" || isPem(value), NOT_PEM),
  })
  .superRefine((values, ctx) => {
    // Required on an add only. On an edit the box starts empty because the key
    // is never returned, and empty there means keep the stored one.
    if (values.certificateId === "" && values.privateKey === "") {
      ctx.addIssue({
        code: "custom",
        path: ["privateKey"],
        message: "Paste the private key, including the BEGIN and END lines.",
      });
    }
  });

export type CertificateValues = z.infer<typeof schema>;

/**
 * Certificates, as a `ResourceSpec`.
 *
 * **Editing keeps a quirk worth knowing about.** `updateCertificateSchema` is
 * `.partial()` and the service only rewrites the files on disk when
 * `certificateData` or `privateKey` is in the body — and for a host certificate
 * it also asks for instance authority then. So `update` below sends only what
 * changed: a rename sends the name alone and touches no files. The **private
 * key is never returned**, so an edit dialog opens with that box empty; sending
 * the empty string back would be a lie about what is stored. F15's rule
 * therefore applies here too: a blank secret box means *keep*, the schema
 * requires the key on an add only, and `update` omits the field rather than
 * sending it.
 *
 * So an edit can change the name alone, replace the certificate and keep the
 * stored key (a renewal from the same key), or replace both halves.
 */
export function certificateSpec(
  invalidate: () => Promise<unknown>,
): ResourceSpec<Certificate, CertificateValues> {
  return {
    noun: "certificate",
    plural: "certificates",
    title: "Certificates",
    lede: "TLS material you bring yourself. Traefik serves these for the hosts they cover.",
    icon: "shield",
    addLabel: "Add a certificate",
    emptyTitle: "No certificates yet",
    emptyBody:
      "A domain with HTTPS turned on gets its certificate from Let's Encrypt unless you choose otherwise. Add one here for a host Let's Encrypt cannot reach — an internal domain, a wildcard you bought, or anything signed by your own CA — then choose Stored certificate on that domain. Traefik serves a certificate from here for every host it covers, even one set to Let's Encrypt.",
    tableLabel: "Certificates in this Organization",

    getRowId: (row) => row.certificateId,
    rowName: (row) => row.name,
    defaultSort: { id: "name", dir: "asc" },

    columns: [
      {
        id: "name",
        head: "Name",
        tone: "key",
        cell: (row) => row.name,
        compare: (a, b) => a.name.localeCompare(b.name),
      },
      {
        id: "kind",
        head: "Kind",
        cell: (row) => <Chip>{row.certificateType}</Chip>,
      },
      {
        id: "path",
        head: "Written to",
        tone: "muted",
        cell: (row) => row.certificatePath,
      },
    ],

    schema,
    toDefaults: (row) => ({
      certificateId: row?.certificateId ?? "",
      name: row?.name ?? "",
      certificateData: row?.certificateData ?? "",
      // Never returned by the API, so an edit always starts empty and empty
      // means keep — F15's rule, and the one place a blank field is not a blank
      // value.
      privateKey: "",
    }),

    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "What you will recognise it by. It is not the hostname.",
      },
      {
        kind: "textarea",
        name: "certificateData",
        label: "Certificate",
        mono: true,
        rows: 6,
        hint: "The full PEM chain, leaf first. Paste it including the -----BEGIN CERTIFICATE----- lines.",
      },
      {
        kind: "textarea",
        name: "privateKey",
        label: "Private key",
        mono: true,
        rows: 6,
        hint: "Never shown again once saved. Leave it empty when editing to keep the stored one.",
      },
    ],

    // What `/certificates` asks of each write — `ResourceList` turns the
    // control off for a role without it.
    permissions: {
      create: { certificate: ["create"] },
      update: { certificate: ["update"] },
      remove: { certificate: ["delete"] },
    },
    create: async ({ name, certificateData, privateKey }) => {
      await certificatesApi.create({ name, certificateData, privateKey });
      await invalidate();
    },

    update: async (row, values) => {
      await certificatesApi.update(row.certificateId, {
        name: values.name,
        // Sent only when it changed: the service reads its presence as new
        // material and rewrites the pair on disk, so an unchanged certificate
        // sent back would turn a rename into a file write.
        ...(values.certificateData === row.certificateData
          ? {}
          : { certificateData: values.certificateData }),
        // Omitted rather than sent empty: `PATCH` leaves a column it does not
        // mention exactly as it was (F10's rule), and this is the column where
        // sending `""` would replace a working key with nothing.
        ...(values.privateKey === "" ? {} : { privateKey: values.privateKey }),
      });
      await invalidate();
    },

    remove: async (row) => {
      await certificatesApi.remove(row.certificateId);
      await invalidate();
    },

    deleteNote: (row) =>
      `The files under ${row.certificatePath} are removed from Traefik's certificate directory as well as the row. Any host that was being served with this certificate falls back to whatever Traefik has left — usually its own self-signed default, which browsers refuse.`,
  };
}
