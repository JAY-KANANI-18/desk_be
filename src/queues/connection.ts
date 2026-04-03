const redisHost = process.env.REDIS_HOST;
const redisPort = process.env.REDIS_PORT;

console.log('[REDIS CONFIG]', {
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPort,
});

if (!redisHost || !redisPort) {
  throw new Error(
    `Missing Redis env. REDIS_HOST=${redisHost}, REDIS_PORT=${redisPort}`
  );
}

export const connection = {
  host: redisHost,
  port: Number(redisPort),
};