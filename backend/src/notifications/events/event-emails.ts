import { render } from '@react-email/components';
import { emailLogoAttachment } from '../../mail/email-logo';
import type { RenderedEmail } from '../../mail/templates';
import { TEST_MESSAGE, TEST_TITLE } from '../channels/channel.strategy';
import type { ChannelEvent } from '../channels/channel.strategy';
import { NotificationEmailTemplate } from '../templates/notification-email';
import { formatEventTime } from './event-time';
import {
  AGENT_RATE_LIMITED_TITLE,
  AGENT_ROW_LINK_LABEL,
  agentRateLimitedFacts,
  describeStrandedMember,
  PREVIEW_TEARDOWN_STUCK_TITLE,
  previewTeardownStuckFacts,
  SERVICE_HEALTH_LINK_LABEL,
  serviceIncidentFacts,
  serviceIncidentTitle,
  AI_MODEL_LINK_LABEL,
  AI_MODEL_NOT_ANSWERING_TITLE,
  aiModelNotAnsweringFacts,
} from './notification-event';

/**
 * The email rendering half of the notification triggers: event → subject
 * ("… for Cloudgate") + HTML rendered through NotificationEmailTemplate, with
 * the header's logo for the template's white header as its inline image.
 * Returns null for events that are never emailed (server-threshold).
 */
export async function renderEventEmail(
  event: ChannelEvent,
): Promise<RenderedEmail | null> {
  const date = new Date();
  switch (event.type) {
    case 'test':
      // The test-connection probe, from the same two constants every channel
      // renders — the twelfth copy counted was here, as was the one
      // subject that named the transport instead of the probe ({@link
      // TEST_TITLE} settles which).
      return { subject: TEST_TITLE, html: `<p>${TEST_MESSAGE}</p>` };
    case 'app-deploy':
      return {
        subject: 'Build success for Cloudgate',
        html: await render(
          NotificationEmailTemplate({
            previewText: `Build success for ${event.applicationName}`,
            heading: `Build success for ${event.applicationName}`,
            intro: `Your build for ${event.applicationName} was successful`,
            details: [
              { label: 'Project Name', value: event.projectName },
              { label: 'Application Name', value: event.applicationName },
              { label: 'Environment', value: event.environmentName },
              { label: 'Application Type', value: event.applicationType },
              { label: 'Date', value: formatEventTime(date) },
            ],
            ...(event.buildLink && {
              link: { label: 'View build', url: event.buildLink },
            }),
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'app-build-error':
      return {
        subject: 'Build failed for Cloudgate',
        html: await render(
          NotificationEmailTemplate({
            previewText: `Build failed for ${event.applicationName}`,
            heading: `Build failed for ${event.applicationName}`,
            intro: `Your build for ${event.applicationName} failed`,
            details: [
              { label: 'Project Name', value: event.projectName },
              { label: 'Application Name', value: event.applicationName },
              { label: 'Application Type', value: event.applicationType },
              { label: 'Error', value: event.errorMessage },
              { label: 'Date', value: formatEventTime(date) },
            ],
            ...(event.buildLink && {
              link: { label: 'View build', url: event.buildLink },
            }),
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'database-backup': {
      const success = event.status === 'success';
      return {
        subject: 'Database backup for Cloudgate',
        html: await render(
          NotificationEmailTemplate({
            previewText: `Database backup ${success ? 'successful' : 'failed'} for ${event.applicationName}`,
            heading: `Database backup ${success ? 'successful' : 'failed'}`,
            intro: `The ${event.databaseType} backup for ${event.applicationName} ${success ? 'completed successfully' : 'failed'}`,
            details: [
              { label: 'Project Name', value: event.projectName },
              { label: 'Application Name', value: event.applicationName },
              { label: 'Database Type', value: event.databaseType },
              { label: 'Database Name', value: event.databaseName },
              ...(event.status === 'error' && event.errorMessage
                ? [{ label: 'Error', value: event.errorMessage }]
                : []),
              { label: 'Date', value: formatEventTime(date) },
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    }
    case 'volume-backup': {
      const success = event.status === 'success';
      return {
        subject: `Volume Backup ${success ? 'Successful' : 'Failed'} - ${event.applicationName}`,
        html: await render(
          NotificationEmailTemplate({
            previewText: `Volume backup ${success ? 'successful' : 'failed'} for ${event.applicationName}`,
            heading: `Volume backup ${success ? 'successful' : 'failed'}`,
            intro: `The backup of volume ${event.volumeName} for ${event.applicationName} ${success ? 'completed successfully' : 'failed'}`,
            details: [
              { label: 'Project Name', value: event.projectName },
              { label: 'Application Name', value: event.applicationName },
              { label: 'Volume Name', value: event.volumeName },
              { label: 'Service Type', value: event.serviceType },
              ...(event.backupSize
                ? [{ label: 'Backup Size', value: event.backupSize }]
                : []),
              ...(event.status === 'error' && event.errorMessage
                ? [{ label: 'Error', value: event.errorMessage }]
                : []),
              { label: 'Date', value: formatEventTime(date) },
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    }
    case 'docker-cleanup':
      return {
        subject: 'Docker cleanup for Cloudgate',
        html: await render(
          NotificationEmailTemplate({
            previewText: 'Docker cleanup completed',
            heading: 'Docker cleanup',
            intro: 'The scheduled Docker cleanup completed successfully',
            details: [
              { label: 'Message', value: event.message },
              { label: 'Date', value: formatEventTime(date) },
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'instance-backup': {
      const success = event.status === 'success';
      return {
        subject: 'Cloudgate instance backup',
        html: await render(
          NotificationEmailTemplate({
            previewText: `Cloudgate instance backup ${success ? 'successful' : 'failed'}`,
            heading: `Instance backup ${success ? 'successful' : 'failed'}`,
            intro: `The backup of the Cloudgate instance ${success ? 'completed successfully' : 'failed'}`,
            details: [
              { label: 'Backup Type', value: 'Complete Cloudgate Instance' },
              ...(event.backupSize
                ? [{ label: 'Backup Size', value: event.backupSize }]
                : []),
              ...(event.status === 'error' && event.errorMessage
                ? [{ label: 'Error', value: event.errorMessage }]
                : []),
              { label: 'Date', value: formatEventTime(date) },
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    }
    case 'license-lapse': {
      const expiry = new Date(event.validUntil);
      const count = event.strandedMembers.length;
      return {
        subject: `Enterprise license lapsed for ${event.organizationName}`,
        html: await render(
          NotificationEmailTemplate({
            previewText: `The enterprise license for ${event.organizationName} has lapsed`,
            heading: 'Enterprise license lapsed',
            // The template's intro is where prose belongs, and this event's
            // prose is the part that matters: what it costs and why nobody was
            // moved off their custom role for them.
            intro: event.message,
            details: [
              { label: 'Organization', value: event.organizationName },
              { label: 'Expired', value: formatEventTime(expiry) },
              { label: 'Stopped', value: event.stopped.join('; ') },
              // Only when somebody is locked out: "Locked out (0)"
              // over an empty row reads as a rendering fault.
              ...(count > 0
                ? [
                    {
                      // Distinct labels: the template keys its rows by label.
                      label: `Locked out (${count})`,
                      value: event.strandedMembers
                        .map(describeStrandedMember)
                        .join('; '),
                    },
                  ]
                : []),
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    }
    case 'license-expiring': {
      const expiry = new Date(event.validUntil);
      return {
        subject: `Enterprise license for ${event.organizationName} expires on ${formatEventTime(expiry)}`,
        html: await render(
          NotificationEmailTemplate({
            previewText: `The enterprise license for ${event.organizationName} expires on ${formatEventTime(expiry)}`,
            heading: 'Enterprise license expiring',
            intro: event.message,
            details: [
              { label: 'Organization', value: event.organizationName },
              { label: 'Expires', value: formatEventTime(expiry) },
              { label: 'Days left', value: String(event.daysLeft) },
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    }
    case 'preview-teardown-stuck':
      // React escapes every value it renders, so the operator-typed names
      // need nothing here.
      return {
        subject: `Requested previews stuck on ${event.serverName}`,
        html: await render(
          NotificationEmailTemplate({
            previewText: `Requested previews cannot be torn down on ${event.serverName}`,
            heading: PREVIEW_TEARDOWN_STUCK_TITLE,
            intro: event.message,
            details: previewTeardownStuckFacts(event).map(
              ({ label, value }) => ({
                label,
                value,
              }),
            ),
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'service-incident':
      // React escapes every value it renders, so the operator-typed names
      // need nothing here.
      return {
        subject:
          event.state === 'opened'
            ? `Incident opened on ${event.serviceName}`
            : `Incident closed on ${event.serviceName}`,
        html: await render(
          NotificationEmailTemplate({
            previewText:
              event.state === 'opened'
                ? event.source === 'error-rate-threshold'
                  ? `Error rate ${event.openingError} breached ${event.target}`
                  : `${event.target} is down: ${event.openingError}`
                : `${event.target}: the Incident is closed`,
            heading: serviceIncidentTitle(event),
            intro:
              event.state === 'opened'
                ? event.source === 'error-rate-threshold'
                  ? `The Error rate of ${event.serviceName} has breached its threshold and an Incident is open.`
                  : `An Uptime check on ${event.serviceName} has failed and an Incident is open.`
                : `The Incident on ${event.serviceName} is closed.`,
            details: serviceIncidentFacts(event),
            ...(event.serviceLink && {
              link: {
                label: SERVICE_HEALTH_LINK_LABEL,
                url: event.serviceLink,
              },
            }),
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'ai-model-not-answering':
      // React escapes every value it renders, so the operator-typed names
      // need nothing here.
      return {
        subject: `AI model ${event.aiModelName} is not answering`,
        html: await render(
          NotificationEmailTemplate({
            previewText: `Calls to ${event.aiModelName} through the gateway are failing`,
            heading: AI_MODEL_NOT_ANSWERING_TITLE,
            intro: event.message,
            details: aiModelNotAnsweringFacts(event),
            ...(event.aiModelLink && {
              link: { label: AI_MODEL_LINK_LABEL, url: event.aiModelLink },
            }),
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'agent-rate-limited':
      // React escapes every value it renders, so the operator-typed names
      // need nothing here.
      return {
        subject: `Agent ${event.agentName} rate limited in ${event.organizationName}`,
        html: await render(
          NotificationEmailTemplate({
            previewText: `${event.agentName} ran out of its rate budget`,
            heading: AGENT_RATE_LIMITED_TITLE,
            intro: event.message,
            details: agentRateLimitedFacts(event).map(({ label, value }) => ({
              label,
              value,
            })),
            ...(event.agentLink && {
              link: { label: AGENT_ROW_LINK_LABEL, url: event.agentLink },
            }),
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    case 'instance-restart':
      return {
        subject: 'Cloudgate Server Restarted',
        html: await render(
          NotificationEmailTemplate({
            previewText: 'Cloudgate server restarted',
            heading: 'Cloudgate server restarted',
            intro: 'The Cloudgate server has been restarted successfully',
            details: [
              { label: 'Status', value: 'Successful' },
              { label: 'Date', value: formatEventTime(date) },
            ],
          }),
        ),
        inlineImages: [emailLogoAttachment('light')],
      };
    default:
      // Server-threshold alerts are never emailed.
      return null;
  }
}
