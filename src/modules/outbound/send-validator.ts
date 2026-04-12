// src/outbound/send-validator.ts
//
// Two responsibilities:
//
//  1. PRE-SEND VALIDATION
//     Before touching the provider, check that the contact has the right
//     identifier for the target channel and the channel itself is healthy.
//     Throws a structured BadRequestException the API can return directly.
//
//  2. PROVIDER ERROR NORMALISATION
//     Catches raw Axios errors from WhatsApp / Meta / nodemailer and maps
//     them to clean, human-readable messages with an error code the frontend
//     can act on (show a toast, highlight the field, etc.).

import { BadRequestException, Logger } from '@nestjs/common';
import { AxiosError } from 'axios';

// ─── Error shape returned to the API consumer ────────────────────────────────

export interface SendError {
  code: SendErrorCode;
  message: string;           // human readable — safe to show in the UI
  detail?: string;           // raw provider message for logging / support
  retryable: boolean;        // should the UI offer a "retry" button?
}

export type SendErrorCode =
  // Contact / channel compatibility
  | 'CONTACT_NO_IDENTIFIER'      // contact has no identifier for this channel
  | 'CONTACT_NOT_ON_CHANNEL'     // ContactChannel row missing
  | 'CONTACT_CHANNEL_NOT_REACHABLE'
  | 'CHANNEL_DISCONNECTED'       // channel.status !== 'connected'
  | 'CHANNEL_MISSING_CREDENTIAL' // access token / SMTP password missing
  // WhatsApp-specific
  | 'WA_INVALID_TOKEN'           // token expired or revoked
  | 'WA_PHONE_NOT_FOUND'         // recipient not on WhatsApp
  | 'WA_OUTSIDE_WINDOW'          // 24-hour messaging window closed
  | 'WA_TEMPLATE_REQUIRED'       // must use template outside window
  | 'WA_TEMPLATE_REJECTED'       // template not approved
  | 'WA_RATE_LIMITED'            // too many messages
  | 'WA_MEDIA_UPLOAD_FAILED'     // media could not be uploaded
  | 'WA_PERMISSION_DENIED'       // page / business not authorised
  | 'WA_RECIPIENT_BLOCKED'       // user blocked the business
  // Instagram / Messenger
  | 'META_INVALID_TOKEN'
  | 'META_NO_PAGE_ACCESS'        // page has not granted messaging permission
  | 'META_USER_NOT_REACHABLE'    // user hasn't messaged in 7 days (IG) or 24h (Messenger)
  | 'META_RATE_LIMITED'
  // Email
  | 'EMAIL_AUTH_FAILED'          // SMTP auth rejected
  | 'EMAIL_RECIPIENT_REJECTED'   // recipient address rejected by SMTP
  | 'EMAIL_CONNECTION_FAILED'    // could not reach SMTP server
  // Generic
  | 'PROVIDER_ERROR'             // unmapped provider error
  | 'UNKNOWN';

// ─── Pre-send validator ───────────────────────────────────────────────────────

export class SendValidator {
  private static readonly logger = new Logger(SendValidator.name);

  /**
   * Call this BEFORE creating the pending Message row.
   * Throws BadRequestException with a structured SendError body.
   */
  static validateContact(opts: {
    channelType: string;
    channelStatus: string;
    credentials: any;
    contactChannel: {
      identifier: string;
      messageWindowExpiry?: string | number | bigint | null;
      hasPermanentCallPermission?: boolean | null;
    } | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    hasTemplate?: boolean;
  }): void {
    const { channelType, channelStatus, credentials, contactChannel } = opts;

    // ── Channel health ──────────────────────────────────────────────────────

    if (channelStatus !== 'connected') {
      throw this.error({
        code: 'CHANNEL_DISCONNECTED',
        message: `This ${this.label(channelType)} channel is disconnected. Reconnect it in Settings before sending.`,
        retryable: false,
      });
    }

    // ── Credential presence ─────────────────────────────────────────────────

    // this.validateCredentials(channelType, credentials);

    // ── Contact compatibility ───────────────────────────────────────────────

    const identifier = contactChannel?.identifier;
     this.logger.debug(`Validating contact for channel ${channelType} with identifier ${identifier}`);
    switch (channelType) {
      case 'whatsapp':
        if (!identifier && !opts.contactPhone) {
          throw this.error({
            code: 'CONTACT_NO_IDENTIFIER',
            message: 'This contact has no WhatsApp phone number. Add a phone number to the contact first.',
            retryable: false,
          });
        }
        this.validateMessagingWindow({
          channelType,
          messageWindowExpiry: contactChannel?.messageWindowExpiry,
          hasTemplate: !!opts.hasTemplate,
        });
        break;

      case 'instagram':
        if (!identifier) {
          throw this.error({
            code: 'CONTACT_NOT_ON_CHANNEL',
            message: 'This contact has never messaged via Instagram. You can only reply to contacts who have messaged you first.',
            retryable: false,
          });
        }
        this.validateMessagingWindow({
          channelType,
          messageWindowExpiry: contactChannel?.messageWindowExpiry,
          hasTemplate: !!opts.hasTemplate,
        });
        break;

      case 'messenger':
        if (!identifier) {
          throw this.error({
            code: 'CONTACT_NOT_ON_CHANNEL',
            message: 'This contact has no Messenger ID. You can only reply to contacts who have messaged you first on Messenger.',
            retryable: false,
          });
        }
        this.validateMessagingWindow({
          channelType,
          messageWindowExpiry: contactChannel?.messageWindowExpiry,
          hasTemplate: !!opts.hasTemplate,
        });
        break;

      case 'email':
        if (!identifier && !opts.contactEmail) {
          throw this.error({
            code: 'CONTACT_NO_IDENTIFIER',
            message: 'This contact has no email address. Add an email address to the contact first.',
            retryable: false,
          });
        }
        break;
    }
  }

  private static validateMessagingWindow(opts: {
    channelType: string;
    messageWindowExpiry?: string | number | bigint | null;
    hasTemplate: boolean;
  }) {
    const expiryMs = this.toEpochMs(opts.messageWindowExpiry);
    if (expiryMs && expiryMs > Date.now()) return;

    if (opts.channelType === 'whatsapp') {
      if (opts.hasTemplate) return;
      throw this.error({
        code: 'WA_TEMPLATE_REQUIRED',
        message: 'This WhatsApp contact channel is not open for free-form messaging. Send an approved template to message the contact.',
        retryable: false,
      });
    }

    if (opts.channelType === 'messenger' || opts.channelType === 'instagram') {
      const label = opts.channelType === 'instagram' ? 'Instagram' : 'Messenger';
      throw this.error({
        code: 'CONTACT_CHANNEL_NOT_REACHABLE',
        message: `This ${label} contact channel is not open for outbound replies. Wait for the contact to send a new message.`,
        retryable: false,
      });
    }
  }

  private static toEpochMs(value: string | number | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    if (typeof value === 'string' && Number.isNaN(Number(value))) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  // ── Credential presence per channel type ───────────────────────────────────

  private static validateCredentials(channelType: string, creds: any): void {
    if (!creds) {
      throw this.error({
        code: 'CHANNEL_MISSING_CREDENTIAL',
        message: `${this.label(channelType)} channel has no credentials configured.`,
        retryable: false,
      });
    }

    switch (channelType) {
      case 'whatsapp':
        if (!creds.accessToken) {
          throw this.error({
            code: 'CHANNEL_MISSING_CREDENTIAL',
            message: 'WhatsApp access token is missing. Reconnect the channel in Settings.',
            retryable: false,
          });
        }
        break;

      case 'instagram':
      case 'messenger':
        if (!creds.accessToken) {
          throw this.error({
            code: 'CHANNEL_MISSING_CREDENTIAL',
            message: `${this.label(channelType)} page access token is missing. Reconnect the channel in Settings.`,
            retryable: false,
          });
        }
        break;

      case 'email':
        // config lives in channel.config, not credentials — checked separately
        break;
    }
  }

  private static label(channelType: string): string {
    const map: Record<string, string> = {
      whatsapp: 'WhatsApp',
      instagram: 'Instagram',
      messenger: 'Messenger',
      email: 'Email',
    };
    return map[channelType] ?? channelType;
  }

  private static error(e: SendError): BadRequestException {
    return new BadRequestException(e);
  }
}

// ─── Provider error normaliser ────────────────────────────────────────────────

export class ProviderErrorNormaliser {
  private static readonly logger = new Logger(ProviderErrorNormaliser.name);

  /**
   * Call inside the outbound service catch block.
   * Re-throws a BadRequestException with a clean SendError body,
   * OR rethrows the original error if it is already a BadRequestException.
   */
  static normalise(err: any, channelType: string): never {
    // Already a structured error from our validators — pass through
    if (err instanceof BadRequestException) throw err;

    const sendError = this.parse(err, channelType);

    this.logger.warn(
      `Provider error [${channelType}] code=${sendError.code} detail=${sendError.detail}`,
    );

    throw new BadRequestException(sendError);
  }

  private static parse(err: any, channelType: string): SendError {
    switch (channelType) {
      case 'whatsapp': return this.parseWhatsApp(err);
      case 'instagram':
      case 'messenger': return this.parseMeta(err, channelType);
      case 'email':     return this.parseEmail(err);
      default:          return this.generic(err);
    }
  }

  // ─── WhatsApp Cloud API errors ────────────────────────────────────────────
  //
  // Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes

  private static parseWhatsApp(err: any): SendError {
    const axiosErr = err as AxiosError<any>;
    const data = axiosErr?.response?.data;
    const status = axiosErr?.response?.status;
    const waError = data?.error;
    const code: number = waError?.code ?? waError?.error_code ?? 0;
    const subcode: number = waError?.error_subcode ?? 0;
    const detail = waError?.message ?? waError?.error_user_msg ?? err.message;

    

    // Token errors
    if (status === 401 || code === 190) {
      return {
        code: 'WA_INVALID_TOKEN',
        message: 'WhatsApp access token is expired or invalid. Reconnect the channel in Settings.',
        detail,
        retryable: false,
      };
    }

    // Permission errors
    if (code === 10 || code === 200 || code === 294) {
      return {
        code: 'WA_PERMISSION_DENIED',
        message: 'Your WhatsApp Business account does not have permission to send this message. Check your Meta Business Manager permissions.',
        detail,
        retryable: false,
      };
    }

    // Recipient not on WhatsApp
    if (code === 131026) {
      return {
        code: 'WA_PHONE_NOT_FOUND',
        message: 'The recipient\'s phone number is not registered on WhatsApp.',
        detail,
        retryable: false,
      };
    }

    // Outside 24-hour window — must use template
    if (code === 131047 || code === 131021) {
      return {
        code: 'WA_OUTSIDE_WINDOW',
        message: 'The 24-hour messaging window has closed. You must send a pre-approved template message to re-open the conversation.',
        detail,
        retryable: false,
      };
    }

    // Template issues
    if (code === 132000 || code === 132001) {
      return {
        code: 'WA_TEMPLATE_REJECTED',
        message: 'The WhatsApp template was rejected or is not approved. Check the template status in Meta Business Manager.',
        detail,
        retryable: false,
      };
    }

    // Rate limiting
    if (code === 130429 || code === 131048 || status === 429) {
      return {
        code: 'WA_RATE_LIMITED',
        message: 'WhatsApp rate limit reached. Please wait a moment before sending again.',
        detail,
        retryable: true,
      };
    }

    // User blocked business
    if (code === 131031) {
      return {
        code: 'WA_RECIPIENT_BLOCKED',
        message: 'The contact has blocked your WhatsApp Business number.',
        detail,
        retryable: false,
      };
    }

    // Media upload failures
    if (code === 131053 || code === 131052) {
      return {
        code: 'WA_MEDIA_UPLOAD_FAILED',
        message: 'The media file could not be uploaded to WhatsApp. Check the file size and format.',
        detail,
        retryable: true,
      };
    }

    return this.generic(err, detail);
  }

  // ─── Instagram / Messenger errors ─────────────────────────────────────────
  //
  // Reference: https://developers.facebook.com/docs/messenger-platform/error-codes

  private static parseMeta(err: any, channelType: string): SendError {
    const axiosErr = err as AxiosError<any>;
    const data = axiosErr?.response?.data;
    const status = axiosErr?.response?.status;
    const fbError = data?.error;
    const code: number = fbError?.code ?? 0;
    const detail = fbError?.message ?? err.message;
    const label = channelType === 'instagram' ? 'Instagram' : 'Messenger';
    this.logger.debug(`Parsing Meta error for ${label}: code=${code} status=${status} message=${detail}`);
    // Token expired
    if (status === 401 || code === 190) {
      return {
        code: 'META_INVALID_TOKEN',
        message: `${label} page access token is expired. Reconnect the channel in Settings.`,
        detail,
        retryable: false,
      };
    }

    // No page messaging permission
    if (code === 10 || code === 200 || code === 230) {
      return {
        code: 'META_NO_PAGE_ACCESS',
        message: `Your ${label} Page has not granted messaging permissions. Check your Meta app permissions.`,
        detail,
        retryable: false,
      };
    }

    // User not reachable — outside messaging window
    if (code === 551 || code === 10900 || code === 2018109) {
      const window = channelType === 'instagram' ? '7 days' : '24 hours';
      return {
        code: 'META_USER_NOT_REACHABLE',
        message: `This contact cannot be reached. They have not sent a message in the last ${window}.`,
        detail,
        retryable: false,
      };
    }

    // Rate limited
    if (code === 32 || code === 613 || status === 429) {
      return {
        code: 'META_RATE_LIMITED',
        message: `${label} rate limit reached. Please wait a moment before sending again.`,
        detail,
        retryable: true,
      };
    }

    return this.generic(err, detail);
  }

  // ─── Nodemailer / SMTP errors ──────────────────────────────────────────────

  private static parseEmail(err: any): SendError {
    const message: string = err?.message ?? '';
    const responseCode: number = err?.responseCode ?? 0;

    // SMTP auth failure
    if (
      message.includes('Invalid login') ||
      message.includes('Authentication failed') ||
      message.includes('Username and Password not accepted') ||
      responseCode === 535
    ) {
      return {
        code: 'EMAIL_AUTH_FAILED',
        message: 'SMTP authentication failed. Check the email username and password in channel settings.',
        detail: message,
        retryable: false,
      };
    }

    // Recipient rejected
    if (
      message.includes('Recipient address rejected') ||
      message.includes('User unknown') ||
      responseCode === 550 ||
      responseCode === 551
    ) {
      return {
        code: 'EMAIL_RECIPIENT_REJECTED',
        message: 'The recipient email address was rejected by the mail server. Check the contact\'s email address.',
        detail: message,
        retryable: false,
      };
    }

    // Can't reach SMTP server
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND')
    ) {
      return {
        code: 'EMAIL_CONNECTION_FAILED',
        message: 'Could not connect to the SMTP server. Check the server address and port in channel settings.',
        detail: message,
        retryable: true,
      };
    }

    return this.generic(err, message);
  }

  // ─── Generic fallback ──────────────────────────────────────────────────────

  private static generic(err: any, detail?: string): SendError {
    
        this.logger.error('Unexpected email sending error', err);

    return {
      code: 'PROVIDER_ERROR',
      message: 'Message could not be sent. Please try again or contact support.',
      detail: detail ?? err?.message ?? String(err),
      retryable: true,
    };
  }
}
