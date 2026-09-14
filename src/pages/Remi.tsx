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

function ChatBubble({ msg, onCopy }: { msg: MessageItem; onCopy?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);

  if (msg.loading) return <TypingIndicator />;

  const isUser = msg.role === "user";

  function handleCopy() {
    if (!msg.content) return;
    void navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (isUser) {
    return (
      <div className="group flex justify-end">
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
    <div className="group flex items-end gap-2.5">
      <RemiAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          className="max-w-[86%] rounded-[1.25rem] rounded-bl-[0.35rem] px-4 py-3"
          style={{ background: "var(--surface-muted)" }}
        >
          <RemiMarkdown content={msg.content} />
        </div>
        <div className="flex items-center gap-2 pl-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-subtle)] transition hover:text-[var(--text-secondary)]"
          >
            {copied ? (
              <>
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 8l4 4 8-8" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <rect x="4" y="4" width="9" height="9" rx="1.5" />
                  <path d="M4 4V3a1 1 0 011-1h7a1 1 0 011 1v7a1 1 0 01-1 1h-1" />
                </svg>
                Copy
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Starter prompts ──────────────────────────────────────────────────────────

const STARTER_PROMPTS = [
  { label: "Can I afford $400 this weekend?", icon: "💳" },
  { label: "How are my debts looking?", icon: "📉" },
  { label: "Compare this month to last month", icon: "📊" },
  { label: "What's my cash flow for the next 30 days?", icon: "🔭" },
  { label: "Where am I on my goals?", icon: "🎯" },
  { label: "Explain my personal spending this month", icon: "🔍" },
];

function StarterPrompts({ onSelect }: { onSelect: (p: string) => void }) {
  return (
    <div className="flex flex-col gap-3 py-4">
      <p className="text-center text-[12px] font-medium text-[var(--text-subtle)]">
        Ask me anything — or pick a question below
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onSelect(p.label)}
            className="flex flex-col items-start gap-1.5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 text-left transition hover:border-[var(--theme-primary)] hover:shadow-sm"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <span className="text-[16px]">{p.icon}</span>
            <span className="text-[12px] font-medium leading-snug text-[var(--text-primary)]">
              {p.label}
            </span>
          </button>
        ))}
      </div>
    </div>
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

// ─── Auto-resizing textarea ───────────────────────────────────────────────────

function AutoTextarea({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className="ui-field flex-1 resize-none overflow-hidden text-[14px] leading-relaxed"
      style={{ minHeight: "44px", maxHeight: "128px" }}
    />
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
        "Hi, I'm Remi — RAF's financial intelligence layer.\n\nI can check your actual plan data, model scenarios, explain variances, and help you think through decisions. Pick a question below or ask me anything.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();

  const [conversations, setConversations] = useState<RemiConversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const hasUserMessage = messages.some((m) => m.role === "user");

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
          "Hi, I'm Remi — RAF's financial intelligence layer.\n\nI can check your actual plan data, model scenarios, explain variances, and help you think through decisions. Pick a question below or ask me anything.",
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
    <PageShell eyebrow="AI Advisor" title="Your RAF guide.">
      {/* Dot animation */}
      <style>{`
        @keyframes remi-dot {
          0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
      `}</style>

      <div className="flex items-start gap-4" style={{ height: "calc(100vh - 9.5rem)" }}>
        {/* ── Sidebar (desktop) ── */}
        <div className="hidden h-full md:flex">
          <ConversationSidebar
            conversations={conversations}
            activeId={conversationId}
            onSelect={(id) => void loadConversation(id)}
            onNew={startNew}
            loading={convLoading}
          />
        </div>

        {/* ── Chat panel ── */}
        <div
          className="flex h-full flex-1 flex-col rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--surface-card)]"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-3.5">
            {/* Mobile: conversations toggle */}
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] transition hover:bg-[var(--surface-muted)] md:hidden"
              onClick={() => setShowSidebar((s) => !s)}
              aria-label="Conversations"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </button>

            <RemiAvatar size="md" />

            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-[var(--text-primary)]">Remi</p>
              <p className="text-[11px] text-[var(--text-subtle)]">
                {isPaid ? "AI-powered · calls your plan data" : "Free tier · upgrade for full insights"}
              </p>
            </div>

            <span
              className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
              style={
                isPaid
                  ? { background: "var(--badge-success-bg)", color: "var(--badge-success-text)" }
                  : { background: "var(--badge-neutral-bg)", color: "var(--badge-neutral-text)" }
              }
            >
              {isPaid ? "AI" : "Free"}
            </span>
          </div>

          {/* Mobile sidebar drawer */}
          {showSidebar && (
            <div className="border-b border-[var(--border-subtle)] p-3 md:hidden">
              <ConversationSidebar
                conversations={conversations}
                activeId={conversationId}
                onSelect={(id) => void loadConversation(id)}
                onNew={startNew}
                loading={convLoading}
              />
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
            {messages.map((m) => (
              <ChatBubble key={m.id} msg={m} />
            ))}

            {/* Starter prompts — only when no user messages yet */}
            {!hasUserMessage && (
              <StarterPrompts onSelect={(p) => void send(p)} />
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="border-t border-[var(--border-subtle)] px-4 py-3.5">
            <form
              onSubmit={(e) => { e.preventDefault(); void send(input); }}
              className="flex items-end gap-2.5"
            >
              <AutoTextarea
                value={input}
                onChange={setInput}
                onSubmit={() => void send(input)}
                disabled={sending}
                placeholder={sending ? "Remi is thinking…" : "Ask Remi anything…"}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                aria-label="Send"
                className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full transition disabled:opacity-35"
                style={{ background: "var(--theme-primary)", color: "#fff" }}
              >
                {sending ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" opacity=".25" />
                    <path d="M21 12a9 9 0 00-9-9" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z" />
                  </svg>
                )}
              </button>
            </form>
            <p className="mt-2 text-center text-[11px] text-[var(--text-subtle)]">
              Shift+Enter for new line · Enter to send
            </p>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
