import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Req,
    Put,
    Query,
} from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AssignContactDto } from './dto/assign.dto';
import {
    LegacyMergeContactsDto,
    MergeContactsDto,
    MergePreviewQueryDto,
} from './dto/merge-contact.dto';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';

@Controller('api/contacts')
export class ContactsController {
    constructor(private contactsService: ContactsService) { }

    @Post()
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    create(@Req() req: any, @Body() dto: CreateContactDto) {
        return this.contactsService.create(req.workspaceId, dto);
    }

    
    @Get()
    @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
    findAll(@Req() req: any) {
        return this.contactsService.findAll(req.workspaceId);
    }

    
    @Get(':id')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
    findOne(@Req() req: any, @Param('id') id: string) {
        return this.contactsService.findOne(req.workspaceId, id);
    }

    @Get(':id/duplicates')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
    findDuplicates(@Req() req: any, @Param('id') id: string) {
        return this.contactsService.findDuplicates(req.workspaceId, id);
    }

    @Get(':id/merge-preview')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
    mergePreview(
        @Req() req: any,
        @Param('id') id: string,
        @Query() query: MergePreviewQueryDto,
    ) {
        return this.contactsService.getMergePreview(
            req.workspaceId,
            id,
            query.duplicateContactId,
        );
    }



    
    @Patch(':id/assign')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    assign(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: AssignContactDto,
    ) {
        return this.contactsService.assign(req.workspaceId, id, dto);
    }

    @Put(':id/lifecycle')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)

    updateLifecycle(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: { lifecycleId: string },
    ) {
        return this.contactsService.updateLifecycle(req.workspaceId, id, dto.lifecycleId);
    }

    @Post(':id/tags')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    addTag(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: { tagId: string },
    ) {
        return this.contactsService.addTag(req.workspaceId, id, dto.tagId);
    }

    @Delete(':id/tags/:tagId')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    removeTag(
        @Req() req: any,
        @Param('id') id: string,
        @Param('tagId') tagId: string,
    ) {
        return this.contactsService.removeTag(req.workspaceId, id, tagId);
    }

    @Patch(':id/status')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    statusUpdate(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: { status: string },
    ) {
        return this.contactsService.statusUpdate(req.workspaceId, id, dto.status);
    }


    @Patch(':id')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateContactDto) {
        return this.contactsService.update(req.workspaceId, id, dto);
    }

    @Post(':id/merge')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    mergeInto(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: MergeContactsDto,
    ) {
        return this.contactsService.mergeContacts(req.workspaceId, id, dto, req.user?.id);
    }

    @Post('merge')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    mergeLegacy(@Req() req: any, @Body() dto: LegacyMergeContactsDto) {
        return this.contactsService.mergeContacts(
            req.workspaceId,
            dto.keepId,
            {
                secondaryContactId: dto.removeId,
                resolution: (dto.merged as any) ?? undefined,
                source: 'legacy_merge_endpoint',
            },
            req.user?.id,
        );
    }

    @Delete(':id')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    remove(@Req() req: any, @Param('id') id: string) {
        return this.contactsService.remove(req.workspaceId, id);
    }
}
