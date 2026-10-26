import { it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

it("rebuilds legacy watch_later with a per-user primary key", async () => {
  const p = path.join(os.tmpdir(), `mig-${Date.now()}.db`);
  process.env.TUBESHELF_TEST_DB_PATH = p;
  const { getDb, closeDb } = await import("./db");
  getDb();
  closeDb();
  const d = new Database(p);
  d.exec(`DROP TABLE watch_later;
  CREATE TABLE watch_later (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL, thumbnail TEXT NOT NULL, added_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  INSERT INTO users (id, email) VALUES ('u1','a'); INSERT INTO watch_later VALUES ('wl-a','a','u1','t','c','x','2026');`);
  d.close();
  const db = getDb();
  const pk = (db.pragma("table_info(watch_later)") as any[]).filter((c) => c.pk > 0).map((c) => c.name);
  expect(pk.sort()).toEqual(["id", "user_id"]);
  expect(db.prepare("select count(*) c from watch_later").get()).toEqual({ c: 1 });
  fs.unlinkSync(p);
});
