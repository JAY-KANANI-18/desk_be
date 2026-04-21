import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtOnly, Public } from 'src/common/auth/route-access.decorator';
import { AUTH_CSRF_COOKIE, AUTH_REFRESH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { buildRequestMeta, parseCookie } from './auth.utils';
import { SignUpDto } from './dto/sign-up.dto';
import { SignInDto } from './dto/sign-in.dto';
import { RequestCodeDto } from './dto/request-code.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MagicLinkDto } from './dto/magic-link.dto';
import { SelectWorkspaceDto } from './dto/select-workspace.dto';
import { DisableTwoFactorDto, VerifyTotpDto } from './dto/two-factor.dto';
import { ResendCodeDto } from './dto/resend-code.dto';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  @Public()
  async signUp(@Body() dto: SignUpDto, @Req() request: Request) {
    return this.authService.signUp(dto, buildRequestMeta(request));
  }

  @Post('signin')
  @Public()
  async signIn(
    @Body() dto: SignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.signIn(dto, buildRequestMeta(request));
    this.setAuthCookies(response, result.refreshToken, result.csrfToken);

    return {
      session: result.session,
      user: result.user,
      csrfToken: result.csrfToken,
      accessToken: result.accessToken,
    };
  }

  @Post('signout')
  @JwtOnly()
  async signOut(
    @CurrentUser() user: any,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.revokeSession(user.id, user.sessionId);
    this.clearAuthCookies(response);
    return { signedOut: true };
  }

  @Get('session')
  @Public()
  async getSession(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authHeader = request.headers.authorization;
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : null;
    const refreshToken = parseCookie(request.headers.cookie, AUTH_REFRESH_COOKIE);
    const result = await this.authService.getSession(accessToken, refreshToken, buildRequestMeta(request));

    if (result?.refreshToken) {
      this.setAuthCookies(response, result.refreshToken, result.csrfToken);
    }

    return result;
  }

  @Post('refresh')
  @Public()
  async refresh(
    @Req() request: Request,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = parseCookie(request.headers.cookie, AUTH_REFRESH_COOKIE);
    const csrfCookie = parseCookie(request.headers.cookie, AUTH_CSRF_COOKIE);

    if (!refreshToken) {
      throw new BadRequestException('Refresh token is missing');
    }

    if ((process.env.AUTH_REQUIRE_CSRF ?? 'true') === 'true' && (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie)) {
      throw new BadRequestException('CSRF validation failed');
    }

    const result = await this.authService.refreshSession(refreshToken, buildRequestMeta(request));
    this.setAuthCookies(response, result.refreshToken, result.csrfToken);

    return {
      session: result.session,
      user: result.user,
      csrfToken: result.csrfToken,
      accessToken: result.accessToken,
    };
  }

  @Post('password/forgot')
  @Public()
  async forgotPassword(@Body() dto: RequestCodeDto, @Req() request: Request) {
    return this.authService.requestPasswordReset(dto, buildRequestMeta(request));
  }

  @Post('otp/email/request')
  @Public()
  async requestEmailOtp(@Body() dto: RequestCodeDto, @Req() request: Request) {
    return this.authService.requestEmailLoginOtp(dto, buildRequestMeta(request));
  }

  @Post('otp/verify')
  @Public()
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.verifyOtp(dto, buildRequestMeta(request));
    this.setAuthCookies(response, result.refreshToken, result.csrfToken);

    return {
      session: result.session,
      user: result.user,
      csrfToken: result.csrfToken,
      accessToken: result.accessToken,
    };
  }

  @Post('otp/resend')
  @Public()
  async resendOtp(@Body() dto: ResendCodeDto, @Req() request: Request) {
    return this.authService.resendCode(
      { email: dto.email, code: '000000', flow: dto.flow },
      buildRequestMeta(request),
    );
  }

  @Post('password/reset')
  @JwtOnly()
  async resetPassword(
    @CurrentUser() user: any,
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.resetPassword(user.id, dto, user.sessionId);

    if ('refreshToken' in result) {
      this.setAuthCookies(response, result.refreshToken, result.csrfToken);
      return {
        session: result.session,
        user: result.user,
        csrfToken: result.csrfToken,
        accessToken: result.accessToken,
      };
    }

    return result;
  }

  @Post('password/change')
  @JwtOnly()
  async changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.changePassword(user.id, dto, user.sessionId);
    if ('refreshToken' in result) {
      this.setAuthCookies(response, result.refreshToken, result.csrfToken);
      return {
        session: result.session,
        user: result.user,
        csrfToken: result.csrfToken,
        accessToken: result.accessToken,
      };
    }
    return result;
  }

  @Post('magic-link')
  @Public()
  async requestMagicLink(@Body() dto: MagicLinkDto, @Req() request: Request) {
    return this.authService.requestMagicLink(dto, buildRequestMeta(request));
  }

  @Get('magic-link/consume')
  @Public()
  async consumeMagicLink(
    @Query('token') token: string,
    @Query('redirectTo') redirectTo: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const result = await this.authService.consumeMagicLink(token, buildRequestMeta(request));
      this.setAuthCookies(response, result.refreshToken, result.csrfToken);
      response.redirect(
        this.authService.buildAuthCallbackUrl({
          flow: result.flow,
          next: result.redirectTo ?? redirectTo ?? `${process.env.AUTH_FRONTEND_BASE_URL ?? 'http://localhost:5173'}/dashboard`,
        }),
      );
    } catch (error) {
      response.redirect(
        this.authService.buildAuthCallbackUrl({
          flow: 'magic-link',
          status: 'error',
          message: this.getCallbackErrorMessage(error, 'We could not verify that link.'),
        }),
      );
    }
  }

  @Get('invite/accept')
  @Public()
  async acceptInvite(
    @Query('token') token: string,
    @Query('redirectTo') redirectTo: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const result = await this.authService.consumeMagicLink(token, buildRequestMeta(request));
      if (result.flow !== 'invite') {
        throw new BadRequestException('Invalid invitation');
      }
      this.setAuthCookies(response, result.refreshToken, result.csrfToken);
      response.redirect(
        this.authService.buildAuthCallbackUrl({
          flow: 'invite',
          next: result.redirectTo ?? redirectTo ?? `${process.env.AUTH_FRONTEND_BASE_URL ?? 'http://localhost:5173'}/auth/set-password`,
        }),
      );
    } catch (error) {
      response.redirect(
        this.authService.buildAuthCallbackUrl({
          flow: 'invite',
          status: 'error',
          message: this.getCallbackErrorMessage(error, 'This invitation is invalid or has expired.'),
        }),
      );
    }
  }

  @Get('oauth/google/start')
  @Public()
  async startGoogleOAuth(
    @Query('redirectTo') redirectTo: string | undefined,
    @Res() response: Response,
  ) {
    const result = await this.authService.startGoogleOAuth(redirectTo);
    response.redirect(result.url);
  }

  @Get('oauth/google/callback')
  @Public()
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const result = await this.authService.finishGoogleOAuth(code, state, buildRequestMeta(request));
      this.setAuthCookies(response, result.refreshToken, result.csrfToken);
      response.redirect(
        this.authService.buildAuthCallbackUrl({
          flow: 'google',
          next: result.redirectTo,
        }),
      );
    } catch (error) {
      response.redirect(
        this.authService.buildAuthCallbackUrl({
          flow: 'google',
          status: 'error',
          message: this.getCallbackErrorMessage(error, 'Google sign-in could not be completed.'),
        }),
      );
    }
  }

  @Get('sessions')
  @JwtOnly()
  async listSessions(@CurrentUser() user: any) {
    return this.authService.listSessions(user.id, user.sessionId);
  }

  @Delete('sessions/:sessionId')
  @JwtOnly()
  async revokeSession(@CurrentUser() user: any, @Req() request: Request) {
    const sessionId = Array.isArray(request.params.sessionId)
      ? request.params.sessionId[0]
      : request.params.sessionId;
    return this.authService.revokeSession(user.id, sessionId);
  }

  @Post('sessions/revoke-all')
  @JwtOnly()
  async revokeAllSessions(@CurrentUser() user: any) {
    return this.authService.revokeAllSessions(user.id, user.sessionId);
  }

  @Post('workspace/select')
  @JwtOnly()
  async selectWorkspace(
    @CurrentUser() user: any,
    @Body() dto: SelectWorkspaceDto,
  ) {
    return this.authService.selectWorkspace(user.id, user.sessionId, dto);
  }

  @Post('2fa/totp/setup')
  @JwtOnly()
  async startTotpSetup(@CurrentUser() user: any) {
    return this.authService.startTotpSetup(user.id);
  }

  @Post('2fa/totp/enable')
  @JwtOnly()
  async enableTotp(@CurrentUser() user: any, @Body() dto: VerifyTotpDto) {
    return this.authService.enableTotp(user.id, dto.code);
  }

  @Post('2fa/totp/disable')
  @JwtOnly()
  async disableTotp(@CurrentUser() user: any, @Body() dto: DisableTwoFactorDto) {
    return this.authService.disableTotp(user.id, dto);
  }

  @Post('2fa/backup-codes/regenerate')
  @JwtOnly()
  async regenerateBackupCodes(@CurrentUser() user: any) {
    return this.authService.regenerateBackupCodes(user.id);
  }

  private setAuthCookies(response: Response, refreshToken: string, csrfToken: string) {
    const secure = `${process.env.AUTH_COOKIE_SECURE ?? (process.env.NODE_ENV === 'production')}` === 'true';
    const sameSite = (process.env.AUTH_COOKIE_SAME_SITE ?? 'lax') as 'lax' | 'strict' | 'none';
    const maxAgeMs = Number(process.env.AUTH_COOKIE_MAX_AGE_MS ?? 30 * 24 * 60 * 60 * 1000);

    response.cookie(AUTH_REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite,
      path: '/',
      maxAge: maxAgeMs,
    });

    response.cookie(AUTH_CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure,
      sameSite,
      path: '/',
      maxAge: maxAgeMs,
    });
  }

  private clearAuthCookies(response: Response) {
    response.clearCookie(AUTH_REFRESH_COOKIE, { path: '/' });
    response.clearCookie(AUTH_CSRF_COOKIE, { path: '/' });
  }

  private getCallbackErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    return fallback;
  }
}
