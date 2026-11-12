import {
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import {
  HOST_UNREACHABLE_CODE,
  PLATFORM_HOST_UNREACHABLE_CODE,
} from '../../src/docker-ops/host-reachability';

/** Just enough of an Express request/response pair for `catch` to answer. */
function httpHost(): ArgumentsHost {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/servers/s1/audit' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

/**
 * **A host that was not reached is journaled once, at warn**.
 *
 * `rethrowIfHostUnreachable` writes the host's own words at warn and throws a
 * 503 carrying the code; this filter then wrote the same failure again at error,
 * as a 5xx. So every page load of an unreachable Server's Overview put an
 * error-level line in the journal for a routine condition that is the host's,
 * not Cloudgate's. Every other 5xx is still a Cloudgate fault and still error.
 */
describe('AllExceptionsFilter — log level of a 5xx', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    error.mockRestore();
  });

  it.each([HOST_UNREACHABLE_CODE, PLATFORM_HOST_UNREACHABLE_CODE])(
    'does not journal a 503 %s at error, since its thrower journaled it at warn',
    (code) => {
      new AllExceptionsFilter().catch(
        new ServiceUnavailableException({ message: 'not reached', code }),
        httpHost(),
      );
      expect(error).not.toHaveBeenCalled();
    },
  );

  it('journals any other 5xx at error', () => {
    new AllExceptionsFilter().catch(
      new InternalServerErrorException(),
      httpHost(),
    );
    new AllExceptionsFilter().catch(new Error('boom'), httpHost());
    new AllExceptionsFilter().catch(
      new ServiceUnavailableException({ message: 'x', code: 'OTHER' }),
      httpHost(),
    );
    expect(error).toHaveBeenCalledTimes(3);
  });
});
