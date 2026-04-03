import { Worker } from "bullmq";
import { RedisService } from "../redis/redis.service";
import { SupabaseService } from "../supdabse/supabase.service";
import { connection } from "./connection";

export class NotificationWorker {
  constructor(
    private redis: RedisService,
    private supabase: SupabaseService
  ) {
    new Worker(
      "notification-queue",
      async (job) => {
        if (job.name === "send-email") {
          const { email, subject, body } = job.data;

          await this.sendEmail(email, subject, body);
        }
      },
      {
        connection: connection
      }
    );
  }

  async sendEmail(email: string, subject: string, body: string) {
    console.log("Sending email to:", email);

    // example email logic
    await this.supabase.sendEmail({
      to: email,
      subject,
      html: body,
    });
  }
}