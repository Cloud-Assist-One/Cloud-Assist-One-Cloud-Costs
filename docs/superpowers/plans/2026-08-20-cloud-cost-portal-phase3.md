# Cloud Cost Review Portal — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the staff review workflow (notes, voice notes, todos, time-tracking — all client-visible) and the staff-only Admin tab for creating companies and user accounts. This is the third and final phase of Phase 1 of the overall product roadmap. After this phase, subscription billing and AI automation are the only remaining future work, and they are explicitly out of scope until specced separately.

**Architecture:** One new migration adds `review_notes`, `review_todos`, `time_entries`, and a `voice-notes` storage bucket, following the exact RLS + GRANT pattern already established in Phase 1's schema. A single `NotesFeed` component covers notes/voice notes/todos/time entries in one chronological feed. The Admin tab reuses the training-portal's service-role admin-user-creation pattern, adapted for this app's `companies`/`profiles` shape.

**Tech Stack:** Same as Phases 1-2 — Next.js 16, React 19, Supabase, `recharts`, Jest + Testing Library, MediaRecorder API for voice notes.

**Spec:** `docs/superpowers/specs/2026-08-19-cloud-cost-portal-phase1-design.md`

## Global Constraints

- This phase builds directly on top of the completed, deployed Phase 1 and Phase 2 codebase — do not re-scaffold the project or re-create any earlier file. Read the existing `lib/admin-guard.ts`, `lib/types.ts`, `components/shell/AppShell.tsx`, and `supabase/migrations/*.sql` before writing anything — this plan assumes they already exist exactly as Phases 1-2 built them.
- **The new migration in this phase MUST include explicit `grant select, insert, update, delete on public.<table> to authenticated;` (narrowed appropriately per table) and full CRUD `to service_role;` in the same migration file** — this is the exact gap that silently broke the training portal (Supabase does not grant base table privileges by default; RLS policies are never evaluated without the GRANT).
- No public self-signup — all accounts are created by staff through the new Admin tab in this phase (Phase 1/2 bootstrapped their test accounts by hand via SQL; this phase's Task 6 verification step uses the real UI instead).
- Follow existing project conventions: CSS Modules per component, `@/*` path alias, tests co-located as `Component.test.tsx`, functional components with hooks, 2-space indentation, `cancelled`-flag guarded `useEffect`.
- Route Handler dynamic params are async (`await params`) — same as the training portal's Next.js version.
- All Supabase env vars are trimmed on read — already true throughout Phases 1-2; don't regress it.

---

## Task 1: Database migration — review workflow schema

**Files:**
- Create: `supabase/migrations/20260820000002_review_workflow_schema.sql`

**Interfaces:**
- Produces: tables `public.review_notes`, `public.review_todos`, `public.time_entries`; storage bucket `voice-notes`.
- Consumes: `private.is_staff()`, `private.user_company_id()` helper functions (from Phase 1's `20260820000000_core_schema.sql` — already exist, do not redefine them).

- [ ] **Step 1: Write the migration file**

`supabase/migrations/20260820000002_review_workflow_schema.sql`:
```sql
-- Review notes ------------------------------------------------------------

create table public.review_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cost_record_id uuid references public.cost_records (id) on delete set null,
  author_id uuid not null references public.profiles (id) on delete cascade,
  note_text text,
  voice_note_path text,
  created_at timestamptz not null default now(),
  constraint review_notes_has_content check (note_text is not null or voice_note_path is not null)
);

create index review_notes_company_id_idx on public.review_notes (company_id);

alter table public.review_notes enable row level security;

create policy "review_notes_select"
  on public.review_notes for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "review_notes_insert_staff"
  on public.review_notes for insert
  to authenticated
  with check ((select private.is_staff()) and author_id = (select auth.uid()));

create policy "review_notes_delete_staff"
  on public.review_notes for delete
  to authenticated
  using ((select private.is_staff()));

-- Review todos ------------------------------------------------------------

create table public.review_todos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cost_record_id uuid references public.cost_records (id) on delete set null,
  title text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index review_todos_company_id_idx on public.review_todos (company_id);

alter table public.review_todos enable row level security;

create policy "review_todos_select"
  on public.review_todos for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "review_todos_insert_staff"
  on public.review_todos for insert
  to authenticated
  with check ((select private.is_staff()) and created_by = (select auth.uid()));

create policy "review_todos_update_staff"
  on public.review_todos for update
  to authenticated
  using ((select private.is_staff()));

create policy "review_todos_delete_staff"
  on public.review_todos for delete
  to authenticated
  using ((select private.is_staff()));

-- Time entries --------------------------------------------------------------

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  staff_id uuid not null references public.profiles (id) on delete cascade,
  entry_date date not null,
  minutes_spent integer not null check (minutes_spent > 0),
  description text not null,
  created_at timestamptz not null default now()
);

create index time_entries_company_id_idx on public.time_entries (company_id);

alter table public.time_entries enable row level security;

create policy "time_entries_select"
  on public.time_entries for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "time_entries_insert_staff"
  on public.time_entries for insert
  to authenticated
  with check ((select private.is_staff()) and staff_id = (select auth.uid()));

create policy "time_entries_update_staff"
  on public.time_entries for update
  to authenticated
  using ((select private.is_staff()));

create policy "time_entries_delete_staff"
  on public.time_entries for delete
  to authenticated
  using ((select private.is_staff()));

-- Storage bucket for voice notes --------------------------------------------
-- Objects are stored under "{company_id}/..." so folder-based RLS can scope them.

insert into storage.buckets (id, name, public)
values ('voice-notes', 'voice-notes', false)
on conflict (id) do nothing;

create policy "voice_notes_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'voice-notes'
    and ((select private.is_staff()) or (storage.foldername(name))[1] = (select private.user_company_id())::text)
  );

create policy "voice_notes_insert_staff"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'voice-notes' and (select private.is_staff()));

create policy "voice_notes_delete_staff"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'voice-notes' and (select private.is_staff()));

-- Base table grants --------------------------------------------------------
-- RLS policies are never evaluated without these — see Global Constraints.

grant select, insert, delete on public.review_notes to authenticated;
grant select, insert, update, delete on public.review_notes to service_role;

grant select, insert, update, delete on public.review_todos to authenticated;
grant select, insert, update, delete on public.review_todos to service_role;

grant select, insert on public.time_entries to authenticated;
grant select, insert, update, delete on public.time_entries to service_role;
```

- [ ] **Step 2: Apply the migration**

Call `mcp__supabase__apply_migration` with the project's `project_id`, `name: "review_workflow_schema"`, and `query` set to the full SQL above.

- [ ] **Step 3: Verify**

Call `mcp__supabase__get_advisors` with `type: "security"` — expect no new warnings.

Call `mcp__supabase__execute_sql` with:
```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('review_notes', 'review_todos', 'time_entries')
  and grantee in ('authenticated', 'service_role')
order by table_name, grantee, privilege_type;
```
Confirm `authenticated` has exactly `SELECT`/`INSERT`/`DELETE` on `review_notes`, `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `review_todos`, `SELECT`/`INSERT` on `time_entries`; `service_role` has full CRUD on all three. **Do not proceed to any later task until this is confirmed.**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260820000002_review_workflow_schema.sql
git commit -m "Add review workflow schema: notes, todos, time entries"
```

---

## Task 2: Notes & Follow-ups feed

**Files:**
- Create: `components/notes/NotesFeed.tsx`
- Create: `components/notes/NotesFeed.module.css`
- Create: `components/notes/NotesFeed.test.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client`. (`ReviewNote`, `ReviewTodo`, `TimeEntry`, `TodoStatus` types are new in this phase — add them to `lib/types.ts` as part of Step 1 below, following the exact shape from the spec's Data Model section: `ReviewNote { id, company_id, cost_record_id: string | null, author_id, note_text: string | null, voice_note_path: string | null, created_at }`; `ReviewTodo { id, company_id, cost_record_id: string | null, title, status: TodoStatus, created_by, created_at, completed_at: string | null }`; `TimeEntry { id, company_id, staff_id, entry_date, minutes_spent, description, created_at }`.)
- Produces: `NotesFeed` (default export, props `{ companyId: string; userId: string; isStaff: boolean }`) — consumed by `AppShell` in Task 4 of this phase.

- [ ] **Step 1: Add the new shared types**

Modify `lib/types.ts` — append (do not remove or reorder the existing `ProfileRole`/`CloudProvider`/`UploadStatus`/`Company`/`Profile`/`UploadedFile`/`CostRecord` types from Phase 1):

```ts
export type TodoStatus = 'open' | 'done';

export interface ReviewNote {
  id: string;
  company_id: string;
  cost_record_id: string | null;
  author_id: string;
  note_text: string | null;
  voice_note_path: string | null;
  created_at: string;
}

export interface ReviewTodo {
  id: string;
  company_id: string;
  cost_record_id: string | null;
  title: string;
  status: TodoStatus;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

export interface TimeEntry {
  id: string;
  company_id: string;
  staff_id: string;
  entry_date: string;
  minutes_spent: number;
  description: string;
  created_at: string;
}
```

- [ ] **Step 2: Write the failing test**

`components/notes/NotesFeed.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotesFeed from './NotesFeed';

const selectNotes = jest.fn();
const selectTodos = jest.fn();
const selectTimeEntries = jest.fn();
const insertNote = jest.fn();
const insertTodo = jest.fn();
const updateTodo = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'review_notes') {
        return {
          select: () => ({ eq: () => ({ order: (...args: unknown[]) => selectNotes(...args) }) }),
          insert: (...args: unknown[]) => insertNote(...args),
        };
      }
      if (table === 'review_todos') {
        return {
          select: () => ({ eq: () => ({ order: (...args: unknown[]) => selectTodos(...args) }) }),
          insert: (...args: unknown[]) => insertTodo(...args),
          update: (...args: unknown[]) => {
            updateTodo(...args);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ order: (...args: unknown[]) => selectTimeEntries(...args) }) }),
      };
    },
  }),
}));

describe('NotesFeed', () => {
  beforeEach(() => {
    selectNotes.mockReset().mockResolvedValue({
      data: [
        {
          id: 'note-1',
          company_id: 'company-1',
          cost_record_id: null,
          author_id: 'staff-1',
          note_text: 'Reviewed the July EC2 spike.',
          voice_note_path: null,
          created_at: '2026-07-15T00:00:00.000Z',
        },
      ],
    });
    selectTodos.mockReset().mockResolvedValue({
      data: [
        {
          id: 'todo-1',
          company_id: 'company-1',
          cost_record_id: null,
          title: 'Confirm with client about unused RDS instance',
          status: 'open',
          created_by: 'staff-1',
          created_at: '2026-07-15T00:00:00.000Z',
          completed_at: null,
        },
      ],
    });
    selectTimeEntries.mockReset().mockResolvedValue({
      data: [
        {
          id: 'time-1',
          company_id: 'company-1',
          staff_id: 'staff-1',
          entry_date: '2026-07-15',
          minutes_spent: 30,
          description: 'Reviewed July AWS spend',
          created_at: '2026-07-15T00:00:00.000Z',
        },
      ],
    });
    insertNote.mockReset().mockReturnValue(Promise.resolve({ error: null }));
    insertTodo.mockReset().mockReturnValue(Promise.resolve({ error: null }));
    updateTodo.mockReset();
  });

  it('lists notes, todos, and time entries', async () => {
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);

    expect(await screen.findByText('Reviewed the July EC2 spike.')).toBeInTheDocument();
    expect(screen.getByText('Confirm with client about unused RDS instance')).toBeInTheDocument();
    expect(screen.getByText(/reviewed july aws spend/i)).toBeInTheDocument();
  });

  it('lets staff add a text note', async () => {
    const user = userEvent.setup();
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);

    await screen.findByText('Reviewed the July EC2 spike.');
    await user.type(screen.getByLabelText(/add a note/i), 'New note text');
    await user.click(screen.getByRole('button', { name: /post note/i }));

    await waitFor(() =>
      expect(insertNote).toHaveBeenCalledWith(
        expect.objectContaining({ company_id: 'company-1', author_id: 'staff-1', note_text: 'New note text' })
      )
    );
  });

  it('lets staff add a todo and toggle it done', async () => {
    const user = userEvent.setup();
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);

    await screen.findByText('Confirm with client about unused RDS instance');
    await user.type(screen.getByLabelText(/new todo/i), 'Check S3 lifecycle rules');
    await user.click(screen.getByRole('button', { name: /add todo/i }));

    await waitFor(() =>
      expect(insertTodo).toHaveBeenCalledWith(
        expect.objectContaining({ company_id: 'company-1', created_by: 'staff-1', title: 'Check S3 lifecycle rules' })
      )
    );

    await user.click(screen.getByRole('checkbox', { name: /confirm with client about unused rds instance/i }));

    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' })));
  });

  it('hides the add-note and add-todo forms for non-staff users', async () => {
    render(<NotesFeed companyId="company-1" userId="client-1" isStaff={false} />);

    await screen.findByText('Reviewed the July EC2 spike.');
    expect(screen.queryByLabelText(/add a note/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new todo/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest components/notes/NotesFeed.test.tsx`
Expected: FAIL — `Cannot find module './NotesFeed'`.

- [ ] **Step 4: Write the component**

`components/notes/NotesFeed.tsx`:
```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { ReviewNote, ReviewTodo, TimeEntry } from '@/lib/types';
import styles from './NotesFeed.module.css';

interface NotesFeedProps {
  companyId: string;
  userId: string;
  isStaff: boolean;
}

export default function NotesFeed({ companyId, userId, isStaff }: NotesFeedProps) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [todos, setTodos] = useState<ReviewTodo[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState('');
  const [todoTitle, setTodoTitle] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const loadAll = useCallback(async () => {
    const supabase = createClient();
    const [notesResult, todosResult, timeEntriesResult] = await Promise.all([
      supabase.from('review_notes').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
      supabase.from('review_todos').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
      supabase.from('time_entries').select('*').eq('company_id', companyId).order('entry_date', { ascending: false }),
    ]);
    setNotes(notesResult.data ?? []);
    setTodos(todosResult.data ?? []);
    setTimeEntries(timeEntriesResult.data ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleAddNote() {
    if (!noteText.trim()) return;
    const supabase = createClient();
    await supabase.from('review_notes').insert({ company_id: companyId, author_id: userId, note_text: noteText.trim() });
    setNoteText('');
    loadAll();
  }

  async function handleAddTodo() {
    if (!todoTitle.trim()) return;
    const supabase = createClient();
    await supabase.from('review_todos').insert({ company_id: companyId, created_by: userId, title: todoTitle.trim() });
    setTodoTitle('');
    loadAll();
  }

  async function handleToggleTodo(todo: ReviewTodo) {
    const supabase = createClient();
    const nextStatus = todo.status === 'open' ? 'done' : 'open';
    await supabase
      .from('review_todos')
      .update({ status: nextStatus, completed_at: nextStatus === 'done' ? new Date().toISOString() : null })
      .eq('id', todo.id);
    loadAll();
  }

  async function handleStartRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    audioChunksRef.current = [];
    recorder.ondataavailable = (event) => audioChunksRef.current.push(event.data);
    recorder.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const supabase = createClient();
      const storagePath = `${companyId}/${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage.from('voice-notes').upload(storagePath, blob);
      if (!uploadError) {
        await supabase.from('review_notes').insert({ company_id: companyId, author_id: userId, voice_note_path: storagePath });
        loadAll();
      }
      stream.getTracks().forEach((track) => track.stop());
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
  }

  function handleStopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div className={styles.wrapper}>
      <section>
        <h3>Time reviewed</h3>
        {timeEntries.length === 0 ? (
          <p>No time logged yet.</p>
        ) : (
          <ul className={styles.timeList}>
            {timeEntries.map((entry) => (
              <li key={entry.id}>
                {entry.entry_date} — {entry.minutes_spent} min — {entry.description}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Follow-ups</h3>
        {isStaff && (
          <div className={styles.addForm}>
            <label htmlFor="new-todo">New todo</label>
            <input id="new-todo" value={todoTitle} onChange={(e) => setTodoTitle(e.target.value)} />
            <button type="button" onClick={handleAddTodo}>
              Add todo
            </button>
          </div>
        )}
        {todos.length === 0 ? (
          <p>No follow-ups yet.</p>
        ) : (
          <ul className={styles.todoList}>
            {todos.map((todo) => (
              <li key={todo.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={todo.status === 'done'}
                    onChange={() => handleToggleTodo(todo)}
                    disabled={!isStaff}
                    aria-label={todo.title}
                  />
                  <span className={todo.status === 'done' ? styles.done : undefined}>{todo.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Notes</h3>
        {isStaff && (
          <div className={styles.addForm}>
            <label htmlFor="new-note">Add a note</label>
            <textarea id="new-note" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            <div className={styles.noteActions}>
              <button type="button" onClick={handleAddNote}>
                Post note
              </button>
              {!isRecording ? (
                <button type="button" onClick={handleStartRecording}>
                  Record voice note
                </button>
              ) : (
                <button type="button" onClick={handleStopRecording}>
                  Stop recording
                </button>
              )}
            </div>
          </div>
        )}
        {notes.length === 0 ? (
          <p>No notes yet.</p>
        ) : (
          <ul className={styles.notesList}>
            {notes.map((note) => (
              <li key={note.id}>
                {note.note_text && <p>{note.note_text}</p>}
                {note.voice_note_path && <p>Voice note recorded.</p>}
                <span className={styles.timestamp}>{new Date(note.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

`components/notes/NotesFeed.module.css`:
```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.addForm {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 28rem;
  margin-bottom: 1rem;
}

.addForm input,
.addForm textarea {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.noteActions {
  display: flex;
  gap: 0.5rem;
}

.addForm button {
  align-self: flex-start;
  background: var(--color-accent);
  color: #fff;
  border: none;
  padding: 0.5rem 1.25rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
}

.todoList,
.notesList,
.timeList {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.done {
  text-decoration: line-through;
  color: var(--color-muted);
}

.timestamp {
  color: var(--color-muted);
  font-size: 0.8rem;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest components/notes/NotesFeed.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts components/notes
git commit -m "Add Notes and Follow-ups feed with voice notes, todos, and time entries"
```

---

## Task 3: Admin API routes and guard

**Files:**
- Modify: `lib/admin-guard.ts`
- Create: `app/api/admin/users/route.ts`
- Create: `app/api/admin/users/[id]/route.ts`

**Interfaces:**
- Consumes: `createClient` (server) from `@/lib/supabase/server`, `createAdminClient` from `@/lib/supabase/admin` (both existing from Phase 1). Existing `requireCompanyAccess` in `lib/admin-guard.ts` is untouched.
- Produces: `requireStaff()` (added to `lib/admin-guard.ts`, alongside the existing `requireCompanyAccess`); `GET /api/admin/users` → list of profiles with company info; `POST /api/admin/users` (body: `email`, `password`, `role`, `companyId` — required when `role` is `'client'`) → creates an auth user + profile; `DELETE /api/admin/users/[id]` — consumed by `AdminUsers` in Task 4 of this phase.

- [ ] **Step 1: Read the existing `lib/admin-guard.ts`**

Read the file in full before editing — it currently contains only `requireCompanyAccess`. Add `requireStaff` as a new export in the same file; do not modify `requireCompanyAccess`.

- [ ] **Step 2: Add `requireStaff` to `lib/admin-guard.ts`**

Append to the end of the existing `lib/admin-guard.ts`:
```ts
type StaffGuardResult = { authorized: true; userId: string } | { authorized: false; status: number; message: string };

export async function requireStaff(): Promise<StaffGuardResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { authorized: false, status: 401, message: 'Not signed in.' };
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();

  if (profile?.role !== 'staff') {
    return { authorized: false, status: 403, message: 'Staff access required.' };
  }

  return { authorized: true, userId: user.id };
}
```

- [ ] **Step 3: Write the users list/create route**

`app/api/admin/users/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET() {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, email, role, company_id, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ users: data });
}

export async function POST(request: NextRequest) {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const body = await request.json();
  const { email, password, role, companyId } = body as {
    email?: string;
    password?: string;
    role?: string;
    companyId?: string;
  };

  if (!email || !password || (role !== 'client' && role !== 'staff')) {
    return NextResponse.json({ error: 'email, password, and a valid role are required.' }, { status: 400 });
  }
  if (role === 'client' && !companyId) {
    return NextResponse.json({ error: 'companyId is required for client accounts.' }, { status: 400 });
  }

  const adminClient = createAdminClient();
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    return NextResponse.json({ error: createError?.message ?? 'Could not create the user.' }, { status: 500 });
  }

  const { error: profileError } = await adminClient
    .from('profiles')
    .update({ role, company_id: role === 'client' ? companyId : null })
    .eq('id', created.user.id);

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ id: created.user.id, email, role, companyId: role === 'client' ? companyId : null });
}
```

- [ ] **Step 4: Write the user-delete route**

`app/api/admin/users/[id]/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function DELETE(_request: Request, context: RouteContext<'/api/admin/users/[id]'>) {
  const guard = await requireStaff();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { id } = await context.params;

  const adminClient = createAdminClient();
  const { error } = await adminClient.auth.admin.deleteUser(id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
```

Note: `RouteContext<'/api/admin/users/[id]'>` is the typed async-params helper this Next.js version generates — confirm the exact type name against `node_modules/next/dist/docs/` (Route Handlers page) if the build reports a type error; this mirrors the pattern already used in the training portal's `app/api/portal/admin/users/[id]/route.ts`.

- [ ] **Step 5: Verify the routes type-check**

Run: `npx tsc --noEmit` — expect no errors. There are no dedicated route-handler tests here, matching the Phase 1 `app/api/upload/route.ts` precedent (thin, guard-delegating routes verified end-to-end in Task 6 rather than unit-tested in isolation).

- [ ] **Step 6: Commit**

```bash
git add lib/admin-guard.ts app/api/admin
git commit -m "Add staff admin API routes for user management"
```

---

## Task 4: Admin UI — companies and users

**Files:**
- Create: `components/admin/AdminCompanies.tsx`
- Create: `components/admin/AdminCompanies.module.css`
- Create: `components/admin/AdminCompanies.test.tsx`
- Create: `components/admin/AdminUsers.tsx`
- Create: `components/admin/AdminUsers.module.css`
- Create: `components/admin/AdminUsers.test.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client` (for `AdminCompanies`'s list+create, which only touches `companies` and is covered by existing RLS — no new API route needed for companies, matching the pattern that `profiles_insert` is staff-gated by RLS already); `fetch('/api/admin/users', ...)` (Task 3, for `AdminUsers`); `Company` type from `@/lib/types`.
- Produces: `AdminCompanies` (default export, no props), `AdminUsers` (default export, no props) — both consumed together by `AppShell` in Task 5 of this phase.

- [ ] **Step 1: Write the failing test for `AdminCompanies`**

`components/admin/AdminCompanies.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminCompanies from './AdminCompanies';

const listCompanies = jest.fn();
const insertCompany = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }),
      insert: (...args: unknown[]) => insertCompany(...args),
    }),
  }),
}));

describe('AdminCompanies', () => {
  beforeEach(() => {
    listCompanies.mockReset().mockResolvedValue({
      data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }],
    });
    insertCompany.mockReset().mockReturnValue(Promise.resolve({ error: null }));
  });

  it('lists existing companies', async () => {
    render(<AdminCompanies />);
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  });

  it('creates a new company', async () => {
    const user = userEvent.setup();
    render(<AdminCompanies />);

    await screen.findByText('Acme Corp');
    await user.type(screen.getByLabelText(/company name/i), 'Globex');
    await user.click(screen.getByRole('button', { name: /create company/i }));

    await waitFor(() => expect(insertCompany).toHaveBeenCalledWith(expect.objectContaining({ name: 'Globex' })));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/admin/AdminCompanies.test.tsx`
Expected: FAIL — `Cannot find module './AdminCompanies'`.

- [ ] **Step 3: Write `AdminCompanies`**

`components/admin/AdminCompanies.tsx`:
```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company } from '@/lib/types';
import styles from './AdminCompanies.module.css';

export default function AdminCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);

  const loadCompanies = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
    setCompanies(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  async function handleCreate() {
    if (!name.trim()) return;
    const supabase = createClient();
    await supabase.from('companies').insert({ name: name.trim() });
    setName('');
    loadCompanies();
  }

  return (
    <div className={styles.wrapper}>
      <h3>Companies</h3>
      <div className={styles.addForm}>
        <label htmlFor="new-company-name">Company name</label>
        <input id="new-company-name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={handleCreate}>
          Create company
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : companies.length === 0 ? (
        <p>No companies yet.</p>
      ) : (
        <ul className={styles.list}>
          {companies.map((company) => (
            <li key={company.id}>{company.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`components/admin/AdminCompanies.module.css`:
```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.addForm {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
}

.addForm input {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.addForm button {
  background: var(--color-accent);
  color: #fff;
  border: none;
  padding: 0.5rem 1.25rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/admin/AdminCompanies.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for `AdminUsers`**

`components/admin/AdminUsers.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminUsers from './AdminUsers';

const listCompanies = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }),
    }),
  }),
}));

describe('AdminUsers', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    listCompanies.mockReset().mockResolvedValue({
      data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }],
    });
  });

  it('lists existing users with their role and company', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 'u1', email: 'client@example.com', role: 'client', company_id: 'c1', created_at: '2026-07-01T00:00:00.000Z' }],
      }),
    });

    render(<AdminUsers />);

    expect(await screen.findByText('client@example.com')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('creates a new client user tied to a company', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'u2', email: 'new@example.com', role: 'client', companyId: 'c1' }) });

    const user = userEvent.setup();
    render(<AdminUsers />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/admin/users'));

    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.selectOptions(screen.getByLabelText(/company/i), 'c1');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest components/admin/AdminUsers.test.tsx`
Expected: FAIL — `Cannot find module './AdminUsers'`.

- [ ] **Step 7: Write `AdminUsers`**

`components/admin/AdminUsers.tsx`:
```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company, Profile } from '@/lib/types';
import styles from './AdminUsers.module.css';

export default function AdminUsers() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'client' | 'staff'>('client');
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const response = await fetch('/api/admin/users');
    const body = await response.json();
    setUsers(body.users ?? []);
    setLoading(false);
  }, []);

  const loadCompanies = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
    setCompanies(data ?? []);
    if (data && data.length > 0) setCompanyId(data[0].id);
  }, []);

  useEffect(() => {
    loadUsers();
    loadCompanies();
  }, [loadUsers, loadCompanies]);

  function companyName(id: string | null): string {
    if (!id) return '—';
    return companies.find((c) => c.id === id)?.name ?? id;
  }

  async function handleCreate() {
    setError(null);
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, role, companyId: role === 'client' ? companyId : undefined }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Could not create the user.');
      return;
    }
    setEmail('');
    setPassword('');
    loadUsers();
  }

  return (
    <div className={styles.wrapper}>
      <h3>Users</h3>
      <div className={styles.addForm}>
        <label htmlFor="new-user-email">Email</label>
        <input id="new-user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

        <label htmlFor="new-user-password">Password</label>
        <input id="new-user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />

        <label htmlFor="new-user-role">Role</label>
        <select id="new-user-role" value={role} onChange={(e) => setRole(e.target.value as 'client' | 'staff')}>
          <option value="client">Client</option>
          <option value="staff">Staff</option>
        </select>

        {role === 'client' && (
          <>
            <label htmlFor="new-user-company">Company</label>
            <select id="new-user-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </>
        )}

        {error && <p role="alert">{error}</p>}

        <button type="button" onClick={handleCreate}>
          Create user
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : users.length === 0 ? (
        <p>No users yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Company</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{companyName(u.company_id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

`components/admin/AdminUsers.module.css`:
```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.addForm {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 24rem;
}

.addForm input,
.addForm select {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.addForm button {
  align-self: flex-start;
  background: var(--color-accent);
  color: #fff;
  border: none;
  padding: 0.5rem 1.25rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx jest components/admin/AdminUsers.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add components/admin
git commit -m "Add Admin tab: company and user management"
```

---

## Task 5: Wire Notes & Follow-ups and Admin tabs into the app shell

**Files:**
- Modify: `components/shell/AppShell.tsx`
- Modify: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: `NotesFeed` from `../notes/NotesFeed` (Task 2), `AdminCompanies` from `../admin/AdminCompanies`, `AdminUsers` from `../admin/AdminUsers` (both Task 4).
- Produces: no new exports — `AppShell`'s props are unchanged from Phases 1-2 (`{ userId: string; role: ProfileRole; companyId: string | null }`). This is the final planned modification to `AppShell.tsx` across all three phases.

- [ ] **Step 1: Read the current `AppShell.tsx` and its test**

Read both files in full — after Phase 2, the tab list is `aws | azure | compare | files`. This task adds `notes` (available to everyone) and `admin` (staff-only).

- [ ] **Step 2: Extend the failing test first**

Add these mocks alongside the existing ones at the top of `components/shell/AppShell.test.tsx`:
```tsx
jest.mock('./../notes/NotesFeed', () => ({
  __esModule: true,
  default: ({ isStaff }: { isStaff: boolean }) => <div>notes-feed-content isStaff={String(isStaff)}</div>,
}));
jest.mock('./../admin/AdminCompanies', () => ({
  __esModule: true,
  default: () => <div>admin-companies-content</div>,
}));
jest.mock('./../admin/AdminUsers', () => ({
  __esModule: true,
  default: () => <div>admin-users-content</div>,
}));
```

Add these two tests inside the existing `describe('AppShell', ...)` block:
```tsx
  it('shows the Notes & Follow-ups tab for a client, but not the Admin tab', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(screen.getByText('notes-feed-content isStaff=false')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows the Admin tab for staff, with Notes marked isStaff=true', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="staff-1" role="staff" companyId={null} />);

    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(screen.getByText('notes-feed-content isStaff=true')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /admin/i }));
    expect(screen.getByText('admin-companies-content')).toBeInTheDocument();
    expect(screen.getByText('admin-users-content')).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: the pre-existing tests still PASS; the two new tests FAIL because there's no "Notes" or "Admin" tab yet.

- [ ] **Step 4: Extend `AppShell.tsx`**

Change:
```tsx
type TabKey = 'aws' | 'azure' | 'compare' | 'files';
```
to:
```tsx
type TabKey = 'aws' | 'azure' | 'compare' | 'files' | 'notes' | 'admin';
```

Add the imports alongside the existing ones:
```tsx
import NotesFeed from '../notes/NotesFeed';
import AdminCompanies from '../admin/AdminCompanies';
import AdminUsers from '../admin/AdminUsers';
```

The component currently destructures `{ role, companyId }` from props — it needs `userId` too for `NotesFeed`. Change the function signature from:
```tsx
export default function AppShell({ role, companyId }: AppShellProps) {
```
to:
```tsx
export default function AppShell({ userId, role, companyId }: AppShellProps) {
```

In the `role="tablist"` block, add the "Notes & Follow-ups" tab after "Uploaded Files", and the "Admin" tab last, gated on `role === 'staff'`:
```tsx
        <button type="button" role="tab" aria-selected={activeTab === 'notes'} onClick={() => setActiveTab('notes')}>
          Notes & Follow-ups
        </button>
        {role === 'staff' && (
          <button type="button" role="tab" aria-selected={activeTab === 'admin'} onClick={() => setActiveTab('admin')}>
            Admin
          </button>
        )}
```

In the panel-switch block, add:
```tsx
            {activeTab === 'notes' && (
              <NotesFeed companyId={effectiveCompanyId} userId={userId} isStaff={role === 'staff'} />
            )}
            {activeTab === 'admin' && role === 'staff' && (
              <div className={styles.adminSections}>
                <AdminCompanies />
                <AdminUsers />
              </div>
            )}
```

Note the Admin panel does not depend on `effectiveCompanyId` (company/user management is cross-company) — place it outside the `!effectiveCompanyId ? <p>Select a company...</p> : (...)` guard that wraps the other panels, so staff can reach Admin even before selecting a company. Read the existing conditional structure carefully before making this change — it may require restructuring the guard slightly (e.g., checking `activeTab === 'admin'` before the `!effectiveCompanyId` check) rather than a blind insertion.

Add to `AppShell.module.css`:
```css
.adminSections {
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
}
```

- [ ] **Step 5: Run the tests to verify they all pass**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: PASS (all tests — the full accumulated suite from Phases 1, 2, and this task).

- [ ] **Step 6: Verify the full pipeline**

Run: `npx tsc --noEmit` — expect no errors.
Run: `npm test` — expect all tests passing across the whole project.
Run: `npm run lint` — expect no errors.
Run: `npm run build` — expect a successful production build.

- [ ] **Step 7: Commit**

```bash
git add components/shell/AppShell.tsx components/shell/AppShell.module.css components/shell/AppShell.test.tsx
git commit -m "Add Notes & Follow-ups and Admin tabs to the app shell"
```

---

## Task 6: Manual verification and final deployment

**Files:** none (verification and deployment only).

- [ ] **Step 1: Manual end-to-end pass, this time using the real Admin UI**

Run `npm run dev`, sign in as the existing staff test account (from Phase 1/2's manual bootstrap):

1. Go to the new Admin tab. Confirm the existing "Test Company" (created via SQL in Phase 1) appears in Companies.
2. Create a brand-new company through the UI, e.g. "Initech".
3. Create a new staff user through the UI (role: staff, no company).
4. Create a new client user through the UI tied to "Initech" (role: client, company: Initech).
5. Sign out, sign in as the new client user — confirm they land on a dashboard scoped to "Initech" with no data yet (clean slate, proving multi-tenancy isolation from "Test Company").
6. Sign back in as staff, switch the company switcher to "Initech", upload an AWS file for it, confirm it shows up correctly in that company's AWS tab only (not in "Test Company"'s).
7. As staff, go to Notes & Follow-ups for "Initech": post a text note, record and post a voice note (grant microphone permission when prompted), add a todo, then toggle it done. Log time is deferred to a follow-up if no `time_entries` insert UI was built in Task 2 — if so, insert a `time_entries` row via `mcp__supabase__execute_sql` for verification purposes and confirm it displays; note this UI gap to the user afterward rather than silently leaving it unverified.
8. Sign out, sign in as the "Initech" client user — confirm the note, voice note (playable), todo (marked done), and time entry are all visible in their own Notes & Follow-ups tab, and that they cannot see or edit the add-note/add-todo forms (client, not staff).
9. Confirm the original "Test Company" client (from Phase 1/2) still sees only their own data, unaffected by anything done for "Initech".

If anything fails, fix it and re-run the affected steps before deploying.

- [ ] **Step 2: Deploy**

Push the branch and confirm the production Vercel deployment builds successfully. Re-run the Step 1 verification pass (or at minimum steps 5-9) against the production URL.

- [ ] **Step 3: Report completion**

Summarize to the user that all three phases of Phase 1 of the overall product roadmap are complete and deployed: login, multi-tenant AWS/Azure billing upload and reporting, cross-cloud comparison, and the staff review workflow (notes/voice notes/todos/time-tracking) with a full Admin UI for company and user management. Remind them that subscription billing (product-roadmap Phase 2) and AI-driven automation (product-roadmap Phase 3) remain explicitly out of scope until specced separately, per the original design spec's Future Work section.
