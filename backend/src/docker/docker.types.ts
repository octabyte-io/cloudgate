/**
 * A mount attached to a deployable service. Which optional field applies
 * depends on `type`: volume → volumeName, bind → hostPath, file → filePath
 * (relative to the service's files directory).
 */
export interface ServiceMount {
  type: 'volume' | 'bind' | 'file';
  mountPath: string;
  volumeName?: string | null;
  hostPath?: string | null;
  filePath?: string | null;
}

/** Raw resource limits/reservations as stored on a service (strings). */
export interface ServiceResources {
  memoryLimit: string | null;
  memoryReservation: string | null;
  cpuLimit: string | null;
  cpuReservation: string | null;
}

/** Dockerode mount spec (subset used for swarm services/containers). */
export interface DockerMountSpec {
  Type: 'volume' | 'bind';
  Source: string;
  Target: string;
}
