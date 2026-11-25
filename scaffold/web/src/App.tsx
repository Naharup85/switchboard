import { useEffect, useState, useRef, useCallback } from 'react';

const API_BASE = 'http://localhost:4000';
const WS_BASE = 'ws://localhost:4000';

interface Workspace {
  id: string;
  role: string;
}

interface User {
  sub: string;
  name?: string;
  email?: string;
  workspaces: Workspace[];
}

interface Conversation {
  workspace: string;
  contact: string;
  assignee?: string | null;
  status?: string;
  lastMessageAt?: string;
  updatedAt?: string;
}

interface Message {
  id: string;
  client_ref?: string;
  direction: 'inbound' | 'outbound';
  contact: string;
  text: string;
  status?: string;
  occurred_at?: string;
  timestamp: number;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeContact, setActiveContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');

  const lastSeqRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<any>(null);

  // 1. Check Authentication on Mount
  useEffect(() => {
    fetch(`${API_BASE}/api/me`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('Unauthenticated');
        return res.json();
      })
      .then((data: User) => {
        setUser(data);
        if (data.workspaces && data.workspaces.length > 0) {
          setActiveWorkspace(data.workspaces[0].id);
        }
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, []);

  // 2. Fetch Conversations when Workspace changes
  const loadConversations = useCallback(async (ws: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/conversations?workspace=${encodeURIComponent(ws)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  }, []);

  useEffect(() => {
    if (activeWorkspace) {
      loadConversations(activeWorkspace);
      setActiveContact(null);
      setMessages([]);
      lastSeqRef.current = 0;
    }
  }, [activeWorkspace, loadConversations]);

  // 3. Fetch Messages for Active Contact
  const loadMessages = useCallback(async (ws: string, contact: string) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(ws)}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }, []);

  useEffect(() => {
    if (activeWorkspace && activeContact) {
      loadMessages(activeWorkspace, activeContact);
    }
  }, [activeWorkspace, activeContact, loadMessages]);

  // 4. WebSocket Live Updates & Reconnection
  useEffect(() => {
    if (!user || !activeWorkspace) return;

    let unmounted = false;

    const connectWebSocket = () => {
      if (unmounted) return;
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }

      setWsStatus('connecting');
      const afterParam = lastSeqRef.current > 0 ? `&after=${lastSeqRef.current}` : '';
      const url = `${WS_BASE}/ws?workspace=${encodeURIComponent(activeWorkspace)}${afterParam}`;

      const socket = new WebSocket(url);
      wsRef.current = socket;

      socket.onopen = () => {
        if (unmounted) return;
        setWsStatus('connected');
      };

      socket.onmessage = (event) => {
        if (unmounted) return;
        try {
          const frame = JSON.parse(event.data);
          if (typeof frame.seq === 'number') {
            lastSeqRef.current = Math.max(lastSeqRef.current, frame.seq);
          }

          if (frame.type === 'message.inbound') {
            // Update messages timeline if this contact is open
            if (activeContact && frame.contact === activeContact) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === frame.message_id)) return prev;
                return [
                  ...prev,
                  {
                    id: frame.message_id,
                    direction: 'inbound',
                    contact: frame.contact,
                    text: frame.text || '',
                    occurred_at: frame.occurred_at,
                    timestamp: new Date(frame.occurred_at || Date.now()).getTime(),
                  },
                ];
              });
            }

            // Update conversations list (bump to top)
            setConversations((prev) => {
              const existingIdx = prev.findIndex((c) => c.contact === frame.contact);
              const now = new Date().toISOString();
              if (existingIdx !== -1) {
                const updated = { ...prev[existingIdx], lastMessageAt: now, updatedAt: now };
                return [updated, ...prev.filter((_, i) => i !== existingIdx)];
              } else {
                return [
                  {
                    workspace: activeWorkspace,
                    contact: frame.contact,
                    assignee: null,
                    status: 'open',
                    lastMessageAt: now,
                    updatedAt: now,
                  },
                  ...prev,
                ];
              }
            });
          } else if (frame.type === 'message.status') {
            // Update message status in timeline
            setMessages((prev) =>
              prev.map((m) => {
                if (m.client_ref === frame.client_ref) {
                  return { ...m, status: frame.status };
                }
                return m;
              })
            );
          } else if (frame.type === 'conversation.assigned') {
            // Update assignee in conversation list & active view
            setConversations((prev) =>
              prev.map((c) => {
                if (c.contact === frame.contact) {
                  return { ...c, assignee: frame.assignee };
                }
                return c;
              })
            );
          }
        } catch {
          // ignore malformed frame
        }
      };

      socket.onclose = () => {
        if (unmounted) return;
        setWsStatus('disconnected');
        reconnectTimerRef.current = setTimeout(connectWebSocket, 2000);
      };

      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          // ignore
        }
      };
    };

    connectWebSocket();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, [user, activeWorkspace, activeContact]);

  // 5. Action Handlers
  const handleClaim = async () => {
    if (!activeContact || !activeWorkspace) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/conversations/${encodeURIComponent(activeContact)}/claim?workspace=${encodeURIComponent(activeWorkspace)}`,
        { method: 'POST', credentials: 'include' }
      );
      if (res.ok) {
        setConversations((prev) =>
          prev.map((c) => (c.contact === activeContact ? { ...c, assignee: user?.sub } : c))
        );
      } else if (res.status === 409) {
        alert('This conversation is already claimed by another agent.');
      }
    } catch (err) {
      console.error('Claim failed:', err);
    }
  };

  const handleToggleStatus = async (currentStatus?: string) => {
    if (!activeContact || !activeWorkspace) return;
    const nextStatus = currentStatus === 'closed' ? 'open' : 'closed';
    try {
      const res = await fetch(
        `${API_BASE}/api/conversations/${encodeURIComponent(activeContact)}/status?workspace=${encodeURIComponent(activeWorkspace)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status: nextStatus, workspace: activeWorkspace }),
        }
      );
      if (res.ok) {
        setConversations((prev) =>
          prev.map((c) => (c.contact === activeContact ? { ...c, status: nextStatus } : c))
        );
      }
    } catch (err) {
      console.error('Status update failed:', err);
    }
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || !activeContact || !activeWorkspace || sending) return;

    setSending(true);
    const clientRef = `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const textToSend = replyText.trim();
    setReplyText('');

    // Optimistically add outbound message
    const optimisticMsg: Message = {
      id: clientRef,
      client_ref: clientRef,
      direction: 'outbound',
      contact: activeContact,
      text: textToSend,
      status: 'queued',
      timestamp: Date.now(),
      occurred_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await fetch(
        `${API_BASE}/api/conversations/${encodeURIComponent(activeContact)}/reply?workspace=${encodeURIComponent(activeWorkspace)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            text: textToSend,
            client_ref: clientRef,
            workspace: activeWorkspace,
          }),
        }
      );

      if (!res.ok) {
        setMessages((prev) =>
          prev.map((m) => (m.client_ref === clientRef ? { ...m, status: 'failed' } : m))
        );
      }
    } catch (err) {
      console.error('Reply failed:', err);
      setMessages((prev) =>
        prev.map((m) => (m.client_ref === clientRef ? { ...m, status: 'failed' } : m))
      );
    } finally {
      setSending(false);
    }
  };

  if (authChecking) {
    return (
      <div style={styles.centerContainer}>
        <div style={styles.loadingSpinner}>Loading Switchboard…</div>
      </div>
    );
  }

  // Not signed in: show IdP Login Page
  if (!user) {
    return (
      <div style={styles.centerContainer}>
        <div style={styles.loginCard}>
          <div style={styles.logoBadge}>SB</div>
          <h1 style={{ margin: '0 0 8px 0', fontSize: 24, fontWeight: 700 }}>Switchboard</h1>
          <p style={{ margin: '0 0 24px 0', color: '#6b7280', fontSize: 14 }}>
            Sign in to access your shared team inbox and customer conversations.
          </p>
          <a href={`${API_BASE}/auth/login`} style={styles.loginButton}>
            Sign in with Switchboard IdP
          </a>
        </div>
      </div>
    );
  }

  const selectedConversation = conversations.find((c) => c.contact === activeContact);
  const filteredConversations = conversations.filter((c) =>
    c.contact.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div style={styles.appContainer}>
      {/* Top Navigation Bar */}
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={styles.headerLogo}>Switchboard</span>
          <select
            value={activeWorkspace}
            onChange={(e) => setActiveWorkspace(e.target.value)}
            style={styles.workspaceSelect}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor:
                  wsStatus === 'connected'
                    ? '#10b981'
                    : wsStatus === 'connecting'
                    ? '#f59e0b'
                    : '#ef4444',
              }}
            />
            <span style={{ color: '#6b7280' }}>
              {wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
          </div>

          <div style={{ textAlign: 'right', fontSize: 13 }}>
            <div style={{ fontWeight: 600, color: '#111827' }}>{user.name || user.sub}</div>
            <div style={{ color: '#6b7280', fontSize: 11 }}>{user.email || user.sub}</div>
          </div>
        </div>
      </header>

      {/* Main Split Layout */}
      <div style={styles.mainLayout}>
        {/* Left Pane: Conversations List */}
        <aside style={styles.leftPane}>
          <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb' }}>
            <input
              type="text"
              placeholder="Filter by contact…"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              style={styles.searchInput}
            />
          </div>

          <div style={styles.conversationList}>
            {filteredConversations.length === 0 ? (
              <div style={styles.emptyState}>No conversations found</div>
            ) : (
              filteredConversations.map((c) => {
                const isSelected = c.contact === activeContact;
                const isMine = c.assignee === user.sub;
                const isClosed = c.status === 'closed';

                return (
                  <div
                    key={c.contact}
                    onClick={() => setActiveContact(c.contact)}
                    style={{
                      ...styles.conversationItem,
                      backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                      borderLeft: isSelected ? '4px solid #3b82f6' : '4px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{c.contact}</span>
                      <span style={badgeStyle(isClosed ? 'closed' : 'open')}>
                        {isClosed ? 'Closed' : 'Open'}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: 6,
                        fontSize: 12,
                      }}
                    >
                      <span style={assigneeBadgeStyle(c.assignee, isMine)}>
                        {c.assignee ? (isMine ? 'You' : c.assignee) : 'Unassigned'}
                      </span>
                      {c.lastMessageAt && (
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>
                          {formatTime(c.lastMessageAt)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Pane: Conversation Details & Messages */}
        <main style={styles.rightPane}>
          {selectedConversation ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {/* Detail Header */}
              <div style={styles.detailHeader}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>
                    {selectedConversation.contact}
                  </h2>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                    <span style={badgeStyle(selectedConversation.status === 'closed' ? 'closed' : 'open')}>
                      {selectedConversation.status === 'closed' ? 'Closed' : 'Open'}
                    </span>
                    <span
                      style={assigneeBadgeStyle(
                        selectedConversation.assignee,
                        selectedConversation.assignee === user.sub
                      )}
                    >
                      {selectedConversation.assignee
                        ? selectedConversation.assignee === user.sub
                          ? 'Assigned to you'
                          : `Assigned to ${selectedConversation.assignee}`
                        : 'Unassigned'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleClaim}
                    style={styles.actionButton}
                    disabled={selectedConversation.assignee === user.sub}
                  >
                    {selectedConversation.assignee === user.sub ? 'Claimed' : 'Claim'}
                  </button>
                  <button
                    onClick={() => handleToggleStatus(selectedConversation.status)}
                    style={styles.secondaryButton}
                  >
                    {selectedConversation.status === 'closed' ? 'Reopen' : 'Close'}
                  </button>
                </div>
              </div>

              {/* Message Timeline */}
              <div style={styles.messageTimeline}>
                {messages.length === 0 ? (
                  <div style={styles.emptyState}>No messages yet in this conversation.</div>
                ) : (
                  messages.map((m, idx) => {
                    const isInbound = m.direction === 'inbound';
                    return (
                      <div
                        key={m.id || idx}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: isInbound ? 'flex-start' : 'flex-end',
                          marginBottom: 12,
                        }}
                      >
                        <div
                          style={{
                            maxWidth: '70%',
                            padding: '10px 14px',
                            borderRadius: 12,
                            backgroundColor: isInbound ? '#f3f4f6' : '#2563eb',
                            color: isInbound ? '#1f2937' : '#ffffff',
                            fontSize: 14,
                            lineHeight: 1.4,
                            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                          }}
                        >
                          {m.text}
                        </div>

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginTop: 4,
                            fontSize: 11,
                            color: '#9ca3af',
                          }}
                        >
                          <span>{formatTime(m.occurred_at || new Date(m.timestamp).toISOString())}</span>
                          {!isInbound && m.status && (
                            <span style={statusBadgeStyle(m.status)}>{m.status}</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Reply Input Box */}
              <form onSubmit={handleSendReply} style={styles.replyBox}>
                <input
                  type="text"
                  placeholder={`Reply to ${selectedConversation.contact}…`}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  style={styles.replyInput}
                  disabled={sending}
                />
                <button
                  type="submit"
                  style={{
                    ...styles.sendButton,
                    opacity: sending || !replyText.trim() ? 0.6 : 1,
                    cursor: sending || !replyText.trim() ? 'not-allowed' : 'pointer',
                  }}
                  disabled={sending || !replyText.trim()}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
            </div>
          ) : (
            <div style={styles.centerContainer}>
              <div style={{ color: '#9ca3af', textAlign: 'center' }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>💬</div>
                <div style={{ fontSize: 16, fontWeight: 500 }}>Select a conversation</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Choose a conversation from the left to read messages and reply.
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// Helpers
function formatTime(isoStr?: string): string {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function badgeStyle(status: 'open' | 'closed'): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 9999,
    fontWeight: 600,
    backgroundColor: status === 'open' ? '#dcfce7' : '#f3f4f6',
    color: status === 'open' ? '#15803d' : '#6b7280',
  };
}

function assigneeBadgeStyle(assignee?: string | null, isMine = false): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 9999,
    fontWeight: 500,
    backgroundColor: isMine ? '#dbeafe' : assignee ? '#fef3c7' : '#f3f4f6',
    color: isMine ? '#1e40af' : assignee ? '#92400e' : '#9ca3af',
  };
}

function statusBadgeStyle(status: string): React.CSSProperties {
  let bg = '#f3f4f6';
  let color = '#6b7280';
  if (status === 'sent') {
    bg = '#e0f2fe';
    color = '#0369a1';
  } else if (status === 'delivered') {
    bg = '#dcfce7';
    color = '#15803d';
  } else if (status === 'failed') {
    bg = '#fee2e2';
    color = '#b91c1c';
  }
  return {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 4,
    fontWeight: 600,
    textTransform: 'uppercase',
    backgroundColor: bg,
    color,
  };
}

const styles: Record<string, React.CSSProperties> = {
  appContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#f9fafb',
  },
  header: {
    height: 56,
    borderBottom: '1px solid #e5e7eb',
    backgroundColor: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
  },
  headerLogo: {
    fontWeight: 800,
    fontSize: 18,
    color: '#1e40af',
    letterSpacing: -0.5,
  },
  workspaceSelect: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 13,
    backgroundColor: '#f9fafb',
    color: '#111827',
    fontWeight: 500,
  },
  mainLayout: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPane: {
    width: 320,
    borderRight: '1px solid #e5e7eb',
    backgroundColor: '#ffffff',
    display: 'flex',
    flexDirection: 'column',
  },
  searchInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 13,
    outline: 'none',
  },
  conversationList: {
    flex: 1,
    overflowY: 'auto',
  },
  conversationItem: {
    padding: '12px 16px',
    borderBottom: '1px solid #f3f4f6',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
  rightPane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  detailHeader: {
    padding: '16px 24px',
    borderBottom: '1px solid #e5e7eb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
  },
  messageTimeline: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
    backgroundColor: '#f9fafb',
  },
  replyBox: {
    padding: '14px 24px',
    borderTop: '1px solid #e5e7eb',
    backgroundColor: '#ffffff',
    display: 'flex',
    gap: 12,
  },
  replyInput: {
    flex: 1,
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    fontSize: 14,
    outline: 'none',
  },
  sendButton: {
    padding: '10px 20px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontWeight: 600,
    fontSize: 14,
  },
  actionButton: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid #2563eb',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    color: '#374151',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  centerContainer: {
    display: 'flex',
    height: '100%',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingSpinner: {
    fontSize: 16,
    color: '#6b7280',
  },
  loginCard: {
    width: 380,
    padding: 36,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
    textAlign: 'center',
    border: '1px solid #e5e7eb',
  },
  logoBadge: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#2563eb',
    color: '#ffffff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    fontWeight: 800,
    marginBottom: 16,
  },
  loginButton: {
    display: 'inline-block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 20px',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    borderRadius: 8,
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 15,
  },
  emptyState: {
    padding: 32,
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 14,
  },
};
