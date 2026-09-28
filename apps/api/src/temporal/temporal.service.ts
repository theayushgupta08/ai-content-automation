import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import type { JobInput } from '@avg/contracts';
import { appConfig } from '../config';

export const VIDEO_JOB_WORKFLOW = 'VideoJobWorkflow';

export interface VideoJobParams {
  jobId: string;
  workspaceId: string;
  input: JobInput;
  pipelineVersion: string;
}

@Injectable()
export class TemporalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporalService.name);
  private connection?: Connection;
  private client?: Client;

  async onModuleInit(): Promise<void> {
    this.connection = await Connection.connect({ address: appConfig.temporal.address });
    this.client = new Client({
      connection: this.connection,
      namespace: appConfig.temporal.namespace,
    });
    this.logger.log(`connected to Temporal at ${appConfig.temporal.address}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  static workflowId(jobId: string): string {
    return `job-${jobId}`;
  }

  async startVideoJob(params: VideoJobParams): Promise<string> {
    const workflowId = TemporalService.workflowId(params.jobId);
    await this.getClient().workflow.start(VIDEO_JOB_WORKFLOW, {
      taskQueue: appConfig.temporal.taskQueue,
      workflowId,
      args: [params],
      searchAttributes: {},
    });
    return workflowId;
  }

  async approve(jobId: string, checkpoint: 'script' | 'characters'): Promise<void> {
    await this.getClient()
      .workflow.getHandle(TemporalService.workflowId(jobId))
      .signal('approve', checkpoint);
  }

  async cancel(jobId: string): Promise<boolean> {
    try {
      await this.getClient().workflow.getHandle(TemporalService.workflowId(jobId)).cancel();
      return true;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return false;
      throw e;
    }
  }

  /** Whether the job's workflow still exists (running or closed) on the Temporal server. */
  async exists(jobId: string): Promise<boolean> {
    try {
      await this.getClient().workflow.getHandle(TemporalService.workflowId(jobId)).describe();
      return true;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return false;
      throw e;
    }
  }

  /** Running / closed status of the workflow, or null when it does not exist. */
  async workflowStatus(jobId: string): Promise<string | null> {
    try {
      const d = await this.getClient()
        .workflow.getHandle(TemporalService.workflowId(jobId))
        .describe();
      return d.status.name;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return null;
      throw e;
    }
  }

  async queryStatus(jobId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.getClient()
        .workflow.getHandle(TemporalService.workflowId(jobId))
        .query('status');
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return null;
      throw e;
    }
  }

  private getClient(): Client {
    if (!this.client) throw new Error('Temporal client not initialised');
    return this.client;
  }
}
