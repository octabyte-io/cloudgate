/**
 * Docker Swarm service-spec overrides — the typed JSON columns on an
 * Application, passed through to the Docker Engine API at deploy time
 * (`applications/swarm.types.ts`).
 *
 * The PascalCase field names are the Docker Engine API's own and stay that way:
 * a third party's strings keep their own names.
 */

export interface HealthCheckSwarm {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  StartPeriod?: number;
  Retries?: number;
}

export interface RestartPolicySwarm {
  Condition?: string;
  Delay?: number;
  MaxAttempts?: number;
  Window?: number;
}

export interface PlacementSwarm {
  Constraints?: string[];
  Preferences?: { Spread: { SpreadDescriptor: string } }[];
  MaxReplicas?: number;
  Platforms?: { Architecture: string; OS: string }[];
}

export interface UpdateConfigSwarm {
  Parallelism: number;
  Delay?: number;
  FailureAction?: string;
  Monitor?: number;
  MaxFailureRatio?: number;
  Order: string;
}

export interface ServiceModeSwarm {
  Replicated?: { Replicas?: number };
  Global?: object;
  ReplicatedJob?: { MaxConcurrent?: number; TotalCompletions?: number };
  GlobalJob?: object;
}

export interface NetworkSwarm {
  Target?: string;
  Aliases?: string[];
  DriverOpts?: Record<string, string>;
}

export type LabelsSwarm = Record<string, string>;

export interface EndpointPortConfigSwarm {
  Protocol?: string;
  TargetPort?: number;
  PublishedPort?: number;
  PublishMode?: string;
}

export interface EndpointSpecSwarm {
  Mode?: string;
  Ports?: EndpointPortConfigSwarm[];
}

export interface UlimitSwarm {
  Name: string;
  Soft: number;
  Hard: number;
}

export type UlimitsSwarm = UlimitSwarm[];
