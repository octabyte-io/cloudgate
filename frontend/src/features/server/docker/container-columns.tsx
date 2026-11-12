import { Dash } from "@/components/console/dash";
import type { Column } from "@/components/console/data-table";
import { StatusPill } from "@/components/console/status-pill";
import type { ContainerListItem } from "@/lib/api/endpoints/docker";
import { containerMark } from "@/lib/design/status";

/**
 * A container on a host, as a table row. One declaration per column, F07's rule, so
 * a header cannot end up over the wrong cell.
 *
 * Two of docker's own fields are deliberately kept apart rather than merged.
 * **`State`** is the machine-readable word — `running`, `exited`, `created` — and it
 * is what `containerMark` is keyed on, so it becomes the pill. **`Status`** is
 * docker's sentence about the same thing (`Up 4 minutes`, `Exited (137) 1 hour ago`)
 * and it carries the part the pill cannot: how long, and with what exit code. A
 * container killed by the OOM killer says `Exited (137)` and that number is the whole
 * diagnosis.
 *
 * The **container id is short and mono**, because it is the thing you paste into
 * somebody else's terminal. The full one is on the row's title, since `docker ps`
 * gives twelve characters and every command accepts them.
 *
 * **Name, image and ports truncate, and share the width the rest leave**
 * All three are
 * strings docker writes to whatever length it likes —
 * `127.0.0.1:9000-9001->9000-9001/tcp` alone was 289px — and while any of them
 * set its own width, the row's Actions sat behind the table's horizontal scroll
 * at 1440px. The image used to wrap, but an image has no space to wrap at. Each
 * keeps its whole value on its `title`.
 */
export function containerColumns(): Column<ContainerListItem>[] {
  return [
    {
      id: "name",
      head: "Container",
      tone: "key",
      truncate: true,
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (row) => (
        <span className="block truncate" title={row.name}>
          {row.name}
        </span>
      ),
    },
    {
      id: "state",
      head: "State",
      compare: (a, b) => a.state.localeCompare(b.state),
      // `containerMark` takes a string rather than a key, because this arrives as
      // free text over SSH — an unknown state is labelled with the word docker used
      // instead of rendering `undefined`.
      cell: (row) => <StatusPill mark={containerMark(row.state)} />,
    },
    {
      id: "status",
      head: "For",
      tone: "muted",
      cell: (row) => row.status || <Dash word="Unknown" />,
    },
    {
      id: "image",
      head: "Image",
      className: "font-mono",
      truncate: true,
      compare: (a, b) => a.image.localeCompare(b.image),
      cell: (row) => <span title={row.image}>{row.image}</span>,
    },
    {
      id: "ports",
      head: "Ports",
      className: "font-mono",
      truncate: true,
      cell: (row) =>
        row.ports && row.ports !== "No ports" ? (
          <span className="block truncate" title={row.ports}>
            {row.ports}
          </span>
        ) : (
          <Dash word="None published" />
        ),
    },
    {
      id: "id",
      head: "Id",
      className: "font-mono",
      cell: (row) => (
        <span title={row.containerId}>{row.containerId.slice(0, 12)}</span>
      ),
    },
  ];
}
