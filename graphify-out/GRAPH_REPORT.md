# Graph Report - Kiro  (2026-10-30)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1166 nodes · 3347 edges · 58 communities (52 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a264ec5b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 56

## God Nodes (most connected - your core abstractions)
1. `getDb()` - 174 edges
2. `requireApiSession()` - 84 edges
3. `writeAudit()` - 46 edges
4. `GatewayError` - 45 edges
5. `vitest` - 31 edges
6. `requireSession()` - 30 edges
7. `next` - 28 edges
8. `zod` - 27 edges
9. `runResearch()` - 25 edges
10. `applyTextFileChangeInternal()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `policy()` --calls--> `getDb()`  [EXTRACTED]
  tests/integration/budgets.test.ts → src/core/database.ts
- `insertGitHub()` --calls--> `getDb()`  [EXTRACTED]
  tests/integration/data-lifecycle.test.ts → src/core/database.ts
- `insertProvider()` --calls--> `getDb()`  [EXTRACTED]
  tests/integration/data-lifecycle.test.ts → src/core/database.ts
- `populateOwnerGraph()` --calls--> `getDb()`  [EXTRACTED]
  tests/integration/account-deletion.test.ts → src/core/database.ts
- `GET()` --calls--> `githubStatus()`  [EXTRACTED]
  app/api/v1/github/connection/route.ts → src/modules/github/service.ts

## Import Cycles
- None detected.

## Communities (58 total, 6 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (83): AnthropicAdapter, messagesForAnthropic(), GeminiAdapter, messagesForGemini(), resultObject(), adapters, messagesForOpenAI(), OpenAICompatibleAdapter (+75 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (90): GET(), POST(), POST(), POST(), GET(), POST(), GET(), POST() (+82 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (46): GET, POST, better-auth, migrate(), root, standalone, artifactRoot, databasePath (+38 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (44): POST(), GET(), GET(), POST(), AuditInput, redact(), writeAudit(), getDb() (+36 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (42): env, needs, permissions, runs-on, steps, timeout-minutes, concurrency, cancel-in-progress (+34 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (33): POST(), requestSchema, runtime, register(), OwnerArtifactCleanupOptions, OwnerArtifactCleanupResult, ACCOUNT_DELETION_CONFIRMATION, AccountDeletionError (+25 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (30): POST(), schema, POST(), acknowledgeAgentMessages(), declaredBrokerTools(), AgentLoopInput, AgentLoopResult, assertCapability() (+22 more)

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (28): GET(), POST(), BROKER_TOOL_NAMES, BrokerToolName, INTERNAL_ORCHESTRATION_TOOL_NAMES, InternalOrchestrationToolName, MAX_AGENT_DELEGATIONS_PER_ATTEMPT, MAX_AGENT_MESSAGES_PER_ATTEMPT (+20 more)

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (13): better-sqlite3, vitest, globalDatabase, createAgentRun(), getRun(), createConnection(), boundedConversationHistory(), CHAT_HISTORY_CHARACTER_LIMIT (+5 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (28): agent_team_members, agent_teams, audit_events, budget_policies, conversations, github_connections, idempotency_keys, idx_audit_user_created (+20 more)

### Community 10 - "Community 10"
Cohesion: 0.14
Nodes (26): agentBudgetSchema, assertBudget(), assertResourceAdmission(), assertUnits(), consumeUnknownUsageInTransaction(), contextClause(), insertResourceReservations(), matchingPolicies() (+18 more)

### Community 11 - "Community 11"
Cohesion: 0.14
Nodes (15): GET(), AgentsPage(), ChatPage(), ProjectsPage(), Agent, AgentConsole(), Model, SAFE_TOOLS (+7 more)

### Community 12 - "Community 12"
Cohesion: 0.18
Nodes (20): POST(), POST(), POST(), abortRun(), activeControllers, ClaimedTask, ClaimResult, claimTask() (+12 more)

### Community 13 - "Community 13"
Cohesion: 0.16
Nodes (21): resolveAvailableModel(), buildEvidencePacket(), buildReport(), CitationValidationError, estimate(), getResearchReport(), meaningfulTokens(), normalizeResearchItem() (+13 more)

### Community 14 - "Community 14"
Cohesion: 0.20
Nodes (15): boundedSignal(), executeConnector(), fetchFeed(), fetchGitHub(), fetchHackerNews(), fetchWeb(), htmlText(), normalizeSpace() (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.14
Nodes (12): POST(), DELETE(), POST(), DELETE(), MAX_ARTIFACT_BYTES, deleteConversation(), deleteProject(), disconnectGitHub() (+4 more)

### Community 16 - "Community 16"
Cohesion: 0.14
Nodes (17): DELETE(), GET(), ArtifactRecord, ArtifactScanner, ArtifactStorageRow, defaultArtifactScanner, deleteArtifact(), DeletionFileRow (+9 more)

### Community 17 - "Community 17"
Cohesion: 0.10
Nodes (19): replicas, NEXUS_ARTIFACT_ROOT, NEXUS_DATABASE_PATH, build, cap_drop, deploy, env_file, environment (+11 more)

### Community 18 - "Community 18"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 19 - "Community 19"
Cohesion: 0.16
Nodes (13): GET(), CommandCenter(), RunPage(), RunsPage(), AgentMessage, Participant, Run, RunEvent (+5 more)

### Community 20 - "Community 20"
Cohesion: 0.16
Nodes (10): GitHubPage(), SettingsPage(), AccountDeletionForm(), DataLifecycleControls(), GitHubConnection, ProviderConnection, MemoryManager(), react (+2 more)

### Community 21 - "Community 21"
Cohesion: 0.16
Nodes (7): metadata, LoginPage(), AuthForm(), nextConfig, next, authClient, getSession()

### Community 22 - "Community 22"
Cohesion: 0.25
Nodes (17): FileResult, GitHubConsole(), applyChange(), connect(), createBranch(), createDraftPull(), createIssue(), inspect() (+9 more)

### Community 23 - "Community 23"
Cohesion: 0.21
Nodes (16): agent_messages, agents, idx_agents_user, idx_tasks_lease, idx_tasks_ready, task_attempts, tasks, idx_agent_messages_correlation (+8 more)

### Community 24 - "Community 24"
Cohesion: 0.22
Nodes (16): idx_resource_budget_agent, idx_resource_budget_owner_unit, idx_resource_budget_project, idx_resource_budget_run, idx_resource_usage_admission, idx_resource_usage_agent, idx_resource_usage_expiry, idx_resource_usage_model_unit (+8 more)

### Community 25 - "Community 25"
Cohesion: 0.12
Nodes (16): dependencies, better-auth@1.7.14, better-sqlite3@13.0.3, cheerio@^1.2.0, fast-xml-parser@^5.11.2, ipaddr.js@^2.3.0, next@16.4.3, react@19.3.1 (+8 more)

### Community 26 - "Community 26"
Cohesion: 0.12
Nodes (16): scripts, backup, build, check, db:migrate, dev, lint, restore:verify (+8 more)

### Community 27 - "Community 27"
Cohesion: 0.16
Nodes (11): parsedCapabilities(), ReportSource, ResearchPage(), RetrievalError, Usage, placeholders, ResearchLab(), ResearchModel (+3 more)

### Community 28 - "Community 28"
Cohesion: 0.17
Nodes (12): CitationSupport, ClaimVerification, ResearchClaim, ResearchItem, ResearchModelTarget, ResearchSourceInput, ResearchStatus, StoredResearchSource (+4 more)

### Community 29 - "Community 29"
Cohesion: 0.31
Nodes (10): GET(), getConfig(), resetConfigForTests(), ServerConfig, serverSchema, decryptSecret(), encryptSecret(), getKey() (+2 more)

### Community 30 - "Community 30"
Cohesion: 0.19
Nodes (8): GET(), runtime, createOwnerExport(), encoder, exportChunks(), ExportSection, sections, populateOwnerGraph()

### Community 31 - "Community 31"
Cohesion: 0.21
Nodes (13): artifacts, attachments, idx_artifacts_user_created, idx_messages_conversation_created, messages, attachments_v2, idx_artifacts_owner_state, idx_artifacts_storage_path (+5 more)

### Community 32 - "Community 32"
Cohesion: 0.22
Nodes (8): GET(), POST(), schema, ConnectionsPage(), Connection, ConnectionManager(), SUPPORTED_PROVIDERS, listConnections()

### Community 33 - "Community 33"
Cohesion: 0.24
Nodes (12): assertActive(), BROKER_TOOL_DEFINITIONS, canonical(), executeBrokerTool(), readArtifactText(), redactValue(), safeResult(), schemas (+4 more)

### Community 34 - "Community 34"
Cohesion: 0.23
Nodes (6): GatewayPage(), ModelPricingForm(), ApiSessionOptions, isAllowedApiRequest(), mediaType(), SAFE_METHODS

### Community 35 - "Community 35"
Cohesion: 0.17
Nodes (11): ajv@8.20.0, tsx@4.20.6, description, engines, node, name, private, type (+3 more)

### Community 36 - "Community 36"
Cohesion: 0.17
Nodes (12): devDependencies, @types/better-sqlite3@7.6.13, @types/node@24.10.0, @types/react@19.2.2, @types/react-dom@19.2.2, typescript@5.9.3, vitest@5.0.5, @types/better-sqlite3 (+4 more)

### Community 37 - "Community 37"
Cohesion: 0.25
Nodes (6): GET(), POST(), ArtifactsPage(), ArtifactManager(), listProjects(), Project

### Community 38 - "Community 38"
Cohesion: 0.36
Nodes (8): GET(), runtime, artifactDownload(), ArtifactError, cleanupOwnerArtifactContent(), removeContentAddressedFile(), resolveArtifactPath(), validateOwnedContentRow()

### Community 39 - "Community 39"
Cohesion: 0.31
Nodes (6): AuthenticatedLayout(), AppShell(), primary, system, SignOut(), ThemeToggle()

### Community 40 - "Community 40"
Cohesion: 0.33
Nodes (8): assertOwnedScope(), createSchema, DELETE(), GET(), ownerContext(), POST(), scopeFields, RESOURCE_UNITS

### Community 41 - "Community 41"
Cohesion: 0.33
Nodes (5): Policy, ResourceTotal, UsagePage(), BudgetDeleteButton(), BudgetForm()

### Community 42 - "Community 42"
Cohesion: 0.28
Nodes (7): ChatWorkspace(), submit(), updateAnswer(), initialTurns(), Model, StoredMessage, Turn

### Community 43 - "Community 43"
Cohesion: 0.32
Nodes (7): GET(), POST(), runtime, listArtifacts(), sanitizeFilename(), uploadArtifact(), writeUpload()

### Community 44 - "Community 44"
Cohesion: 0.25
Nodes (4): @playwright/test@1.64.1, env, env, @playwright/test

### Community 45 - "Community 45"
Cohesion: 0.40
Nodes (5): GET(), POST(), sourceSchema, targetSchema, listResearch()

### Community 46 - "Community 46"
Cohesion: 0.40
Nodes (4): eslint@9.39.3, eslint-config-next@16.4.3, eslint, eslint-config-next

### Community 47 - "Community 47"
Cohesion: 0.67
Nodes (3): tool_invocations, idx_tool_invocations_attempt_call, idx_tool_invocations_task_attempt

### Community 48 - "Community 48"
Cohesion: 0.83
Nodes (3): github_write_operations, idx_github_write_operations_owner_repo, idx_github_write_operations_recovery

### Community 49 - "Community 49"
Cohesion: 0.67
Nodes (3): idx_research_report_sources_source, idx_usage_research_report, research_report_sources

### Community 50 - "Community 50"
Cohesion: 0.83
Nodes (3): account_deletion_files, account_deletion_jobs, idx_account_deletion_jobs_recovery

### Community 51 - "Community 51"
Cohesion: 0.50
Nodes (3): idx_usage_dispatch_recovery, owner_runtime_state, owner_runtime_state_after_user_insert

## Knowledge Gaps
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getDb()` connect `Community 3` to `Community 1`, `Community 2`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 10`, `Community 11`, `Community 12`, `Community 13`, `Community 15`, `Community 16`, `Community 19`, `Community 20`, `Community 28`, `Community 29`, `Community 30`, `Community 32`, `Community 33`, `Community 37`, `Community 38`, `Community 40`, `Community 41`, `Community 43`, `Community 45`?**
  _High betweenness centrality (0.145) - this node is a cross-community bridge._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05051312808210049 - nodes in this community are weakly interconnected._
- **Why does `next` connect `Community 21` to `Community 32`, `Community 34`, `Community 35`, `Community 37`, `Community 39`, `Community 41`, `Community 42`, `Community 11`, `Community 19`, `Community 20`, `Community 22`, `Community 25`, `Community 27`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.055728625822083766 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `Community 8` to `Community 0`, `Community 1`, `Community 2`, `Community 35`, `Community 36`, `Community 5`, `Community 34`, `Community 10`, `Community 14`, `Community 15`, `Community 28`, `Community 29`, `Community 30`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.05955734406438632 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.08653061224489796 - nodes in this community are weakly interconnected._