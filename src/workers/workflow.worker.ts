// src/workers/workflow.worker.ts
import { Worker } from 'bullmq';
import { WorkflowEngineService } from '../modules/workflows/workflow-engine.service';
import { WorkflowJob } from '../queues/workflow.queue';

export function createWorkflowWorker(engine: WorkflowEngineService) {
    return new Worker<WorkflowJob>(
        'workflow',
        async (job) => {
            const data = job.data;

            switch (data.type) {
                case 'TRIGGER':
                    await engine.startRun(data);
                    break;

                case 'EXECUTE_STEP':
                    await engine.executeStep(data.runId, data.stepId);
                    break;

                case 'RESUME':
                    await engine.resumeRun(data.runId, data.resumeData);
                    break;
            }
        },
        {

            connection: {
                host: '127.0.0.1',
                port: 6379,
            },

            concurrency: 1,
            limiter: { max: 100, duration: 1000 },
        },
    );
}