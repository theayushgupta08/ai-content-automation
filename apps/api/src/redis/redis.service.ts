import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Subject } from 'rxjs';
import { appConfig } from '../config';

export interface PublishedJobEvent {
  jobId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Redis client pair: one connection for commands/publishing and one dedicated subscriber that
 * fans job events out to in-process SSE streams through an rxjs Subject.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client = new Redis(appConfig.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
  private readonly subscriber = new Redis(appConfig.redisUrl, { lazyConnect: true });
  readonly jobEvents$ = new Subject<PublishedJobEvent>();

  static channel(jobId: string): string {
    return `job:${jobId}:events`;
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.subscriber.connect();
    await this.subscriber.psubscribe('job:*:events');
    this.subscriber.on('pmessage', (_pattern, _channel, message) => {
      try {
        this.jobEvents$.next(JSON.parse(message) as PublishedJobEvent);
      } catch (e) {
        this.logger.warn(`dropping malformed job event: ${(e as Error).message}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.jobEvents$.complete();
    await Promise.allSettled([this.subscriber.quit(), this.client.quit()]);
  }

  async publishJobEvent(event: PublishedJobEvent): Promise<void> {
    await this.client.publish(RedisService.channel(event.jobId), JSON.stringify(event));
  }
}
