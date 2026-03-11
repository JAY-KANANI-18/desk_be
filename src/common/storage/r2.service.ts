import { Injectable } from "@nestjs/common";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

@Injectable()
export class R2Service {

  private client: S3Client
  private bucket = process.env.R2_BUCKET!

  constructor() {

    this.client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY!,
        secretAccessKey: process.env.R2_SECRET_KEY!
      }
    })

  }

  async createPresignedUploadUrl(
    key: string,
    contentType: string
  ) {

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType
    })

    const uploadUrl = await getSignedUrl(
      this.client,
      command,
      { expiresIn: 300 } // 5 minutes
    )

    return {
      uploadUrl,
      fileUrl: `${process.env.R2_PUBLIC_URL}/${key}`
    }

  }

   async uploadBuffer(
    key: string,
    buffer: Buffer,
    mimeType: string
  ) {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    });

    await this.client.send(command);

    return {
      url: `${process.env.R2_PUBLIC_URL}/${key}`,
      key,
    };
  }
}