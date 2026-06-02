// @ts-ignore Drizzle is introduced by the D1 schema/migration toolchain.
import { relations, sql } from "drizzle-orm";
// @ts-ignore Drizzle is introduced by the D1 schema/migration toolchain.
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const collectionVisibilityValues = ["public", "unlisted", "private"] as const;
export type CollectionVisibility = (typeof collectionVisibilityValues)[number];

export const noteModerationStatusValues = ["active", "pending", "blocked", "deleted"] as const;
export type NoteModerationStatus = (typeof noteModerationStatusValues)[number];

const now = sql`CURRENT_TIMESTAMP`;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull().default(now),
    lastLoginAt: text("last_login_at"),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    ip: text("ip"),
    ua: text("ua"),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility", { enum: collectionVisibilityValues }).notNull().default("private"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (table) => [
    uniqueIndex("collections_slug_unique").on(table.slug),
    index("collections_owner_user_id_idx").on(table.ownerUserId),
    index("collections_visibility_idx").on(table.visibility),
    check(
      "collections_visibility_check",
      sql`${table.visibility} in ('public', 'unlisted', 'private')`,
    ),
  ],
);

export const notesIndex = sqliteTable(
  "notes_index",
  {
    slug: text("slug").primaryKey(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    collectionId: text("collection_id").references(() => collections.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    title: text("title").notNull(),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull().default(now),
    modStatus: text("mod_status", { enum: noteModerationStatusValues }).notNull().default("active"),
  },
  (table) => [
    index("notes_index_owner_user_id_idx").on(table.ownerUserId),
    index("notes_index_collection_id_idx").on(table.collectionId),
    index("notes_index_expires_at_idx").on(table.expiresAt),
    index("notes_index_mod_status_idx").on(table.modStatus),
    check(
      "notes_index_mod_status_check",
      sql`${table.modStatus} in ('active', 'pending', 'blocked', 'deleted')`,
    ),
  ],
);

export const collectionNotes = sqliteTable(
  "collection_notes",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade", onUpdate: "cascade" }),
    noteSlug: text("note_slug")
      .notNull()
      .references(() => notesIndex.slug, { onDelete: "cascade", onUpdate: "cascade" }),
    position: text("position").notNull(),
  },
  (table) => [
    primaryKey({ name: "collection_notes_pk", columns: [table.collectionId, table.noteSlug] }),
    index("collection_notes_note_slug_idx").on(table.noteSlug),
    index("collection_notes_collection_position_idx").on(table.collectionId, table.position),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  collections: many(collections),
  notes: many(notesIndex),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const collectionsRelations = relations(collections, ({ many, one }) => ({
  owner: one(users, {
    fields: [collections.ownerUserId],
    references: [users.id],
  }),
  notes: many(collectionNotes),
}));

export const notesIndexRelations = relations(notesIndex, ({ many, one }) => ({
  owner: one(users, {
    fields: [notesIndex.ownerUserId],
    references: [users.id],
  }),
  primaryCollection: one(collections, {
    fields: [notesIndex.collectionId],
    references: [collections.id],
  }),
  collectionMemberships: many(collectionNotes),
}));

export const collectionNotesRelations = relations(collectionNotes, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionNotes.collectionId],
    references: [collections.id],
  }),
  note: one(notesIndex, {
    fields: [collectionNotes.noteSlug],
    references: [notesIndex.slug],
  }),
}));

export const schema = {
  users,
  sessions,
  collections,
  notesIndex,
  collectionNotes,
  usersRelations,
  sessionsRelations,
  collectionsRelations,
  notesIndexRelations,
  collectionNotesRelations,
};
