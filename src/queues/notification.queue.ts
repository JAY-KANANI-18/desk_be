import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class NotificationQueue {
  private queue: Queue;

  constructor(private redisService: RedisService) {
    this.queue = new Queue("notification-queue", {
      connection: {
  host: "127.0.0.1",
  port: 6379
},
    });
  }

  async addEmailNotification(data: {
    email: string;
    subject: string;
    body: string;
  }) {
    await this.queue.add("send-email", data, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}