import { ALLOWED_OPERATIONS, OPERATION_MAP } from '../protocol';

describe('relay wire operation contract', () => {
  it('maps every allowed operation to a valid method and local API path', () => {
    expect(Object.keys(OPERATION_MAP).sort()).toEqual([...ALLOWED_OPERATIONS].sort());

    for (const operation of ALLOWED_OPERATIONS) {
      expect(OPERATION_MAP[operation]).toEqual(
        expect.objectContaining({
          method: expect.stringMatching(/^(GET|POST|DELETE)$/),
          path: expect.stringMatching(/^\//),
        }),
      );
    }
  });

  it('keeps administrative and shell operations outside the remote relay allowlist', () => {
    for (const operation of [
      'auth/rotate-token',
      'workspaces.create',
      'workspaces.delete',
      'terminal.run',
      'exec',
      'shell',
    ]) {
      expect(ALLOWED_OPERATIONS.has(operation)).toBe(false);
      expect(OPERATION_MAP[operation]).toBeUndefined();
    }
  });
});
