-- Restore the primary administrator's credential and privileges once during
-- deployment. OAuth accounts remain linked through the same User row.
UPDATE "User"
SET
  "passwordHash" = '$2b$12$tzEL4GAKFX44mBoUASliZuflL5l19c4OVc40hD84ZqeuaGNKsDD52',
  "role" = 'ADMIN',
  "platformAdmin" = true,
  "emailVerified" = COALESCE("emailVerified", NOW()),
  "updatedAt" = NOW()
WHERE LOWER("email") = 'ocirhashbaatar@gmail.com';

