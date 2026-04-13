import { Injectable } from "@nestjs/common";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

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

  async uploadStream(
    key: string,
    body: NodeJS.ReadableStream,
    mimeType: string
  ) {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      Body: body as any,
      ContentType: mimeType,
    });

    await this.client.send(command);

    return {
      url: `${process.env.R2_PUBLIC_URL}/${key}`,
      key,
    };
  }

  async getObjectStream(keyOrUrl: string) {
    const key = this.resolveKey(keyOrUrl);
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
    });

    const response = await this.client.send(command);
    const body = response.Body;

    if (!body) {
      throw new Error(`R2 object body missing for key ${key}`);
    }

    if (body instanceof Readable) {
      return body;
    }

    if (typeof (body as any).transformToWebStream === "function") {
      return Readable.fromWeb((body as any).transformToWebStream());
    }

    if (typeof (body as any).getReader === "function") {
      return Readable.fromWeb(body as ReadableStream<any>);
    }

    return body as unknown as Readable;
  }

  resolveKey(keyOrUrl: string) {
    if (!keyOrUrl) return keyOrUrl;

    const publicUrl = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
    if (publicUrl && keyOrUrl.startsWith(`${publicUrl}/`)) {
      return keyOrUrl.slice(publicUrl.length + 1);
    }

    return keyOrUrl.replace(/^\/+/, "");
  }
}
