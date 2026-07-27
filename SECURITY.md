# Security notes

- Do not commit `.dev.vars`, `.env`, owner tokens, project sessions, recovery codes, or access codes.
- Rotate `RW_BOOTSTRAP_SECRET` only with a planned migration: it is the key material used to derive token encryption keys.
- Revoke leaked project invitations from RW Studio.
- Keep the Worker endpoint public; it is not a secret. Authorization is enforced by encrypted invitations and bearer sessions.
- RW Studio should be the only client allowed to edit reserved collaboration metadata.
