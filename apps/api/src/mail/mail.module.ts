import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  providers: [MailService, NotificationsService],
  exports: [MailService, NotificationsService],
})
export class MailModule {}
