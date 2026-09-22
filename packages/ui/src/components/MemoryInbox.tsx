import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingMemory } from "@cuesheet/core";
import {
  approveMemory,
  discardMemory,
  fetchMemoryInbox,
} from "../api/client.js";
import { memoryApproval, memoryDraft, type MemoryDraft } from "../memory.js";

export function MemoryInbox(): React.JSX.Element {
  const [pending, setPending] = useState<PendingMemory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const decidedIds = useRef(new Set<string>());

  const load = useCallback(() => {
    setError(null);
    void fetchMemoryInbox()
      .then((items) =>
        setPending(items.filter((item) => !decidedIds.current.has(item.id))),
      )
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  useEffect(() => {
    load();
    // Captures can arrive from a run while this surface is already open. The
    // run socket carries run events only, so a small inbox poll keeps a new
    // decision from waiting behind a manual refresh without broadening that
    // event contract for one global resource.
    const timer = window.setInterval(load, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const decided = (id: string): void => {
    // A poll that began before approval can settle afterwards with the old
    // item. Remember local decisions so that stale response cannot put a
    // discarded or approved card back on screen.
    decidedIds.current.add(id);
    setPending((items) => items?.filter((item) => item.id !== id) ?? []);
  };

  return (
    <main className="memory-inbox" id="work" tabIndex={-1}>
      <header className="memory-head">
        <div>
          <h1 className="project-title">Memory inbox</h1>
          <p className="project-where">
            Agent captures stay here until you approve, edit, or discard them.
          </p>
        </div>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={load}>
          refresh
        </button>
      </header>

      {error !== null && (
        <div className="notice" data-kind="error" role="alert">
          <p className="notice-title">The inbox could not be read.</p>
          <p className="notice-detail">{error}</p>
          <button type="button" onClick={load}>
            try again
          </button>
        </div>
      )}
      {outcome !== null && <p className="memory-outcome">{outcome}</p>}
      {error === null && pending === null && (
        <div className="notice" data-kind="loading" role="status">
          <p className="notice-title">
            <span className="notice-spin" aria-hidden="true" />
            Reading pending memories…
          </p>
        </div>
      )}
      {error === null && pending?.length === 0 && (
        <div className="notice" data-kind="empty">
          <p className="notice-title">No memories are waiting.</p>
          <p className="notice-detail">
            Captures appear here by default. Nothing in this inbox is projected
            into an agent context file.
          </p>
        </div>
      )}
      {error === null && pending !== null && pending.length > 0 && (
        <ul className="memory-list">
          {pending.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              onDecided={decided}
              onOutcome={setOutcome}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function MemoryCard({
  memory,
  onDecided,
  onOutcome,
}: {
  memory: PendingMemory;
  onDecided: (id: string) => void;
  onOutcome: (message: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<MemoryDraft>(() => memoryDraft(memory));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (key: keyof MemoryDraft, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const captured = new Date(memory.provenance.at);
  const when = Number.isNaN(captured.getTime())
    ? memory.provenance.at
    : captured.toLocaleString();

  return (
    <li className="memory-card">
      <div className="memory-provenance">
        <span>{memory.provenance.station ?? "unknown station"}</span>
        <span>run {memory.provenance.run ?? "unknown"}</span>
        <span>{when}</span>
      </div>
      <label>
        Fact id
        <input
          value={draft.id}
          onChange={(event) => change("id", event.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        Title
        <input
          value={draft.title}
          onChange={(event) => change("title", event.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        Memory
        <textarea
          rows={6}
          value={draft.body}
          onChange={(event) => change("body", event.target.value)}
          disabled={busy}
        />
      </label>
      <div className="memory-fields">
        <label>
          Tags <span className="memory-help">comma-separated</span>
          <input
            value={draft.tags}
            onChange={(event) => change("tags", event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Projects <span className="memory-help">IDs, comma-separated</span>
          <input
            value={draft.projects}
            onChange={(event) => change("projects", event.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      {error !== null && <p className="memory-error">{error}</p>}
      <div className="memory-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void approveMemory(memory.id, memoryApproval(draft))
              .then((result) => {
                onDecided(memory.id);
                onOutcome(
                  result.committed
                    ? `Approved “${result.fact.title}” and regenerated context.`
                    : `Approved “${result.fact.title}”, but Git history is unavailable: ${result.reason ?? "unknown reason"}`,
                );
              })
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Discard “${draft.title}”?`)) return;
            setBusy(true);
            setError(null);
            void discardMemory(memory.id)
              .then(() => {
                onDecided(memory.id);
                onOutcome(`Discarded “${draft.title}”.`);
              })
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          discard
        </button>
      </div>
    </li>
  );
}
