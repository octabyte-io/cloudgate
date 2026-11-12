import { withSecretsHidden } from '../../src/databases/redis/secrets-hidden';

/**
 * A redis Cloudgate made on a cloud (ElastiCache or Memorystore) is
 * never connected to with the Server's generated password, so a response
 * does not carry it; a redis on a Server still does.
 */
describe('withSecretsHidden', () => {
  const server = {
    redisId: 'r-1',
    cloudAccountId: null,
    databasePassword: 'server-password',
    authToken: null,
  };

  it('keeps the password of a redis on a Server', () => {
    expect(withSecretsHidden(server)).toEqual({
      redisId: 'r-1',
      cloudAccountId: null,
      databasePassword: 'server-password',
      hasAuthToken: false,
    });
  });

  it('drops the password of a redis on a cloud, and answers its AUTH token only as set', () => {
    const cloud = {
      redisId: 'r-2',
      cloudAccountId: 'ca-1',
      databasePassword: 'never-used-password',
      authToken: 'the-elasticache-token',
    };

    expect(withSecretsHidden(cloud)).toEqual({
      redisId: 'r-2',
      cloudAccountId: 'ca-1',
      hasAuthToken: true,
    });
  });

  it('drops it in every row of a list', () => {
    const cloud = {
      redisId: 'r-3',
      cloudAccountId: 'ca-1',
      databasePassword: 'never-used-password',
      authToken: null,
    };

    expect(withSecretsHidden([server, cloud])).toEqual([
      expect.objectContaining({ databasePassword: 'server-password' }),
      { redisId: 'r-3', cloudAccountId: 'ca-1', hasAuthToken: false },
    ]);
  });
});
