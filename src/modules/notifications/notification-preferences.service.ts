import { Injectable } from "@nestjs/common";
import { PrismaService } from "prisma/prisma.service";

@Injectable()
export class NotificationPreferencesService {

  constructor(private prisma: PrismaService) {}

  async getUserPreferences(userId: string) {

    let prefs = await this.prisma.notificationPreference.findUnique({
      where: { userId }
    })

    // create default if not exists
    if (!prefs) {

      prefs = await this.prisma.notificationPreference.create({
        data: { userId }
      })

    }

    return prefs
  }

}