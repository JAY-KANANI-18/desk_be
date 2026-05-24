import { buildTemplateComponents } from './template-validator';

describe('WhatsApp template component builder', () => {
    it('trims text parameter values before building the provider payload', () => {
        const components = [
            {
                type: 'BODY',
                text: 'Hello {{1}}, contact us at {{2}}.',
            },
        ];

        expect(buildTemplateComponents(components, {
            '1': ' Jay ',
            '2': ' support@example.com ',
        })).toEqual([
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: 'Jay' },
                    { type: 'text', text: 'support@example.com' },
                ],
            },
        ]);
    });
});
