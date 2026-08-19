# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/bradtaylorsf/quorable/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. You should get
an acknowledgement within a week. This is a small project maintained in
spare time — please set expectations accordingly.

## What quorable does with your data and keys

Worth knowing before you point it at anything sensitive:

- **Your documents are sent to the model providers you configure.** That is
  the entire function of the tool. Whatever you put in `--context` is sent
  too, on every Stage-1 call. Check your providers' data-retention terms;
  quorable cannot make a hosted API forget anything.
- **Local endpoints keep documents on your machine.** Point `providers.endpoints`
  at a local OpenAI-compatible server and nothing leaves the host. See
  `docs/operations.md` for what that costs you in reliability.
- **Keys live in `~/.quorable/.env`, created chmod 600.** Process environment
  variables always take precedence. Keys are masked (`sk-o…mnop`) wherever
  the CLI prints them.
- **Run outputs contain your document.** `<filename>-reviewed/` holds the raw
  reviews and the synthesis. The repo's `.gitignore` excludes `*-reviewed/`,
  `runs/`, `outputs/` and `handoff/`; if you vendor quorable into another
  repo, carry those rules across.
- **Rubric gate patterns are regexes compiled from your own YAML.** Loading a
  rubric you did not write runs its patterns against your document — treat
  third-party packs the way you would treat any other executable config.

## Supported versions

quorable is pre-1.0. Fixes land on the latest minor release only.
