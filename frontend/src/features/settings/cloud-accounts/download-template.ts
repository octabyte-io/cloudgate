import type {
  CloudAccountTemplate,
  GoogleSetupTemplate,
} from "@/lib/api/endpoints/cloud-accounts";

/** Saves `text` as a file named `name`, without a round trip. */
function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Saves a setup template's CloudFormation form. The file name carries the
 * policy version, so an operator updating a role for "permissions out of
 * date" can tell the new template from the one they first used.
 */
export function downloadCloudFormation(
  cloudAccountId: string,
  template: CloudAccountTemplate,
) {
  download(
    `cloudgate-${cloudAccountId}-v${template.policyVersion}.cloudformation.json`,
    template.cloudFormation,
  );
}

/** Saves a setup template's plain-JSON form, for an operator who pastes. */
export function downloadPlainJson(
  cloudAccountId: string,
  template: CloudAccountTemplate,
) {
  download(
    `cloudgate-${cloudAccountId}-v${template.policyVersion}.json`,
    JSON.stringify(template.json, null, 2),
  );
}

/**
 * Saves the JWKS holding only the key that now signs, after a key change,
 * named for that key so it cannot be mistaken for the one
 * that also trusts the old key.
 */
export function downloadNewOnlyJwks(
  cloudAccountId: string,
  keyId: string,
  jwks: string,
) {
  download(`cloudgate-${cloudAccountId}-${keyId}.jwks.json`, jwks);
}

/**
 * Saves one file of a Google Cloud project's setup (slice 6): the `gcloud`
 * script, the JWKS it uploads, or the role it makes, each named for the
 * Cloud account and the role version, for an operator who would rather run
 * the steps by hand than paste the script.
 */
export function downloadGoogleSetup(
  cloudAccountId: string,
  template: GoogleSetupTemplate,
  part: "script" | "jwks" | "role",
) {
  const base = `cloudgate-${cloudAccountId}-v${template.policyVersion}`;
  if (part === "script") {
    download(`${base}.setup.sh`, template.script, "text/x-shellscript");
  } else if (part === "jwks") {
    download(`${base}.jwks.json`, template.jwks);
  } else {
    download(`${base}.role.yaml`, template.roleDefinition, "application/yaml");
  }
}
