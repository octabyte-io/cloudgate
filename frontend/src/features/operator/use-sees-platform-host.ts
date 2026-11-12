import { useIsOperator } from "./use-operator";

/**
 * Whether the reader is shown the **platform host**'s pages — Traefik,
 * Instance, Maintenance and Branding: everybody on a
 * Self-hosted instance, and only an Operator on the Hosted one, whose box is
 * Octabyte's and whose backend refuses every customer on those routes
 * (ADR-0053).
 *
 * `sees` stays false while the mode or the Operator answer is pending, the way
 * `useIsOperator` holds back the Operator page: a page offered only on a yes
 * appears once and never flashes out again.
 */
export function useSeesPlatformHost(): { sees: boolean; pending: boolean } {
  const { operator, hosted, pending } = useIsOperator();
  return { sees: !pending && (!hosted || operator), pending };
}
