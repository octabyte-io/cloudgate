import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

function answer(exception: unknown): Record<string, unknown> {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  new AllExceptionsFilter().catch(exception, {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/registries/test-connection' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost);
  const [[body]] = response.json.mock.calls as [[Record<string, unknown>]];
  return body;
}

/**
 * A registry test's refusal is a plain sentence in `message` and
 * docker's own output in `output`, which the console keeps behind "Details".
 * Opt-in: nothing else's body grows the field.
 */
describe('AllExceptionsFilter — output', () => {
  it('publishes the output a thrower carried beside its message', () => {
    expect(
      answer(
        new BadRequestException({
          message: 'Could not reach registry.example.com (Bad Gateway).',
          output: 'Get "https://registry.example.com/v2/": Bad Gateway',
        }),
      ),
    ).toMatchObject({
      statusCode: 400,
      message: 'Could not reach registry.example.com (Bad Gateway).',
      output: 'Get "https://registry.example.com/v2/": Bad Gateway',
    });
  });

  it('adds no output to a refusal that carried none', () => {
    expect(
      answer(new NotFoundException('Registry not found')),
    ).not.toHaveProperty('output');
    expect(
      answer(new BadRequestException({ message: 'x', output: '' })),
    ).not.toHaveProperty('output');
  });
});
