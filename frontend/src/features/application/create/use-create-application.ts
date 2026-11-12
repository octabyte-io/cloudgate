import { useMutation } from "@tanstack/react-query";

import {
  applicationsApi,
  type CreateApplicationInput,
} from "@/lib/api/endpoints/applications";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * Create an Application in an Environment.
 *
 * The twin of `useCreateDatabase` and `useCreateCompose`, down to what it
 * invalidates: the Environment's own read is what lists the services deployed in
 * it, so the panel the
 * new Application was created from shows it without anything having to refetch
 * by hand.
 *
 * **`POST /applications` answers with the new row**, which is what lets the flow
 * end on the Application's own screen rather than on the list it was started
 * from — the same argument F11 and F12 made for the two create flows already in
 * that header.
 *
 * It sits beside the modal rather than in `use-application.ts` with the rest of
 * the Application's reads and writes, which is where it belongs; moving it is a
 * one-line change nobody has to make today.
 */
export function useCreateApplication(environmentId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateApplicationInput) => applicationsApi.create(input),
    onSuccess: () => invalidate.application({ environmentId }),
  });
}
