import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { R2Service } from "../../common/storage/r2.service";

@Module({
  controllers: [FilesController],
  providers: [R2Service],
  exports: [R2Service]
})
export class FilesModule {}