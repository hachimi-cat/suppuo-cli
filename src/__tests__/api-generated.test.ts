import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `suppuo api <area> <action>`: every feature route, generated from the API spec.
// The CLI's own request helper (lib/api.ts) is stubbed; everything above it is real.
const apiRequest = vi.fn();
vi.mock('../lib/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/api.js')>();
  return { ...real, apiRequest: (...args: unknown[]) => apiRequest(...args) };
});

const { API_ROUTES, buildApiCommand } = await import('../commands/api.generated.js');

let exits: Array<number | undefined>;

beforeEach(() => {
  apiRequest.mockReset();
  exits = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code);
    return undefined as never;
  }) as typeof process.exit);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(argv: string[]): Promise<number | undefined> {
  await buildApiCommand().exitOverride().parseAsync(argv, { from: 'user' });
  return exits[0];
}

describe('suppuo api', () => {
  it('has a command for every feature route', () => {
    const count = API_ROUTES.reduce((n, a) => n + a.routes.length, 0);
    expect(count).toBeGreaterThanOrEqual(65);
    const areas = API_ROUTES.map((a) => a.area);
    expect(areas).toEqual(expect.arrayContaining(['tickets', 'canned-replies', 'help', 'webhook-subscriptions']));
  });

  it('creates a ticket from flags, typed as the spec says', async () => {
    apiRequest.mockResolvedValue({ id: 'tkt_1' });
    const code = await run([
      'tickets', 'create',
      '--subject', 'Refund', '--body', 'Please refund order 42', '--requester-email', 'a@b.co', '--channel', 'email',
    ]);
    expect(code).toBe(0);
    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/v1/tickets', {
      query: {},
      body: { subject: 'Refund', body: 'Please refund order 42', requesterEmail: 'a@b.co', channel: 'email' },
    });
  });

  it('refuses a value the spec does not allow, and a missing required field', async () => {
    expect(await run(['tickets', 'create', '--subject', 'X', '--body', 'Y', '--requester-email', 'a@b.co', '--channel', 'fax'])).toBe(1);
    exits = [];
    expect(await run(['tickets', 'create', '--subject', 'X', '--body', 'Y'])).toBe(1);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('puts path parameters in the path and query fields in the query; PUT goes through', async () => {
    apiRequest.mockResolvedValue({});
    expect(await run(['tickets', 'get', 'tkt 1'])).toBe(0);
    expect(apiRequest).toHaveBeenLastCalledWith('GET', '/api/v1/tickets/tkt%201', { query: {}, body: undefined });
    exits = [];
    expect(await run(['tickets', 'list', '--status', 'open', '--limit', '5'])).toBe(0);
    expect(apiRequest).toHaveBeenLastCalledWith('GET', '/api/v1/tickets', { query: { status: 'open', limit: '5' }, body: undefined });
    exits = [];
    expect(await run(['settings', 'set-automation', '--auto-response-enabled', 'true'])).toBe(0);
    expect(apiRequest).toHaveBeenLastCalledWith('PUT', '/api/v1/settings/automation', {
      query: {},
      body: { autoResponseEnabled: true },
    });
  });
});
