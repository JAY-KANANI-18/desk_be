import { Injectable } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {

    private supabase;

    constructor() {
        this.supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }

    async inviteUser(email: string) {

        const { data, error } =
            await this.supabase.auth.admin.inviteUserByEmail(email, {
                data: {
                    password_pending: true,
                },
            });

        if (error) {
            throw new Error(error.message);
        }

        return data;
    }

    async sendEmail(options: { to: string; subject: string; html: string }) {
        console.log("Sending email via Supabase:", options);
        // const { data, error } = await this.supabase
        //     .from('email_queue')
        //     .insert([
        //         {
        //             to: options.to,
        //             subject: options.subject,
        //             html: options.html,
        //         },
        //     ]);

    }

}