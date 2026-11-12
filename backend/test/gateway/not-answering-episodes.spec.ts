import { AiModelNotAnsweringEpisodes } from '../../src/gateway/not-answering-episodes';
import type {
  AiModelNotAnsweringNotifier,
  NotAnswering,
} from '../../src/gateway/not-answering-episodes';

/**
 * "AI model not answering"'s already-told mark (spec stories
 * 97-98): the first call of an episode that could not get through raises the
 * Notification, every failing call inside it stays silent, and the next call
 * that gets through closes it. Driven by the outcomes the Gateway settles its
 * calls with; the notifier is the one port it reaches out through.
 */

const AT = new Date('2026-10-16T09:00:00.000Z');

function setup() {
  const told: NotAnswering[] = [];
  const send = jest.fn((episode: NotAnswering) => {
    told.push(episode);
    return Promise.resolve();
  });
  const notifier: AiModelNotAnsweringNotifier = { aiModelNotAnswering: send };
  return { told, send, episodes: new AiModelNotAnsweringEpisodes(notifier) };
}

describe('AiModelNotAnsweringEpisodes', () => {
  it('tells the operator at the first call that could not get through, naming the AI model and when', () => {
    const { told, episodes } = setup();

    episodes.observe('app-1', 'runtime-error', AT);

    expect(told).toEqual([{ applicationId: 'app-1', failedAt: AT }]);
  });

  it('stays silent for every further failing call of the episode', () => {
    const { told, episodes } = setup();

    episodes.observe('app-1', 'runtime-error', AT);
    episodes.observe('app-1', 'runtime-error', AT);
    episodes.observe('app-1', 'runtime-error', AT);

    expect(told).toHaveLength(1);
  });

  it('is re-armed by a call that gets through, so the next failure tells again', () => {
    const { told, episodes } = setup();
    const later = new Date(AT.getTime() + 60_000);

    episodes.observe('app-1', 'runtime-error', AT);
    episodes.observe('app-1', 'ok', AT);
    episodes.observe('app-1', 'runtime-error', later);

    expect(told).toEqual([
      { applicationId: 'app-1', failedAt: AT },
      { applicationId: 'app-1', failedAt: later },
    ]);
  });

  it('neither tells nor re-arms on a refusal or a caller who left', () => {
    const { told, episodes } = setup();

    episodes.observe('app-1', 'refused', AT);
    episodes.observe('app-1', 'client-aborted', AT);
    expect(told).toHaveLength(0);

    episodes.observe('app-1', 'runtime-error', AT);
    episodes.observe('app-1', 'refused', AT);
    episodes.observe('app-1', 'client-aborted', AT);
    episodes.observe('app-1', 'runtime-error', AT);
    expect(told).toHaveLength(1);
  });

  it('keeps each AI model its own episode', () => {
    const { told, episodes } = setup();

    episodes.observe('app-1', 'runtime-error', AT);
    episodes.observe('app-2', 'runtime-error', AT);
    episodes.observe('app-2', 'ok', AT);
    episodes.observe('app-1', 'runtime-error', AT);

    expect(told.map((episode) => episode.applicationId)).toEqual([
      'app-1',
      'app-2',
    ]);
  });

  it('keeps the episode marked when the notifier fails, never telling twice', async () => {
    const { send, episodes } = setup();
    send.mockRejectedValueOnce(new Error('channel down'));

    episodes.observe('app-1', 'runtime-error', AT);
    await new Promise((resolve) => setImmediate(resolve));
    episodes.observe('app-1', 'runtime-error', AT);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
