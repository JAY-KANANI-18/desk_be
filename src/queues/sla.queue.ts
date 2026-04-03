import { Queue } from 'bullmq';
import { connection } from './connection';

export const slaQueue = new Queue('sla', {
    connection: connection,
});