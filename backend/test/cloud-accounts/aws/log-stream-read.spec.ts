import type { ConfigService } from '@nestjs/config';
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';

import { AwsCloudAdapter } from '../../../src/cloud-accounts/aws/aws-cloud.adapter';
import type { Env } from '../../../src/common/config/env.schema';

const SESSION = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'token',
};
const STREAM = {
  region: 'us-east-1',
  logGroupName: '/cloudgate/env/app',
  logStreamName: 'service/service/task',
};

/**
 * A CloudWatch stream as `GetLogEvents` answers it, as the walk by hand
 * found it in us-east-1: a read of a stream with no events yet still hands
 * out a forward token, and that token never sees an event added after it, so
 * a reader that keeps it reads nothing for good. A token from a read that
 * had events moves on from them, and is handed back unchanged when nothing
 * is newer.
 */
class Stream {
  private readonly events: string[] = [];
  private readonly emptyTokens = new Set<string>();
  private issued = 0;

  print(...lines: string[]): void {
    this.events.push(...lines);
  }

  answer(input: { nextToken?: string }) {
    if (input.nextToken && this.emptyTokens.has(input.nextToken)) {
      return { events: [], nextForwardToken: input.nextToken };
    }
    const from = input.nextToken ? Number(input.nextToken.slice(2)) : 0;
    const events = this.events.slice(from).map((message) => ({ message }));
    if (events.length === 0 && !input.nextToken) {
      const token = `e/${++this.issued}`;
      this.emptyTokens.add(token);
      return { events, nextForwardToken: token };
    }
    return { events, nextForwardToken: `f/${this.events.length}` };
  }
}

describe('AwsCloudAdapter.readLogStream', () => {
  const adapter = new AwsCloudAdapter({
    get: () => 'unused',
  } as unknown as ConfigService<Env, true>);
  let stream: Stream;
  let made: boolean;
  let send: jest.SpyInstance;

  beforeEach(() => {
    stream = new Stream();
    made = true;
    send = jest.spyOn(CloudWatchLogsClient.prototype, 'send');
    send.mockImplementation((command: unknown) => {
      if (!(command instanceof GetLogEventsCommand)) {
        throw new Error('unexpected command');
      }
      if (!made) {
        throw new ResourceNotFoundException({
          message: 'The specified log stream does not exist.',
          $metadata: {},
        });
      }
      return Promise.resolve(stream.answer(command.input));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  async function read(from: string | null) {
    const answer = await adapter.readLogStream(SESSION, { ...STREAM, from });
    if (!answer.ok) throw new Error(answer.message);
    return answer.value;
  }

  it('reads from the head again after a read that found the stream empty', async () => {
    const first = await read(null);
    expect(first.messages).toEqual([]);

    stream.print('inside says hello', 'nightly ran');
    const second = await read(first.next);
    expect(second.messages).toEqual(['inside says hello', 'nightly ran']);
  });

  it('reads from the head after a read of a stream not made yet', async () => {
    made = false;
    const first = await read(null);
    expect(first).toEqual({ messages: [], next: null });

    made = true;
    stream.print('tick');
    expect((await read(first.next)).messages).toEqual(['tick']);
  });

  it('goes on from where a read with events ended, and reads nothing twice', async () => {
    stream.print('one');
    const first = await read(null);
    expect(first.messages).toEqual(['one']);

    const idle = await read(first.next);
    expect(idle).toEqual({ messages: [], next: first.next });

    stream.print('two');
    expect((await read(idle.next)).messages).toEqual(['two']);
  });
});
