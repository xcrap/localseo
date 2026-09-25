import { randomUUID } from "node:crypto";
import { all, get, jsonParse, run } from "./db";
import { notFound } from "./errors";
import { optionalInt } from "./input";

// In-app notices raised by the scheduler: scan regressions, failed scheduled
// scans, and failed or partial scheduled rank checks. They stay until deleted.

export type NotificationType = "scan-regression" | "scan-failed" | "rank-run-problem";

export function createNotification(input: {
  siteId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
}) {
  const id = randomUUID();
  run("INSERT INTO notifications (id, site_id, type, title, body, data_json) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    input.siteId,
    input.type,
    input.title,
    input.body,
    JSON.stringify(input.data),
  ]);
  return id;
}

function publicNotification(row: any) {
  const { data_json, ...rest } = row;
  return { ...rest, site_name: rest.site_name ?? null, data: jsonParse<Record<string, unknown>>(data_json, {}) };
}

export function listNotifications(input: { siteId?: unknown; unread?: unknown; limit?: unknown }) {
  const siteId = input.siteId ? String(input.siteId) : "";
  const unreadOnly = input.unread === true || input.unread === "1" || input.unread === "true";
  const limit = optionalInt(input.limit, "limit", 50, 1, 500);
  const siteWhere = siteId ? "n.site_id = ?" : "1 = 1";
  const siteParams = siteId ? [siteId] : [];
  const rows = all(
    `
    SELECT n.*, sites.name AS site_name
    FROM notifications n
    LEFT JOIN sites ON sites.id = n.site_id
    WHERE ${siteWhere} ${unreadOnly ? "AND n.read_at IS NULL" : ""}
    ORDER BY n.created_at DESC, n.rowid DESC
    LIMIT ?
    `,
    [...siteParams, limit],
  ).map(publicNotification);
  const unreadCount =
    get<{ count: number }>(`SELECT count(*) AS count FROM notifications n WHERE ${siteWhere} AND n.read_at IS NULL`, siteParams)
      ?.count || 0;
  return { rows, unreadCount };
}

export function markNotificationRead(id: string) {
  const info = run("UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ?", [id]);
  if (!info.changes) throw notFound("Notification not found.");
  return publicNotification(
    get("SELECT n.*, sites.name AS site_name FROM notifications n LEFT JOIN sites ON sites.id = n.site_id WHERE n.id = ?", [id]),
  );
}

export function markAllNotificationsRead(input: { siteId?: unknown }) {
  const siteId = input.siteId ? String(input.siteId) : "";
  const info = siteId
    ? run("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL AND site_id = ?", [siteId])
    : run("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL");
  return { updated: Number(info.changes || 0) };
}

export function deleteNotification(id: string) {
  const info = run("DELETE FROM notifications WHERE id = ?", [id]);
  return { deleted: Number(info.changes || 0) > 0 };
}
