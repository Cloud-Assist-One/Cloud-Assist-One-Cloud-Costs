/**
 * An unknown throw, made printable.
 *
 * Its own module because lib/billingSourceInspect.ts needs it and must not
 * reach it through lib/billingSourceStore.ts: that module loads the AWS SDK,
 * which is ESM, which takes the inspect tests' Jest environment down with it.
 * Several API routes still carry their own copy of this; they are not in the
 * way of anything and are left alone.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}
