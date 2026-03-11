import { createRemoteJWKSet, jwtVerify } from 'jose';

const SUPABASE_JWKS = createRemoteJWKSet(
    new URL(process.env.SUPABASE_JWKS_URL!)
);

export async function verifySupabaseToken(token: string) {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS);
    return payload;
}