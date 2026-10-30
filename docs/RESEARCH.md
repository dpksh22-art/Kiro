# Research and technology decisions

Research date: 2026-10-29. Ten independent specialist agents examined the empty repository, current provider APIs, multi-model workspaces, orchestration, frontend patterns, research access, GitHub, security, and QA. Official documentation and active repositories were prioritized; community reports were used only as test-plan input.

## Executive summary

NEXUS uses a modular monolith instead of assembling several operational platforms. Next.js supplies the authenticated web/BFF boundary. Better Auth provides maintained session and password behavior. SQLite WAL makes the personal deployment runnable without external infrastructure. Direct provider adapters keep the first gateway auditable. A relational task DAG provides durable shared state without Temporal's second control plane. The design retains migration seams for PostgreSQL, separate workers, LiteLLM, LangGraph, and Temporal when measured requirements justify them.

## Workspace landscape

- [LibreChat](https://github.com/LibreChat-AI/LibreChat) is a strong MIT multi-provider workspace with agents, MCP, and ACLs. Its default stack adds several persistent services.
- [Open WebUI](https://docs.openwebui.com/license) has broad workspace/local-model features, but current releases use branding-oriented source-available terms rather than a standard OSI license.
- [Dify](https://github.com/langgenius/dify/blob/main/LICENSE) offers a mature visual workflow product; community terms restrict multi-tenant and white-label use.
- [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) is practical for smaller private RAG deployments.
- [Onyx](https://github.com/onyx-dot-app/onyx) is strongest when permission-aware enterprise search is the main requirement.

Building in the existing empty repository is justified because the requested product needs one coherent data/policy plane, custom agent execution, exact GitHub controls, and a purpose-built interface. NEXUS does not copy restricted product code.

## Gateway alternatives

- [LiteLLM](https://docs.litellm.ai/docs/) offers broad provider normalization, virtual keys, budgets, and fallbacks. It remains a good later data-plane option, but adds a Python service and community-maintained metadata that cannot be treated as authoritative model evidence.
- [Vercel AI SDK](https://ai-sdk.dev/docs/introduction) offers strong TypeScript streaming and provider packages. It is an application SDK, not the authoritative registry, policy plane, or durable orchestrator.
- Direct official adapters create more conformance work but preserve provider semantics and keep the initial deployment single-process.

Decision: direct native adapters for Anthropic and Gemini plus a strict OpenAI-compatible adapter profile. Add LiteLLM only when its provider breadth outweighs another service and compatibility qualification.

## Orchestration alternatives

- [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) fits checkpointed reasoning/tool loops and human interrupts. It does not replace the NEXUS tenant/task/budget ledger.
- [Temporal](https://docs.temporal.io/temporal) has the strongest long-lived distributed workflow semantics and worker versioning. It adds a service and still needs a relational business projection.
- [Trigger.dev](https://trigger.dev/docs) and [Inngest](https://www.inngest.com/docs) provide managed TypeScript-first durable work, with cloud/edition trade-offs.
- PostgreSQL/SQLite task ledgers require owned recovery logic but directly express dynamic DAGs, permissions, budget transactions, and audit queries.

Decision: database-backed control plane now, Temporal when NEXUS coordinates multi-service workflows for days or custom recovery becomes the dominant cost. LangGraph can later sit inside a task runtime.

## Research access

Credential-free first sources are direct public HTTP, RSS/Atom, the [official Hacker News API](https://github.com/HackerNews/API), and public [GitHub REST APIs](https://docs.github.com/rest). [Tavily](https://docs.tavily.com/documentation/api-reference/introduction) is the optional first general-search provider. Reddit and X connectors are not implemented. Reddit requires explicit platform approval and OAuth under its current data API policy; X requires approved developer access and paid API use. Credentials alone do not establish either approval. Anonymous scraping is not used as a fallback.

## Frontend

[Next.js App Router](https://nextjs.org/docs/app) supports protected server rendering, route handlers, layouts, and streaming. The interface uses a persistent command shell, readable transcript width, two-column answer comparison, status text in addition to color, an accessible task list rather than graph-only semantics, responsive bottom navigation, and honest unknown/empty/error states. React renders untrusted content as text.

## Cost and operations

The initial software has no required service fee beyond hosting and chosen providers. A single Node process and persistent volume can run on a small VM. Model and search charges vary by account and model; NEXUS does not freeze unverified prices in source. Costs are controlled with model selection, maximum output tokens, run parallelism, task/attempt/depth limits, deadlines, cancellation, and transactional monetary reservations.

## Security implications

Primary risks are provider/GitHub credential theft, prompt injection, SSRF, malicious repositories, cross-user access, arbitrary tool execution, duplicate external writes, worker crashes, and cost exhaustion. The first release deliberately does not execute model-proposed tools or uploaded code. OWASP's [LLM Prompt Injection Prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html), [SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), and [ASVS](https://owasp.org/www-project-application-security-verification-standard/) informed the controls.

## Community signals

GitHub issues and public discussions report upgrade churn, scaling edge cases, checkpoint semantics, and RAG integration problems across several products. These reports are anecdotes rather than proof of current defects. They informed tests for interrupted streams, leases, retries, provider failure, and clean upgrades.

## Phased priorities

1. Promote one real provider through live conformance testing.
2. Add token/request budgets for unknown-priced models.
3. Add provider-native tools/structured output behind deterministic permission checks.
4. Add artifact upload with MIME validation, malware scanning, quotas, and isolated extraction.
5. Add a GitHub App installation/OAuth flow and webhook reconciliation.
6. Migrate to PostgreSQL and separate workers before horizontal scale.
7. Evidence-aware model synthesis is implemented with local schema, citation, URL, and conservative excerpt-overlap validation; keep semantic entailment verification as a separate future decision.

Content from linked sources was rephrased for compliance with licensing restrictions.
