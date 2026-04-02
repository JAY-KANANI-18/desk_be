import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AssignContactDto } from './dto/assign.dto';

@Controller('api/contacts')
export class ContactsController {
    constructor(private contactsService: ContactsService) { }

    @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    @RequirePermission('message.send')
    @Post()
    create(@Req() req: any, @Body() dto: CreateContactDto) {
        return this.contactsService.create(req.workspaceId, dto);
    }

    @UseGuards(JwtGuard, WorkspaceGuard)
    @Get()
    findAll(@Req() req: any) {
        return this.contactsService.findAll(req.workspaceId);
    }

    @UseGuards(JwtGuard, WorkspaceGuard)
    @Get(':id')
    findOne(@Req() req: any, @Param('id') id: string) {
        return this.contactsService.findOne(req.workspaceId, id);
    }

  

    @UseGuards(JwtGuard, WorkspaceGuard)
    // @RequirePermission('conversation.assign')
    @Patch(':id/assign')
    assign(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: AssignContactDto,
    ) {
        return this.contactsService.assign(req.workspaceId, id, dto);
    }

    @Patch(':id/lifecycle')
    updateLifecycle(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: { lifecycleId: string },
    ) {
        return this.contactsService.updateLifecycle(req.workspaceId, id, dto.lifecycleId);
    }

    @UseGuards(JwtGuard, WorkspaceGuard)
    // @RequirePermission('conversation.assign')
    @Patch(':id/status')
    statusUpdate(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: { status: string },
    ) {
        return this.contactsService.statusUpdate(req.workspaceId, id, dto.status);
    }


    @UseGuards(JwtGuard, WorkspaceGuard)
    // @RequirePermission('message.send')
    @Patch(':id')
    update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateContactDto) {
        return this.contactsService.update(req.workspaceId, id, dto);
    }

    @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    @RequirePermission('workspace.manage')
    @Delete(':id')
    remove(@Req() req: any, @Param('id') id: string) {
        return this.contactsService.remove(req.workspaceId, id);
    }
}