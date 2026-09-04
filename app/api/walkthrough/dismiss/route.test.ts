/** @jest-environment node */
// next/server needs the Request/Response globals, which the project's default
// jsdom environment does not provide. Same docblock as the billing routes.

import { POST } from './route';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/supabase/admin', () => ({ createAdminClient: jest.fn() }));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockedCreateAdminClient = createAdminClient as jest.MockedFunction<typeof createAdminClient>;

function stubSession(user: { id: string } | null) {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user } }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function stubAdmin(opts: { error?: string } = {}) {
  const captured: Record<string, unknown> = {};
  const eq = jest.fn((column: string, value: unknown) => {
    captured.eqColumn = column;
    captured.eqValue = value;
    return Promise.resolve({ error: opts.error ? { message: opts.error } : null });
  });
  const update = jest.fn((values: Record<string, unknown>) => {
    captured.values = values;
    return { eq };
  });
  const from = jest.fn((table: string) => {
    captured.table = table;
    return { update };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedCreateAdminClient.mockReturnValue({ from } as any);
  return { captured, from, update, eq };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/walkthrough/dismiss', () => {
  it('rejects a caller who is not signed in, and writes nothing', async () => {
    stubSession(null);
    const admin = stubAdmin();

    const response = await POST();

    expect(response.status).toBe(401);
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('stamps the dismissal on the caller’s own profile only', async () => {
    stubSession({ id: 'user-1' });
    const admin = stubAdmin();

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ dismissed: true });
    expect(admin.captured.table).toBe('profiles');
    // The row written is always the session's own user id -- nothing from the
    // request can redirect this at someone else's profile.
    expect(admin.captured.eqColumn).toBe('id');
    expect(admin.captured.eqValue).toBe('user-1');
  });

  it('writes only the walkthrough column, never role or company', async () => {
    stubSession({ id: 'user-1' });
    const admin = stubAdmin();

    await POST();

    const values = admin.captured.values as Record<string, unknown>;
    expect(Object.keys(values)).toEqual(['walkthrough_dismissed_at']);
    expect(typeof values.walkthrough_dismissed_at).toBe('string');
  });

  it('reports a failed write rather than claiming success', async () => {
    stubSession({ id: 'user-1' });
    stubAdmin({ error: 'connection reset' });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/could not save/i);
  });
});
