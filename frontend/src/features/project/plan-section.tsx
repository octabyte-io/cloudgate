import { cn } from "@/lib/utils";

/** One titled section of a Plan: Creates, Changes, Destroys, Notes and the rest. */
export function PlanSection({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className={cn("grid gap-2.5", className)}>
      <h4 className="text-meta font-semibold tracking-wide uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}
