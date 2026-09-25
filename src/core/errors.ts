export class AgentLinkError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AgentLinkError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string) => new AgentLinkError("not_found", `${what} not found`, 404);
export const forbidden = (message: string) => new AgentLinkError("forbidden", message, 403);
export const invalid = (message: string, details?: unknown) =>
  new AgentLinkError("invalid", message, 400, details);
export const limited = (code: string, message: string) => new AgentLinkError(code, message, 429);
