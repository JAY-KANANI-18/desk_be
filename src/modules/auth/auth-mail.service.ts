import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { redactEmail } from './auth.utils';

@Injectable()
export class AuthMailService {
  private readonly logger = new Logger(AuthMailService.name);
  private transporter?: nodemailer.Transporter;

  private getTransporter() {
    if (this.transporter) {
      return this.transporter;
    }

    const host = process.env.AUTH_SMTP_HOST ?? process.env.NOTIFICATIONS_SMTP_HOST ?? process.env.SMTP_HOST;
    const port = Number(process.env.AUTH_SMTP_PORT ?? process.env.NOTIFICATIONS_SMTP_PORT ?? process.env.SMTP_PORT ?? 587);
    const user = process.env.AUTH_SMTP_USER ?? process.env.NOTIFICATIONS_SMTP_USER ?? process.env.SMTP_USER;
    const pass = process.env.AUTH_SMTP_PASS ?? process.env.NOTIFICATIONS_SMTP_PASS ?? process.env.SMTP_PASS;
    const secure = `${process.env.AUTH_SMTP_SECURE ?? 'false'}` === 'true';

    if (!host || !user || !pass) {
      return null;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    return this.transporter;
  }

  async sendMail(options: { to: string; subject: string; html: string; text: string }) {
    const transporter = this.getTransporter();
    const from = process.env.AUTH_FROM_EMAIL ?? process.env.NOTIFICATIONS_FROM_EMAIL ?? process.env.SMTP_FROM_EMAIL ?? process.env.SMTP_USER;

    if (!transporter || !from) {
      this.logger.warn(`SMTP not configured. Auth email skipped for ${redactEmail(options.to)} (${options.subject})`);
      this.logger.debug(options.text);
      return;
    }

    await transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }
}

