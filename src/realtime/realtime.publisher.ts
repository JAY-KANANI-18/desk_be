import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL);

export async function publishMessageStatus(payload: any) {
    await redis.publish(
        'message-status',
        JSON.stringify(payload),
    );
}