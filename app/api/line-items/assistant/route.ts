import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { requireActiveBilling } from '@/lib/billingGuard';
import { ASSISTANT_FILTER_PROPERTIES, parseAssistantFilters } from '@/lib/assistantFilters';

/**
 * Turns a plain-English question about line items into a filter.
 *
 * This route reads no cost data and returns none. It translates a question
 * into the same filter object the tab already applies, and the browser then
 * runs that filter through the user's own Supabase session, where RLS decides
 * what is readable. The model never sees a customer's costs, and the worst it
 * can produce is a filter that finds the wrong rows -- never another
 * company's.
 */

// Sonnet handles the awkward part of this well: "last week", "over a hundred
// dollars", a service named three different ways. Haiku is cheaper but loses
// enough of those to be a false economy on a question a person had to type.
const MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = `You turn questions about cloud billing line items into a filter.

Call the set_filter tool exactly once. Set only the fields the question actually implies, and leave everything else unset — an unset field means "no restriction", which is almost always what an unmentioned field should be.

Guidance:
- Prefer a specific field over searchText when one fits. searchText is the catch-all.
- serviceNames is an EQUALITY match on the full service name. Service names vary by source: the same service may be stored as "AmazonEC2" or "Amazon Elastic Compute Cloud - Compute". Unless the question gives a complete service name verbatim, put the service in searchText instead — a partial name in serviceNames matches nothing and reads as "you spent nothing on that", which is worse than a loose match.
- Dates must be YYYY-MM-DD. Resolve relative dates ("last week", "the 5th") against today's date, given below.
- Costs are plain numbers, no currency symbol.
- Never guess an account id, region or billing code that the question did not state.
- If the question implies no filtering at all, call the tool with no fields set.`;

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'The assistant is not configured. ANTHROPIC_API_KEY is not set.' },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  const { companyId, question } = (body ?? {}) as { companyId?: string; question?: string };

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }
  // Guarded like every other company-scoped route: the assistant is not a way
  // around access control just because it only returns a filter.
  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  // The assistant burns a paid API call and is a mutating side effect of
  // using the product, not merely a read -- it must lock the same as every
  // other company-scoped route.
  const billing = await requireActiveBilling(companyId, guard.role);
  if (!billing.allowed) {
    return NextResponse.json({ error: billing.message }, { status: billing.status });
  }

  const asked = typeof question === 'string' ? question.trim().slice(0, 500) : '';
  if (!asked) {
    return NextResponse.json({ error: 'Ask a question first.' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const today = new Date().toISOString().slice(0, 10);

  let message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: `${SYSTEM_PROMPT}\n\nToday's date is ${today}.`,
      tools: [
        {
          name: 'set_filter',
          description: 'Apply a filter to the line items grid.',
          input_schema: {
            type: 'object',
            properties: ASSISTANT_FILTER_PROPERTIES,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'set_filter' },
      messages: [{ role: 'user', content: asked }],
    });
  } catch (err) {
    console.error('Line items assistant call failed:', err);
    const status = (err as { status?: number })?.status;
    if (status === 401) {
      return NextResponse.json({ error: 'The assistant’s API key was rejected.' }, { status: 502 });
    }
    if (status === 429) {
      return NextResponse.json(
        { error: 'The assistant is rate limited right now. Try again in a moment.' },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: 'The assistant could not answer that.' }, { status: 502 });
  }

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    return NextResponse.json(
      { error: 'The assistant did not produce a filter. Try rephrasing the question.' },
      { status: 502 }
    );
  }

  // Validated, never trusted: unknown keys, wrong types and anything naming a
  // period or company are dropped here rather than reaching a query.
  const filters = parseAssistantFilters(toolUse.input);

  return NextResponse.json({ filters });
}
