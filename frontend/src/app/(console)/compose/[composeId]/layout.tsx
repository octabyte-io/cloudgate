import { OfferScopeShell } from "@/features/service-shell/offer-scope-shell";

/**
 * Every tab of one Compose stack: the page, plus its shell under the docked
 * terminal's `+` — here rather than on the Shell tab, so the offer
 * stands on every tab and does not come and go as the tabs change.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <OfferScopeShell />
    </>
  );
}
