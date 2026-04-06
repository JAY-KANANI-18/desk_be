import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { SupabaseService } from 'src/supdabse/supabase.service';

@Module({
    controllers: [WorkspaceController],
    providers: [WorkspaceService,SupabaseService],
})
export class WorkspaceModule { }