import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { RedisService } from "../redis/redis.service";
import { connection } from "./connection";

@Injectable()
export class NotificationQueue {
  private queue: Queue;

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
  }) {
    await this.queue.add("send-email", data, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async addPushNotification(data: {
    notificationId: string;
    userId: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.queue.add("send-push", data, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
