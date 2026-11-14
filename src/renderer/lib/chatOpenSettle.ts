/**
 * How long a session has to stay open before it is worth starting work that
 * spawns a process: a follow-up suggestion or a PR refresh.
 *
 * `suggestFollowUp` spawns a provider CLI, which is the most expensive thing a
 * session switch can do — measured 2026-09-10, clicking through ten chats at
 * roughly one per second took the machine from 16 helper processes to 115 and
 * the load average from 13 to 22, which is what a switch feels slow *from*.
 * Someone paging through the sidebar looking for a chat passes through most of
 * them, and a placeholder they never read is not worth a CLI boot.
 */
export const SETTLE_MS = 600;
