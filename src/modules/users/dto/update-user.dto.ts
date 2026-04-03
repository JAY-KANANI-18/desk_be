import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class UpdateUserDto {


    @IsString()
    avatarUrl: string;

    @IsString()
    @IsNotEmpty()
    firstName: string;


    @IsString()
    lastName?: string;


    


   
}