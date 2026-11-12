import type { DnsRecord } from "@/lib/api/endpoints/environments";

/** A DNS record as the operator removes it at their DNS provider. */
export function dnsRecordLine(record: DnsRecord): string {
  return `${record.type} ${record.name} → ${record.value}`;
}

/** The DNS records its Domains leave, which Cloudgate never writes. */
export function DnsRecords({ records }: { records: readonly DnsRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div className="text-meta text-tx-2">
      <p>
        Cloudgate never writes DNS, so remove these records its Domains left at
        your DNS provider:
      </p>
      <ul className="ml-4 list-disc">
        {records.map((record) => (
          <li key={dnsRecordLine(record)} className="font-mono wrap-anywhere">
            {dnsRecordLine(record)}
          </li>
        ))}
      </ul>
    </div>
  );
}
