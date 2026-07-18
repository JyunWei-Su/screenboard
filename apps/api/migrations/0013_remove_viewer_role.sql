-- The read-only 'viewer' role is removed; only 'admin' and 'operator' remain.
-- Existing viewers are promoted to 'operator' (the least-privileged remaining
-- role) so no account is left with an invalid role. Reassign or delete these
-- accounts afterwards if operator access is not intended.
UPDATE users SET role = 'operator' WHERE role = 'viewer';
