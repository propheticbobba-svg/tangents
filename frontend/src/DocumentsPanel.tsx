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
    <div className="border-b border-line px-4 py-3">
      <div className="rounded-2xl border border-dashed border-line bg-paper/60 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="label">Documents · {count}</span>
          <button
            type="button"
            disabled={disabled || indexing !== null}
            onClick={() => inputRef.current?.click()}
            className="btn-ghost !px-2.5 !py-0.5 !text-xs"
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
        {indexing && <p className="shimmer mt-2 truncate text-xs">Indexing {indexing}…</p>}
        {error && <p className="text-danger mt-2 text-xs">{error}</p>}
        {documents.length > 0 && (
          <ul className="mt-2 max-h-40 divide-y divide-line overflow-y-auto">
            {documents.map((document) => (
              <li key={document.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm" title={document.filename}>
                  {document.filename}
                  <span className="text-xs text-muted">
                    {" "}
                    · {document.chunk_count} {document.chunk_count === 1 ? "passage" : "passages"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={disabled || indexing !== null}
                  onClick={() => onDelete(document)}
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
