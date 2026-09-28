import Ajv2020, { type ValidateFunction, type ErrorObject } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import jobInputSchema from '../schemas/job-input.schema.json';
import scriptSchema from '../schemas/script.schema.json';
import scenesSchema from '../schemas/scenes.schema.json';
import timelineSchema from '../schemas/timeline.schema.json';
import jobEventSchema from '../schemas/job-event.schema.json';

import type { JobInput, Script, ScenePlan, Timeline, JobEvent } from './generated/types';

export * from './generated/types';

export const schemas = {
  jobInput: jobInputSchema,
  script: scriptSchema,
  scenes: scenesSchema,
  timeline: timelineSchema,
  jobEvent: jobEventSchema,
} as const;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // Required properties are declared inside anyOf branches (e.g. CharacterRef); that is valid
  // JSON Schema but Ajv's strictRequired flags it, so disable only that check.
  strictRequired: false,
  useDefaults: false,
  allowUnionTypes: true,
});
addFormats(ajv);

export class ContractValidationError extends Error {
  constructor(
    public readonly contract: string,
    public readonly errors: ErrorObject[],
  ) {
    super(`${contract} failed validation: ${ajv.errorsText(errors, { separator: '; ' })}`);
    this.name = 'ContractValidationError';
  }
}

interface Validator<T> {
  /** Type guard: true when `data` satisfies the contract. */
  is: (data: unknown) => data is T;
  /** Returns `data` typed as T or throws ContractValidationError. */
  assert: (data: unknown) => T;
  /** Errors from the most recent `is` call that returned false. */
  errors: () => ErrorObject[];
}

function makeValidator<T>(name: string, schema: object): Validator<T> {
  const fn = ajv.compile(schema) as ValidateFunction<T>;
  return {
    is: (data: unknown): data is T => fn(data) === true,
    assert: (data: unknown): T => {
      if (fn(data)) return data;
      throw new ContractValidationError(name, fn.errors ?? []);
    },
    errors: () => fn.errors ?? [],
  };
}

export const jobInput = makeValidator<JobInput>('JobInput', jobInputSchema);
export const script = makeValidator<Script>('Script', scriptSchema);
export const scenePlan = makeValidator<ScenePlan>('ScenePlan', scenesSchema);
export const timeline = makeValidator<Timeline>('Timeline', timelineSchema);
export const jobEvent = makeValidator<JobEvent>('JobEvent', jobEventSchema);

export const isJobInput = jobInput.is;
export const isScript = script.is;
export const isScenePlan = scenePlan.is;
export const isTimeline = timeline.is;
export const isJobEvent = jobEvent.is;

export const assertJobInput = jobInput.assert;
export const assertScript = script.assert;
export const assertScenePlan = scenePlan.assert;
export const assertTimeline = timeline.assert;
export const assertJobEvent = jobEvent.assert;

/** Stage identifiers in pipeline order. */
export const STAGES = [
  'moderation',
  'story',
  'characters',
  'keyframes',
  'video',
  'audio',
  'edit',
  'final',
] as const;
export type Stage = (typeof STAGES)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'canceled',
  'needs_review',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
