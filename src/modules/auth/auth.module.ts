import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthPasswordService } from './auth-password.service';
import { AuthTokenService } from './auth-token.service';
import { AuthMailService } from './auth-mail.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthSessionCacheService } from './auth-session-cache.service';
import { AuthCryptoService } from './auth-crypto.service';
import { AuthTotpService } from './auth-totp.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthPasswordService,
    AuthTokenService,
    AuthMailService,
    AuthRateLimitService,
    AuthSessionCacheService,
    AuthCryptoService,
    AuthTotpService,
  ],
  exports: [AuthService, AuthTokenService],
})
export class AuthModule {}

