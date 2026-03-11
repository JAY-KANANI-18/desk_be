export function extractTemplateVariables(components: any[]) {
    const bodyComponent = components.find(
        c => c.type === 'BODY'
    );

    if (!bodyComponent?.text) return [];

    const matches = bodyComponent.text.match(/{{\d+}}/g);

    if (!matches) return [];

    return matches.map(m => m.replace(/[{}]/g, ''));
}
export function validateTemplateVariables(
    components: any[],
    provided: Record<string, string>
) {
    const required = extractTemplateVariables(components);

    if (required.length === 0) return true;

    for (const key of required) {
        if (!provided[key]) {
            throw new Error(`Missing template variable: ${key}`);
        }
    }

    return true;
}
export function buildTemplateComponents(
    components: any[],
    variables: Record<string, string>
) {
    return components.map(component => {
        if (component.type === 'BODY') {
            const requiredVars = extractTemplateVariables([component]);

            if (!requiredVars.length) return component;

            return {
                type: 'body',
                parameters: requiredVars.map(key => ({
                    type: 'text',
                    text: variables[key],
                })),
            };
        }

        return component;
    });
}