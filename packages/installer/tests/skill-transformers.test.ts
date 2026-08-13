/**
 * Per-client transformer snapshot tests. Each transformer takes the
 * same SKILL.md source and emits the right shape for its target
 * client (.mdc / .md frontmatter / plain prompt).
 *
 * If a downstream client (Cursor 0.43 changes its frontmatter,
 * Continue moves to a different `if` syntax, etc.) we want THIS file
 * to fail loudly rather than silently producing files Cursor / Continue
 * ignore.
 */
import { describe, expect, it } from "vitest";
import {
  parseSkillSource,
  toContinueRule,
  toCursorRule,
  toZedPrompt,
  transformSkill,
} from "../src/skill-transformers.js";

const RAW = `---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files.
triggers: extract pdf text, merge pdfs, fill pdf forms
---

# PDF skill

Extracts text from PDFs and fills forms.

## When to use
When the user mentions a .pdf file.
`;

describe("parseSkillSource", () => {
  it("parses frontmatter + body", () => {
    const s = parseSkillSource("pdf", RAW);
    expect(s.slug).toBe("pdf");
    expect(s.frontmatter.name).toBe("pdf");
    expect(s.frontmatter.description).toContain("PDF files");
    expect(s.frontmatter.triggers).toEqual(["extract pdf text", "merge pdfs", "fill pdf forms"]);
    expect(s.body.startsWith("# PDF skill")).toBe(true);
  });

  it("tolerates missing frontmatter", () => {
    const s = parseSkillSource("foo", "# Just a body\n\nNo frontmatter here.");
    expect(s.frontmatter).toEqual({});
    expect(s.body).toContain("Just a body");
  });

  it("strips quoted frontmatter values", () => {
    const s = parseSkillSource("foo", '---\nname: "quoted"\n---\nbody');
    expect(s.frontmatter.name).toBe("quoted");
  });
});

describe("toCursorRule", () => {
  it("emits .mdc with description frontmatter + alwaysApply:false", () => {
    const out = toCursorRule(parseSkillSource("pdf", RAW));
    expect(out).toContain("---");
    expect(out).toContain(
      'description: "Use this skill whenever the user wants to do anything with PDF files."',
    );
    expect(out).toContain("alwaysApply: false");
    expect(out).toContain("# PDF skill");
  });

  it("falls back to name then slug when description is absent", () => {
    const out = toCursorRule(parseSkillSource("foo", "# body"));
    expect(out).toContain('description: "foo"');
  });

  it("escapes double quotes in description", () => {
    const raw = `---\ndescription: He said "go"\n---\nbody`;
    const out = toCursorRule(parseSkillSource("foo", raw));
    expect(out).toContain('description: "He said \\"go\\""');
  });
});

describe("toContinueRule", () => {
  it("emits .md with name + if frontmatter", () => {
    const out = toContinueRule(parseSkillSource("pdf", RAW));
    expect(out).toContain('name: "pdf"');
    expect(out).toContain(
      'if: "Use this skill whenever the user wants to do anything with PDF files."',
    );
    expect(out).toContain("# PDF skill");
  });

  it("synthesizes a default 'if' when description is missing", () => {
    const out = toContinueRule(parseSkillSource("foo", "# body"));
    expect(out).toContain('if: "Use the foo skill."');
  });
});

describe("toZedPrompt", () => {
  it("leads with the description as the picker header", () => {
    const out = toZedPrompt(parseSkillSource("pdf", RAW));
    expect(out.split("\n")[0]).toBe(
      "Use this skill whenever the user wants to do anything with PDF files.",
    );
    expect(out).toContain("# PDF skill");
  });

  it("falls back to slug when no description/name", () => {
    const out = toZedPrompt(parseSkillSource("foo", "# body"));
    expect(out.split("\n")[0]).toBe("foo");
  });
});

describe("transformSkill dispatcher", () => {
  it("returns raw for anthropic-skill-md (verbatim)", () => {
    const s = parseSkillSource("pdf", RAW);
    expect(transformSkill("anthropic-skill-md", s)).toBe(RAW);
  });

  it("dispatches to the right transformer", () => {
    const s = parseSkillSource("pdf", RAW);
    expect(transformSkill("cursor-rule-mdc", s)).toContain("alwaysApply");
    expect(transformSkill("continue-rule-md", s)).toContain('name: "pdf"');
    expect(transformSkill("zed-prompt-md", s)).toContain("Use this skill");
  });
});
