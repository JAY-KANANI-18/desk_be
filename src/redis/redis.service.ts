import { Injectable } from '@nestjs/common';
import IORedis from 'ioredis';

@Injectable()
export class RedisService {
    public readonly client: IORedis;

    constructor() {
        this.client = new IORedis(process.env.REDIS_URL);
    }



    async getJSON(key: string) {
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }


    async setJSON(key: string, value: any) {
        await this.client.set(key, JSON.stringify(value));
    }

    async increment(key: string, field: string, amount = 1) {
        const data = await this.getJSON(key);

        if (!data) return;

        data[field] = (data[field] || 0) + amount;

        await this.setJSON(key, data);
    }
}