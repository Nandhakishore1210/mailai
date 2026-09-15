import axios from "axios";
import { EmailSummary, EmailDetail, MailFilters, MailBox } from "./types";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
});

export const authApi = {
  me: () => api.get("/auth/me").then((r) => r.data),
  googleAuthUrl: () => api.get("/auth/google").then((r) => r.data.url as string),
  passwordLogin: (data: { email: string; password: string; imap_host?: string; smtp_host?: string }) =>
    api.post("/auth/password", data).then((r) => r.data),
  logout: () => api.post("/auth/logout"),
};

export const mailApi = {
  box: (box: MailBox, max = 20): Promise<EmailSummary[]> =>
    api.get(`/mail/box/${box}?max_results=${max}`).then((r) => r.data),
  inbox: (max = 20): Promise<EmailSummary[]> => mailApi.box("inbox", max),
  sent: (max = 20): Promise<EmailSummary[]> => mailApi.box("sent", max),
  detail: (id: string): Promise<EmailDetail> =>
    api.get(`/mail/${id}`).then((r) => r.data),
  thread: (threadId: string): Promise<EmailDetail[]> =>
    api.get(`/mail/thread/${threadId}`).then((r) => r.data),
  search: (filters: MailFilters): Promise<EmailSummary[]> =>
    api.post("/mail/search", filters).then((r) => r.data),
  send: (data: { to: string[]; subject: string; body: string }) =>
    api.post("/mail/send", data).then((r) => r.data),
  reply: (message_id: string, body: string) =>
    api.post("/mail/reply", { message_id, body }).then((r) => r.data),
  forward: (message_id: string, to: string[], note?: string) =>
    api.post("/mail/forward", { message_id, to, note }).then((r) => r.data),
  markRead: (id: string, read: boolean) =>
    api.post(`/mail/${id}/read`, { read }).then((r) => r.data),
  trash: (id: string) => api.post(`/mail/${id}/trash`).then((r) => r.data),
  spam: (id: string) => api.post(`/mail/${id}/spam`).then((r) => r.data),
  restore: (id: string) => api.post(`/mail/${id}/restore`).then((r) => r.data),
  deleteForever: (id: string) => api.delete(`/mail/${id}`).then((r) => r.data),
  wake: () => api.post("/mail/sync/wake").then((r) => r.data),
  poll: (): Promise<{ changed: boolean }> =>
    api.get("/mail/sync/poll").then((r) => r.data),
};

export const assistantApi = {
  chat: (
    message: string,
    ui_context: object,
    conversation_id?: string
  ): Promise<{ conversation_id: string; reply: string; actions: object[]; emails: object[] }> =>
    api.post("/assistant/chat", { message, ui_context, conversation_id }).then((r) => r.data),
};
