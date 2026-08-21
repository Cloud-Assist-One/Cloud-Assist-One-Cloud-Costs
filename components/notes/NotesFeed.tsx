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
    async function load() {
      await loadAll();
    }
    load();
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
