# AI tools

> [!CAUTION]
> This is a **personal project** built around how I want AI to work on my
> machines
>
> The point is to get permission prompts, approval gates, and other
> interruptions out of the way so agents can do stuff **without me stepping
> in**
>
> That includes letting them run commands and change files without asking
> first, so **they can break things too**. That's a tradeoff I'm making for
> _my own setup_

> [!WARNING]
> **AI wrote the code** in this repo. **The writing, ideas, architecture, and
> decisions are mine**
>
> **As for the code: slop ahead, close your eyes!** I've put effort
> _(and a bunch of tokens)_ into making sure it's not too bad, but
> **don't come in with high hopes**
>
> The ideas and overall approach are probably the parts worth looking at. The
> code is just how those ideas ended up working in my setup. Expect _rough
> edges and weird bugs_

My personal tooling and settings for AI tools I use. Feel free to take shit

## What I use

| Tool            | Where it fits                                                                       |
| --------------- | ----------------------------------------------------------------------------------- |
| **Codex CLI**   | Good ol' reliable slop maker                                                        |
| **OMP**         | My new shiny slop maker, especially for remote work                                 |
| **ChatGPT.app** | Web work and research, awesome for making sites and letting an agent browse the web |
| **OpenCode**    | Sometimes                                                                           |

I usually reach for OMP when I know I'll be doing remote work. It tends to keep
going longer and put more effort into testing its shit. Tbh both can give up too
early or not go hard enough, but OMP tends to try harder

## Farstep

I got into Pi after watching
[Building pi in a World of Slop](https://youtu.be/RjfbvDXpFls). What really sold
me was having **ZERO APPROVAL FOR JUST DOING SHIT** without getting interrupted
to approve `cat` or `ls`, like omfg YES U CAN RUN CAT 🙄🙄

[Farstep](farstep/) exists to take this **A STEP FURTHER**. I want to give
agents a deeper interface to the machine so they can touch more of it: commands,
jobs, interactive terminals, desktops, system services, all that stuff. Across
platforms, with the goal of keeping it
**modular and independent so any harness can use it**

## SSH and local execution

I use remote machines a lot, and imo the experience in most harnesses kinda
sucks. The agent writes some insane inline SSH command, hits an escaping issue,
then starts writing scripts locally and shuffling shit back and forth with
rsync. It's this whole awkward dance just to get work done

The [SSH extension](apps/omp/extensions/remote/) gives the agent tools for doing
that work, with Farstep handling execution and jobs. And **the same command and
job interface works locally too**

- **Scripts:** write TypeScript with zx on the selected machine, with ordinary
  loops, functions, and output parsing. Pass parameters as data and interpolate
  them into shell commands
- **Batches:** run steps together, say which ones depend on others, and wait for
  a service to actually be ready
- **Jobs:** check on work later, wait for it, stop it, or keep it running after
  disconnecting
- **Terminals:** see the terminal screen, press named keys, and reply to prompts

It also handles remote file reading and editing, desktop capture and input,
and coordinating shared work. Right now the extension is for OMP, with the
shared interfaces in [packages/toolkit/](packages/toolkit/) and
[Farstep](farstep/)

## Sky / Skylight

### How I found it

I found this after switching to ChatGPT and trying the Computer Use skill in
the macOS app. I wanted to see what was actually going on under the hood, so I
dug into the app bundle

> oh wait, there's literally a JS library in here I can wire up to my own tools

### Where it came from

Sky used to be its own Mac AI assistant, made by Software Applications
Incorporated. Two of its founders, Ari Weinstein and Conrad Kramer, had built
[Workflow, which became Apple Shortcuts][workflow]. OpenAI
[acquired the company on October 23, 2025][acquisition] to bring Sky's Mac
integration into ChatGPT

### What's actually in there

Inside the macOS app:

- **`@oai/sky`:** the JS API for computer use
- **`SkyComputerUseService`:** a Swift service for app inspection and
  interaction; the JS API talks to it over a local socket
- **`@oai/cua`:** a higher-level library for working with apps and browsers

I wire this into OMP through [Skylight](apps/omp/extensions/skylight/), and
Farstep lets me run it locally or on another machine over SSH. Different
platforms support different bits, but that's the idea: computer use on the
machine where the agent is actually doing the work

```mermaid
flowchart LR
    OMP --> Skylight
    Skylight --> F["Farstep - local or SSH"]
    F --> S["Sky runtime"]
```

> **Fun detail:** macOS already has a private `SkyLight.framework`, and
> WindowServer lives inside it

## Settings and setup

[settings](config/settings/) has my settings for Codex, Claude Code, OMP,
OpenCode, and ChatGPT. There's also launcher stuff, OMP patches, and ChatGPT
integration, installed through Nix and Home Manager

[workflow]: https://www.macrumors.com/2017/03/22/apple-acquires-popular-automation-app-workflow/
[acquisition]: https://openai.com/index/openai-acquires-software-applications-incorporated/
