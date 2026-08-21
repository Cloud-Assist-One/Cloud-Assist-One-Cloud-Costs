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

const SIGNED_URL_TTL_SECONDS = 3600;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// The voice-notes bucket is private, so each recording needs a short-lived
// signed URL before an <audio> element can play it.
async function resolveVoiceNoteUrls(notes: ReviewNote[]): Promise<Record<string, string>> {
  const paths = Array.from(
    new Set(notes.map((note) => note.voice_note_path).filter((path): path is string => Boolean(path)))
  );
  if (paths.length === 0) return {};

  const supabase = createClient();
  const entries = await Promise.all(
    paths.map(async (path) => {
      const { data } = await supabase.storage.from('voice-notes').createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      return [path, data?.signedUrl ?? null] as const;
    })
  );

  const resolved: Record<string, string> = {};
  for (const [path, url] of entries) {
    if (url) resolved[path] = url;
  }
  return resolved;
}

export default function NotesFeed({ companyId, userId, isStaff }: NotesFeedProps) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [todos, setTodos] = useState<ReviewTodo[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [todoTitle, setTodoTitle] = useState('');
  const [entryDate, setEntryDate] = useState(todayIso);
  const [minutesSpent, setMinutesSpent] = useState('');
  const [timeDescription, setTimeDescription] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const fetchAll = useCallback(async () => {
    const supabase = createClient();
    const [notesResult, todosResult, timeEntriesResult] = await Promise.all([
      supabase.from('review_notes').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
      supabase.from('review_todos').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
      supabase.from('time_entries').select('*').eq('company_id', companyId).order('entry_date', { ascending: false }),
    ]);
    return {
      notes: notesResult.data ?? [],
      todos: todosResult.data ?? [],
      timeEntries: timeEntriesResult.data ?? [],
    };
  }, [companyId]);

  const loadAll = useCallback(async () => {
    const result = await fetchAll();
    setNotes(result.notes);
    setTodos(result.todos);
    setTimeEntries(result.timeEntries);
    setLoading(false);
    setSignedUrls(await resolveVoiceNoteUrls(result.notes));
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const result = await fetchAll();
      if (cancelled) return;
      setNotes(result.notes);
      setTodos(result.todos);
      setTimeEntries(result.timeEntries);
      setLoading(false);

      const urls = await resolveVoiceNoteUrls(result.notes);
      if (!cancelled) {
        setSignedUrls(urls);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  // Unmounting mid-recording would otherwise leave the mic indicator lit.
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
    };
  }, []);

  const totalMinutes = timeEntries.reduce((sum, entry) => sum + (entry.minutes_spent ?? 0), 0);

  async function handleAddNote() {
    if (!noteText.trim()) return;
    setError(null);
    const supabase = createClient();
    const { error: insertError } = await supabase
      .from('review_notes')
      .insert({ company_id: companyId, author_id: userId, note_text: noteText.trim() });
    if (insertError) {
      setError(insertError.message ?? 'Could not save the note.');
      return;
    }
    setNoteText('');
    loadAll();
  }

  async function handleAddTodo() {
    if (!todoTitle.trim()) return;
    setError(null);
    const supabase = createClient();
    const { error: insertError } = await supabase
      .from('review_todos')
      .insert({ company_id: companyId, created_by: userId, title: todoTitle.trim() });
    if (insertError) {
      setError(insertError.message ?? 'Could not save the follow-up.');
      return;
    }
    setTodoTitle('');
    loadAll();
  }

  async function handleToggleTodo(todo: ReviewTodo) {
    setError(null);
    const supabase = createClient();
    const nextStatus = todo.status === 'open' ? 'done' : 'open';
    const { error: updateError } = await supabase
      .from('review_todos')
      .update({ status: nextStatus, completed_at: nextStatus === 'done' ? new Date().toISOString() : null })
      .eq('id', todo.id);
    if (updateError) {
      setError(updateError.message ?? 'Could not update the follow-up.');
      return;
    }
    loadAll();
  }

  async function handleAddTimeEntry() {
    const minutes = Number(minutesSpent);
    if (!entryDate || !Number.isFinite(minutes) || minutes <= 0 || !timeDescription.trim()) return;
    setError(null);
    const supabase = createClient();
    const { error: insertError } = await supabase.from('time_entries').insert({
      company_id: companyId,
      staff_id: userId,
      entry_date: entryDate,
      minutes_spent: minutes,
      description: timeDescription.trim(),
    });
    if (insertError) {
      setError(insertError.message ?? 'Could not log the time entry.');
      return;
    }
    setMinutesSpent('');
    setTimeDescription('');
    setEntryDate(todayIso());
    loadAll();
  }

  async function handleStartRecording() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access was blocked, so recording could not start.');
      return;
    }

    const recorder = new MediaRecorder(stream);
    audioChunksRef.current = [];
    recorder.ondataavailable = (event) => audioChunksRef.current.push(event.data);
    recorder.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const supabase = createClient();
      const storagePath = `${companyId}/${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage.from('voice-notes').upload(storagePath, blob);
      if (uploadError) {
        setError(uploadError.message ?? 'Could not upload the voice note.');
      } else {
        const { error: insertError } = await supabase
          .from('review_notes')
          .insert({ company_id: companyId, author_id: userId, voice_note_path: storagePath });
        if (insertError) {
          setError(insertError.message ?? 'Could not save the voice note.');
        } else {
          loadAll();
        }
      }
      stream.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    mediaStreamRef.current = stream;
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
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <section>
        <h3>Time reviewed</h3>
        <p className={styles.timeSummary}>{totalMinutes} min reviewed</p>
        {isStaff && (
          <div className={styles.addForm}>
            <label htmlFor="time-entry-date">Date</label>
            <input
              id="time-entry-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />

            <label htmlFor="time-entry-minutes">Minutes spent</label>
            <input
              id="time-entry-minutes"
              type="number"
              min="1"
              value={minutesSpent}
              onChange={(e) => setMinutesSpent(e.target.value)}
            />

            <label htmlFor="time-entry-description">Work description</label>
            <input
              id="time-entry-description"
              value={timeDescription}
              onChange={(e) => setTimeDescription(e.target.value)}
            />

            <button type="button" onClick={handleAddTimeEntry}>
              Log time
            </button>
          </div>
        )}
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
                {note.voice_note_path &&
                  (signedUrls[note.voice_note_path] ? (
                    <audio controls src={signedUrls[note.voice_note_path]} className={styles.audio}>
                      Your browser does not support audio playback.
                    </audio>
                  ) : (
                    <p>Voice note recorded.</p>
                  ))}
                <span className={styles.timestamp}>{new Date(note.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
