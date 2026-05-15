import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module'; // 👈 ADD THIS
import { ActivityModule } from '../activity/activity.module';
import { CommerceModule } from '../commerce/commerce.module';

@Module({
    imports: [
        PrismaModule,
        RealtimeModule, // 👈 VERY IMPORTANT
        ActivityModule,
        CommerceModule,
    ],
    controllers: [ContactsController],
    providers: [ContactsService],
})
export class ContactsModule { }
