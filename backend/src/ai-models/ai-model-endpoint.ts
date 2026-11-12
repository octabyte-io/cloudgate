/**
 * The gateway's fixed path on the platform host ("Gateway path:
 * `/ai`"). It collides with no console route.
 */
export const GATEWAY_PATH = '/ai';

/**
 * An AI model's **endpoint**: its OpenAI-compatible base URL on the gateway,
 * `<platform host URL>/ai/<AI model id>/v1`, where the AI model's
 * id is its Application's. Every reader builds it here, so the console's Model
 * tab, `get_service` and the gateway's own route agree on one spelling.
 *
 * `null` while the platform host URL is not configured
 * (`InstanceUrlService.getInstanceUrl`): an address with no host is not one a
 * client could call.
 */
export function aiModelEndpoint(
  platformHostUrl: string | null,
  applicationId: string,
): string | null {
  if (!platformHostUrl) return null;
  return `${platformHostUrl.replace(/\/+$/, '')}${GATEWAY_PATH}/${applicationId}/v1`;
}
