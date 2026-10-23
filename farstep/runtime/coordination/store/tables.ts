import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    project: text().notNull(),
    actor: text().notNull(),
    generation: text().notNull(),
    connected: integer().notNull(),
    payload: text().notNull(),
  },
  (table) => [
    unique().on(table.project, table.actor),
    index("sessions_project").on(table.project),
  ],
);
export const works = sqliteTable(
  "works",
  {
    id: text().primaryKey(),
    project: text().notNull(),
    owner: text(),
    payload: text().notNull(),
  },
  (table) => [index("works_project").on(table.project)],
);
export const claims = sqliteTable(
  "claims",
  {
    work: text()
      .primaryKey()
      .references(() => works.id),
    project: text().notNull(),
    actor: text().notNull(),
    expires: integer().notNull(),
    payload: text().notNull(),
  },
  (table) => [index("claims_expiry").on(table.expires)],
);
export const resources = sqliteTable(
  "resources",
  {
    project: text().notNull(),
    resource: text().notNull(),
    work: text()
      .notNull()
      .references(() => claims.work, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.project, table.resource] })],
);
export const jobs = sqliteTable(
  "jobs",
  {
    scope: text().notNull(),
    name: text().notNull(),
    project: text().notNull(),
    actor: text().notNull(),
    payload: text({ mode: "json" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.name] }),
    index("jobs_project").on(table.project),
  ],
);
export const notes = sqliteTable(
  "notes",
  {
    sequence: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    project: text().notNull(),
    thread: text().notNull(),
    work: text(),
    recipient: text(),
    body: text().notNull(),
    payload: text().notNull(),
  },
  (table) => [
    index("notes_project").on(table.project, table.sequence),
    index("notes_recipient").on(table.project, table.recipient, table.sequence),
    index("notes_thread").on(table.project, table.thread, table.sequence),
  ],
);
export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    project: text().notNull(),
    payload: text().notNull(),
  },
  (table) => [index("events_project").on(table.project, table.id)],
);
export const requests = sqliteTable(
  "requests",
  {
    project: text().notNull(),
    actor: text().notNull(),
    request: text().notNull(),
    fingerprint: text().notNull(),
    result: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.project, table.actor, table.request] })],
);
