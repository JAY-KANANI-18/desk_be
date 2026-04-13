import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { WorkspacePermission } from '../../common/constants/permissions';
import { WorkspaceRoute } from '../../common/auth/route-access.decorator';
import { CreateExportJobDto } from './dto/create-export-job.dto';
import { CreateImportJobDto } from './dto/create-import-job.dto';
import { ListImportExportJobsDto } from './dto/list-import-export-jobs.dto';
import { PreviewImportDto } from './dto/preview-import.dto';
import { StartImportDto } from './dto/start-import.dto';
import { ImportExportService } from './import-export.service';

@Controller('api')
export class ImportExportController {
  constructor(private readonly importExportService: ImportExportService) {}

  @Post('import/upload')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 20 * 1024 * 1024,
      },
    }),
  )
  uploadImportFile(
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.importExportService.uploadImportFile(req.workspaceId, req.user, file);
  }

  @Post('import/preview')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
  previewImport(@Req() req: any, @Body() dto: PreviewImportDto) {
    return this.importExportService.previewImport(req.workspaceId, dto);
  }

  @Post('import/start')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
  startImport(@Req() req: any, @Body() dto: StartImportDto) {
    return this.importExportService.startImportJob(req.workspaceId, req.user, dto);
  }

  @Post('import')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_MANAGE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 25 * 1024 * 1024,
      },
    }),
  )
  createImport(
    @Req() req: any,
    @Body() dto: CreateImportJobDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.importExportService.createImportJob(req.workspaceId, req.user, dto, file);
  }

  @Post('export')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
  createExport(@Req() req: any, @Body() dto: CreateExportJobDto) {
    return this.importExportService.createExportJob(req.workspaceId, req.user, dto);
  }

  @Get('jobs')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
  listJobs(@Req() req: any, @Query() query: ListImportExportJobsDto) {
    return this.importExportService.listJobs(
      req.workspaceId,
      req.user.id,
      req.workspaceRole,
      query,
    );
  }

  @Get('jobs/:id')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
  getJob(@Req() req: any, @Param('id') id: string) {
    return this.importExportService.getJob(
      req.workspaceId,
      req.user.id,
      req.workspaceRole,
      id,
    );
  }

  @Get('jobs/:id/download')
  @WorkspaceRoute(WorkspacePermission.CONTACTS_VIEW)
  download(@Req() req: any, @Param('id') id: string) {
    return this.importExportService.getDownload(
      req.workspaceId,
      req.user.id,
      req.workspaceRole,
      id,
    );
  }
}
