export const WORKSPACE_PERMISSIONS: Record<string, string[]> = {
    owner: [
        'workspace.manage',
        'team.manage',
        'conversation.assign',
        'conversation.delete',
        'message.send',
    ],
    admin: [
        'team.manage',
        'conversation.assign',
        'message.send',
    ],
    supervisor: [
        'conversation.assign',
        'message.send',
    ],
    agent: [
        'message.send',
    ],
};