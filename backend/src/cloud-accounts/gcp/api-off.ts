/**
 * Google's words for an API that is off in the project, as its APIs and the
 * Google provider answer them: `Cloud Run Admin API has not been used in
 * project 123 before or it is disabled. Enable it by visiting
 * https://console.developers.google.com/apis/api/run.googleapis.com/overview?project=123`
 * (`SERVICE_DISABLED`).
 */
const NOT_USED = /([A-Z][\w-]*(?: [\w-]+)*? API) has not been used in project/;
const API_LINK = /apis\/api\/([a-z0-9-]+\.googleapis\.com)/;
const API_ID = /\b([a-z0-9-]+\.googleapis\.com)\b/;

/**
 * A Google refusal as a plan read's reason (the Google Cloud spec): one that says an API
 * is off names the API and the setup script's step that turns it on, since
 * Cloudgate never turns on an API itself; any other is
 * Google's own words, unchanged.
 */
export function googleRefusalReason(
  message: string,
  projectId: string,
): string {
  if (
    !/has not been used in project|SERVICE_DISABLED|is disabled/.test(message)
  ) {
    return message;
  }
  const api = (API_LINK.exec(message) ?? API_ID.exec(message))?.[1];
  if (!api) return message;
  const name = NOT_USED.exec(message)?.[1];
  return `The ${name ? `${name} (${api})` : api} is off in Google Cloud project ${projectId}. Cloudgate never turns on an API: turn it on as step 1 of the setup script does (gcloud services enable ${api}), then Check for changes`;
}
