/**
 * The six WebSocket gateways' paths, one per `@WebSocketGateway` under
 * `realtime/gateways/`.
 *
 * Listed here for the one reader that cannot import a decorator: the Hosted
 * instance's Traefik routing (`traefik/config/hosted.ts`), which sends
 * exactly these paths to the API and everything else to the console. A seventh
 * gateway missing from this list would be routed to the console and never
 * connect, so `backend/test/traefik/hosted.spec.ts` holds the list to the
 * decorators.
 */
export const REALTIME_GATEWAY_PATHS = [
  '/listen-deployment',
  '/listen-server-setup',
  '/listen-docker-stats-monitoring',
  '/docker-container-logs',
  '/docker-container-terminal',
  '/terminal',
] as const;
