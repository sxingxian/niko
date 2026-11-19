# Knowledge release check

Run before releasing a change to Knowledge. It uses a real AI, so it is not part of `npm test`.

```sh
# Your own OpenAI-format key answers; Cloudflare finds files by meaning, as in production.
EVAL_AI_BASE_URL=https://api.openai.com/v1 EVAL_AI_KEY=sk-… EVAL_AI_MODEL=gpt-4o-mini \
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
npm run eval:knowledge

# Or Workers AI answers too (only the Cloudflare details).
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run eval:knowledge

# Search only, no key and no cost: checks which file comes first, not the answers.
EVAL_DRY=1 npm run eval:knowledge
```

The Cloudflare token needs **Workers AI: Read**. Keep keys in your shell, not in a file in the repo.

It needs PostgreSQL 16 with pgvector on this machine (as `npm test` does). It runs the real Worker, adds the files in
`knowledge-set.mjs` (a made-up homeware shop: a handbook, a price list, clients, contracts, suppliers, an IT policy),
and asks:

| Group | Questions | Passes when | Needed |
|---|---|---|---|
| Known answers | 50 | the right file leads, and the answer has the facts | 90% |
| Unrelated | 10 | no file leads | 90% |
| Situations | 20 | the files' rules are applied, or Niko asks for the missing fact | 80% |

Without Cloudflare details, files are found by words only. Then no file ever leads, so the check looks for the right
file coming first, and for unrelated questions being offered no file.

It writes `eval-knowledge-report.md` (what failed, with each answer) and exits 1 when a group is under its mark.
`EVAL_ONLY=known,situations` runs some groups; `EVAL_LIMIT=5` runs the first few of each.

Nothing leaves this machine except calls to the AI services above. The database is temporary and removed at the end.
