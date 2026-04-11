import { Worker } from "bullmq";
import { NotificationChannel, NotificationDeliveryStatus, PrismaClient } from "@prisma/client";
import { RedisService } from "../redis/redis.service";
import { connection } from "./connection";
import * as nodemailer from "nodemailer";

export class NotificationWorker {
  private transporter?: nodemailer.Transporter;
  private transporterVerified = false;
  private transporterVerifyPromise?: Promise<void>;

  constructor(
    private redis: RedisService,
    private prisma: PrismaClient,
  ) {
    new Worker(
      "notification-queue",
      async (job) => {
        if (job.name === "send-email") {
          const { notificationId, email, subject, body } = job.data;

          await this.sendEmail(notificationId, email, subject, body);
        }

        if (job.name === "send-push") {
          const { notificationId } = job.data;
          await this.markDelivery(notificationId, NotificationChannel.MOBILE_PUSH, NotificationDeliveryStatus.SENT);
        }
      },
      {
        connection: connection
      }
    );
  }

  async sendEmail(notificationId: string, email: string, subject: string, body: string) {
    console.log("Sending email to:", email);

    try {
      const transporter = await this.getTransporter();
      const result = await transporter.sendMail({
        from: this.getFromAddress(),
        to: email,
        subject,
        html: body,
        text: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      });
      console.log("Notification email accepted by SMTP:", {
        notificationId,
        email,
        messageId: result.messageId,
        response: result.response,
      });

      await this.markDelivery(
        notificationId,
        NotificationChannel.EMAIL,
        NotificationDeliveryStatus.SENT,
        undefined,
        result.messageId ?? null,
      );

      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
      });

      const contactId = typeof notification?.metadata === "object" && notification?.metadata && "contactId" in (notification.metadata as Record<string, unknown>)
        ? String((notification.metadata as Record<string, unknown>).contactId)
        : null;

      if (notification?.workspaceId && contactId) {
        const activity = await this.prisma.userActivity.findUnique({
          where: { userId: notification.userId },
        });

        if (activity?.inactivitySessionId) {
          await this.prisma.notificationEmailHistory.upsert({
            where: {
              userId_contactId_type_inactivitySessionId: {
                userId: notification.userId,
                contactId,
                type: notification.type,
                inactivitySessionId: activity.inactivitySessionId,
              },
            },
            create: {
              notificationId,
              userId: notification.userId,
              workspaceId: notification.workspaceId,
              contactId,
              type: notification.type,
              inactivitySessionId: activity.inactivitySessionId,
            },
            update: {
              sentAt: new Date(),
            },
          });
        }
      }
    } catch (error) {
      console.error("Notification email failed:", {
        notificationId,
        email,
        error: error instanceof Error ? error.message : error,
      });
      await this.markDelivery(
        notificationId,
        NotificationChannel.EMAIL,
        NotificationDeliveryStatus.FAILED,
        error instanceof Error ? error.message : "Unknown delivery error",
      );
      throw error;
    }
  }

  private async markDelivery(
    notificationId: string,
    channel: NotificationChannel,
    status: NotificationDeliveryStatus,
    lastError?: string,
    providerMessageId?: string | null,
  ) {
    await this.prisma.notificationDelivery.update({
      where: {
        notificationId_channel: {
          notificationId,
          channel,
        },
      },
      data: {
        status,
        lastError: status === NotificationDeliveryStatus.SENT ? null : lastError,
        providerMessageId: providerMessageId ?? undefined,
        attemptCount: {
          increment: 1,
        },
        lastAttemptAt: new Date(),
      },
    });
  }

  private createTransport() {
    const host = process.env.NOTIFICATIONS_SMTP_HOST || process.env.SMTP_HOST;
    const port = Number(process.env.NOTIFICATIONS_SMTP_PORT || process.env.SMTP_PORT || 587);
    const user = process.env.NOTIFICATIONS_SMTP_USER || process.env.SMTP_USER;
    const pass = process.env.NOTIFICATIONS_SMTP_PASS || process.env.SMTP_PASS;
    const secure = String(process.env.NOTIFICATIONS_SMTP_SECURE || process.env.SMTP_SECURE || "false") === "true";

    if (!host || !user || !pass) {
      throw new Error("Notification email transport is not configured. Set NOTIFICATIONS_SMTP_HOST/USER/PASS or SMTP_HOST/USER/PASS.");
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    return transporter;
  }

  private async verifyTransporter(transporter: nodemailer.Transporter) {
    if (this.transporterVerified) {
      return;
    }

    if (!this.transporterVerifyPromise) {
      const host = process.env.NOTIFICATIONS_SMTP_HOST || process.env.SMTP_HOST;
      const port = Number(process.env.NOTIFICATIONS_SMTP_PORT || process.env.SMTP_PORT || 587);
      const secure = String(process.env.NOTIFICATIONS_SMTP_SECURE || process.env.SMTP_SECURE || "false") === "true";

      this.transporterVerifyPromise = transporter.verify()
        .then(() => {
          this.transporterVerified = true;
          console.log("Notification SMTP transporter verified", {
            host,
            port,
            secure,
            from: this.getFromAddress(),
          });
        })
        .catch((error) => {
          this.transporterVerifyPromise = undefined;
          console.error("Notification SMTP transporter verification failed", {
            host,
            port,
            secure,
            error: error instanceof Error ? error.message : error,
          });
          throw error;
        });
    }

    await this.transporterVerifyPromise;
  }

  private async getTransporter() {
    if (!this.transporter) {
      this.transporter = this.createTransport();
    }

    await this.verifyTransporter(this.transporter);
    return this.transporter;
  }

  private getFromAddress() {
    return process.env.NOTIFICATIONS_EMAIL_FROM
      || process.env.EMAIL_FROM
      || process.env.SMTP_FROM
      || process.env.SMTP_USER;
  }
}
