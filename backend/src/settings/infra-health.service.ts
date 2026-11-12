import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Docker from 'dockerode';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { DOCKER_CLIENT } from '../docker/docker-client.provider';
import { readSwarmServiceHealth } from '../docker/swarm-service-health';

export interface ServiceHealthStatus {
  status: 'healthy' | 'unhealthy';
  message?: string;
}

/**
 * The platform's infrastructure health: postgres is probed through the live
 * database connection (Cloudgate connects via DATABASE_URL — there is no
 * self-managed cloudgate-postgres swarm service to inspect), traefik through
 * the docker client. There is no redis to probe: the deployment queue is
 * in-process.
 */
@Injectable()
export class InfraHealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
  ) {}

  /** Public liveness: `{ status: 'ok' }` once `SELECT 1` answers. */
  async health(): Promise<{ status: 'ok' }> {
    await this.db.execute(sql`SELECT 1`);
    return { status: 'ok' };
  }

  async checkPostgresHealth(): Promise<ServiceHealthStatus> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: 'healthy' };
    } catch (error) {
      return {
        status: 'unhealthy',
        message:
          error instanceof Error ? error.message : 'Failed to check PostgreSQL',
      };
    }
  }

  /** Traefik's health: the standalone container, else the swarm service. */
  async checkTraefikHealth(): Promise<ServiceHealthStatus> {
    try {
      const container = this.docker.getContainer('cloudgate-traefik');
      const info = await container.inspect();
      if (!info.State.Running) {
        return { status: 'unhealthy', message: 'Container is not running' };
      }
      return { status: 'healthy' };
    } catch {
      return this.checkSwarmServiceRunning('cloudgate-traefik');
    }
  }

  /**
   * Whether a swarm service has a running task, reading through the shared
   * `readSwarmServiceHealth` — this was one of two copies of
   * inspect-replicas-then-count-tasks, and the Update phase's convergence poll
   * would have been a third.
   *
   * One behaviour moved with the extraction: an absent `Spec.Mode.Replicated`
   * is now one wanted task rather than zero. That is what a **global** service
   * looks like, and answering "0 replicas configured" about one was reporting a
   * fault where there was none; its tasks now decide, like every other service's.
   */
  private async checkSwarmServiceRunning(
    serviceName: string,
  ): Promise<ServiceHealthStatus> {
    try {
      const health = await readSwarmServiceHealth(this.docker, serviceName);
      if (!health.deployed) {
        return { status: 'unhealthy', message: 'Service not found' };
      }
      if (health.wanted === 0) {
        return {
          status: 'unhealthy',
          message: 'Service has 0 replicas configured',
        };
      }
      // One answering replica is health here, not the full replica count: this
      // asks whether Traefik can serve, not whether it is finished scaling.
      if (health.running === 0) {
        return {
          status: 'unhealthy',
          message: `No running tasks (current state: ${health.lastState ?? 'unknown'})`,
        };
      }

      return { status: 'healthy' };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Service not found',
      };
    }
  }

  /** Postgres and Traefik health, probed together. */
  async checkInfrastructureHealth(): Promise<{
    postgres: ServiceHealthStatus;
    traefik: ServiceHealthStatus;
  }> {
    const [postgres, traefik] = await Promise.all([
      this.checkPostgresHealth(),
      this.checkTraefikHealth(),
    ]);
    return { postgres, traefik };
  }
}
