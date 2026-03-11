export class MessageCreatedEvent {

  constructor(
    public readonly messageId: string,
    public readonly conversationId: string,
    public readonly assigneeEmail: string,
    public readonly senderId: string,
    public readonly workspaceId: string,
    public readonly assignedUserIds: string[],
  ) {}

}