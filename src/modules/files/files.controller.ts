import { Controller, Post, Body } from "@nestjs/common";
import { R2Service } from "../../common/storage/r2.service";

@Controller("api/files")
export class FilesController {

    constructor(private r2: R2Service) { }

    @Post("presign")
    async createPresignedUrl(
        @Body() body: {
            type: string
            fileName: string
            contentType: string
            entityId?: string
        }
    ) {

        let key: string

        switch (body.type) {

            case "user-avatar":
                key = `files/avatars/users/${body.entityId}/${Date.now()}-${body.fileName}`
                break

            case "contact-avatar":
                key = `files/avatars/contacts/${body.entityId}/${Date.now()}-${body.fileName}`
                break

            case "message-attachment":
                key = `files/attachments/messages/${body.entityId}/${Date.now()}-${body.fileName}`
                break

            case "import":
                key = `files/imports/workspace/${body.entityId}/${Date.now()}-${body.fileName}`
                break

            default:
                key = `files/misc/${Date.now()}-${body.fileName}`
        }


        return {
            ... await this.r2.createPresignedUploadUrl(key, body.contentType),
            fileName: body.fileName,
            contentType: body.contentType,

        }

    }

}