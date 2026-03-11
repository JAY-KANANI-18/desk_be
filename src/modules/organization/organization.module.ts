import { Module } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { SupabaseService } from 'src/supdabse/supabase.service';

@Module({
    controllers: [OrganizationController],
    providers: [OrganizationService, SupabaseService],

})
export class OrganizationModule { }