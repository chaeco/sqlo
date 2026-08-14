-- 002_create_posts.sql
CREATE TABLE posts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title  TEXT NOT NULL,
  body   TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
);
