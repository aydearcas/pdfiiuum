import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import IconButton from "./IconButton";
import type { FindStatus } from "./Viewer";

interface Props {
  status: FindStatus | null;
  onFind(query: string, opts?: { again?: boolean; previous?: boolean }): void;
  onClose(): void;
}

export default function SearchBar({ status, onFind, onClose }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const id = setTimeout(() => onFind(query), 150);
    return () => clearTimeout(id);
  }, [query]);

  const next = (previous = false) => query && onFind(query, { again: true, previous });

  let counter = "";
  if (query && status) {
    counter = status.total ? `${status.current} de ${status.total}` : status.notFound ? "Sin resultados" : "";
  }

  return (
    <div className="searchbar" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <Search size={16} className="muted" />
      <input
        ref={inputRef}
        value={query}
        placeholder="Buscar en el documento"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && next(e.shiftKey)}
      />
      <span className={`counter${status?.notFound && query ? " error" : ""}`}>{counter}</span>
      <IconButton icon={ChevronUp} label="Anterior (Mayús+Enter)" onClick={() => next(true)} />
      <IconButton icon={ChevronDown} label="Siguiente (Enter)" onClick={() => next(false)} />
      <IconButton icon={X} label="Cerrar (Esc)" onClick={onClose} />
    </div>
  );
}
