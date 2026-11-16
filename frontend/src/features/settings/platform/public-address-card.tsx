"use client";

import { useState } from "react";
import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import { ApiError } from "@/lib/api/api-error";
import { PUBLIC_ADDRESS_UNVERIFIED_CODE } from "@/lib/api/endpoints/settings";

import { useInstanceGate, usePlatformMutations } from "./use-platform";

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** An IP address as the backend takes one, brackets allowed; or empty. */
function isAddressOrEmpty(value: string): boolean {
  const bare = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return (
    bare === "" || IPV4.test(bare) || (bare.includes(":") && IPV6.test(bare))
  );
}

const schema = z.object({
  serverIp: z.string().max(255).refine(isAddressOrEmpty, {
    message:
      "An IP address, such as 203.0.113.10. For a hostname, use Console domain below.",
  }),
  confirmUnverified: z.boolean(),
});

/**
 * Settings > Instance's public address: this server's public IP, which the
 * free sslip.io Domains for what runs on it are made from.
 *
 * **An IP and nothing else**, because an sslip.io name carries the address
 * itself; a hostname here made no Domain and said so only when one was
 * generated. A hostname for the console is Console domain.
 *
 * **And one this server knows as its own, unless it is confirmed.** The backend
 * refuses an address that is on none of this host's interfaces and is not the
 * public IP the install found, with `PUBLIC_ADDRESS_UNVERIFIED`. Behind NAT or
 * a load balancer the right address can be one this host cannot see, so the
 * refusal is a question rather than a wall: the toast says why, and a "Save it
 * anyway" switch appears under the field for that address alone. Typing a
 * different address takes the switch away again.
 */
export function PublicAddressCard({ value }: { value: string | null }) {
  const mutations = usePlatformMutations();
  const gate = useInstanceGate();
  const [unverified, setUnverified] = useState<string | null>(null);

  return (
    <SettingsCard
      gate={gate}
      title="Public address"
      lede="This server's public IP. The install fills it in, and never replaces one you save."
      schema={schema}
      fields={[
        {
          kind: "text",
          name: "serverIp",
          label: "IP address",
          optional: true,
          mono: true,
          placeholder: "203.0.113.10",
          hint: "The free sslip.io addresses for what runs on this server are made from it. For a hostname, use Console domain below.",
        },
        {
          kind: "switch",
          name: "confirmUnverified",
          label: "Save it anyway",
          hint: "This server does not see that address as its own. Turn this on if it reaches the server through NAT or a load balancer.",
          when: (values) =>
            unverified !== null && values.serverIp.trim() === unverified,
        },
      ]}
      defaultValues={{ serverIp: value ?? "", confirmUnverified: false }}
      submit={async (values) => {
        const serverIp = values.serverIp.trim();
        try {
          const saved = await mutations.updateIp.mutateAsync({
            serverIp,
            confirmUnverified:
              values.confirmUnverified && serverIp === unverified,
          });
          setUnverified(null);
          return saved;
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.code === PUBLIC_ADDRESS_UNVERIFIED_CODE
          ) {
            setUnverified(serverIp);
          }
          throw error;
        }
      }}
      savedMessage="The public address is saved."
    />
  );
}
