/**
 * Authentication service handling user login and session management.
 */

import { User } from "./models/user.js";

export interface AuthConfig {
  secretKey: string;
  tokenExpiry: number;
  refreshEnabled: boolean;
}

export type TokenPayload = {
  userId: string;
  role: string;
  exp: number;
};

export enum AuthRole {
  Admin = "admin",
  User = "user",
  Guest = "guest",
}

export const MAX_LOGIN_ATTEMPTS = 5;
export const SESSION_TIMEOUT = 3600;

export class AuthService {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  async login(email: string, password: string): Promise<string> {
    // Authenticate user
    return "token";
  }

  async logout(token: string): Promise<void> {
    // Invalidate session
  }

  validateToken(token: string): TokenPayload | null {
    return null;
  }

  static createDefault(): AuthService {
    return new AuthService({
      secretKey: "default",
      tokenExpiry: 3600,
      refreshEnabled: true,
    });
  }
}

export async function hashPassword(password: string): Promise<string> {
  return "hashed";
}

export const createToken = async (payload: TokenPayload): Promise<string> => {
  return "token";
};

function _internalHelper(): void {
  // Not exported
}
