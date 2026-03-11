import { IsString, IsEnum, IsObject } from 'class-validator';

export class ConnectChannelDto {

    @IsEnum(['whatsapp', 'instagram', 'messenger', 'email'])
    type: string;

    @IsString()
    name: string;

    @IsString()
    identifier: string;
    // WhatsApp → phone_number_id
    // Instagram → pageId
    // Messenger → pageId
    // Email → email address

    @IsObject()
    config: Record<string, any>;
}