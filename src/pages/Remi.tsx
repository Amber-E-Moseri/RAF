import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client";
import { getRemiConversation, listRemiConversations, sendRemiMessage } from "../api/remiApi";
import type { RemiConversation, RemiMessage } from "../api/remiApi";
import { PageShell } from "../components/layout/PageShell";
import { useAuth } from "../context/AuthContext";

// ─── Inline markdown renderer ─────────────────────────────────────────────────

function parseInline(text: string, prefix = ""): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(text.slice(last, m.index));
    if (m[1] != null) tokens.push(<strong key={`${prefix}b${n++}`}>{m[1]}</strong>);
    else if (m[2] != null) tokens.push(
      <code key={`${prefix}c${n++}`} className="rounded bg-[var(--surface-muted)] px-1 py-0.5 font-mono text-[0.82em]">
        {m[2]}
      </code>,
    );
    else if (m[3] != null) tokens.push(<em key={`${prefix}e${n++}`}>{m[3]}</em>);
    last = re.lastIndex;
  }

  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

function RemiMarkdown({ content }: { content: string }) {
  const chunks = content.split(/\n{2,}/);
  const nodes: React.ReactNode[] = [];

  chunks.forEach((chunk, ci) => {
    const lines = chunk.split("\n").filter((l) => l !== "");
    if (!lines.length) return;

    const firstLine = lines[0];

    // Heading
    const hm = firstLine.match(/^(#{1,3})\s+(.+)$/);
    if (hm && lines.length === 1) {
      const level = hm[1].length;
      const cls =
        level === 1
          ? "text-[15px] font-bold leading-snug text-[var(--text-primary)]"
          : "text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]";
      nodes.push(<p key={ci} className={cls}>{parseInline(hm[2], `h${ci}`)}</p>);
      return;
    }

    // List block (majority of lines are bullet items)
    const bulletLines = lines.filter((l) => /^[-*]\s+/.test(l));
    if (bulletLines.length >= Math.ceil(lines.length * 0.75)) {
      nodes.push(
        <ul key={ci} className="space-y-1.5">
          {lines.map((line, li) => {
            const im = line.match(/^[-*]\s+(.+)$/);
            if (!im) return null;
            return (
              <li key={li} className="flex gap-2 text-[14px] leading-[1.65]">
                <span
                  className="mt-[0.45em] h-[5px] w-[5px] shrink-0 rounded-full"
                  style={{ background: "var(--theme-primary)" }}
                />
                <span className="min-w-0">{parseInline(im[1], `li${ci}-${li}`)}</span>
              </li>
            );
          })}
        </ul>,
      );
      return;
    }

    // Paragraph (possibly multi-line with soft line breaks)
    nodes.push(
      <p key={ci} className="text-[14px] leading-[1.7] text-[var(--text-primary)]">
        {lines.flatMap((line, li) => [
          ...(li > 0 ? [<br key={`br-${ci}-${li}`} />] : []),
          ...parseInline(line, `p${ci}-${li}`),
        ])}
      </p>,
    );
  });

  return <div className="space-y-3">{nodes}</div>;
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5">
      <RemiAvatar />
      <div
        className="flex items-center gap-1.5 rounded-[1.25rem] rounded-bl-[0.35rem] px-4 py-3"
        style={{ background: "var(--surface-muted)" }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-[6px] w-[6px] rounded-full"
            style={{
              background: "var(--text-subtle)",
              animation: `remi-dot 1.3s ease-in-out ${i * 0.18}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

function RemiAvatar({ size = "sm" }: { size?: "sm" | "md" }) {
  const sz = size === "md" ? "h-8 w-8 text-[13px]" : "h-7 w-7 text-[11px]";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${sz}`}
      style={{ background: "var(--theme-primary)", color: "#fff" }}
    >
      R
    </div>
  );
}

// ─── Chat bubble ──────────────────────────────────────────────────────────────

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  loading?: boolean;
}

function ChatBubble({ msg }: { msg: MessageItem }) {
  if (msg.loading) return <TypingIndicator />;

  const isUser = msg.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[82%] rounded-[1.25rem] rounded-br-[0.35rem] px-4 py-3 text-[14px] leading-[1.65]"
          style={{ background: "var(--theme-primary)", color: "#fff" }}
        >
          {msg.content.split("\n").map((line, i) => (
            <p key={i} className={i > 0 ? "mt-1.5" : ""}>{line}</p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start">
      <div
        className="max-w-[86%] rounded-[1.25rem] px-4 py-3"
        style={{ background: "var(--surface-elevated, #f3f4f6)" }}
      >
        <RemiMarkdown content={msg.content} />
      </div>
    </div>
  );
}

// ─── Starter prompts ──────────────────────────────────────────────────────────

const STARTER_PROMPTS = [
  "How is my month going?",
  "What needs my attention?",
  "Explain my cash flow",
  "Which goal is closest?",
];


function SuggestedQuestions({ onSelect }: { onSelect: (p: string) => void }) {
  return (
    <aside className="hidden w-60 shrink-0 lg:block">
      <div className="mb-3">
        <p className="text-[12px] font-[800] text-[var(--text-strong)]">Try asking</p>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Prototype responses use your local demo state.</p>
      </div>
      <div className="rounded-[12px] border border-[var(--border-color)] overflow-hidden">
        {STARTER_PROMPTS.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => onSelect(p)}
            className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-elevated)] ${
              i > 0 ? "border-t border-[var(--border-color)]" : ""
            }`}
          >
            <span className="text-[12px] font-[600] text-[var(--text-primary)]">{p}</span>
            <span className="shrink-0 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--border-color)] text-[10px] font-[700] text-[var(--text-subtle)]">+</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ─── Conversation sidebar ─────────────────────────────────────────────────────

function relativeTime(isoDate?: string) {
  if (!isoDate) return "";
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  loading,
}: {
  conversations: RemiConversation[];
  activeId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading: boolean;
}) {
  return (
    <aside
      className="flex w-[240px] shrink-0 flex-col gap-2 rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      <button
        type="button"
        onClick={onNew}
        className="flex w-full items-center justify-center gap-2 rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] px-3 py-2.5 text-[13px] font-semibold text-[var(--text-secondary)] transition hover:border-[var(--theme-primary)] hover:text-[var(--theme-primary)]"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 2v12M2 8h12" />
        </svg>
        New chat
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <p className="py-4 text-center text-[12px] text-[var(--text-subtle)]">Loading…</p>
        )}
        {!loading && conversations.length === 0 && (
          <p className="py-6 text-center text-[12px] text-[var(--text-subtle)]">No conversations yet</p>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={`w-full rounded-[var(--r-md)] px-3 py-2.5 text-left transition ${
              c.id === activeId
                ? "bg-[var(--theme-soft)] text-[var(--theme-primary)]"
                : "text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
            }`}
          >
            <p className="truncate text-[13px] font-medium">{c.title || "Untitled"}</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">{relativeTime(c.createdAt)}</p>
          </button>
        ))}
      </div>
    </aside>
  );
}


// ─── Main page ────────────────────────────────────────────────────────────────

let _id = 0;
function uid() { return String(++_id); }

export function Remi() {
  const { session } = useAuth();
  const isPaid = session?.remiTier === "paid";

  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: uid(),
      role: "assistant",
      content:
        "Hi — I can help you understand your NOMI plan, cash flow, goals, and recent activity.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();

  const [conversations, setConversations] = useState<RemiConversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load conversation list
  const loadConversations = useCallback(async () => {
    setConvLoading(true);
    try {
      const res = await listRemiConversations();
      setConversations(res.conversations ?? []);
    } catch {
      // non-critical
    } finally {
      setConvLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Load a past conversation
  async function loadConversation(id: string) {
    try {
      const res = await getRemiConversation(id);
      const loaded: MessageItem[] = (res.messages ?? []).map((m: RemiMessage) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      }));
      setMessages(loaded.length > 0 ? loaded : messages);
      setConversationId(id);
      setShowSidebar(false);
    } catch {
      // keep current state
    }
  }

  // Start a new conversation
  function startNew() {
    setConversationId(undefined);
    setMessages([
      {
        id: uid(),
        role: "assistant",
        content:
          "Hi — I can help you understand your NOMI plan, cash flow, goals, and recent activity.",
      },
    ]);
    setInput("");
    setShowSidebar(false);
  }

  // Send message
  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const userMsg: MessageItem = { id: uid(), role: "user", content: trimmed };
    const thinkingId = uid();
    const thinkingMsg: MessageItem = { id: thinkingId, role: "assistant", content: "", loading: true };

    setMessages((prev) => [...prev, userMsg, thinkingMsg]);
    setInput("");
    setSending(true);

    try {
      const res = await sendRemiMessage(trimmed, conversationId);
      if (res.conversationId) {
        setConversationId(res.conversationId);
        // Refresh conversation list in background
        void loadConversations();
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingId
            ? { ...m, content: res.reply, loading: false, createdAt: new Date().toISOString() }
            : m,
        ),
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingId ? { ...m, content: msg, loading: false } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <PageShell
      eyebrow="Remi"
      title="Your NOMI guide."
      description="Ask about your plan, recent activity, goals or cash-flow context. This prototype uses local deterministic responses."
    >
      {/* Dot animation */}
      <style>{`
        @keyframes remi-dot {
          0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
      `}</style>

      <div className="flex gap-6" style={{ minHeight: "calc(100vh - 12rem)" }}>
        {/* ── Chat panel ── */}
        <div
          className="flex flex-1 flex-col rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] md:rounded-[var(--r-xl)]"
          style={{ boxShadow: "var(--shadow-card)" }}
        >

          {/* Messages */}
          <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-5 sm:py-5">
            {messages.map((m) => (
              <ChatBubble key={m.id} msg={m} />
            ))}

            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="border-t border-[var(--border-subtle)] px-3 py-3 sm:px-4 sm:py-3.5">
            <form
              onSubmit={(e) => { e.preventDefault(); void send(input); }}
              className="flex items-center gap-2.5"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={sending}
                placeholder={sending ? "Remi is thinking…" : "Ask Remi about your NOMI…"}
                className="ui-field flex-1 text-[14px]"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="shrink-0 rounded-[8px] px-5 py-2.5 text-[13px] font-[700] transition disabled:opacity-35"
                style={{ background: "var(--theme-primary)", color: "#fff" }}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </form>
          </div>
        </div>

        {/* ── Suggested questions sidebar ── */}
        <SuggestedQuestions onSelect={(p) => void send(p)} />
      </div>
    </PageShell>
  );
}
