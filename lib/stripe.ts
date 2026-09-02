import Stripe from 'stripe';

/**
 * One client per call, not a module-level singleton -- a singleton built at
 * import time would throw for every route that imports this file the
 * moment STRIPE_SECRET_KEY is unset, including ones that never touch
 * Stripe, and would do so at build/cold-start rather than inside a route's
 * own try/catch where the caller can turn it into a normal error response.
 */
export function createStripeClient(): Stripe {
  const key = (process.env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set.');
  }
  return new Stripe(key);
}
