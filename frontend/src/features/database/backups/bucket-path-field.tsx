import { SearchInput } from "@/components/console/search-input";

/**
 * **Not a filter over the rows on screen — a path box that happens to filter.**
 *
 * Everything up to the last slash narrows the listing server-side and the rest
 * matches the name, which is `rclone lsjson`'s own shape rather than something
 * imposed on it. The default is this database's own prefix, which is where its
 * dumps go (`<appName>/<prefix>/<timestamp>`).
 */
export function BucketPathField({
  value,
  onChange,
  appName,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The database's own prefix — the placeholder and the sentence both name it. */
  appName: string;
}) {
  return (
    <>
      <SearchInput
        label="Path in the bucket"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`${appName}/`}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-meta md:text-meta"
      />
      <p className="text-meta text-tx-3">
        Everything up to the last slash narrows the listing in the bucket; the rest
        matches the file name. This database&rsquo;s own dumps go under{" "}
        <span className="font-mono">{appName}/</span>. At most 100 objects come
        back.
      </p>
    </>
  );
}
