import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { RequestService } from "@/lib/api/endpoints/monitoring";
import { Icon } from "@/lib/design/icons";

/** What is picked in the Service filter. Nothing picked is every line. */
export interface ServiceChoice {
  serviceIds: ReadonlySet<string>;
  /** Lines that matched no Domain. */
  noService: boolean;
}

/**
 * Narrow the Requests page to one or more Services, built the way
 * `MethodFilter` is: a popover of checkboxes, several picked meaning **any**
 * of them, the count on the trigger.
 *
 * **The first option names what nothing picked means.** "All" for a caller
 * who sees the whole Server; "All yours" for one who sees only some of its
 * lines, so the default never reads as more than it is. Then each Service
 * the caller may read on this Server, as the read answered them, and last
 * "No Service" — the lines that matched no Domain — offered only to a
 * `server: ['read']` holder, the only one ever sent them.
 *
 * The backend applies the filter after the split by Service, so the options
 * are a convenience, not the guard. A Domain is found with the search box,
 * not here.
 */
export function ServiceFilter({
  services,
  offersNoService,
  wholeServer,
  selected,
  onChange,
  disabled,
}: {
  services: readonly RequestService[];
  offersNoService: boolean;
  /** Whether the caller sees every line on the Server, or only theirs. */
  wholeServer: boolean;
  selected: ServiceChoice;
  onChange: (next: ServiceChoice) => void;
  disabled?: boolean;
}) {
  const count = selected.serviceIds.size + (selected.noService ? 1 : 0);

  function toggle(serviceId: string, on: boolean) {
    const draft = new Set(selected.serviceIds);
    if (on) draft.add(serviceId);
    else draft.delete(serviceId);
    onChange({ serviceIds: draft, noService: selected.noService });
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Filter by Service, ${count} selected`}
            disabled={disabled}
          >
            <Icon name="filter" size={15} />
            Service
            {count > 0 ? (
              <span className="rounded-md bg-brand-tint px-1.25 text-chip text-brand-tx">
                {count}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent
        align="start"
        className="w-64 rounded-xl border border-line bg-panel p-1.5 shadow-pop ring-0"
      >
        <ul className="flex flex-col">
          <Option
            label={wholeServer ? "All" : "All yours"}
            checked={count === 0}
            onChange={(on) => {
              if (on) onChange({ serviceIds: new Set(), noService: false });
            }}
          />
          {services.map((service) => (
            <Option
              key={service.serviceId}
              label={service.name}
              checked={selected.serviceIds.has(service.serviceId)}
              onChange={(on) => toggle(service.serviceId, on)}
            />
          ))}
          {offersNoService ? (
            <Option
              label="No Service"
              checked={selected.noService}
              onChange={(on) =>
                onChange({ serviceIds: selected.serviceIds, noService: on })
              }
            />
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function Option({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li>
      <label className="flex h-8 cursor-pointer items-center gap-2.25 rounded-md px-2.25 text-body text-tx hover:bg-raise">
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => onChange(next === true)}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </label>
    </li>
  );
}
