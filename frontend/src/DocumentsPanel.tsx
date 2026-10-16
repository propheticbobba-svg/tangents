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
    <div className="border-b border-line px-3 py-3">
      <div className="glass rounded-xl border-dashed p-3">
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
        {indexing && <p className="shimmer mt-2 truncate font-mono text-[11px]">Indexing {indexing}…</p>}
        {error && <p className="text-danger mt-2 text-xs">{error}</p>}
        {documents.length > 0 && (
          <ul className="mt-2 max-h-40 divide-y divide-line overflow-y-auto">
            {documents.map((document) => (
              <li key={document.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs" title={document.filename}>
                  {document.filename}
                  <span className="font-mono text-[11px] text-muted">
                    {" "}
                    · {document.chunk_count} {document.chunk_count === 1 ? "passage" : "passages"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={disabled || indexing !== null}
                  onClick={() => onDelete(document)}
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
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
