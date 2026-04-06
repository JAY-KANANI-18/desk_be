import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Req,
} from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AssignContactDto } from './dto/assign.dto';
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



    
    @Patch(':id/assign')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    assign(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: AssignContactDto,
    ) {
        return this.contactsService.assign(req.workspaceId, id, dto);
    }

    @Patch(':id/lifecycle')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)

    updateLifecycle(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: { lifecycleId: string },
    ) {
        return this.contactsService.updateLifecycle(req.workspaceId, id, dto.lifecycleId);
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

    @Delete(':id')
    @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
    remove(@Req() req: any, @Param('id') id: string) {
        return this.contactsService.remove(req.workspaceId, id);
    }
}