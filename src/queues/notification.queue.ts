import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { RedisService } from "../redis/redis.service";
import { connection } from "./connection";

@Injectable()
export class NotificationQueue {
  private queue: Queue;
  private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

  constructor(private redisService: RedisService) {
    this.queue = new Queue("notification-queue", {
      connection :connection
    });
  }

  async addEmailNotification(data: {
    notificationId: string;
    email: string;
    subject: string;
    body: string;
    workspaceId?: string | null;
  }) {
    this.logDebug("enqueue:email", data);
    await this.queue.add("send-email", data, {
      jobId: `notification:email:${data.notificationId}`,
      attempts: 4,
      backoff: {
        type: 'exponential',
        delay: 30_000,
      },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }

  async addPushNotification(data: {
    notificationId: string;
    userId: string;
    workspaceId?: string | null;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    this.logDebug("enqueue:push", data);
    await this.queue.add("send-push", data, {
      jobId: `notification:push:${data.notificationId}`,
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 20_000,
      },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  private logDebug(event: string, details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    console.info(`[NotificationDebug][Queue] ${event}`, details ?? "");
  }
}
