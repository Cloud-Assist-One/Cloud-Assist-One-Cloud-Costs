import { buildSupportRequestEmail } from './supportRequestEmail';

const base = {
  companyName: 'Initech',
  firstName: 'Mark',
  email: 'mark@initech.com',
  phone: '407-388-4747',
  phoneExt: '204',
  topics: ['Reduce logging costs', 'Technical cloud support'],
  details: 'Our CloudWatch bill tripled last month.',
};

describe('buildSupportRequestEmail', () => {
  it('names the company and the topics in the subject so the inbox is scannable', () => {
    const { subject } = buildSupportRequestEmail(base);

    expect(subject).toBe('Support request from Initech — Mark');
  });

  it('includes every submitted field in the body', () => {
    const { text } = buildSupportRequestEmail(base);

    expect(text).toContain('Initech');
    expect(text).toContain('Mark');
    expect(text).toContain('mark@initech.com');
    expect(text).toContain('407-388-4747');
    expect(text).toContain('ext. 204');
    expect(text).toContain('Reduce logging costs');
    expect(text).toContain('Technical cloud support');
    expect(text).toContain('Our CloudWatch bill tripled last month.');
  });

  it('omits the extension line when no extension was given', () => {
    const { text } = buildSupportRequestEmail({ ...base, phoneExt: null });

    expect(text).toContain('407-388-4747');
    expect(text).not.toContain('ext.');
  });

  it('says so explicitly when optional fields are missing, rather than leaving a blank line', () => {
    const { text } = buildSupportRequestEmail({ ...base, phone: null, phoneExt: null, details: null });

    // A blank value reads as a rendering bug; "Not provided" reads as the
    // submitter's choice.
    expect(text).toContain('Phone: Not provided');
    expect(text).toContain('Details: Not provided');
  });

  it('names the portal as Cloud Assist One', () => {
    const { text } = buildSupportRequestEmail({
      companyName: 'Acme Corp',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: null,
      phoneExt: null,
      topics: ['Technical cloud support'],
      details: null,
    });

    expect(text).toContain('Cloud Assist One portal');
    expect(text).not.toContain('Cloud Cost Assistant');
  });
});
