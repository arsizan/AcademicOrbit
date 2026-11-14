// 14 Nov 2026: the rules of the message actions (edit within 5 minutes,
// delete for me, delete for everyone, pin), checked as each kind of user.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, asUser, uid } from './harness.mjs';

let passed = 0;
const ok = () => { passed += 1; };

const db = await makeDb();
const as = asUser(db);
const one = async (sql) => (await db.query(sql)).rows[0];

const [A, B, C] = [uid(1), uid(2), uid(3)];
const [DM, NEW, OLD, BOBS] = [uid(501), uid(901), uid(902), uid(903)];

await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
  ('${A}','a@x.dev','{"full_name":"Alice"}'), ('${B}','b@x.dev','{"full_name":"Bob"}'), ('${C}','c@x.dev','{"full_name":"Carol"}');
  insert into public.conversations (id, participant_one_id, participant_two_id, conversation_type, created_by) values
    ('${DM}','${A}','${B}','direct','${A}');
  insert into public.conversation_members (conversation_id, user_id) values ('${DM}','${A}'), ('${DM}','${B}');
  insert into public.messages (id, conversation_id, sender_id, body, created_at) values
    ('${NEW}','${DM}','${A}','first try', now() - interval '1 minute'),
    ('${OLD}','${DM}','${A}','old one', now() - interval '6 minutes'),
    ('${BOBS}','${DM}','${B}','from Bob', now());`);

// Edit: own message, first 5 minutes only, never empty.
await as(A, `select public.edit_message('${NEW}', '  fixed text ')`);
const edited = await one(`select body, edited_at from public.messages where id = '${NEW}'`);
assert.equal(edited.body, 'fixed text'); assert.ok(edited.edited_at); ok();
await assert.rejects(as(A, `select public.edit_message('${OLD}', 'too late')`), /first 5 minutes/); ok();
await assert.rejects(as(B, `select public.edit_message('${NEW}', 'not mine')`), /only edit your own/); ok();
await assert.rejects(as(A, `select public.edit_message('${NEW}', '   ')`), /needs text/); ok();
// Editing by hand is still not allowed (only read_at can be changed directly).
await assert.rejects(as(A, `update public.messages set body = 'sneaky' where id = '${OLD}'`), /permission denied/); ok();
console.log('EDIT: own message, first 5 minutes, not empty; direct updates refused');

// Pin: any member; a stranger cannot.
await as(B, `select public.set_message_pinned('${NEW}', true)`);
assert.equal((await one(`select pinned_by from public.messages where id = '${NEW}'`)).pinned_by, B); ok();
await assert.rejects(as(C, `select public.set_message_pinned('${NEW}', false)`), /no longer exists/); ok();
await as(A, `select public.set_message_pinned('${NEW}', false)`);
assert.equal((await one(`select pinned_at from public.messages where id = '${NEW}'`)).pinned_at, null); ok();
console.log('PIN: members pin and unpin; outsiders cannot');

// Delete for me: hidden only for that person, who can read only their own list.
await as(B, `select public.hide_message_for_me('${NEW}')`);
await as(B, `select public.hide_message_for_me('${NEW}')`); // twice is fine
assert.equal((await as(B, `select count(*)::int n from public.message_hidden`))[0].n, 1); ok();
assert.equal((await as(A, `select count(*)::int n from public.message_hidden`))[0].n, 0, 'Alice does not see Bob\'s list'); ok();
await assert.rejects(as(C, `select public.hide_message_for_me('${NEW}')`), /no longer exists/); ok();
await assert.rejects(as(B, `insert into public.message_hidden (user_id, message_id) values ('${A}', '${OLD}')`), /permission denied/); ok();
await assert.rejects(as(null, `select public.hide_message_for_me('${NEW}')`), /permission denied/); ok();
// The app asks for one chat's list; the chat list skips the hidden message.
assert.equal((await as(B, `select count(*)::int n from public.message_hidden where conversation_id = '${DM}'`))[0].n, 1); ok();
await as(B, `select public.hide_message_for_me('${BOBS}')`);
const preview = async (user) => (await as(user, `select last_message_body b from public.my_conversation_summaries() where conversation_id = '${DM}'`))[0].b;
assert.equal(await preview(B), 'old one', 'Bob no longer sees his hidden messages as the last one'); ok();
assert.equal(await preview(A), 'from Bob', 'Alice still does'); ok();
console.log('DELETE FOR ME: only for the person who chose it; the chat list follows');

// Delete for everyone: own messages only; the text and file are gone.
await assert.rejects(as(A, `select public.delete_message_for_everyone('${BOBS}')`), /only delete your own/); ok();
await as(A, `select public.delete_message_for_everyone('${OLD}')`);
const gone = await one(`select is_deleted, body, message_text, deleted_at from public.messages where id = '${OLD}'`);
assert.equal(gone.is_deleted, true); assert.equal(gone.body, null); assert.equal(gone.message_text, null); assert.ok(gone.deleted_at); ok();
assert.equal((await as(A, `select public.delete_message_for_everyone('${OLD}') p`))[0].p, null, 'again: nothing to do'); ok();
await assert.rejects(as(A, `select public.edit_message('${OLD}', 'back')`), /no longer exists/); ok();
console.log('DELETE FOR EVERYONE: own messages only; text and attachment removed');

// Running the file again changes nothing.
const file = readFileSync(new URL('../../supabase/migrations/20261114000000_message_actions.sql', import.meta.url), 'utf8');
const before = await one(`select (select count(*) from public.message_hidden)::int h, (select count(*) from public.messages where edited_at is not null)::int e`);
await db.exec(file);
assert.deepEqual(await one(`select (select count(*) from public.message_hidden)::int h, (select count(*) from public.messages where edited_at is not null)::int e`), before); ok();
console.log('RERUN: second run keeps everything as it is');

console.log(`\nALL MESSAGE ACTION CHECKS PASSED: ${passed}`);
