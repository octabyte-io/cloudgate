import type { Metadata } from "next";

import { CertificatesSection } from "@/features/certificates/certificates-section";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Certificates" };

export default function Page() {
  return (
    <SettingsPage slug="certificates">
      <CertificatesSection />
    </SettingsPage>
  );
}
