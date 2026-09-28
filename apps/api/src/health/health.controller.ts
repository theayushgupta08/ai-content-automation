import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiError } from '../common/problem.filter';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'fail'> = { database: 'fail', redis: 'fail' };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      /* reported below */
    }
    try {
      if ((await this.redis.client.ping()) === 'PONG') checks.redis = 'ok';
    } catch {
      /* reported below */
    }
    if (Object.values(checks).includes('fail')) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'NOT_READY', JSON.stringify(checks));
    }
    return { status: 'ready', checks };
  }
}
