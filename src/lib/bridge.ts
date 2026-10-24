// Visor de pdfiiuum dentro del navegador (extensión): lo que hace PDFium (leer y escribir
// anotaciones, editar, organizar páginas) lo hace la app instalada, a través del mismo puente
// de mensajería nativa que «Abrir en pdfiiuum» (src-tauri/src/native_host.rs, «sesión»).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

const HOST = "com.pdfiiuum.open";
/** 6 MB en binario son 8 MB en base64 (el límite hacia la app es 64 MB por mensaje). */
const CHUNK = 6 * 1024 * 1024;

interface Pending {
  parts: Uint8Array[];
  resolve(r: { result: unknown; bytes: Uint8Array | null; current: boolean }): void;
  reject(e: Error): void;
}

let port: { postMessage(m: unknown): void } | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
/** El PDF que tiene ahora el puente: si se vuelve a usar el mismo, no hace falta mandarlo. */
let hostHas: Uint8Array | null = null;
/** Las llamadas van de una en una para saber siempre qué PDF tiene el puente. */
let queue: Promise<unknown> = Promise.resolve();

function friendly(message: string | undefined): string {
  if (!message) return "Se cerró la conexión con pdfiiuum";
  if (/not found|no se encontr/i.test(message)) return "pdfiiuum no está instalado en este equipo (o es una versión anterior a la 0.4.0)";
  return message;
}

function connect() {
  if (port) return port;
  const p = chrome.runtime.connectNative(HOST);
  p.onMessage.addListener((m: { type: string; id: number; data?: string; result?: unknown; current?: boolean; error?: string }) => {
    const job = pending.get(m.id);
    if (!job) return;
    if (m.type === "part") job.parts.push(fromBase64(m.data!));
    else if (m.type === "error") {
      pending.delete(m.id);
      job.reject(new Error(m.error));
    } else if (m.type === "result") {
      pending.delete(m.id);
      job.resolve({ result: m.result, bytes: job.parts.length ? concat(job.parts) : null, current: !!m.current });
    }
  });
  p.onDisconnect.addListener(() => {
    const error = new Error(friendly(chrome.runtime.lastError?.message));
    port = null;
    hostHas = null;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  });
  port = p;
  return p;
}

/**
 * Pide una operación al puente sobre `pdf` (o sobre el último PDF si se omite). Devuelve el
 * resultado y, si la operación produce un PDF, sus bytes.
 */
export function call<T>(cmd: string, args: unknown, pdf?: Uint8Array): Promise<{ result: T; bytes: Uint8Array | null }> {
  const run = async () => {
    const p = connect();
    if (pdf && pdf !== hostHas) {
      p.postMessage({ type: "put", size: pdf.length });
      for (let i = 0; i < pdf.length; i += CHUNK) p.postMessage({ type: "part", data: toBase64(pdf.subarray(i, i + CHUNK)) });
      hostHas = pdf;
    }
    const id = ++seq;
    const reply = await new Promise<{ result: unknown; bytes: Uint8Array | null; current: boolean }>((resolve, reject) => {
      pending.set(id, { parts: [], resolve, reject });
      p.postMessage({ type: "call", id, cmd, args });
    });
    if (reply.current && reply.bytes) hostHas = reply.bytes;
    return { result: reply.result as T, bytes: reply.bytes };
  };
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(data: string): Uint8Array {
  const s = atob(data);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
