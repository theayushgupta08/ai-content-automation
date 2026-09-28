import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { MediaModule } from '../media/media.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [JobsModule, MediaModule],
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
