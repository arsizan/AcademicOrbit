// 14 Nov 2026: browser tests for the message actions in Messages: edit (own
// message, first 5 minutes), delete for me, delete for everyone, pin.
import { uid } from './fake-supabase.mjs';
import { accessibilityProblems, expect, rpcCalls, signIn, test } from './helpers.mjs';

const CHAT_1 = uid(501);

async function openChat(app) {
  await app.goto('/messages');
  await app.getByRole('button', { name: /Researcher 2\b/ }).first().click();
  await expect(app.getByLabel('Message', { exact: true })).toBeVisible();
}

const bubble = (app, text) => app.locator('p.whitespace-pre-wrap', { hasText: text });
const row = (app, text) => app.locator('[id^="message-"]').filter({ has: bubble(app, text) });
const menu = (app) => app.getByRole('menu', { name: 'Message options' });
const confirmBox = (app) => app.getByRole('alertdialog');

async function openMenu(app, text) {
  await row(app, text).hover();
  await row(app, text).getByRole('button', { name: 'Message options' }).click();
  await expect(menu(app)).toBeVisible();
  return menu(app);
}

test.beforeEach(async ({ context, db }) => {
  await signIn(context, db);
});

test('a message I just sent can be edited, and then shows "Edited"', async ({ app, db }) => {
  await openChat(app);
  await app.getByLabel('Message', { exact: true }).fill('Fresh message');
  await app.getByRole('button', { name: 'Send message' }).click();
  await expect(bubble(app, 'Fresh message')).toBeVisible();

  const options = await openMenu(app, 'Fresh message');
  await expect(options.getByRole('menuitem')).toHaveText(['Edit', 'Pin', 'Delete for me', 'Delete for everyone']);
  expect(await accessibilityProblems(app)).toEqual([]);
  await options.getByRole('menuitem', { name: 'Edit' }).click();

  const box = app.getByLabel('Edit message');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('Fresh message');
  await box.fill('Fixed message');
  await box.press('Enter');

  await expect(bubble(app, 'Fixed message')).toBeVisible();
  await expect(row(app, 'Fixed message')).toContainText('Edited');
  await expect(box).toHaveCount(0);
  expect(rpcCalls(db, 'edit_message').map((c) => c.args.p_body)).toEqual(['Fixed message']);
  expect(db.tables.messages.find((m) => m.body === 'Fixed message')).toMatchObject({ conversation_id: CHAT_1, sender_id: db.U });
});

test('Escape stops editing without saving', async ({ app, db }) => {
  await openChat(app);
  await app.getByLabel('Message', { exact: true }).fill('Keep me');
  await app.getByRole('button', { name: 'Send message' }).click();
  await (await openMenu(app, 'Keep me')).getByRole('menuitem', { name: 'Edit' }).click();
  await app.getByLabel('Edit message').fill('Changed');
  await app.getByLabel('Edit message').press('Escape');
  await expect(app.getByLabel('Edit message')).toHaveCount(0);
  await expect(bubble(app, 'Keep me')).toBeVisible();
  expect(rpcCalls(db, 'edit_message')).toHaveLength(0);
});

test('older messages cannot be edited; only my own can be deleted for everyone', async ({ app }) => {
  await openChat(app);
  // Mine, sent long ago.
  await expect((await openMenu(app, 'Chat 1 message 2')).getByRole('menuitem')).toHaveText(['Pin', 'Delete for me', 'Delete for everyone']);
  await app.keyboard.press('Escape');
  await expect(menu(app)).toHaveCount(0);
  // From the other person.
  await expect((await openMenu(app, 'Chat 1 message 3')).getByRole('menuitem')).toHaveText(['Pin', 'Delete for me']);
});

test('delete for me asks first, then hides the message only for me', async ({ app, db }) => {
  await openChat(app);
  await (await openMenu(app, 'Chat 1 message 3')).getByRole('menuitem', { name: 'Delete for me' }).click();
  await expect(confirmBox(app)).toContainText('Delete for you?');
  await confirmBox(app).getByRole('button', { name: 'Delete for me' }).click();

  await expect(bubble(app, 'Chat 1 message 3')).toHaveCount(0);
  expect(db.tables.message_hidden).toEqual([expect.objectContaining({ user_id: db.U, conversation_id: CHAT_1 })]);
  // Still there for the other person.
  expect(db.tables.messages.find((m) => m.body === 'Chat 1 message 3').is_deleted).toBe(false);

  // Stays hidden after a reload.
  await openChat(app);
  await expect(bubble(app, 'Chat 1 message 2')).toBeVisible();
  await expect(bubble(app, 'Chat 1 message 3')).toHaveCount(0);
});

test('delete for everyone asks first; Cancel keeps the message', async ({ app, db }) => {
  await openChat(app);
  await (await openMenu(app, 'Chat 1 message 2')).getByRole('menuitem', { name: 'Delete for everyone' }).click();
  await expect(confirmBox(app)).toContainText('Delete for everyone?');
  await confirmBox(app).getByRole('button', { name: 'Cancel' }).click();
  await expect(bubble(app, 'Chat 1 message 2')).toBeVisible();
  expect(rpcCalls(db, 'delete_message_for_everyone')).toHaveLength(0);

  await (await openMenu(app, 'Chat 1 message 2')).getByRole('menuitem', { name: 'Delete for everyone' }).click();
  await confirmBox(app).getByRole('button', { name: 'Delete for everyone' }).click();
  await expect(bubble(app, 'Chat 1 message 2')).toHaveCount(0);
  const gone = db.tables.messages.find((m) => m.id === uid(1012));
  expect(gone).toMatchObject({ is_deleted: true, body: null });
});

test('pinning shows the message in the pinned bar; Unpin there removes it', async ({ app, db }) => {
  await openChat(app);
  await (await openMenu(app, 'Chat 1 message 1')).getByRole('menuitem', { name: 'Pin' }).click();
  const pinned = app.getByRole('button', { name: /^Pinned: Chat 1 message 1/ });
  await expect(pinned).toBeVisible();
  expect(db.tables.messages.find((m) => m.body === 'Chat 1 message 1').pinned_by).toBe(db.U);

  // A second pin: the newest is shown first, the bar counts them.
  await (await openMenu(app, 'Chat 1 message 3')).getByRole('menuitem', { name: 'Pin' }).click();
  await expect(app.getByRole('button', { name: /^Pinned 1\/2: Chat 1 message 3/ })).toBeVisible();
  // The menu now offers Unpin for it.
  await expect((await openMenu(app, 'Chat 1 message 3')).getByRole('menuitem', { name: 'Unpin' })).toBeVisible();
  await app.keyboard.press('Escape');
  expect(await accessibilityProblems(app)).toEqual([]);

  // A tap on the bar shows the next one.
  await app.getByRole('button', { name: /^Pinned 1\/2:/ }).click();
  await expect(app.getByRole('button', { name: /^Pinned 2\/2: Chat 1 message 1/ })).toBeVisible();

  await app.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(app.getByRole('button', { name: /^Pinned: Chat 1 message 3/ })).toBeVisible();
  await app.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(app.getByRole('button', { name: /^Pinned/ })).toHaveCount(0);
  expect(db.tables.messages.filter((m) => m.pinned_at)).toHaveLength(0);
});

test('the message menu works with the keyboard and stays inside the chat on a phone', async ({ app }) => {
  await app.setViewportSize({ width: 360, height: 740 });
  // On a phone the first chat opens by itself.
  await app.goto('/messages');
  await expect(app.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(bubble(app, 'Chat 1 message 3')).toBeVisible();
  for (const text of ['Chat 1 message 1', 'Chat 1 message 2', 'Chat 1 message 3']) {
    const button = row(app, text).getByRole('button', { name: 'Message options' });
    await button.focus();
    await app.keyboard.press('Enter');
    const items = menu(app).getByRole('menuitem');
    await expect(items.first()).toBeFocused();
    await app.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();

    const box = await menu(app).boundingBox();
    const area = await app.locator('[data-message-scroll]').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(area.x);
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
    expect(box.y).toBeGreaterThanOrEqual(area.y);
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);

    await app.keyboard.press('Escape');
    await expect(menu(app)).toHaveCount(0);
    await expect(button).toBeFocused();
  }
  // Nothing sticks out sideways.
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
