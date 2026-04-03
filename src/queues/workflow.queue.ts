// src/queues/workflow.queue.ts
import { Queue } from 'bullmq';
import { connection } from './connection';

export const workflowQueue = new Queue('workflow', {
    connection: connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
});

// Job type definitions
export interface TriggerWorkflowJob {
    type: 'TRIGGER';
    workspaceId: string;
    workflowId: string;
    contactId: string;
    conversationId?: string;
    triggerData: Record<string, any>;
}

export interface ResumeWorkflowJob {
    type: 'RESUME';
    runId: string;
    resumeData: Record<string, any>; // e.g. { answer: 'user reply text' }
}

export interface ExecuteStepJob {
    type: 'EXECUTE_STEP';
    runId: string;
    stepId: string;
}

export type WorkflowJob = TriggerWorkflowJob | ResumeWorkflowJob | ExecuteStepJob;