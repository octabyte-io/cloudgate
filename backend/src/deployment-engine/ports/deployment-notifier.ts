/**
 * Port for build outcome notifications (build success and build error),
 * implemented by the Phase 39 notifications module.
 */
export const DEPLOYMENT_NOTIFIER = Symbol('DEPLOYMENT_NOTIFIER');

export interface DeploymentNotification {
  projectName: string;
  applicationName: string;
  /** 'application' or 'compose'. */
  applicationType: string;
  environmentName: string;
  organizationId: string;
  // The ids the notification's dashboard link is assembled from.
  projectId: string;
  environmentId: string;
  /** applicationId or composeId, matching applicationType. */
  serviceId: string;
}

export interface DeploymentNotifier {
  buildSuccess(notification: DeploymentNotification): Promise<void>;
  buildError(
    notification: DeploymentNotification & { errorMessage: string },
  ): Promise<void>;
}
