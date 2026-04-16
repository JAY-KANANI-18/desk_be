type TemplateVariables = Record<string, string> | string[] | null | undefined;

function normaliseVariables(provided: TemplateVariables): Record<string, string> {
    if (!provided) return {};

    if (Array.isArray(provided)) {
        return provided.reduce<Record<string, string>>((acc, value, index) => {
            acc[String(index + 1)] = String(value ?? '');
            return acc;
        }, {});
    }

    return Object.entries(provided).reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = String(value ?? '');
        return acc;
    }, {});
}

export function extractTemplateVariables(components: any[]) {
    const vars = new Set<string>();
    const re = /\{\{\s*([\w.]+)\s*\}\}/g;

    for (const component of components ?? []) {
        const texts = [
            component?.text,
            ...(component?.buttons ?? []).map((button: any) => button?.url),
        ].filter(Boolean);

        for (const text of texts) {
            let match: RegExpExecArray | null;
            while ((match = re.exec(String(text))) !== null) {
                vars.add(match[1]);
            }
        }
    }

    return Array.from(vars).sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return a.localeCompare(b);
    });
}
export function validateTemplateVariables(
    components: any[],
    provided: TemplateVariables
) {
    const required = extractTemplateVariables(components);
    const variables = normaliseVariables(provided);

    if (required.length === 0) return true;

    for (const key of required) {
        if (!variables[key]) {
            throw new Error(`Missing template variable: ${key}`);
        }
    }

    return true;
}
export function buildTemplateComponents(
    components: any[],
    provided: TemplateVariables
) {
    const variables = normaliseVariables(provided);
    const built: any[] = [];

    const textParameters = (text?: string) =>
        extractTemplateVariables([{ text }]).map(key => ({
            type: 'text',
            text: variables[key],
        }));

    for (const component of components ?? []) {
        const type = String(component?.type ?? '').toUpperCase();

        if (type === 'HEADER') {
            if (component?.format === 'TEXT' && component?.text) {
                const parameters = textParameters(component.text).filter(p => p.text !== undefined);
                if (parameters.length) built.push({ type: 'header', parameters });
                continue;
            }

            if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(component?.format)) {
                const mediaUrl = variables.header_url;
                if (mediaUrl) {
                    const key = String(component.format).toLowerCase();
                    built.push({
                        type: 'header',
                        parameters: [{ type: key, [key]: { link: mediaUrl } }],
                    });
                }
                continue;
            }
        }

        if (type === 'BODY') {
            const parameters = textParameters(component?.text).filter(p => p.text !== undefined);
            if (parameters.length) built.push({ type: 'body', parameters });
            continue;
        }

        if (type === 'BUTTONS') {
            for (let index = 0; index < (component?.buttons ?? []).length; index++) {
                const button = component.buttons[index];
                const buttonType = String(button?.type ?? '').toUpperCase();

                if (buttonType === 'URL' && button?.url?.includes('{{')) {
                    const parameters = textParameters(button.url).filter(p => p.text !== undefined);
                    if (parameters.length) {
                        built.push({
                            type: 'button',
                            sub_type: 'url',
                            index: String(index),
                            parameters,
                        });
                    }
                }

                if (buttonType === 'COPY_CODE') {
                    const couponCode = variables.coupon_code;
                    if (couponCode) {
                        built.push({
                            type: 'button',
                            sub_type: 'copy_code',
                            index: String(index),
                            parameters: [{ type: 'coupon_code', coupon_code: couponCode }],
                        });
                    }
                }
            }
        }
    }

    return built;
}
