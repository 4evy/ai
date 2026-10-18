CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  actor TEXT NOT NULL,
  generation TEXT NOT NULL,
  connected INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (project, actor)
);

CREATE TABLE works (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  owner TEXT,
  payload TEXT NOT NULL
);

CREATE TABLE claims (
  work TEXT PRIMARY KEY REFERENCES works (id),
  project TEXT NOT NULL,
  actor TEXT NOT NULL,
  expires INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE resources (
  project TEXT NOT NULL,
  resource TEXT NOT NULL,
  work TEXT NOT NULL REFERENCES claims (work) ON DELETE CASCADE,
  PRIMARY KEY (project, resource)
);

CREATE TABLE jobs (
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  project TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (scope, name)
);

CREATE TABLE notes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  thread TEXT NOT NULL,
  work TEXT,
  recipient TEXT,
  body TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE requests (
  project TEXT NOT NULL,
  actor TEXT NOT NULL,
  request TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (project, actor, request)
);

CREATE INDEX sessions_project ON sessions (project);

CREATE INDEX works_project ON works (project);

CREATE INDEX claims_expiry ON claims (expires);

CREATE INDEX jobs_project ON jobs (project);

CREATE INDEX notes_project ON notes (project, sequence);

CREATE INDEX notes_recipient ON notes (project, recipient, sequence);

CREATE INDEX notes_thread ON notes (project, thread, sequence);

CREATE INDEX events_project ON events (project, id);

PRAGMA user_version = 1;
