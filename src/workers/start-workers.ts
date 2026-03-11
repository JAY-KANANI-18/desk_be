import { RedisService } from "../redis/redis.service";
import { SupabaseService } from "../supdabse/supabase.service";
import { NotificationWorker } from "./notification.worker";

async function start() {
  const redis = new RedisService();
  const supabase = new SupabaseService();

  new NotificationWorker(redis, supabase);

  console.log("Notification worker started");
}

start();