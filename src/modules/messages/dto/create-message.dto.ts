import { IsOptional, IsString, IsEnum } from 'class-validator';

export class CreateMessageDto {
    @IsOptional()
    @IsString()
    text?: string;

    @IsEnum(['reply', 'comment', 'system'])
    type: 'reply' | 'comment' | 'system';

    @IsEnum(['incoming', 'outgoing', 'internal'])
    direction: 'incoming' | 'outgoing' | 'internal';
}