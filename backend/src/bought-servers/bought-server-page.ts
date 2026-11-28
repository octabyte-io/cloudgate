/**
 * Where a **Bought Server**'s changes and Restores are made in the console,
 * which every email about one links to.
 */
export function boughtServerPageUrl(siteUrl: string, serverId: string): string {
  return `${siteUrl}/servers/${serverId}/bought-server`;
}
