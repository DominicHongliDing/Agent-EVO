CREATE TABLE evo_projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX evo_projects_owner ON evo_projects(owner);
CREATE TABLE evo_objects (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES evo_projects(id), kind TEXT NOT NULL, created TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX evo_objects_project ON evo_objects(project,kind);
CREATE TABLE evo_tokens (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES evo_projects(id), connection TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, created TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE evo_attempts (id TEXT PRIMARY KEY, project TEXT NOT NULL, job TEXT NOT NULL, connection TEXT NOT NULL, case_id TEXT NOT NULL, repeat_no INTEGER NOT NULL, status TEXT NOT NULL, lease TEXT, lease_until INTEGER, input TEXT NOT NULL, result TEXT, result_hash TEXT, created TEXT NOT NULL);
CREATE INDEX evo_attempts_queue ON evo_attempts(project,connection,status);
CREATE INDEX evo_attempts_job ON evo_attempts(project,job);
