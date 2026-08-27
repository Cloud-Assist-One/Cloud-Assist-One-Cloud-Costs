import { SUPPORT_FORM_TOPICS, SUPPORT_TOPICS, isSupportTopic } from './supportTopics';

describe('SUPPORT_FORM_TOPICS', () => {
  // The form's checkboxes are what a client picks from on a blank form.
  // "Security finding" means nothing there — it only makes sense attached to
  // a finding the portal itself raised.
  it('does not offer the finding-raised topics as checkboxes', () => {
    expect(SUPPORT_FORM_TOPICS).not.toContain('Security finding');
    expect(SUPPORT_FORM_TOPICS).not.toContain('Cost leakage');
  });

  it('still offers every topic a client could previously choose', () => {
    expect(SUPPORT_FORM_TOPICS).toEqual([
      'Understanding my cloud billing',
      'Tagging for cost center reporting',
      'S3/Azure bucket cost reduction',
      'Reduce logging costs',
      'EC2/virtual machine cost reduction',
      'Technical cloud support',
      'Other',
    ]);
  });

  it('is a subset of the topics validation accepts', () => {
    for (const topic of SUPPORT_FORM_TOPICS) {
      expect(SUPPORT_TOPICS).toContain(topic);
    }
  });
});

describe('isSupportTopic', () => {
  it('accepts the finding-raised topics, so a ticket from a finding validates', () => {
    expect(isSupportTopic('Security finding')).toBe(true);
    expect(isSupportTopic('Cost leakage')).toBe(true);
  });

  it('accepts an ordinary form topic', () => {
    expect(isSupportTopic('Technical cloud support')).toBe(true);
  });

  it('rejects anything not on the list', () => {
    expect(isSupportTopic('Delete production')).toBe(false);
    expect(isSupportTopic('')).toBe(false);
    expect(isSupportTopic(null)).toBe(false);
    expect(isSupportTopic(42)).toBe(false);
  });
});
