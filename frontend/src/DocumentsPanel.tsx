import { useRef } from "react";
import type { DocumentInfo } from "./types";

const ACCEPT = ".txt,.md,.markdown,.docx,.pdf,.pptx,.xlsx,.html,.htm,.epub";

export function DocumentsPanel({
  documents,
  disabled,
  indexing,
  error,
  onUpload,
  onDelete,
}: {
  documents: DocumentInfo[];
  disabled: boolean;
  indexing: string | null;
  error: string | null;
  onUpload: (files: File[]) => void;
  onDelete: (document: DocumentInfo) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const count = documents.length === 1 ? "1 document" : `${documents.length} documents`;

  return (
    <div className="border-b border-line px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">Documents · {count}</span>
        <button
          type="button"
          disabled={disabled || indexing !== null}
          onClick={() => inputRef.current?.click()}
          className="rounded-md border border-line px-2 py-0.5 text-xs hover:border-accent disabled:opacity-40"
        >
          Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = "";
            if (files.length > 0) onUpload(files);
          }}
        />
      </div>
      {indexing && <p className="mt-2 truncate text-xs text-muted">Indexing {indexing}…</p>}
      {error && <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
      {documents.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {documents.map((document) => (
            <li key={document.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs" title={document.filename}>
                {document.filename}
                <span className="text-muted">
                  {" "}
                  · {document.chunk_count} {document.chunk_count === 1 ? "passage" : "passages"}
                </span>
              </span>
              <button
                type="button"
                disabled={disabled || indexing !== null}
                onClick={() => onDelete(document)}
                className="shrink-0 rounded px-1 py-0.5 text-xs text-muted hover:text-rose-700 disabled:opacity-40 dark:hover:text-rose-300"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
