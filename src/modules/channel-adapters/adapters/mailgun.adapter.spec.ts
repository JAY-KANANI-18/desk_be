import { MailgunProvider } from './mailgun.adapter';

describe('MailgunProvider', () => {
  let provider: MailgunProvider;

  beforeEach(() => {
    provider = new MailgunProvider();
  });

  it('keeps full forwarded email html instead of Mailgun stripped html', async () => {
    const [parsed] = await provider.parseWebhook({
      from: 'Axora Infotech <info@axorainfotech.com>',
      sender: 'info@axorainfotech.com',
      To: 'info@axorainfotech.com',
      subject: 'Fwd: [Case 177821827800850] New correspondence added',
      'Message-Id': '<forwarded-message@email.android.com>',
      'body-plain':
        'Sent from Android device \n' +
        '---------- Forwarded message ---------- \n' +
        'From: Amazon Web Services <no-reply-aws@amazon.com> \n' +
        'Date: May 10, 2026 12:18 PM \n' +
        'Subject: [Case 177821827800850] New correspondence added \n' +
        'To: info@axorainfotech.com \n' +
        '\n' +
        'A new correspondence was added to case 177821827800850 \n' +
        'https://console.aws.amazon.com/support/home#/case/?displayId=177821827800850&language=en',
      'stripped-html':
        '<html><body><div>Sent from Android device</div>' +
        '<div>---------- Forwarded message ----------<br>From: Amazon Web Services</div></body></html>',
      'body-html':
        '<div>Sent from Android device</div>' +
        '<div class="gmail_quote">---------- Forwarded message ----------<br>' +
        'From: Amazon Web Services &lt;no-reply-aws@amazon.com&gt;<br>' +
        '<blockquote><p>A new correspondence was added to case 177821827800850</p>' +
        '<p><a href="https://console.aws.amazon.com/support/home#/case/?displayId=177821827800850&amp;language=en">https://console.aws.amazon.com/support/home#/case/?displayId=177821827800850&amp;language=en</a></p>' +
        '</blockquote></div>',
    });

    expect(parsed.text).toContain('A new correspondence was added to case 177821827800850');
    expect(parsed.metadata?.email?.htmlBody).toContain(
      'A new correspondence was added to case 177821827800850',
    );
    expect(parsed.metadata?.email?.htmlBody).toContain('https://console.aws.amazon.com/support/home#');
  });

  it('still trims quoted reply history for regular replies', async () => {
    expect(
      await provider.extractReply('Thanks\n\nOn Sun, May 10, 2026 at 9:00 AM Jay wrote:\n> Old text'),
    ).toBe('Thanks');
  });

  it('prefers the header From over Mailgun envelope sender', async () => {
    const [parsed] = await provider.parseWebhook({
      sender: '0100019e10dee813-dba98550-2836-447f-9fc1-8185bd772ac7-000000@amazonses.com',
      from: 'Amazon Web Services <no-reply-aws@amazon.com>',
      To: 'info@axorainfotech.com',
      Subject: 'RE: [Case 177821827800452] Action Required',
      'Message-Id': '<aws-message@example.com>',
      'body-plain': 'Hello there,\n\nThis case appears to be a duplicate.',
    });

    expect(parsed.contactIdentifier).toBe('no-reply-aws@amazon.com');
    expect(parsed.metadata?.email?.from).toBe('Amazon Web Services <no-reply-aws@amazon.com>');
    expect(parsed.metadata?.email?.envelopeSender).toBe(
      '0100019e10dee813-dba98550-2836-447f-9fc1-8185bd772ac7-000000@amazonses.com',
    );
  });

  it('falls back to message-headers From when direct header fields are missing', async () => {
    const [parsed] = await provider.parseWebhook({
      sender: '0100019e10dee813-dba98550-2836-447f-9fc1-8185bd772ac7-000000@amazonses.com',
      recipient: 'info@sandbox278843f4f32541ddb46190d5a96b990f.mailgun.org',
      'message-headers': JSON.stringify([
        ['From', 'Amazon Web Services <no-reply-aws@amazon.com>'],
        ['To', 'info@axorainfotech.com'],
        ['Subject', 'RE: [Case 177821827800452] Action Required'],
        ['Message-Id', '<aws-message@example.com>'],
      ]),
      'body-plain': 'Hello there',
    });

    expect(parsed.contactIdentifier).toBe('no-reply-aws@amazon.com');
    expect(parsed.metadata?.email?.to).toBe('info@axorainfotech.com');
    expect(parsed.metadata?.email?.subject).toBe('RE: [Case 177821827800452] Action Required');
  });
});
