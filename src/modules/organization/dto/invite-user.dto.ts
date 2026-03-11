import { IsEmail, IsString, IsArray } from 'class-validator';

export class InviteUserDto {

    @IsEmail()
    @IsString()
    email: string;

    @IsString()
    role: string;

    @IsArray()
    workspaceAccess?: {
        workspaceId: string;
        role: string;
    }[];


}