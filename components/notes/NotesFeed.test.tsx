import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotesFeed from './NotesFeed';

const selectNotes = jest.fn();
const selectTodos = jest.fn();
const selectTimeEntries = jest.fn();
const insertNote = jest.fn();
const insertTodo = jest.fn();
const insertTimeEntry = jest.fn();
const updateTodo = jest.fn();
const createSignedUrl = jest.fn();

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
        insert: (...args: unknown[]) => insertTimeEntry(...args),
      };
    },
    storage: {
      from: () => ({
        createSignedUrl: (...args: unknown[]) => createSignedUrl(...args),
      }),
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
    insertTimeEntry.mockReset().mockReturnValue(Promise.resolve({ error: null }));
    updateTodo.mockReset();
    createSignedUrl
      .mockReset()
      .mockResolvedValue({ data: { signedUrl: 'https://signed.example/voice.webm' }, error: null });
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

  it('surfaces an error and keeps the draft when the note insert fails', async () => {
    insertNote.mockReturnValue(Promise.resolve({ error: { message: 'Insert rejected by RLS.' } }));

    const user = userEvent.setup();
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);

    await screen.findByText('Reviewed the July EC2 spike.');
    await user.type(screen.getByLabelText(/add a note/i), 'Draft that must survive');
    await user.click(screen.getByRole('button', { name: /post note/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Insert rejected by RLS.');
    expect(screen.getByLabelText(/add a note/i)).toHaveValue('Draft that must survive');
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

  it('lets staff log a time entry', async () => {
    const user = userEvent.setup();
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);

    await screen.findByText('Reviewed the July EC2 spike.');
    await user.clear(screen.getByLabelText(/^date$/i));
    await user.type(screen.getByLabelText(/^date$/i), '2026-08-01');
    await user.type(screen.getByLabelText(/minutes spent/i), '45');
    await user.type(screen.getByLabelText(/work description/i), 'Reviewed August Azure spend');
    await user.click(screen.getByRole('button', { name: /log time/i }));

    await waitFor(() =>
      expect(insertTimeEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          company_id: 'company-1',
          staff_id: 'staff-1',
          entry_date: '2026-08-01',
          minutes_spent: 45,
          description: 'Reviewed August Azure spend',
        })
      )
    );
  });

  it('shows a time-tracking total across loaded entries', async () => {
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);
    expect(await screen.findByText('30 min reviewed')).toBeInTheDocument();
  });

  it('renders a playable audio element for voice notes using a signed URL', async () => {
    selectNotes.mockResolvedValue({
      data: [
        {
          id: 'note-2',
          company_id: 'company-1',
          cost_record_id: null,
          author_id: 'staff-1',
          note_text: null,
          voice_note_path: 'company-1/1234.webm',
          created_at: '2026-07-16T00:00:00.000Z',
        },
      ],
    });

    const { container } = render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />);

    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    expect(container.querySelector('audio')).toHaveAttribute('src', 'https://signed.example/voice.webm');
    expect(createSignedUrl).toHaveBeenCalledWith('company-1/1234.webm', 3600);
  });

  it('hides the add-note and add-todo forms for non-staff users', async () => {
    render(<NotesFeed companyId="company-1" userId="client-1" isStaff={false} />);

    await screen.findByText('Reviewed the July EC2 spike.');
    expect(screen.queryByLabelText(/add a note/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new todo/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/minutes spent/i)).not.toBeInTheDocument();
  });
});
