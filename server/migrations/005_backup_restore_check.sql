-- Each off-host backup is downloaded back, decrypted and restored into a temporary folder to prove it can be restored.
ALTER TABLE backups ADD COLUMN restore_verified_at TEXT;
ALTER TABLE backups ADD COLUMN restore_detail TEXT;
