// Contraseñas de los PDF cifrados. Se piden al abrir el PDF y solo duran mientras la app está
// abierta (no se guardan en disco). pdf.js y PDFium prueban todas las de la sesión, así que las
// copias que salen del PDF (guardadas, editadas, con el formulario escrito) se abren solas.
import { invoke } from "@tauri-apps/api/core";

const known: string[] = [];
/** Cambia cada vez que se añade una contraseña. */
let version = 0;
/** La app de escritorio tiene que conocerlas antes de abrir el PDF con PDFium. */
let synced: Promise<unknown> = Promise.resolve();

export type PasswordPrompt = (request: { name?: string; retry: boolean }) => Promise<string | null>;
let prompt: PasswordPrompt | null = null;
/** Las peticiones van de una en una (al abrir varios PDF a la vez). */
let queue: Promise<unknown> = Promise.resolve();

/** El usuario canceló la contraseña: el PDF no se abre, sin mensaje de error. */
export class PasswordCancelled extends Error {
  constructor() {
    super("Se canceló la contraseña");
    this.name = "PasswordCancelled";
  }
}

export function setPasswordPrompt(fn: PasswordPrompt | null) {
  prompt = fn;
}

export function askPassword(request: { name?: string; retry: boolean }): Promise<string | null> {
  if (!prompt) return Promise.resolve(null);
  const ask = prompt;
  const job = queue.then(() => ask(request));
  queue = job.catch(() => {});
  return job;
}

export const knownPasswords = (): readonly string[] => known;
export const passwordsVersion = () => version;

export function rememberPassword(password: string) {
  if (!password || known.includes(password)) return;
  known.push(password);
  version++;
  if ("__TAURI_INTERNALS__" in window) {
    synced = Promise.all([synced, invoke("add_password", { password }).catch(() => {})]);
  }
}

/** Espera a que PDFium conozca las contraseñas escritas (app de escritorio). */
export const passwordsSynced = () => synced;
