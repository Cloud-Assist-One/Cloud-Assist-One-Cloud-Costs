import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/**
 * Permanently stops the trial walkthrough reopening for the signed-in user.
 *
 * The company id is never taken from the request: the row written is always
 * the caller's own profile, resolved from their session. There is nothing a
 * caller could pass that would let them dismiss someone else's walkthrough.
 *
 * This uses the service-role client because clients hold no update policy on
 * profiles -- see 20260904000001_walkthrough_dismissal.sql for why granting
 * them one would be a privilege-escalation path.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { error } = await createAdminClient()
    .from('profiles')
    .update({ walkthrough_dismissed_at: new Date().toISOString() })
    .eq('id', user.id);

  if (error) {
    // Reported honestly as a failure even though the caller treats it as
    // non-fatal: the walkthrough simply reappears next session, which is a
    // self-correcting outcome that needs no interruption at the point of use.
    return NextResponse.json({ error: 'Could not save your preference.' }, { status: 500 });
  }

  return NextResponse.json({ dismissed: true });
}
