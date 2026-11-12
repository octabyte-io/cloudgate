import { cloudKindEnum } from '../../src/cloud-accounts/cloud-account.schema';
import {
  GENERATED_ADDRESSES,
  NATIVE_ADDRESS_RENAMES,
} from '../../src/native/address-snapshot';
import type { NativeCloud } from '../../src/native/address-snapshot';
import { kindsOn } from '../../src/project-config/planner/plan-environment';
import { generatedAddresses } from './built-definitions';

/**
 * Every address the cloud builders (ADR-0044 rule 10, Consequences)
 * generate is a promise to every file whose native block names it. The
 * committed snapshot (`GENERATED_ADDRESSES`) only grows; a listed address
 * the builders no longer generate fails here until the rename table maps
 * it to the address that took its place, which the config reader then
 * reads it as.
 */

const CLOUDS: readonly NativeCloud[] = cloudKindEnum.enumValues;
const generated = generatedAddresses();

const listed = (cloud: NativeCloud, kind: string) =>
  Object.hasOwn(GENERATED_ADDRESSES[cloud], kind)
    ? GENERATED_ADDRESSES[cloud][kind]
    : [];
const renamesOf = (cloud: NativeCloud, kind: string) =>
  Object.hasOwn(NATIVE_ADDRESS_RENAMES[cloud], kind)
    ? NATIVE_ADDRESS_RENAMES[cloud][kind]
    : {};

describe('GENERATED_ADDRESSES, against what the builders generate', () => {
  it.each(CLOUDS)(
    'runs a builder for every kind a Cloud account on %s makes',
    (cloud) => {
      expect(Object.keys(generated[cloud]).sort()).toEqual(
        [...kindsOn(cloud)].sort(),
      );
    },
  );

  it.each(CLOUDS)(
    'lists every address the %s builders generate (a new one is added to GENERATED_ADDRESSES)',
    (cloud) => {
      const unlisted = Object.entries(generated[cloud]).flatMap(
        ([kind, addresses]) =>
          addresses
            .filter((address) => !listed(cloud, kind).includes(address))
            .map((address) => `${cloud} ${kind}: ${address}`),
      );

      expect(unlisted).toEqual([]);
    },
  );

  it.each(CLOUDS)(
    'has every listed %s address still generated, or renamed to one that is (a vanished address needs its entry in NATIVE_ADDRESS_RENAMES)',
    (cloud) => {
      const vanished = Object.entries(GENERATED_ADDRESSES[cloud]).flatMap(
        ([kind, addresses]) => {
          const now = generated[cloud][kind] ?? [];
          return addresses
            .filter(
              (address) =>
                !now.includes(address) &&
                !Object.hasOwn(renamesOf(cloud, kind), address),
            )
            .map((address) => `${cloud} ${kind}: ${address}`);
        },
      );

      expect(vanished).toEqual([]);
    },
  );

  it.each(CLOUDS)(
    'renames on %s only a listed address no longer generated, to one generated now',
    (cloud) => {
      const wrong = Object.entries(NATIVE_ADDRESS_RENAMES[cloud]).flatMap(
        ([kind, renames]) => {
          const now = generated[cloud][kind] ?? [];
          return Object.entries(renames).flatMap(([from, to]) => [
            ...(listed(cloud, kind).includes(from)
              ? []
              : [`${cloud} ${kind}: ${from} is not in the snapshot`]),
            ...(now.includes(from)
              ? [`${cloud} ${kind}: ${from} is still generated`]
              : []),
            ...(now.includes(to)
              ? []
              : [`${cloud} ${kind}: ${to} is not generated now`]),
          ]);
        },
      );

      expect(wrong).toEqual([]);
    },
  );
});
