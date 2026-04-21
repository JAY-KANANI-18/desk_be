import { createRemoteJWKSet, jwtVerify } from 'jose';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getSupabaseJwks() {
  const url = process.env.SUPABASE_JWKS_URL;
  if (!url) {
    throw new Error('SUPABASE_JWKS_URL is not configured');
  }

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
  }

  return jwks;
}

export async function verifySupabaseToken(token: string) {
  const { payload } = await jwtVerify(token, getSupabaseJwks());
  return payload;
}

