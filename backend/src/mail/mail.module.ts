import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { ResendSender } from './senders/resend';
import { SmtpSender } from './senders/smtp';

@Module({
  providers: [MailService, SmtpSender, ResendSender],
  exports: [MailService, SmtpSender, ResendSender],
})
export class MailModule {}
