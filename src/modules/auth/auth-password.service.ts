import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PASSWORD_POLICY_MIN_LENGTH } from './auth.constants';

@Injectable()
export class AuthPasswordService {
  async hashPassword(password: string) {
    this.assertPasswordPolicy(password);

    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_COST ?? 19456),
      timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 3),
      parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
    });
  }

  async verifyPassword(hash: string, password: string) {
    return argon2.verify(hash, password);
  }

  assertPasswordPolicy(password: string) {
    if (password.length < Number(process.env.AUTH_PASSWORD_MIN_LENGTH ?? PASSWORD_POLICY_MIN_LENGTH)) {
      throw new BadRequestException(`Password must be at least ${process.env.AUTH_PASSWORD_MIN_LENGTH ?? PASSWORD_POLICY_MIN_LENGTH} characters`);
    }
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException('Password must contain at least one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
      throw new BadRequestException('Password must contain at least one lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException('Password must contain at least one number');
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      throw new BadRequestException('Password must contain at least one symbol');
    }
  }
}

