import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthCredentialType,
  AuthAuditEvent,
  AuthProvider,
  AuthSessionStatus,
  AuthTokenPurpose,
  LoginAttemptResult,
  RefreshTokenStatus,
  TwoFactorType,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { AuthPasswordService } from './auth-password.service';
import { AuthTokenService } from './auth-token.service';
import { AuthMailService } from './auth-mail.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthSessionCacheService } from './auth-session-cache.service';
import { AuthCryptoService } from './auth-crypto.service';
import { AuthTotpService } from './auth-totp.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  EMAIL_VERIFICATION_TTL_MINUTES,
  GOOGLE_OAUTH_STATE_TTL_SECONDS,
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  MAGIC_LINK_TTL_MINUTES,
  OTP_RATE_LIMIT_MAX_ATTEMPTS,
  OTP_RATE_LIMIT_WINDOW_SECONDS,
  PASSWORD_RESET_TTL_MINUTES,
  SESSION_IDLE_TTL_SECONDS,
  SESSION_REMEMBER_ME_TTL_SECONDS,
} from './auth.constants';
import { addMinutes, addSeconds, generateOpaqueToken, generateOtpCode, hashValue, normalizeEmail } from './auth.utils';
import { RequestMeta, SessionContext } from './auth.types';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MagicLinkDto } from './dto/magic-link.dto';
import { RequestCodeDto } from './dto/request-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SelectWorkspaceDto } from './dto/select-workspace.dto';
import { SignInDto } from './dto/sign-in.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { DisableTwoFactorDto } from './dto/two-factor.dto';

type SessionQueryResult = Awaited<ReturnType<AuthService['getSessionRecord']>>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly frontendBaseUrl = process.env.AUTH_FRONTEND_BASE_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173';
  private readonly apiBaseUrl = process.env.AUTH_API_BASE_URL ?? 'http://localhost:3000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly passwordService: AuthPasswordService,
    private readonly tokenService: AuthTokenService,
    private readonly mailService: AuthMailService,
    private readonly rateLimitService: AuthRateLimitService,
    private readonly sessionCache: AuthSessionCacheService,
    private readonly cryptoService: AuthCryptoService,
    private readonly totpService: AuthTotpService,
  ) {}

  async signUp(dto: SignUpDto, meta: RequestMeta) {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({
      where: { email },
      include: { authCredentials: true },
    });

    if (existing?.emailVerifiedAt && existing.authCredentials.some((item) => Boolean(item.passwordHash))) {
      throw new ConflictException('An account with this email already exists');
    }

    const nameParts = (dto.name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const firstName = dto.firstName?.trim() || nameParts.shift() || null;
    const lastName = dto.lastName?.trim() || nameParts.join(' ') || null;

    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            status: existing.status ?? 'PENDING',
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
        })
      : await this.prisma.user.create({
          data: {
            email,
            status: 'PENDING',
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
        });

    const passwordHash = await this.passwordService.hashPassword(dto.password);

    await this.prisma.authCredential.upsert({
      where: {
        userId_type: {
          userId: user.id,
          type: AuthCredentialType.PASSWORD,
        },
      },
      update: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        mustRotatePassword: false,
        failedPasswordAttempts: 0,
        lockedUntil: null,
      },
      create: {
        userId: user.id,
        type: AuthCredentialType.PASSWORD,
        passwordHash,
        passwordUpdatedAt: new Date(),
      },
    });

    await this.issueEmailVerification(user.id, email, meta);
    await this.logAudit(AuthAuditEvent.SIGN_UP, {
      userId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { email },
    });

    return {
      requiresVerification: true,
      email,
    };
  }

  async signIn(dto: SignInDto, meta: RequestMeta) {
    const email = normalizeEmail(dto.email);
    const throttle = await this.rateLimitService.consume(
      `login:${email}:${meta.ipHash ?? 'unknown'}`,
      Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS ?? LOGIN_RATE_LIMIT_MAX_ATTEMPTS),
      Number(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS ?? LOGIN_RATE_LIMIT_WINDOW_SECONDS),
    );

    if (!throttle.allowed) {
      await this.recordLoginAttempt({
        email,
        userId: null,
        result: LoginAttemptResult.LOCKED,
        reason: 'rate-limit',
        meta,
      });
      throw new UnauthorizedException('Too many login attempts. Try again later');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        authCredentials: true,
        organizationMemberships: true,
        workspaceMemberships: true,
        twoFactorSecrets: {
          where: { type: TwoFactorType.TOTP, disabledAt: null },
          include: { backupCodes: true },
        },
      },
    });

    const credential = user?.authCredentials.find((item) => item.type === AuthCredentialType.PASSWORD) ?? null;

    if (!user || !credential?.passwordHash) {
      await this.recordLoginAttempt({
        email,
        userId: user?.id ?? null,
        result: LoginAttemptResult.FAILURE,
        reason: 'missing-credential',
        meta,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    if (credential.lockedUntil && credential.lockedUntil > new Date()) {
      await this.recordLoginAttempt({
        email,
        userId: user.id,
        result: LoginAttemptResult.LOCKED,
        reason: 'credential-locked',
        meta,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordValid = await this.passwordService.verifyPassword(credential.passwordHash, dto.password);

    if (!passwordValid) {
      await this.prisma.authCredential.update({
        where: { id: credential.id },
        data: {
          failedPasswordAttempts: { increment: 1 },
          lockedUntil: credential.failedPasswordAttempts + 1 >= 10 ? addMinutes(new Date(), 15) : undefined,
        },
      });
      await this.recordLoginAttempt({
        email,
        userId: user.id,
        result: LoginAttemptResult.FAILURE,
        reason: 'invalid-password',
        meta,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.prisma.authCredential.update({
      where: { id: credential.id },
      data: {
        failedPasswordAttempts: 0,
        lockedUntil: null,
      },
    });

    if (!user.emailVerifiedAt) {
      await this.issueEmailVerification(user.id, email, meta);
      throw new ForbiddenException('Email verification required');
    }

    const totpSecret = user.twoFactorSecrets[0] ?? null;
    if (totpSecret?.enabledAt) {
      const challengePassed = await this.verifyTwoFactorChallenge(
        user.id,
        totpSecret.secretEncrypted,
        dto.totpCode,
        dto.backupCode,
      );

      if (!challengePassed) {
        await this.recordLoginAttempt({
          email,
          userId: user.id,
          result: LoginAttemptResult.CHALLENGE_REQUIRED,
          reason: 'two-factor-required',
          meta,
        });
        throw new UnauthorizedException('Two-factor authentication required');
      }
    }

    await this.recordLoginAttempt({
      email,
      userId: user.id,
      result: LoginAttemptResult.SUCCESS,
      reason: 'password-login',
      meta,
    });

    await this.rateLimitService.clear(`login:${email}:${meta.ipHash ?? 'unknown'}`);

    return this.createSession(user.id, meta, {
      rememberMe: Boolean(dto.rememberMe),
      currentOrganizationId: dto.currentOrganizationId ?? null,
      currentWorkspaceId: dto.currentWorkspaceId ?? null,
      authProvider: 'local',
    });
  }

  async requestPasswordReset(dto: RequestCodeDto, meta: RequestMeta) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      return { sent: true };
    }

    await this.issuePasswordReset(user.id, email, meta);

    return { sent: true };
  }

  async requestEmailLoginOtp(dto: RequestCodeDto, meta: RequestMeta) {
    const email = normalizeEmail(dto.email);
    const throttle = await this.rateLimitService.consume(
      `otp:${email}:${meta.ipHash ?? 'unknown'}`,
      Number(process.env.AUTH_OTP_RATE_LIMIT_MAX_ATTEMPTS ?? OTP_RATE_LIMIT_MAX_ATTEMPTS),
      Number(process.env.AUTH_OTP_RATE_LIMIT_WINDOW_SECONDS ?? OTP_RATE_LIMIT_WINDOW_SECONDS),
    );

    if (!throttle.allowed) {
      throw new UnauthorizedException('Too many requests. Try again later');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      return { sent: true };
    }

    const code = generateOtpCode();
    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        email,
        purpose: AuthTokenPurpose.EMAIL_OTP_LOGIN,
        codeHash: hashValue(code),
        expiresAt: addMinutes(new Date(), Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10)),
        requestedByIp: meta.ipAddress ?? undefined,
        requestedByUserAgent: meta.userAgent ?? undefined,
      },
    });

    await this.mailService.sendMail({
      to: email,
      subject: 'Your Axodesk sign-in code',
      text: `Use this one-time code to sign in to Axodesk: ${code}. It expires in 10 minutes.`,
      html: `<p>Use this one-time code to sign in to Axodesk:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>It expires in 10 minutes.</p>`,
    });

    await this.logAudit(AuthAuditEvent.OTP_SENT, {
      userId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { purpose: 'login' },
    });

    return { sent: true };
  }

  async verifyOtp(dto: VerifyOtpDto, meta: RequestMeta) {
    const email = normalizeEmail(dto.email);
    const purpose = dto.flow === 'signup'
      ? AuthTokenPurpose.EMAIL_OTP_VERIFY
      : dto.flow === 'forgot-password'
        ? AuthTokenPurpose.EMAIL_OTP_RESET
        : AuthTokenPurpose.EMAIL_OTP_LOGIN;

    const otp = await this.prisma.otpCode.findFirst({
      where: {
        email,
        purpose,
        consumedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    if (otp.attemptCount >= otp.maxAttempts) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    if (otp.codeHash !== hashValue(dto.code)) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: {
          attemptCount: { increment: 1 },
        },
      });
      throw new UnauthorizedException('Invalid or expired code');
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: {
        consumedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    if (dto.flow === 'signup') {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerifiedAt: new Date(),
          status: 'ACTIVE',
        },
      });
      await this.logAudit(AuthAuditEvent.EMAIL_VERIFIED, {
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    }

    return this.createSession(user.id, meta, {
      rememberMe: true,
      authProvider: dto.flow === 'login' ? 'otp' : 'local',
    });
  }

  async resendCode(dto: VerifyOtpDto, meta: RequestMeta) {
    if (dto.flow === 'signup') {
      const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(dto.email) } });
      if (user) {
        await this.issueEmailVerification(user.id, normalizeEmail(dto.email), meta);
      }
      return { sent: true };
    }

    return this.requestPasswordReset({ email: dto.email }, meta);
  }

  async resetPassword(userId: string, dto: ResetPasswordDto, currentSessionId?: string | null) {
    const passwordHash = await this.passwordService.hashPassword(dto.newPassword);

    await this.prisma.authCredential.upsert({
      where: {
        userId_type: {
          userId,
          type: AuthCredentialType.PASSWORD,
        },
      },
      update: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        mustRotatePassword: false,
        failedPasswordAttempts: 0,
        lockedUntil: null,
      },
      create: {
        userId,
        type: AuthCredentialType.PASSWORD,
        passwordHash,
        passwordUpdatedAt: new Date(),
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerifiedAt: { set: new Date() },
        status: 'ACTIVE',
      },
    });

    await this.revokeAllSessions(userId, currentSessionId ?? null);

    if (currentSessionId) {
      return this.refreshCurrentSession(currentSessionId);
    }

    return { success: true };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, currentSessionId: string) {
    const credential = await this.prisma.authCredential.findUnique({
      where: {
        userId_type: {
          userId,
          type: AuthCredentialType.PASSWORD,
        },
      },
    });

    if (!credential?.passwordHash) {
      throw new BadRequestException('Password authentication is not configured for this user');
    }

    const matches = await this.passwordService.verifyPassword(credential.passwordHash, dto.currentPassword);
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    return this.resetPassword(userId, { newPassword: dto.newPassword }, currentSessionId);
  }

  async requestMagicLink(dto: MagicLinkDto, meta: RequestMeta) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      return { sent: true };
    }

    const rawToken = generateOpaqueToken();
    const redirectTo = dto.redirectTo ?? `${this.frontendBaseUrl}/dashboard`;

    await this.prisma.magicLinkToken.create({
      data: {
        userId: user.id,
        email,
        purpose: dto.purpose === 'invite' ? AuthTokenPurpose.TEAM_INVITE : AuthTokenPurpose.MAGIC_LINK_LOGIN,
        tokenHash: hashValue(rawToken),
        redirectUri: redirectTo,
        expiresAt: addMinutes(new Date(), Number(process.env.AUTH_MAGIC_LINK_TTL_MINUTES ?? MAGIC_LINK_TTL_MINUTES)),
        requestedByIp: meta.ipAddress ?? undefined,
        requestedByUserAgent: meta.userAgent ?? undefined,
      },
    });

    const magicLink = `${this.apiBaseUrl}/api/auth/magic-link/consume?token=${encodeURIComponent(rawToken)}&redirectTo=${encodeURIComponent(redirectTo)}`;
    await this.mailService.sendMail({
      to: email,
      subject: 'Your Axodesk magic link',
      text: `Use this secure link to sign in to Axodesk: ${magicLink}`,
      html: `<p>Use this secure link to sign in to Axodesk:</p><p><a href="${magicLink}">${magicLink}</a></p>`,
    });

    await this.logAudit(AuthAuditEvent.MAGIC_LINK_SENT, {
      userId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { redirectTo },
    });

    return { sent: true };
  }

  async consumeMagicLink(rawToken: string, meta: RequestMeta) {
    const token = await this.prisma.magicLinkToken.findUnique({
      where: { tokenHash: hashValue(rawToken) },
      include: { user: true },
    });

    if (!token || token.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired magic link');
    }

    const isInviteToken = token.purpose === AuthTokenPurpose.TEAM_INVITE;
    if (!isInviteToken && token.consumedAt) {
      throw new UnauthorizedException('Invalid or expired magic link');
    }

    const user = token.user ?? await this.prisma.user.findUnique({ where: { email: token.email } });
    if (!user) {
      throw new UnauthorizedException('Invalid or expired magic link');
    }

    if (!token.consumedAt) {
      await this.prisma.magicLinkToken.update({
        where: { id: token.id },
        data: { consumedAt: new Date() },
      });
    }

    if (token.purpose === AuthTokenPurpose.EMAIL_VERIFICATION) {
      await this.prisma.emailVerificationToken.updateMany({
        where: {
          userId: user.id,
          tokenHash: token.tokenHash,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
    }

    if (token.purpose === AuthTokenPurpose.PASSWORD_RESET) {
      await this.prisma.passwordResetToken.updateMany({
        where: {
          userId: user.id,
          tokenHash: token.tokenHash,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        status: user.status === 'PENDING' || user.status === 'INVITED' ? 'ACTIVE' : user.status,
      },
    });

    if (!isInviteToken || !token.consumedAt) {
      await this.logAudit(
        token.purpose === AuthTokenPurpose.TEAM_INVITE
          ? AuthAuditEvent.TEAM_INVITE_ACCEPTED
          : token.purpose === AuthTokenPurpose.EMAIL_VERIFICATION
            ? AuthAuditEvent.EMAIL_VERIFIED
            : AuthAuditEvent.MAGIC_LINK_CONSUMED,
        {
          userId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          metadata: { purpose: token.purpose },
        },
      );
    }

    return {
      ...(await this.createSession(user.id, meta, {
        rememberMe: true,
        currentOrganizationId: token.organizationId ?? null,
        currentWorkspaceId: token.workspaceId ?? null,
        authProvider: isInviteToken ? 'invite' : 'magic_link',
      })),
      redirectTo: token.redirectUri ?? `${this.frontendBaseUrl}/dashboard`,
      flow: isInviteToken
        ? 'invite'
        : token.purpose === AuthTokenPurpose.PASSWORD_RESET
          ? 'password-reset'
          : token.purpose === AuthTokenPurpose.EMAIL_VERIFICATION
            ? 'verify-email'
            : 'magic-link',
    };
  }

  async getSession(accessToken?: string | null, refreshToken?: string | null, meta?: RequestMeta | null) {
    if (accessToken) {
      const payload = await this.tokenService.verifyAccessToken(accessToken);
      const context = await this.getSessionContext(payload.sid as string);
      return {
        ...(await this.buildEnvelope(context, accessToken)),
        refreshToken: '',
      };
    }

    if (refreshToken && meta) {
      return this.refreshSession(refreshToken, meta);
    }

    return {
      session: null,
      user: null,
      accessToken: null,
      refreshToken: '',
      csrfToken: null,
    };
  }

  async refreshSession(rawRefreshToken: string, meta: RequestMeta) {
    const tokenHash = hashValue(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        session: true,
        user: true,
      },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.status !== RefreshTokenStatus.ACTIVE || record.revokedAt || record.expiresAt <= new Date()) {
      await this.handleRefreshTokenReuse(record);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.session.revokedAt || record.session.status !== AuthSessionStatus.ACTIVE || record.session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session has expired');
    }

    const nextRefreshToken = generateOpaqueToken();

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: record.id },
        data: {
          status: RefreshTokenStatus.USED,
          usedAt: new Date(),
          rotatedAt: new Date(),
          lastSeenIp: meta.ipAddress ?? undefined,
        },
      }),
      this.prisma.refreshToken.create({
        data: {
          sessionId: record.sessionId,
          userId: record.userId,
          tokenFamilyId: record.tokenFamilyId,
          previousTokenId: record.id,
          status: RefreshTokenStatus.ACTIVE,
          tokenHash: hashValue(nextRefreshToken),
          expiresAt: record.expiresAt,
          createdByIp: meta.ipAddress ?? undefined,
          lastSeenIp: meta.ipAddress ?? undefined,
          userAgent: meta.userAgent ?? undefined,
        },
      }),
      this.prisma.authSession.update({
        where: { id: record.sessionId },
        data: {
          lastRefreshedAt: new Date(),
          lastSeenAt: new Date(),
          ipAddress: meta.ipAddress ?? undefined,
          ipHash: meta.ipHash ?? undefined,
          userAgent: meta.userAgent ?? undefined,
        },
      }),
    ]);

    const context = await this.refreshCurrentSession(record.sessionId);
    context.refreshToken = nextRefreshToken;

    return context;
  }

  async listSessions(userId: string, currentSessionId?: string | null) {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        status: AuthSessionStatus.ACTIVE,
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    return sessions.map((session) => ({
      id: session.id,
      current: session.id === currentSessionId,
      deviceName: session.deviceName,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      currentWorkspaceId: session.currentWorkspaceId,
      currentOrganizationId: session.currentOrganizationId,
      rememberMe: session.rememberMe,
      lastSeenAt: session.lastSeenAt,
      lastRefreshedAt: session.lastRefreshedAt,
      expiresAt: session.expiresAt,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

    if (!session) {
      throw new BadRequestException('Session not found');
    }

    await this.revokeSessionInternal(sessionId, 'user-revoked');
    return { revoked: true };
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string | null) {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        revokedAt: null,
      },
      select: { id: true },
    });

    for (const session of sessions) {
      await this.revokeSessionInternal(session.id, 'revoke-all');
    }

    return { revoked: true, count: sessions.length };
  }

  async selectWorkspace(userId: string, currentSessionId: string, dto: SelectWorkspaceDto) {
    const context = await this.getSessionContext(currentSessionId, true);

    if (context.userId !== userId) {
      throw new ForbiddenException('Invalid session');
    }

    if (dto.organizationId && !context.orgRoles[dto.organizationId]) {
      throw new ForbiddenException('You do not belong to that organization');
    }

    if (dto.workspaceId && !context.workspaceRoles[dto.workspaceId]) {
      throw new ForbiddenException('You do not belong to that workspace');
    }

    await this.prisma.authSession.update({
      where: { id: currentSessionId },
      data: {
        currentOrganizationId: dto.organizationId ?? null,
        currentWorkspaceId: dto.workspaceId ?? null,
        sessionVersion: { increment: 1 },
      },
    });

    return this.refreshCurrentSession(currentSessionId);
  }

  async startGoogleOAuth(redirectTo?: string) {
    const state = generateOpaqueToken(24);
    const target = redirectTo ?? `${this.frontendBaseUrl}/dashboard`;

    await this.redis.client.set(
      `auth:google:state:${state}`,
      JSON.stringify({ redirectTo: target }),
      'EX',
      Number(process.env.AUTH_GOOGLE_STATE_TTL_SECONDS ?? GOOGLE_OAUTH_STATE_TTL_SECONDS),
    );

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? `${this.apiBaseUrl}/api/auth/oauth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    };
  }

  async finishGoogleOAuth(code: string, state: string, meta: RequestMeta) {
    const stateKey = `auth:google:state:${state}`;
    const stored = await this.redis.client.get(stateKey);
    if (!stored) {
      throw new UnauthorizedException('Invalid OAuth state');
    }
    await this.redis.client.del(stateKey);

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? `${this.apiBaseUrl}/api/auth/oauth/google/callback`,
        grant_type: 'authorization_code',
      }).toString(),
    });

    if (!tokenResponse.ok) {
      throw new UnauthorizedException('Google token exchange failed');
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      throw new UnauthorizedException('Google user info request failed');
    }

    const profile = await userInfoResponse.json() as {
      sub: string;
      email: string;
      email_verified?: boolean;
      given_name?: string;
      family_name?: string;
      picture?: string;
      name?: string;
    };

    const email = normalizeEmail(profile.email);
    console.log({email});
    
    let user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          firstName: profile.given_name ?? profile.name ?? email.split('@')[0],
          lastName: profile.family_name ?? null,
          avatarUrl: profile.picture ?? null,
          emailVerifiedAt: profile.email_verified ? new Date() : null,
          status: 'ACTIVE',
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          firstName: user.firstName ?? profile.given_name ?? null,
          lastName: user.lastName ?? profile.family_name ?? null,
          avatarUrl: user.avatarUrl ?? profile.picture ?? null,
          emailVerifiedAt: user.emailVerifiedAt ?? (profile.email_verified ? new Date() : null),
          status: user.status ?? 'ACTIVE',
        },
      });
    }

    await this.prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider: AuthProvider.GOOGLE,
          providerAccountId: profile.sub,
        },
      },
      update: {
        userId: user.id,
        email,
        accessTokenEncrypted: this.cryptoService.encrypt(tokenData.access_token),
        refreshTokenEncrypted: tokenData.refresh_token ? this.cryptoService.encrypt(tokenData.refresh_token) : undefined,
        idTokenEncrypted: tokenData.id_token ? this.cryptoService.encrypt(tokenData.id_token) : undefined,
        scope: tokenData.scope,
        tokenType: tokenData.token_type,
        expiresAt: tokenData.expires_in ? addSeconds(new Date(), tokenData.expires_in) : undefined,
        profile,
        lastUsedAt: new Date(),
      },
      create: {
        userId: user.id,
        provider: AuthProvider.GOOGLE,
        providerAccountId: profile.sub,
        email,
        accessTokenEncrypted: this.cryptoService.encrypt(tokenData.access_token),
        refreshTokenEncrypted: tokenData.refresh_token ? this.cryptoService.encrypt(tokenData.refresh_token) : undefined,
        idTokenEncrypted: tokenData.id_token ? this.cryptoService.encrypt(tokenData.id_token) : undefined,
        scope: tokenData.scope,
        tokenType: tokenData.token_type,
        expiresAt: tokenData.expires_in ? addSeconds(new Date(), tokenData.expires_in) : undefined,
        profile,
        lastUsedAt: new Date(),
      },
    });

    const session = await this.createSession(user.id, meta, {
      rememberMe: true,
      authProvider: 'oauth',
    });
    const statePayload = JSON.parse(stored) as { redirectTo: string };

    await this.logAudit(AuthAuditEvent.OAUTH_SIGN_IN, {
      userId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: 'google' },
    });

    return {
      ...session,
      redirectTo: statePayload.redirectTo,
    };
  }

  async startTotpSetup(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const secret = this.totpService.generateSecret();
    const encryptedSecret = this.cryptoService.encrypt(secret);

    await this.prisma.twoFactorSecret.upsert({
      where: {
        userId_type: {
          userId,
          type: TwoFactorType.TOTP,
        },
      },
      update: {
        secretEncrypted: encryptedSecret,
        disabledAt: null,
        confirmedAt: null,
        enabledAt: null,
      },
      create: {
        userId,
        type: TwoFactorType.TOTP,
        secretEncrypted: encryptedSecret,
        issuer: 'Axodesk',
        label: user.email,
      },
    });

    return {
      secret,
      otpauthUrl: this.totpService.generateOtpauthUrl({
        secret,
        email: user.email,
        issuer: 'Axodesk',
      }),
    };
  }

  async enableTotp(userId: string, code: string) {
    const secret = await this.prisma.twoFactorSecret.findUnique({
      where: {
        userId_type: {
          userId,
          type: TwoFactorType.TOTP,
        },
      },
    });

    if (!secret) {
      throw new BadRequestException('TOTP has not been set up');
    }

    const decrypted = this.cryptoService.decrypt(secret.secretEncrypted);
    if (!this.totpService.verifyCode(decrypted, code)) {
      throw new UnauthorizedException('Invalid authenticator code');
    }

    const backupCodes = this.totpService.generateBackupCodes();
    await this.prisma.$transaction([
      this.prisma.twoFactorSecret.update({
        where: { id: secret.id },
        data: {
          confirmedAt: new Date(),
          enabledAt: new Date(),
          disabledAt: null,
          lastUsedAt: new Date(),
        },
      }),
      this.prisma.backupCode.deleteMany({
        where: { userId },
      }),
      this.prisma.backupCode.createMany({
        data: backupCodes.map((backupCode) => ({
          userId,
          twoFactorSecretId: secret.id,
          codeHash: hashValue(backupCode),
        })),
      }),
    ]);

    await this.logAudit(AuthAuditEvent.TWO_FACTOR_ENABLED, {
      userId,
      metadata: { type: 'totp' },
    });

    return { backupCodes };
  }

  async disableTotp(userId: string, dto: DisableTwoFactorDto) {
    const secret = await this.prisma.twoFactorSecret.findUnique({
      where: {
        userId_type: {
          userId,
          type: TwoFactorType.TOTP,
        },
      },
      include: { backupCodes: true },
    });

    if (!secret?.enabledAt) {
      return { disabled: true };
    }

    const verified = await this.verifyTwoFactorChallenge(
      userId,
      secret.secretEncrypted,
      dto.code,
      dto.backupCode,
    );
    if (!verified) {
      throw new UnauthorizedException('Invalid authenticator challenge');
    }

    await this.prisma.$transaction([
      this.prisma.twoFactorSecret.update({
        where: { id: secret.id },
        data: {
          disabledAt: new Date(),
        },
      }),
      this.prisma.backupCode.deleteMany({
        where: { userId },
      }),
    ]);

    await this.logAudit(AuthAuditEvent.TWO_FACTOR_DISABLED, {
      userId,
      metadata: { type: 'totp' },
    });

    return { disabled: true };
  }

  async regenerateBackupCodes(userId: string) {
    const secret = await this.prisma.twoFactorSecret.findUnique({
      where: {
        userId_type: {
          userId,
          type: TwoFactorType.TOTP,
        },
      },
    });

    if (!secret?.enabledAt) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const backupCodes = this.totpService.generateBackupCodes();
    await this.prisma.$transaction([
      this.prisma.backupCode.deleteMany({ where: { userId } }),
      this.prisma.backupCode.createMany({
        data: backupCodes.map((backupCode) => ({
          userId,
          twoFactorSecretId: secret.id,
          codeHash: hashValue(backupCode),
        })),
      }),
    ]);

    await this.logAudit(AuthAuditEvent.BACKUP_CODES_REGENERATED, {
      userId,
      metadata: { count: backupCodes.length },
    });

    return { backupCodes };
  }

  async inviteUser(input: {
    email: string;
    organizationId?: string | null;
    workspaceId?: string | null;
    redirectTo?: string | null;
    roleSnapshot?: unknown;
  }) {
    const email = normalizeEmail(input.email);
    let user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          status: 'INVITED',
        },
      });
    }

    const rawToken = generateOpaqueToken();
    const redirectUri = input.redirectTo ?? `${this.frontendBaseUrl}/auth/set-password`;

    await this.prisma.magicLinkToken.create({
      data: {
        userId: user.id,
        email,
        purpose: AuthTokenPurpose.TEAM_INVITE,
        organizationId: input.organizationId ?? undefined,
        workspaceId: input.workspaceId ?? undefined,
        roleSnapshot: input.roleSnapshot as any,
        tokenHash: hashValue(rawToken),
        redirectUri,
        expiresAt: addMinutes(new Date(), Number(process.env.AUTH_INVITE_TTL_MINUTES ?? MAGIC_LINK_TTL_MINUTES)),
      },
    });

    const inviteLink = `${this.apiBaseUrl}/api/auth/invite/accept?token=${encodeURIComponent(rawToken)}&redirectTo=${encodeURIComponent(redirectUri)}`;
    await this.mailService.sendMail({
      to: email,
      subject: 'You have been invited to Axodesk',
      text: `You have been invited to Axodesk. Accept your invitation here: ${inviteLink}`,
      html: `<p>You have been invited to Axodesk.</p><p><a href="${inviteLink}">Accept your invitation</a></p>`,
    });

    await this.logAudit(AuthAuditEvent.TEAM_INVITE_SENT, {
      userId: user.id,
      metadata: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
      },
    });

    return { invited: true };
  }

  private async createSession(
    userId: string,
    meta: RequestMeta,
    options: {
      rememberMe?: boolean;
      currentOrganizationId?: string | null;
      currentWorkspaceId?: string | null;
      authProvider: SessionContext['authProvider'];
    },
  ) {
    const now = new Date();
    const rememberMe = Boolean(options.rememberMe);
    const ttlSeconds = rememberMe
      ? Number(process.env.AUTH_REMEMBER_ME_TTL_SECONDS ?? SESSION_REMEMBER_ME_TTL_SECONDS)
      : Number(process.env.AUTH_SESSION_IDLE_TTL_SECONDS ?? SESSION_IDLE_TTL_SECONDS);

    const session = await this.prisma.authSession.create({
      data: {
        userId,
        status: AuthSessionStatus.ACTIVE,
        rememberMe,
        currentOrganizationId: options.currentOrganizationId ?? undefined,
        currentWorkspaceId: options.currentWorkspaceId ?? undefined,
        ipAddress: meta.ipAddress ?? undefined,
        ipHash: meta.ipHash ?? undefined,
        userAgent: meta.userAgent ?? undefined,
        deviceId: meta.deviceId ?? undefined,
        deviceName: meta.deviceName ?? undefined,
        deviceFingerprintHash: meta.deviceFingerprint ? hashValue(meta.deviceFingerprint) : undefined,
        lastSeenAt: now,
        lastRefreshedAt: now,
        expiresAt: addSeconds(now, ttlSeconds),
        idleExpiresAt: addSeconds(now, ttlSeconds),
      },
    });

    const refreshToken = generateOpaqueToken();
    await this.prisma.refreshToken.create({
      data: {
        sessionId: session.id,
        userId,
        tokenFamilyId: session.id,
        status: RefreshTokenStatus.ACTIVE,
        tokenHash: hashValue(refreshToken),
        expiresAt: addSeconds(now, ttlSeconds),
        createdByIp: meta.ipAddress ?? undefined,
        lastSeenIp: meta.ipAddress ?? undefined,
        userAgent: meta.userAgent ?? undefined,
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lastLoginAt: now,
      },
    });

    const context = await this.getSessionContext(session.id, true, options.authProvider);
    const envelope = await this.buildEnvelope(context);
    envelope.refreshToken = refreshToken;

    await this.logAudit(AuthAuditEvent.SIGN_IN, {
      userId,
      sessionId: session.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: options.authProvider },
    });

    return envelope;
  }

  private async refreshCurrentSession(sessionId: string) {
    const context = await this.getSessionContext(sessionId, true);
    return this.buildEnvelope(context);
  }

  private async buildEnvelope(context: SessionContext, accessToken?: string) {
    const token = accessToken ?? await this.tokenService.signAccessToken(context);
    return this.tokenService.buildSessionEnvelope(context, token);
  }

  async getSessionContext(sessionId: string, forceRefresh = false, providerOverride?: SessionContext['authProvider']) {
    if (!forceRefresh) {
      const cached = await this.sessionCache.get(sessionId);
      if (cached) {
        return cached;
      }
    }

    const session = await this.getSessionRecord(sessionId);
    if (!session || session.revokedAt || session.status !== AuthSessionStatus.ACTIVE) {
      throw new UnauthorizedException('Session has been revoked');
    }
    if (session.expiresAt <= new Date() || session.idleExpiresAt <= new Date()) {
      await this.revokeSessionInternal(sessionId, 'expired');
      throw new UnauthorizedException('Session has expired');
    }

    const context = this.buildContextFromRecord(session, providerOverride);
    await this.sessionCache.set(context);

    return context;
  }

  private async getSessionRecord(sessionId: string) {
    return this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          include: {
            authCredentials: true,
            organizationMemberships: true,
            workspaceMemberships: true,
          },
        },
      },
    });
  }

  private buildContextFromRecord(session: NonNullable<SessionQueryResult>, providerOverride?: SessionContext['authProvider']): SessionContext {
    const orgRoles = Object.fromEntries(
      session.user.organizationMemberships.map((membership) => [membership.organizationId, membership.role]),
    );
    const workspaceRoles = Object.fromEntries(
      session.user.workspaceMemberships.map((membership) => [membership.workspaceId, membership.role]),
    );

    return {
      sessionId: session.id,
      userId: session.user.id,
      user: {
        id: session.user.id,
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        avatarUrl: session.user.avatarUrl,
        language: session.user.language,
        status: session.user.status,
        emailVerifiedAt: session.user.emailVerifiedAt?.toISOString() ?? null,
        lastLoginAt: session.user.lastLoginAt?.toISOString() ?? null,
      },
      passwordSet: session.user.authCredentials.some((credential) => Boolean(credential.passwordHash)),
      sessionVersion: session.sessionVersion,
      currentOrganizationId: session.currentOrganizationId,
      currentWorkspaceId: session.currentWorkspaceId,
      rememberMe: session.rememberMe,
      csrfToken: hashValue(`${session.id}:${process.env.AUTH_CSRF_SECRET ?? 'axodesk-csrf'}`),
      orgRoles,
      workspaceRoles,
      trustedDeviceId: session.trustedDeviceId,
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      lastRefreshedAt: session.lastRefreshedAt.toISOString(),
      authProvider: providerOverride ?? 'local',
    };
  }

  private async issueEmailVerification(userId: string, email: string, meta: RequestMeta) {
    const rawToken = generateOpaqueToken();
    const code = generateOtpCode();

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.create({
        data: {
          userId,
          email,
          tokenHash: hashValue(rawToken),
          purpose: AuthTokenPurpose.EMAIL_VERIFICATION,
          expiresAt: addMinutes(new Date(), Number(process.env.AUTH_EMAIL_VERIFICATION_TTL_MINUTES ?? EMAIL_VERIFICATION_TTL_MINUTES)),
          requestedByIp: meta.ipAddress ?? undefined,
          requestedByUserAgent: meta.userAgent ?? undefined,
        },
      }),
      this.prisma.magicLinkToken.create({
        data: {
          userId,
          email,
          purpose: AuthTokenPurpose.EMAIL_VERIFICATION,
          tokenHash: hashValue(rawToken),
          redirectUri: `${this.frontendBaseUrl}/dashboard`,
          expiresAt: addMinutes(new Date(), Number(process.env.AUTH_EMAIL_VERIFICATION_TTL_MINUTES ?? EMAIL_VERIFICATION_TTL_MINUTES)),
          requestedByIp: meta.ipAddress ?? undefined,
          requestedByUserAgent: meta.userAgent ?? undefined,
        },
      }),
      this.prisma.otpCode.create({
        data: {
          userId,
          email,
          purpose: AuthTokenPurpose.EMAIL_OTP_VERIFY,
          codeHash: hashValue(code),
          expiresAt: addMinutes(new Date(), Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10)),
          requestedByIp: meta.ipAddress ?? undefined,
          requestedByUserAgent: meta.userAgent ?? undefined,
        },
      }),
    ]);

    const verifyLink = `${this.apiBaseUrl}/api/auth/magic-link/consume?token=${encodeURIComponent(rawToken)}&redirectTo=${encodeURIComponent(`${this.frontendBaseUrl}/dashboard`)}`;
    await this.mailService.sendMail({
      to: email,
      subject: 'Verify your Axodesk email',
      text: `Use this verification code: ${code}. Or verify using this secure link: ${verifyLink}`,
      html: `<p>Use this verification code:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>Or verify instantly with this secure link:</p><p><a href="${verifyLink}">${verifyLink}</a></p>`,
    });

    await this.logAudit(AuthAuditEvent.EMAIL_VERIFICATION_SENT, {
      userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  private async issuePasswordReset(userId: string, email: string, meta: RequestMeta) {
    const rawToken = generateOpaqueToken();
    const code = generateOtpCode();

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.create({
        data: {
          userId,
          email,
          tokenHash: hashValue(rawToken),
          purpose: AuthTokenPurpose.PASSWORD_RESET,
          expiresAt: addMinutes(new Date(), Number(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES ?? PASSWORD_RESET_TTL_MINUTES)),
          requestedByIp: meta.ipAddress ?? undefined,
          requestedByUserAgent: meta.userAgent ?? undefined,
        },
      }),
      this.prisma.magicLinkToken.create({
        data: {
          userId,
          email,
          purpose: AuthTokenPurpose.PASSWORD_RESET,
          tokenHash: hashValue(rawToken),
          redirectUri: `${this.frontendBaseUrl}/auth/reset-password`,
          expiresAt: addMinutes(new Date(), Number(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES ?? PASSWORD_RESET_TTL_MINUTES)),
          requestedByIp: meta.ipAddress ?? undefined,
          requestedByUserAgent: meta.userAgent ?? undefined,
        },
      }),
      this.prisma.otpCode.create({
        data: {
          userId,
          email,
          purpose: AuthTokenPurpose.EMAIL_OTP_RESET,
          codeHash: hashValue(code),
          expiresAt: addMinutes(new Date(), Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10)),
          requestedByIp: meta.ipAddress ?? undefined,
          requestedByUserAgent: meta.userAgent ?? undefined,
        },
      }),
    ]);

    const resetLink = `${this.apiBaseUrl}/api/auth/magic-link/consume?token=${encodeURIComponent(rawToken)}&redirectTo=${encodeURIComponent(`${this.frontendBaseUrl}/auth/reset-password`)}`;
    await this.mailService.sendMail({
      to: email,
      subject: 'Reset your Axodesk password',
      text: `Use this reset code: ${code}. Or reset with this secure link: ${resetLink}`,
      html: `<p>Use this reset code:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>Or reset your password with this secure link:</p><p><a href="${resetLink}">${resetLink}</a></p>`,
    });

    await this.logAudit(AuthAuditEvent.PASSWORD_RESET_REQUESTED, {
      userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  private async verifyTwoFactorChallenge(
    userId: string,
    encryptedSecret: string,
    code?: string | null,
    backupCode?: string | null,
  ) {
    if (code) {
      const secret = this.cryptoService.decrypt(encryptedSecret);
      if (this.totpService.verifyCode(secret, code)) {
        await this.prisma.twoFactorSecret.update({
          where: {
            userId_type: {
              userId,
              type: TwoFactorType.TOTP,
            },
          },
          data: {
            lastUsedAt: new Date(),
          },
        });
        return true;
      }
    }

    if (backupCode) {
      const hashed = hashValue(backupCode.replace(/\s+/g, '').toUpperCase());
      const record = await this.prisma.backupCode.findFirst({
        where: {
          userId,
          codeHash: hashed,
          consumedAt: null,
        },
      });

      if (record) {
        await this.prisma.backupCode.update({
          where: { id: record.id },
          data: { consumedAt: new Date() },
        });
        return true;
      }
    }

    return false;
  }

  private async handleRefreshTokenReuse(record: { sessionId: string; tokenFamilyId: string; userId: string }) {
    await this.prisma.refreshToken.updateMany({
      where: {
        tokenFamilyId: record.tokenFamilyId,
        userId: record.userId,
      },
      data: {
        status: RefreshTokenStatus.REUSED,
        revokedAt: new Date(),
        revokedReason: 'reuse-detected',
      },
    });

    await this.revokeSessionInternal(record.sessionId, 'refresh-token-reuse');
    await this.logAudit(AuthAuditEvent.TOKEN_REUSE_DETECTED, {
      userId: record.userId,
      sessionId: record.sessionId,
      metadata: { tokenFamilyId: record.tokenFamilyId },
    });
  }

  private async revokeSessionInternal(sessionId: string, reason: string) {
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: {
          id: sessionId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedReason: reason,
          status: reason === 'expired' ? AuthSessionStatus.EXPIRED : AuthSessionStatus.REVOKED,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: {
          sessionId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedReason: reason,
          status: RefreshTokenStatus.REVOKED,
        },
      }),
    ]);

    await this.sessionCache.delete(sessionId);
  }

  private async recordLoginAttempt(input: {
    email: string;
    userId: string | null;
    result: LoginAttemptResult;
    reason: string;
    meta: RequestMeta;
  }) {
    await this.prisma.loginAttempt.create({
      data: {
        userId: input.userId ?? undefined,
        email: input.email,
        ipAddress: input.meta.ipAddress ?? undefined,
        ipHash: input.meta.ipHash ?? undefined,
        userAgent: input.meta.userAgent ?? undefined,
        result: input.result,
        reason: input.reason,
        requiresChallenge: input.result === LoginAttemptResult.CHALLENGE_REQUIRED,
      },
    });
  }

  private async logAudit(
    event: AuthAuditEvent,
    payload: {
      userId?: string | null;
      sessionId?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
      organizationId?: string | null;
      workspaceId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    await this.prisma.authAuditLog.create({
      data: {
        event,
        userId: payload.userId ?? undefined,
        sessionId: payload.sessionId ?? undefined,
        ipAddress: payload.ipAddress ?? undefined,
        userAgent: payload.userAgent ?? undefined,
        organizationId: payload.organizationId ?? undefined,
        workspaceId: payload.workspaceId ?? undefined,
        metadata: payload.metadata as any,
      },
    });
  }

  buildRedirectUrl(target: string, accessToken?: string) {
    const url = new URL(target, this.frontendBaseUrl);
    if (accessToken) {
      url.hash = new URLSearchParams({ access_token: accessToken }).toString();
    }
    return url.toString();
  }

  buildAuthCallbackUrl(input: {
    flow: string;
    status?: 'success' | 'error';
    next?: string | null;
    message?: string | null;
  }) {
    const url = new URL('/auth/callback', this.frontendBaseUrl);
    url.searchParams.set('flow', input.flow);
    url.searchParams.set('status', input.status ?? 'success');

    if (input.next) {
      url.searchParams.set('next', input.next);
    }

    if (input.message) {
      url.searchParams.set('message', input.message);
    }

    return url.toString();
  }
}
