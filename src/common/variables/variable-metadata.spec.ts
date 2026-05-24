import {
  buildCommonVariableContext,
  findUnsupportedVariableKeys,
  normalizeVariableTemplate,
  renderVariableTemplate,
  SNIPPET_VARIABLE_KEY_SET,
} from './variable-metadata';

describe('variable metadata', () => {
  it('renders the universal dot-notation variables from a shared context', () => {
    const context = buildCommonVariableContext({
      contact: {
        firstName: 'Jay',
        lastName: 'Kanani',
        email: 'jay@example.com',
        phone: '916353969157',
      },
      agent: { firstName: 'Axo', lastName: 'Agent' },
      conversation: { id: 'conversation-1', lastMessage: 'Last inbound note' },
    });

    expect(
      renderVariableTemplate(
        'Hi {{contact.first_name}}, reply at {{contact.email}}. - {{agent.name}}',
        context,
      ),
    ).toBe('Hi Jay, reply at jay@example.com. - Axo Agent');
  });

  it('normalizes optional dollar prefixes without changing dot-notation keys', () => {
    expect(
      normalizeVariableTemplate(
        'Hi {{$contact.first_name}}, reply at {{contact.email}}. - {{agent.name}}',
      ),
    ).toBe('Hi {{contact.first_name}}, reply at {{contact.email}}. - {{agent.name}}');
  });

  it('resolves only exact canonical paths after the context is built', () => {
    expect(
      renderVariableTemplate(
        'Hi {{contact.first_name}}',
        { contact: { first_name: 'Jay' } },
      ),
    ).toBe('Hi Jay');
    expect(
      renderVariableTemplate(
        'Hi {{contact.first_name}}',
        { contact: { firstName: 'Jay' } },
      ),
    ).toBe('Hi ');
  });

  it('validates snippets against the shared variable allow-list', () => {
    expect(
      findUnsupportedVariableKeys(
        'Hi {{contact.name}} from {{agent.name}}',
        SNIPPET_VARIABLE_KEY_SET,
      ),
    ).toEqual([]);
    expect(
      findUnsupportedVariableKeys(
        'Hi {{order.total}}',
        SNIPPET_VARIABLE_KEY_SET,
      ),
    ).toEqual(['order.total']);
  });
});
