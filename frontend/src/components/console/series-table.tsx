export type SeriesTableProps = {
  /** What the series is. Becomes the table's caption. */
  label: string;
  values: number[];
  labelAt: (index: number) => string;
  format: (value: number) => string;
};

/**
 * A series as a table, for a screen reader.
 *
 * Its own component because it is its own deliverable, not decoration on the
 * chart: a plot's hover and its keyboard scrub both *enhance*, and this is what
 * makes them safe to be enhancements — every value is reachable without either
 * of them, and without a pointer.
 *
 * `sr-only` is absolutely positioned, so whatever renders this must be a
 * containing block, or the table resolves against the initial one and extends
 * the document's scroll width.
 */
export function SeriesTable({
  label,
  values,
  labelAt,
  format,
}: SeriesTableProps) {
  return (
    <table className="sr-only">
      <caption>{label}</caption>
      <tbody>
        {values.map((value, index) => (
          <tr key={index}>
            <th scope="row">{labelAt(index)}</th>
            <td>{format(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
