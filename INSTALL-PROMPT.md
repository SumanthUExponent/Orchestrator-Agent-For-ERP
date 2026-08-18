# Share this to install everything

Paste the block below into a **new Claude Code session**. It is written as instructions
to Claude, so the person receiving it does not have to know any of the commands.

They need: **Node 18+**, **git**, and a **bash** (built in on macOS and Linux; on Windows,
[Git for Windows](https://gitforwindows.org) or WSL). Nothing else — there is no
`npm install`, and nothing here talks to a network at runtime.

---

```text
Please install the Orchestrator Agent swarm and its JARVIS voice layer on this machine.

The repo is https://github.com/SumanthUExponent/Orchestrator-Agent-For-ERP — a 45-agent
orchestration swarm for Claude Code tuned to Frappe/ERPNext, plus a voice layer that
announces what each parallel session is doing. It has no runtime dependencies and makes
no network calls; the speech is the operating system's own synthesiser.

Do this:

1. Clone it somewhere permanent (not /tmp) and cd in.

2. Read the README first, then run the dry runs and show me what they plan to do:
       node scripts/orchestrator.mjs install
       node scripts/orchestrator.mjs voice
   Both are dry-run by default and write nothing. Tell me what they would install and
   which of my existing settings, if any, they would touch.

3. If it looks right, apply both. --force on BOTH is required, not optional:
       node scripts/orchestrator.mjs install --apply --force
       node scripts/orchestrator.mjs voice   --apply --force
   Without it, agents that already exist are skipped by name and config.sh is preserved,
   so an install can appear to succeed while changing nothing.

4. Verify, and show me the real output rather than summarising it:
       node scripts/orchestrator.mjs health     # the skill registry
       node scripts/orchestrator.mjs doctor     # the 45 agents
       jarvisctl doctor                         # the voice layer, per platform
   jarvisctl may not be on PATH; it is at ~/.claude/jarvis/jarvisctl.

5. On Linux only, jarvisctl doctor will report no speech or audio backend unless these
   are installed. Install whichever matches this machine and re-run it:
       Debian/Ubuntu:  sudo apt install espeak-ng pulseaudio-utils libnotify-bin
       Fedora:         sudo dnf install espeak-ng pulseaudio-utils libnotify
       Arch:           sudo pacman -S espeak-ng libpulse libnotify

6. Tell me plainly if anything failed or was skipped, including anything doctor flags as
   ADVICE. Do not tell me it worked if it did not.

Two things I should know when you are done:

- The hooks and agent definitions are read AT SESSION START, so none of it is active in
  this session. I need to restart Claude Code.
- Everything installs into ~/.claude/, which is user scope — it applies to every session
  and every directory, with no per-project setup.

Then, so I can hear whether it is any good:
       jarvisctl chimes     # every alert tone, back to back
       jarvisctl demo        # a narrated four-session working day, about 2.5 minutes
```

---

## The one thing worth doing afterwards

On macOS, `jarvisctl doctor` will almost certainly say:

> **ADVICE** no Enhanced, Premium or Siri voice is installed — this is why it sounds robotic

That is not a broken install. Every voice macOS ships by default is the "compact" set, a
2005-era synthesiser, and no amount of tuning fixes it. The good ones are free:

```bash
jarvisctl voices --setup
```

Download a Siri or Premium English (UK) voice, set it as the System Voice, then put
`JARVIS_VOICE="system"` in `~/.claude/jarvis/config.sh`. A Siri voice cannot be selected
by name — `"system"` is what tells JARVIS to omit the `-v` flag, which is the only way to
reach one.

On any platform, `JARVIS_TTS_CMD` points it at a local neural engine instead
([Kokoro](https://github.com/hexgrad/kokoro) is the one to reach for). Still offline, still
no account.

## Upgrading later

```bash
git pull
node scripts/orchestrator.mjs install --apply --force
node scripts/orchestrator.mjs voice   --apply --force
```

`--force` again, for the same reason, and restart sessions afterwards.

## Verified

This flow was tested from a clean clone into empty directories, including against a
`settings.json` that already contained the user's own hooks and model preference — both
survived. The installer merges rather than replaces, backs the file up first, writes
atomically, and refuses to touch a `settings.json` it cannot parse.
