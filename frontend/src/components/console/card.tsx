import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const cardVariants = cva(
  "overflow-hidden rounded-xl border border-line bg-panel",
  {
    variants: {
      // `plain` for a card inside another surface, where a second shadow only
      // says "these two things are at different depths" when they are not.
      tone: { raised: "shadow-panel", plain: "shadow-none" },
    },
    defaultVariants: { tone: "raised" },
  },
);

export type CardProps = React.ComponentProps<"section"> &
  VariantProps<typeof cardVariants>;

/**
 * The surface almost everything in the console sits on
 * (e-console.html:517-545). Header, body, footer — each optional, each with
 * the reference's own padding, so a card is never assembled by hand.
 */
function Card({ className, tone, ...props }: CardProps) {
  return (
    <section
      data-slot="card"
      className={cn(cardVariants({ tone }), className)}
      {...props}
    />
  );
}

export type CardHeaderProps = Omit<React.ComponentProps<"div">, "title"> & {
  title?: React.ReactNode;
  /** The quieter second line under the title. */
  sub?: React.ReactNode;
  /** Controls that belong to this card, pushed to the far end. */
  actions?: React.ReactNode;
  /**
   * Where this card sits in the page's outline. A card inside a section under
   * an `h1` is an `h3`; a card that *is* the section is an `h2`.
   */
  headingLevel?: 2 | 3 | 4;
};

/**
 * **The actions wrap under the title when the two do not fit side by side**.
 * The title block asks for 15rem and grows; the actions keep their
 * natural width and wrap among themselves. At 390px the Compose Deployments
 * card's four actions used to overlap its subtitle and run off the card, and the
 * monitoring card squeezed its subtitle into a five-line column beside the
 * target picker. `PageHeader` does the same at page level.
 */
function CardHeader({
  className,
  title,
  sub,
  actions,
  headingLevel = 3,
  children,
  ...props
}: CardHeaderProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      data-slot="card-header"
      className={cn(
        "flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3.25",
        className,
      )}
      {...props}
    >
      {title || sub ? (
        <div className="min-w-0 grow basis-60">
          {title ? (
            <Heading className="text-body font-semibold wrap-anywhere text-tx">
              {title}
            </Heading>
          ) : null}
          {sub ? <p className="mt-0.5 text-meta text-tx-3">{sub}</p> : null}
        </div>
      ) : null}
      {children}
      {actions ? (
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export type CardBodyProps = React.ComponentProps<"div"> & {
  /** No padding — for a table or a list that owns its own edges. */
  flush?: boolean;
};

function CardBody({ className, flush, ...props }: CardBodyProps) {
  return (
    <div
      data-slot="card-body"
      className={cn("relative", flush ? "p-0" : "p-4", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "border-t border-line bg-panel-2 px-4 py-2.75 text-meta text-tx-2",
        className,
      )}
      {...props}
    />
  );
}

Card.Header = CardHeader;
Card.Body = CardBody;
Card.Footer = CardFooter;

export { Card, CardHeader, CardBody, CardFooter, cardVariants };
