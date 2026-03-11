export class SendMessageDto {
  conversationId: string
  channelId: string
  text: string
  authorId?: string
  metadata?: any

  attachments?: {
    type: string
    url: string
    mimeType?: string
  }[]
}