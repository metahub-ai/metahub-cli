/**
 * Use-case category taxonomy for the public catalog, plus the official-vendor
 * allowlist. One source of truth across surfaces: the portal's classification
 * backfill writes these slugs into `artifact_info.category`, the counts
 * endpoint aggregates them, and the registry renders names/blurbs and the
 * /categories landing pages from the same table.
 *
 * `keywords` double as the deterministic rules pass of the classifier: a
 * keyword hits when it equals a tag or appears in the name/tagline/
 * description (word-ish match, handled by the backfill). Keep them
 * lowercase.
 */

export interface CategoryDef {
  /** Stable slug stored in artifact_info.category and used in URLs. */
  slug: string;
  /** Display name. */
  name: string;
  /** One-line blurb for the category landing page. */
  blurb: string;
  /**
   * Two-to-three sentence introduction rendered on the category landing
   * page, below the blurb. Unique per category on purpose: these pages
   * otherwise differ only by their item grid, which reads as thin/templated
   * content to search engines and tells a human nothing about what the
   * category is actually for.
   */
  intro?: string;
  /** Lowercase tag/text signals for the rule-based classifier pass. */
  keywords: string[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    slug: "coding",
    name: "Coding & Refactoring",
    blurb: "Write, refactor, and ship code with an agent that knows your stack.",
    intro:
      "Most artifacts in the catalog live here: tools that read a codebase, follow its conventions, and make changes you would not be embarrassed to review. Expect language-specific helpers, refactoring workflows, spec-driven development harnesses, and framework-aware assistants for stacks like React, Next.js, Python, Rust, and Go. If you want your agent to stop writing generic code that ignores how your project actually works, start here.",
    keywords: [
      "ai-coding",
      "vibe-coding",
      "vibecoding",
      "coding-agent",
      "coding-agents",
      "agentic-coding",
      "refactor",
      "refactoring",
      "spec-driven-development",
      "typescript",
      "javascript",
      "python",
      "rust",
      "golang",
      "java",
      "react",
      "nextjs",
      "frontend",
      "backend",
      "game-development",
      "gamedev",
      "unreal-engine",
      "ai-coding-assistant",
    ],
  },
  {
    slug: "agents",
    name: "Agents & Orchestration",
    blurb: "Multi-agent workflows, orchestration frameworks, and autonomous runs.",
    intro:
      "Tools for running more than one agent, or one agent for longer than a single turn. This covers orchestration frameworks that split work across sub-agents, planning loops that decompose a task before executing it, handoff patterns, and harnesses that keep long autonomous runs from drifting. Useful when a job is too big for one prompt and you need structure rather than a bigger context window.",
    keywords: [
      "multi-agent",
      "agent-framework",
      "orchestration",
      "agent-orchestration",
      "autonomous-agent",
      "agentic-workflow",
      "subagent",
      "subagents",
      "swarm",
      "agent-team",
    ],
  },
  {
    slug: "prompts",
    name: "Prompts, Context & Memory",
    blurb: "Prompt engineering, RAG, context management, and agent memory.",
    intro:
      "Everything upstream of the model call: prompt engineering patterns, retrieval and RAG pipelines, context window management, and persistent memory across sessions. These artifacts decide what your agent knows when it starts working, which usually matters more than which model you picked. Includes context compaction, knowledge-base wiring, and memory that survives a restart.",
    keywords: [
      "prompt-engineering",
      "context-engineering",
      "rag",
      "retrieval",
      "memory",
      "ai-memory",
      "knowledge-base",
      "knowledge-graph",
      "semantic-search",
      "embeddings",
      "vector",
    ],
  },
  {
    slug: "testing",
    name: "Code Review, Testing & Quality",
    blurb: "Reviews, test discipline, debugging, and accessibility audits.",
    intro:
      "Quality gates you can hand to an agent: code review passes that catch real defects rather than style nits, test generation and test discipline, systematic debugging workflows, and accessibility audits. Several of these are adversarial by design, built to argue with your code instead of agreeing with it. Reach for this category when the goal is finding what is wrong, not producing more.",
    keywords: [
      "code-review",
      "testing",
      "tdd",
      "unit-testing",
      "e2e",
      "debugging",
      "debug",
      "lint",
      "linting",
      "quality",
      "accessibility",
      "wcag",
      "a11y",
    ],
  },
  {
    slug: "devops",
    name: "DevOps & Cloud",
    blurb: "CI/CD, containers, infrastructure, and deployment automation.",
    intro:
      "Infrastructure work that agents are unexpectedly good at: CI/CD pipeline authoring, container and Kubernetes manifests, infrastructure-as-code, deployment automation, and incident triage. These artifacts tend to encode the boring, error-prone steps of shipping, which is exactly the work worth automating. Covers the major clouds along with self-hosted setups.",
    keywords: [
      "devops",
      "docker",
      "kubernetes",
      "k8s",
      "ci-cd",
      "cicd",
      "deployment",
      "terraform",
      "infrastructure",
      "aws",
      "gcp",
      "azure",
      "cloudflare",
      "serverless",
      "monitoring",
      "observability",
    ],
  },
  {
    slug: "data",
    name: "Data & Databases",
    blurb: "Query, model, and analyze data — SQL and beyond.",
    intro:
      "Query, model, migrate, and analyze data without leaving your editor. This spans SQL generation and optimization, schema design and migrations, connectors for Postgres and other engines, dataframe and analytics workflows, and pipeline tooling. Many are MCP servers, which means your agent can inspect a live schema rather than guessing at column names.",
    keywords: [
      "database",
      "databases",
      "sql",
      "postgres",
      "postgresql",
      "sqlite",
      "mysql",
      "mongodb",
      "redis",
      "data-analysis",
      "data-engineering",
      "etl",
      "analytics",
      "spreadsheet",
      "excel",
    ],
  },
  {
    slug: "web-automation",
    name: "Web & Browser Automation",
    blurb: "Drive browsers, scrape pages, and automate the web.",
    intro:
      "Drive a real browser, extract data from pages, and automate flows that never got an API. Includes headless browser control, scraping and crawling, form and session handling, and end-to-end web testing. Useful whenever the information you need exists only as a rendered page, or the task requires clicking through an interface a human would.",
    keywords: [
      "browser",
      "browser-automation",
      "scraping",
      "web-scraping",
      "playwright",
      "puppeteer",
      "selenium",
      "crawler",
      "web-automation",
      "chrome",
    ],
  },
  {
    slug: "research",
    name: "Research & Science",
    blurb: "Literature, experiments, and deep research workflows.",
    intro:
      "Deep research workflows that go beyond one search query: literature review and citation handling, experiment tracking, scientific computing, and multi-source synthesis with the sourcing kept intact. These artifacts are built for questions where the answer needs evidence attached, and where reading twenty sources properly beats skimming three.",
    keywords: [
      "ai-research",
      "ml-research",
      "research-automation",
      "deep-research",
      "paper-writing",
      "paper-review",
      "arxiv",
      "literature",
      "machine-learning",
      "deep-learning",
      "materials-science",
      "ai-scientist",
      "science",
    ],
  },
  {
    slug: "docs",
    name: "Docs & Writing",
    blurb: "Documentation, READMEs, and long-form writing that stays current.",
    intro:
      "Documentation that keeps up with the code, and long-form writing that does not read as generated. Covers README and API doc generation, docstring and changelog maintenance, technical writing assistance, and doc sites that update from source. Particularly worth it on projects where the docs drifted from reality some time ago and nobody has wanted to touch them since.",
    keywords: [
      "documentation",
      "docs",
      "readme",
      "markdown",
      "writing",
      "technical-writing",
      "changelog",
      "blog",
    ],
  },
  {
    slug: "productivity",
    name: "Productivity & Workflows",
    blurb: "Task management, planning, and everyday workflow automation.",
    intro:
      "Everyday workflow automation: task and project management, planning and note-taking, calendar and email handling, and the small repetitive jobs that quietly consume a working day. Many integrate with tools you already use through MCP, so the agent operates your actual systems instead of keeping a parallel copy of your to-do list.",
    keywords: [
      "productivity",
      "workflow-automation",
      "workflow",
      "workflows",
      "planning",
      "notes",
      "note-taking",
      "todo",
      "calendar",
      "email",
      "project-management",
      "project-initialization",
      "slack",
      "notion",
    ],
  },
  {
    slug: "design",
    name: "Design, Media & Games",
    blurb: "UI systems, imagery, video, and creative tooling.",
    intro:
      "Creative and visual work: design systems and UI component generation, image and video processing, diagramming, asset pipelines, and game development tooling. This is where the catalog is most visual, and where MCP servers that reach real rendering or editing tools tend to earn their place over pure prompting.",
    keywords: [
      "design",
      "ui-design",
      "design-system",
      "design-tokens",
      "typography",
      "figma",
      "image",
      "image-generation",
      "ai-video",
      "video",
      "audio",
      "music",
      "3d",
      "animation",
    ],
  },
  {
    slug: "security",
    name: "Security & Secrets",
    blurb: "Scanning, hardening, and keeping credentials where they belong.",
    intro:
      "Find problems before someone else does: dependency and vulnerability scanning, secret detection, static analysis, hardening checklists, and credential handling that keeps keys out of the places they should never reach. Several of these are meant to run in CI as a gate rather than as an occasional manual sweep.",
    keywords: [
      "security",
      "secrets",
      "vulnerability",
      "pentest",
      "audit",
      "sast",
      "appsec",
      "cve",
      "compliance",
      "encryption",
    ],
  },
  {
    slug: "marketing",
    name: "Marketing & GTM",
    blurb: "SEO, AI visibility, content, and go-to-market workflows.",
    intro:
      "Go-to-market work that benefits from automation: SEO audits and technical SEO fixes, content production and editing, analytics interpretation, and the newer problem of AI visibility, meaning whether language models can find and describe your product correctly. Aimed at teams where the same person ships the feature and then has to launch it.",
    keywords: [
      "marketing",
      "dev-gtm",
      "seo",
      "geo",
      "ai-visibility",
      "ai-citation",
      "content-marketing",
      "social-media",
      "growth",
      "copywriting",
    ],
  },
];

/** Fallback slug for artifacts no pass could place. */
export const OTHER_CATEGORY = "other";

const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string | null | undefined): CategoryDef | null {
  return (slug && BY_SLUG.get(slug)) || null;
}

/** Display name for a category slug; falls back to a prettified slug so
 *  legacy/free-form values still render as words. */
export function categoryName(slug: string | null | undefined): string {
  if (!slug) return "Other";
  const def = BY_SLUG.get(slug);
  if (def) return def.name;
  if (slug === OTHER_CATEGORY) return "Other";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * GitHub owners whose artifacts count as "official" — published by the
 * platform/tool vendor itself. Compared case-insensitively against the
 * repo owner (the registry's author handle).
 */
export const OFFICIAL_OWNERS = [
  "anthropics",
  "openai",
  "google",
  "google-gemini",
  "googleapis",
  "microsoft",
  "github",
  "modelcontextprotocol",
  "awslabs",
  "aws",
  "cloudflare",
  "stripe",
  "supabase",
  "vercel",
] as const;

const OFFICIAL_SET = new Set<string>(OFFICIAL_OWNERS);

export function isOfficialOwner(handle: string | null | undefined): boolean {
  return !!handle && OFFICIAL_SET.has(handle.toLowerCase());
}
