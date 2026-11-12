import type { Metadata } from "next";

import { ProjectsScreen } from "@/features/project/projects-screen";

export const metadata: Metadata = { title: "Projects" };

export default function Page() {
  return <ProjectsScreen />;
}
