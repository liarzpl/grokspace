/**
 * The roles a session can be started as, and what each one is told.
 *
 * A brief reaches the agent as the first thing it is asked, not as a flag. `--rules`
 * would have put it in the system prompt, which is the better place, and is not used
 * for two reasons: every flag GrokSpace adds is a way for a session to fail to start
 * on a `grok` that does not recognise it, and the documented flags for `grok agent`
 * do not include it — so it would not work for the ACP sessions a swarm is made of.
 *
 * A prompt works identically for both kinds, cannot stop a session starting, and can
 * be tested by asserting what was sent.
 */

export interface Role {
  /** Stored on the session, shown in its pane, and exported as GROKSPACE_SESSION_ROLE. */
  name: string;
  /** One line for the picker. */
  summary: string;
  /** What the session is asked first. One paragraph; a brief nobody reads is not one. */
  brief: string;
}

/**
 * Written in the second person and kept short on purpose. These are read by a model
 * at the start of a session, alongside the project's memory and whatever the task
 * says, and a long brief crowds out both.
 */
export const ROLES: readonly Role[] = [
  {
    name: "Planner",
    summary: "Breaks work down before anyone starts it",
    brief:
      "You are the planner on this project. Before any code changes, read the project " +
      "memory and the code the work touches, then write the plan as a graph and say what " +
      "you are unsure of. Prefer finding the one decision that shapes everything else " +
      "over listing twenty steps. Do not start implementing unless you are asked to.",
  },
  {
    name: "Coder",
    summary: "Makes the change, in the codebase's own idiom",
    brief:
      "You are implementing on this project. Read the project memory first — the " +
      "conventions and decisions in it are not suggestions. Match the surrounding code's " +
      "idiom over your own preferences, keep the change as small as the goal allows, and " +
      "run whatever the project uses to check itself before you call it done.",
  },
  {
    name: "Reviewer",
    summary: "Reads a change for what will actually bite",
    brief:
      "You are reviewing on this project. Look for what will break or mislead: incorrect " +
      "logic, a lock held across I/O, an error nothing reports, a comment that no longer " +
      "matches its code. Say what you would change and why it matters. Skip style unless " +
      "it changes meaning, and say so plainly when a change looks right.",
  },
  {
    name: "Tester",
    summary: "Finds the case the change forgot",
    brief:
      "You are testing on this project. Find the cases the change does not cover, " +
      "especially the empty one, the concurrent one, and the one where an external thing " +
      "fails. Prefer a test that would have caught a real bug over one that restates the " +
      "implementation, and run the suite rather than reasoning about whether it passes.",
  },
  {
    name: "Scout",
    summary: "Answers a question about the codebase without changing it",
    brief:
      "You are scouting this project. Answer where things are, how they fit together, and " +
      "what the code actually does, with file paths and line numbers. Read widely before " +
      "concluding, say when you are guessing, and change nothing — reporting is the whole " +
      "job.",
  },
];

export function roleByName(name: string): Role | undefined {
  return ROLES.find((role) => role.name === name);
}

/**
 * What a role's session is asked first.
 *
 * One line, for the same reason a dispatched task is: a newline submits in a TUI, so
 * a brief spread over several lines would arrive as several prompts, most of them
 * fragments.
 *
 * The memory is named rather than pasted, which keeps the brief the same length
 * however much the project remembers. It is named unconditionally because the file
 * always exists for a session GrokSpace started — an empty one says there is nothing
 * to know, so there is no case where this points at nothing.
 */
export function briefPrompt(role: Role): string {
  const brief = role.brief.replace(/\s+/g, " ").trim();
  return `${brief} Start by reading $GROKSPACE_MEMORY_FILE for what this project has already decided.`;
}
