import { describe, expect, it } from 'vitest';
import { redact, safeLogEvent } from '../src/live-logs.js';
import { MemoryStore } from '../src/store.js';

describe('live log safety', () => {
  it('redacts credentials and phone numbers while preserving IP endpoints', () => {
    const value = redact('Authorization: Bearer secret-token OPENAI_API_KEY=sk-test-123456789012345 caller +41 91 210 20 49 remote 10.0.0.4:1234 DATABASE_URL=postgresql://u:p@db/x');
    expect(value).not.toContain('secret-token');
    expect(value).not.toContain('sk-test');
    expect(value).not.toContain('postgresql://u:p');
    expect(value).toContain('***2049');
    expect(value).toContain('10.0.0.4:1234');
  });

  it('assigns categories and caps in-memory retention', async () => {
    const store = new MemoryStore();
    for (let index = 0; index < 1002; index++) await store.addLogEvent('restaurant', safeLogEvent({ source: 'SIP', level: 'INFO', message: `event ${index}` }));
    const logs = await store.listLogEvents('restaurant', 500);
    expect(logs).toHaveLength(500);
    expect(logs.at(-1)).toMatchObject({ category: 'TELEPHONY', message: 'event 1001' });
  });
});
