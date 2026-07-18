-- Optional sample data for local development.
-- Apply with: wrangler d1 execute screenboard --local --file=./seed.sql
-- (Create the first admin via POST /api/auth/bootstrap, not here.)

INSERT INTO groups (name) VALUES ('Taipei Factory');
INSERT INTO groups (name) VALUES ('Production');
INSERT INTO groups (name) VALUES ('Warehouse');
INSERT INTO groups (name) VALUES ('Lobby');

INSERT INTO playlists (name, loop) VALUES ('KPI Dashboard', 1);
INSERT INTO playlist_items (playlist_id, type, url, duration_sec, order_index)
  VALUES (1, 'url', 'https://example.com/kpi', 30, 0);
