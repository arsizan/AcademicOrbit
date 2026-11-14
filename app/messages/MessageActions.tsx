"use client";

/*
 * 14 Nov 2026: message actions in Messages.
 *   - MessageMenu: the "..." button next to a message: Edit (own message,
 *     first 5 minutes), Pin / Unpin, Delete for me, Delete for everyone (own).
 *   - MessageEditor: the text box that replaces a message while it is edited.
 *   - PinnedBar: the pinned messages of the chat, under the chat header.
 * The rules are checked again by the database
 * (supabase/migrations/20261114000000_message_actions.sql).
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, MoreHorizontal, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import { notify } from "@/lib/feedback";
import type { MessageRow } from "./UI";

export const EDIT_WINDOW_MS = 5 * 60 * 1000;

/** A message that is still being sent has no actions yet. */
export function isSavedMessage(message: MessageRow) {
  return !message.id.startsWith("temp-");
}

/** Own text message sent less than 5 minutes ago. */
export function canEditMessage(message: MessageRow, userId: string, now = Date.now()) {
  if (!userId || message.sender_id !== userId || !message.body || !message.created_at || !isSavedMessage(message)) {
    return false;
  }
  const sent = new Date(message.created_at).getTime();
  return Number.isFinite(sent) && now - sent < EDIT_WINDOW_MS;
}

/** The element id of a message in the chat (the pinned bar jumps to it). */
export const messageElementId = (messageId: string) => `message-${messageId}`;

type MessageMenuProps = {
  message: MessageRow;
  userId: string;
  onEdit: () => void;
  onTogglePin: () => void;
  onDeleteForMe: () => void;
  onDeleteForEveryone: () => void;
};

const MENU_GAP = 4;
const EDGE = 4;

export function MessageMenu({
  message,
  userId,
  onEdit,
  onTogglePin,
  onDeleteForMe,
  onDeleteForEveryone,
}: MessageMenuProps) {
  const [open, setOpen] = useState(false);
  // Worked out when the menu opens, so "Edit" goes away after 5 minutes.
  const [canEdit, setCanEdit] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mine = message.sender_id === userId;

  // Place the menu inside the chat area (never cut off at its edges): above
  // the button when there is room, otherwise below it.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    const holder = button?.parentElement;
    if (!open || !button || !menu || !holder) return;

    const area =
      button.closest("[data-message-scroll]")?.getBoundingClientRect() ??
      new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const b = button.getBoundingClientRect();
    const h = holder.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;

    const preferredLeft = mine ? b.left : b.right - width;
    const left = Math.max(area.left + EDGE, Math.min(preferredLeft, area.right - width - EDGE));
    const roomAbove = b.top - area.top;
    const roomBelow = area.bottom - b.bottom;
    const above = roomAbove >= height + MENU_GAP || roomAbove > roomBelow;

    menu.style.left = `${left - h.left}px`;
    menu.style.top = above ? `${b.top - h.top - height - MENU_GAP}px` : `${b.bottom - h.top + MENU_GAP}px`;
  }, [open, mine, canEdit]);

  // Escape or a press outside closes the menu.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Up / Down / Home / End move between the menu items.
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Tab") {
      // Leave the menu: Tab goes on from the "..." button.
      setOpen(false);
      buttonRef.current?.focus();
    }
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  };

  const toggle = () => {
    if (!open) setCanEdit(canEditMessage(message, userId));
    setOpen((value) => !value);
  };

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const item =
    "w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm whitespace-nowrap transition-colors hover:bg-muted focus:bg-muted focus:outline-none";

  return (
    <div className="relative flex-shrink-0 self-center">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label="Message options"
        aria-haspopup="menu"
        aria-expanded={open}
        // Always shown on touch screens; with a mouse it shows when the
        // message is pointed at (or the button has keyboard focus).
        className={`rounded-lg p-1.5 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 ${
          open
            ? "bg-muted text-foreground"
            : "[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/message:opacity-100"
        }`}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Message options"
          onKeyDown={moveFocus}
          className="absolute left-0 top-0 z-30 w-max min-w-[11rem] overflow-hidden rounded-xl border border-border bg-card py-1 shadow-xl"
        >
          {canEdit && (
            <button type="button" role="menuitem" onClick={choose(onEdit)} className={`${item} text-foreground`}>
              <Pencil className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Edit
            </button>
          )}
          <button type="button" role="menuitem" onClick={choose(onTogglePin)} className={`${item} text-foreground`}>
            {message.pinned_at ? (
              <PinOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Pin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
            {message.pinned_at ? "Unpin" : "Pin"}
          </button>
          <button type="button" role="menuitem" onClick={choose(onDeleteForMe)} className={`${item} text-foreground`}>
            <Trash2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Delete for me
          </button>
          {mine && (
            <button type="button" role="menuitem" onClick={choose(onDeleteForEveryone)} className={`${item} text-red-700`}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete for everyone
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type MessageEditorProps = {
  initialText: string;
  saving: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
};

export function MessageEditor({ initialText, saving, onSave, onCancel }: MessageEditorProps) {
  const [text, setText] = useState(initialText);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canSave = Boolean(text.trim()) && text.trim() !== initialText.trim() && !saving;
  // Grows with the text, up to 8 lines (then it scrolls).
  const rows = Math.min(8, Math.max(2, text.split("\n").length + Math.floor(text.length / 45)));

  // Start with the cursor after the text.
  useEffect(() => {
    const box = textRef.current;
    if (!box) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  // Keep the whole editor in view (clear of the assistant's round button,
  // scroll-mb-24) when it opens and while it grows.
  useEffect(() => {
    boxRef.current?.scrollIntoView({ block: "nearest" });
  }, [rows]);

  return (
    <div ref={boxRef} className="w-full scroll-mt-4 scroll-mb-24 rounded-2xl border border-primary/40 bg-card p-2 shadow-sm">
      <textarea
        ref={textRef}
        aria-label="Edit message"
        value={text}
        maxLength={4000}
        rows={rows}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSave) onSave(text);
          }
        }}
        className="w-full resize-none rounded-xl bg-muted px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(text)}
          disabled={!canSave}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

type PinnedBarProps = {
  /** Oldest pin first. */
  pinned: MessageRow[];
  onUnpin: (message: MessageRow) => void;
};

/** One pinned message at a time (newest first); a tap jumps to it and shows the next one. */
export function PinnedBar({ pinned, onUnpin }: PinnedBarProps) {
  const [step, setStep] = useState(0);
  if (pinned.length === 0) return null;

  const position = step % pinned.length;
  const shown = pinned[pinned.length - 1 - position];
  const text = shown.body || shown.attachment_name || "Attachment";

  const jump = () => {
    const target = document.getElementById(messageElementId(shown.id));
    if (target) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
      // A short yellow glow shows which message it is.
      target.animate?.(
        [{ backgroundColor: "rgba(251, 191, 36, 0.3)" }, { backgroundColor: "rgba(251, 191, 36, 0)" }],
        { duration: 1600, easing: "ease-out" },
      );
    } else {
      notify("This pinned message is further up. Use \"Load older messages\" to see it.", "info");
    }
    setStep((value) => value + 1);
  };

  return (
    <div className="flex items-center gap-1 border-b border-border bg-amber-50 px-3 py-1.5 flex-shrink-0">
      <button
        type="button"
        onClick={jump}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-sm hover:bg-amber-100"
        title="Show it in the chat"
      >
        <Pin className="h-4 w-4 flex-shrink-0 text-amber-700" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          <span className="font-semibold text-amber-800">
            Pinned{pinned.length > 1 ? ` ${position + 1}/${pinned.length}` : ""}:
          </span>{" "}
          {text}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onUnpin(shown)}
        className="flex-shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
      >
        Unpin
      </button>
    </div>
  );
}
